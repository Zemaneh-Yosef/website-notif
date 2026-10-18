// The HTTP API the site calls (behind nginx, which adds TLS and its own rate limit):
//
//   GET    /v1/key                  the VAPID public key (applicationServerKey)
//   POST   /v1/subscribe            { subscription, display, places?: [{ location, settings, notifications }] } → { token }
//   GET    /v1/subscription         (Authorization: Bearer <token>) the browser and its places
//   PUT    /v1/subscription         (Bearer) { subscription?, display? }
//   DELETE /v1/subscription         (Bearer) stop everything and forget this browser
//   PUT    /v1/places/<lat,lon>     (Bearer) { location, settings, notifications }: add or change a place
//   DELETE /v1/places/<lat,lon>     (Bearer) stop one place
//   GET    /v1/health               status
//
// Before places, a browser had one location: `location`, `settings` and `notifications` at the top level of
// POST /v1/subscribe and PUT /v1/subscription. That still works (as "this browser's only place"), so a page
// from before the change keeps working until it is reloaded.

import type { Config } from "./config.ts";
import type { PlaceFields, Store, SubscriptionRow } from "./db.ts";
import type { DriftCheck } from "./drift.ts";
import { placeParsed, type Scheduler } from "./scheduler.ts";
import * as v from "./validate.ts";
import { b64urlEncode } from "./webpush.ts";
import type { ZmanimEngine } from "./zmanim.ts";

class RateLimit {
	#hits = new Map<string, { windowStart: number; count: number }>();
	constructor(private perHour: number) {}
	allow(key: string, now = Date.now()): boolean {
		const hit = this.#hits.get(key);
		if (!hit || now - hit.windowStart >= 60 * 60 * 1000) {
			this.#hits.set(key, { windowStart: now, count: 1 });
			if (this.#hits.size > 100_000) this.#sweep(now);
			return true;
		}
		return ++hit.count <= this.perHour;
	}
	#sweep(now: number) {
		for (const [k, h] of this.#hits) if (now - h.windowStart >= 60 * 60 * 1000) this.#hits.delete(k);
	}
}

async function sha256Hex(s: string) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

class TooMany extends Error {}

export function createHandler(deps: {
	config: Config;
	store: Store;
	engine: ZmanimEngine;
	scheduler: Scheduler;
	drift: DriftCheck;
	publicKey: string;
	log?: (msg: string) => void;
}) {
	const { config, store, engine, scheduler, drift } = deps;
	const log = deps.log ?? console.log;
	const subscribeLimit = new RateLimit(config.limits.subscribesPerIpPerHour);
	const updateLimit = new RateLimit(config.limits.updatesPerIpPerHour);
	const zmanimKeys = Object.keys(engine.list);

	const json = (status: number, body: unknown, headers: Headers) => {
		headers.set("Content-Type", "application/json; charset=utf-8");
		return new Response(body === null ? null : JSON.stringify(body), { status, headers });
	};

	async function readBody(req: Request): Promise<Record<string, unknown>> {
		const type = req.headers.get("content-type") ?? "";
		if (!type.startsWith("application/json")) throw new v.Invalid("expected application/json");
		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > config.limits.maxBodyBytes) throw new v.Invalid("request too large");
		const reader = req.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > config.limits.maxBodyBytes) { await reader.cancel(); throw new v.Invalid("request too large"); }
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let i = 0;
		for (const c of chunks) { bytes.set(c, i); i += c.length; }
		let body: unknown;
		try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new v.Invalid("body is not JSON"); }
		if (typeof body !== "object" || body === null || Array.isArray(body)) throw new v.Invalid("body must be an object");
		return body as Record<string, unknown>;
	}

	async function authorized(req: Request) {
		const m = (req.headers.get("authorization") ?? "").match(/^Bearer ([A-Za-z0-9_-]{43})$/);
		return m ? store.byToken(await sha256Hex(m[1])) : undefined;
	}

	/** A place's fields, checked; the key is its location's */
	function placeFields(body: Record<string, unknown>): { key: string; fields: PlaceFields } {
		const loc = v.location(body.location);
		return {
			key: v.placeKeyOf(loc.lat, loc.lon),
			fields: {
				lat: loc.lat, lon: loc.lon, elevation: loc.elevation, time_zone: loc.timeZone, location_name: loc.name,
				settings: JSON.stringify(v.settings(body.settings, engine.settingKeys)),
				notifications: JSON.stringify(v.notifications(body.notifications ?? {}, zmanimKeys)),
			},
		};
	}

	function savePlace(subscriptionId: number, key: string, fields: PlaceFields, now: number) {
		if (!store.place(subscriptionId, key) && store.places(subscriptionId).length >= config.limits.maxPlacesPerSubscription)
			throw new TooMany(`at most ${config.limits.maxPlacesPerSubscription} places`);
		const id = store.upsertPlace(subscriptionId, key, fields, now);
		return scheduler.plan(store.placeById(id)!, now);
	}

	/** The pre-places shape: this browser's one location replaces whatever places it had */
	function saveLegacyPlace(subscriptionId: number, body: Record<string, unknown>, now: number) {
		const { key, fields } = placeFields(body);
		for (const place of store.places(subscriptionId))
			if (place.place_key !== key) store.deletePlace(subscriptionId, place.place_key);
		return savePlace(subscriptionId, key, fields, now);
	}

	const describe = (row: SubscriptionRow) => ({
		endpoint: row.endpoint,
		display: JSON.parse(row.display),
		updatedAt: row.updated_at,
		places: store.places(row.id).map((place) => {
			const p = placeParsed(place);
			return { key: p.key, location: p.location, settings: p.settings, notifications: p.notifications, updatedAt: place.updated_at };
		}),
	});

	return async function handle(req: Request, info: { remoteAddr: { hostname: string } }): Promise<Response> {
		const url = new URL(req.url);
		const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		const origin = req.headers.get("origin");
		if (origin && config.allowedOrigins.includes(origin)) {
			headers.set("Access-Control-Allow-Origin", origin);
			headers.set("Vary", "Origin");
		}
		// a browser on another site: refuse (other clients aren't stopped by CORS anyway; the limits are for them)
		if (origin && !config.allowedOrigins.includes(origin)) return json(403, { error: "origin not allowed" }, headers);

		if (req.method === "OPTIONS") {
			headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
			headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
			headers.set("Access-Control-Max-Age", "86400");
			return new Response(null, { status: 204, headers });
		}

		// nginx (on the same machine) passes the client's address; the service only listens on localhost
		const ip = req.headers.get("x-real-ip") ?? info.remoteAddr.hostname;

		try {
			if (url.pathname === "/v1/health" && req.method === "GET")
				return json(200, { ok: true, commit: engine.commit, subscriptions: store.count(), places: store.countPlaces(), drift: drift.state }, headers);

			if (url.pathname === "/v1/key" && req.method === "GET")
				return json(200, { publicKey: deps.publicKey }, headers);

			if (url.pathname === "/v1/subscribe" && req.method === "POST") {
				if (!subscribeLimit.allow(ip)) return json(429, { error: "too many requests" }, headers);
				const body = await readBody(req);
				const sub = v.subscription(body.subscription);
				const display = v.display(body.display);
				// check every place before storing anything
				const places = Array.isArray(body.places) ? body.places.map((p) => placeFields(p as Record<string, unknown>)) : [];
				if (body.places !== undefined && !Array.isArray(body.places)) throw new v.Invalid("places: expected a list");
				if (places.length > config.limits.maxPlacesPerSubscription) throw new TooMany(`at most ${config.limits.maxPlacesPerSubscription} places`);
				const legacy = body.location !== undefined;
				if (legacy) placeFields(body);

				if (store.endpointOwner(sub.endpoint) === null && store.count() >= config.limits.maxSubscriptions) {
					log(`refused a subscription: the limit of ${config.limits.maxSubscriptions} is reached`);
					return json(503, { error: "not taking new subscriptions right now" }, headers);
				}

				const token = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
				const now = Date.now();
				const id = store.upsert({
					token_hash: await sha256Hex(token), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth,
					display: JSON.stringify(display), created_at: now, updated_at: now,
				});
				let queued = 0;
				for (const { key, fields } of places) queued += savePlace(id, key, fields, now);
				if (legacy) queued += saveLegacyPlace(id, body, now);
				return json(201, { token, queued }, headers);
			}

			if (url.pathname === "/v1/subscription") {
				if (!["GET", "PUT", "DELETE"].includes(req.method)) return json(405, { error: "method not allowed" }, headers);
				if (req.method !== "GET" && !updateLimit.allow(ip)) return json(429, { error: "too many requests" }, headers);
				const row = await authorized(req);
				if (!row) return json(401, { error: "unknown or missing token" }, headers);

				if (req.method === "GET") return json(200, describe(row), headers);

				if (req.method === "DELETE") {
					store.delete(row.id);
					return json(204, null, headers);
				}

				const body = await readBody(req);
				const now = Date.now();
				const changes: Partial<SubscriptionRow> = { updated_at: now };
				if ("subscription" in body) {
					const sub = v.subscription(body.subscription);
					const owner = store.endpointOwner(sub.endpoint);
					if (owner !== null && owner !== row.id) store.delete(owner); // an older registration of the same browser
					Object.assign(changes, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, failures: 0 });
				}
				if ("display" in body) changes.display = JSON.stringify(v.display(body.display));
				if ("location" in body) placeFields(body); // check before changing anything
				if ("settings" in body) v.settings(body.settings, engine.settingKeys);
				if ("notifications" in body) v.notifications(body.notifications, zmanimKeys);
				store.update(row.id, changes);
				let queued = 0;
				const legacyChoices = !("location" in body) && ("settings" in body || "notifications" in body);
				if ("location" in body) queued = saveLegacyPlace(row.id, body, now);
				else if (legacyChoices) {
					// the one-location shape without the location: change the browser's only place
					const places = store.places(row.id);
					if (places.length !== 1) throw new v.Invalid("settings and notifications belong to a place: use /v1/places/<key>");
					const p = placeParsed(places[0]);
					queued = saveLegacyPlace(row.id, {
						location: p.location,
						settings: "settings" in body ? body.settings : p.settings,
						notifications: "notifications" in body ? body.notifications : p.notifications,
					}, now);
				} else if ("display" in body) queued = scheduler.planAll(row.id, now);
				return json(200, { queued }, headers);
			}

			const placeMatch = url.pathname.match(/^\/v1\/places\/([^/]+)$/);
			if (placeMatch) {
				if (req.method !== "PUT" && req.method !== "DELETE") return json(405, { error: "method not allowed" }, headers);
				if (!updateLimit.allow(ip)) return json(429, { error: "too many requests" }, headers);
				const row = await authorized(req);
				if (!row) return json(401, { error: "unknown or missing token" }, headers);

				if (req.method === "DELETE") {
					const key = v.placeKey(placeMatch[1]);
					return store.deletePlace(row.id, key) ? json(204, null, headers) : json(404, { error: "no such place" }, headers);
				}

				const body = await readBody(req);
				const { key, fields } = placeFields(body);
				v.placeKey(placeMatch[1], { lat: fields.lat, lon: fields.lon } as never);
				const now = Date.now();
				const queued = savePlace(row.id, key, fields, now);
				store.update(row.id, { updated_at: now });
				return json(200, { key, queued }, headers);
			}

			return json(404, { error: "not found" }, headers);
		} catch (e) {
			if (e instanceof v.Invalid) return json(400, { error: e.message }, headers);
			if (e instanceof TooMany) return json(409, { error: e.message }, headers);
			log(`request ${req.method} ${url.pathname} failed: ${(e as Error)?.stack ?? e}`);
			return json(500, { error: "server error" }, headers);
		}
	};
}
