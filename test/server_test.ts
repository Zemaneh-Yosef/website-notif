// End to end, with the vendored site code: the API, planning, sending, and what a browser would decrypt.
// A stand-in push service records the requests; a stand-in browser decrypts them with its own key.

import { assert, assertEquals } from "./assert.ts";
import { createHandler } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { DriftCheck } from "../src/drift.ts";
import { RefractionCache } from "../src/refraction.ts";
import { Scheduler } from "../src/scheduler.ts";
import { b64urlDecode, b64urlEncode, Vapid } from "../src/webpush.ts";
import { ZmanimEngine } from "../src/zmanim.ts";

const SITE = "https://royzmanim.com";
const engine = await ZmanimEngine.load(new URL("../vendor/site", import.meta.url).pathname);
const pem = await Deno.readTextFile(new URL("./fixtures/vapid_private.pem", import.meta.url));
const publicKey = (await Deno.readTextFile(new URL("./fixtures/vapid_public.txt", import.meta.url))).trim();
const vapid = await Vapid.fromPem(pem, publicKey, "mailto:test@example.com");

/** A browser's push subscription: its key pair, and how it decrypts a message (RFC 8291) */
async function fakeBrowser(endpoint: string) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const hmac = async (key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) =>
		new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
	const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
	const te = new TextEncoder();
	return {
		subscription: { endpoint, keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } },
		async decrypt(body: Uint8Array<ArrayBuffer>) {
			const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
			const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
			const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, pair.privateKey, 256));
			const ikm = (await hmac(await hmac(auth, secret), cat(te.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
			const prk = await hmac(salt, ikm);
			const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
			const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
			const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce },
				await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
			assertEquals(plain[plain.length - 1], 2, "last-record delimiter");
			return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
		},
	};
}

async function setup(limits: Partial<Config["limits"]> = {}) {
	await Deno.mkdir(new URL("./tmp/", import.meta.url), { recursive: true });
	const dbPath = new URL(`./tmp/test-${crypto.randomUUID()}.db`, import.meta.url).pathname;
	const config: Config = {
		listen: { hostname: "127.0.0.1", port: 0 },
		allowedOrigins: [SITE],
		siteOrigin: SITE,
		vapid: { privateKeyFile: "", publicKey, subject: "mailto:test@example.com" },
		refractionServer: "http://127.0.0.1:9", // nothing listens: refraction fails, as offline
		database: dbPath,
		siteDir: "",
		userAgent: "test",
		limits: { maxBodyBytes: 16384, maxSubscriptions: 50, subscribesPerIpPerHour: 10, updatesPerIpPerHour: 100, maxNotificationsPerDay: 40, maxPlacesPerSubscription: 3, inactiveDays: null, ...limits },
	};
	const store = new Store(dbPath);
	const pushes: { url: string; headers: Headers; body: Uint8Array<ArrayBuffer> }[] = [];
	let pushStatus = 201;
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		pushes.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init!.body as Uint8Array) });
		return new Response(null, { status: pushStatus });
	}) as typeof fetch;
	const refraction = new RefractionCache(engine, config.refractionServer, () => {}, () => {});
	const scheduler = new Scheduler(store, engine, refraction, vapid, config, () => {}, fakeFetch);
	const drift = new DriftCheck(engine.commit, "test", () => {}, (async () => new Response("{}", { status: 503 })) as typeof fetch);
	const handle = createHandler({ config, store, engine, scheduler, drift, publicKey, log: () => {} });
	const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
		handle(new Request(`http://127.0.0.1${path}`, {
			method,
			headers: { "Origin": SITE, "X-Real-IP": extra.ip ?? "203.0.113.5", ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
			body: body ? JSON.stringify(body) : undefined,
		}), { remoteAddr: { hostname: "127.0.0.1" } });
	return { store, scheduler, call, pushes, setPushStatus: (s: number) => { pushStatus = s; } };
}

const NYC = { lat: 40.7128, lon: -74.006, elevation: 10, timeZone: "America/New_York", name: "New York" };
const DISPLAY = { language: "en", hourCycle: "h12", seconds: false, locale: "en-US" };
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test("plans the calendar's own times: sunset 6:11 PM on 18 Oct 2026, 5 minutes before", opts, () => {
	const now = Date.parse("2026-10-18T17:00:00-04:00");
	const planned = engine.plan({
		location: NYC, settings: {}, display: DISPLAY as never, refraction: null, refractionId: "x", placeKey: "40.71280,-74.00600",
		notifications: { sunset: { enabled: true, minutes: 5 }, "tzeit-regular": { enabled: true, minutes: 0 } },
		now, horizonMs: 48 * 3600_000, graceMs: 120_000,
	});
	const first = planned.filter((p) => p.zman_at > now).sort((a, b) => a.fire_at - b.fire_at).slice(0, 2);
	// the tag is the vendored site core's (with the place since the site's per-place change)
	const tag = (key: string) => engine.core.notificationTag(key, Temporal.ZonedDateTime.from("2026-10-18T12:00[America/New_York]"), "40.71280,-74.00600");
	assertEquals(first.map((p) => [p.zman_key, new Date(p.fire_at).toISOString(), p.time_text, p.tag]), [
		["sunset", "2026-10-18T22:06:00.000Z", "6:11 PM", tag("sunset")],
		["tzeit-regular", "2026-10-18T22:25:00.000Z", "6:25 PM", tag("tzeit-regular")],
	]);
	// two days ahead: today's, tomorrow's and the day after's (within 48 h)
	assert(planned.length >= 4 && planned.length <= 6, `planned ${planned.length}`);
});

Deno.test("(one-location API, as the site had before places) subscribe → notification sent at its time, encrypted for the browser, with the calendar's wording", opts, async () => {
	const { call, scheduler, pushes, store } = await setup();
	const browser = await fakeBrowser("https://fcm.googleapis.com/fcm/send/abc123");
	const res = await call("POST", "/v1/subscribe", {
		subscription: browser.subscription, location: NYC, display: DISPLAY,
		settings: { candles: "18" }, notifications: { sunset: { enabled: true, minutes: 15 }, alot: { enabled: false, minutes: 10 } },
	});
	assertEquals(res.status, 201);
	const { token, queued } = await res.json();
	assert(/^[A-Za-z0-9_-]{43}$/.test(token), "token");
	assert(queued >= 1, `queued ${queued}`);

	// nothing is due yet… until the queued sunset's time
	const item = store.db.prepare("SELECT * FROM queue ORDER BY fire_at LIMIT 1").get() as { fire_at: number; zman_at: number };
	await scheduler.sendDue(item.fire_at - 1000);
	assertEquals(pushes.length, 0);
	await scheduler.sendDue(item.fire_at);
	assertEquals(pushes.length, 1);

	const push = pushes[0];
	assertEquals(push.url, "https://fcm.googleapis.com/fcm/send/abc123");
	assertEquals(push.headers.get("content-encoding"), "aes128gcm");
	assertEquals(push.headers.get("urgency"), "high");
	assert(/^vapid t=.+, k=/.test(push.headers.get("authorization")!), "VAPID header");
	assert(Number(push.headers.get("ttl")) > 0 && Number(push.headers.get("ttl")) <= 17 * 60, `ttl ${push.headers.get("ttl")}`);
	assert((push.headers.get("topic") ?? "").length <= 32, "topic length");

	const message = await browser.decrypt(push.body);
	assertEquals(message.title, "Sunset in 15 minutes");
	assert(/^\d{1,2}:\d{2} [AP]M · New York$/.test(message.body), message.body);
	assert(message.tag.startsWith("zman-sunset-"), message.tag);
	assertEquals(message.url.split("?")[0], `${SITE}/calendar`);

	// sent once: a replan doesn't queue it again, and it isn't sent twice
	scheduler.planAll(store.byToken(await hash(token))!.id, item.fire_at + 1000);
	await scheduler.sendDue(item.fire_at + 2000);
	assertEquals(pushes.length, 1);
});

async function hash(token: string) {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("(one-location API) update, read back, delete — only with the token", opts, async () => {
	const { call } = await setup();
	const browser = await fakeBrowser("https://updates.push.services.mozilla.com/wpush/v2/xyz");
	const { token } = await (await call("POST", "/v1/subscribe", {
		subscription: browser.subscription, location: NYC, display: DISPLAY, notifications: { sunset: { enabled: true, minutes: 5 } },
	})).json();
	const auth = { Authorization: `Bearer ${token}` };

	assertEquals((await call("PUT", "/v1/subscription", { notifications: { sunset: { enabled: true, minutes: 30 } } })).status, 401);
	assertEquals((await call("PUT", "/v1/subscription", { notifications: { sunset: { enabled: true, minutes: 30 } } }, auth)).status, 200);
	const back = await (await call("GET", "/v1/subscription", undefined, auth)).json();
	assertEquals(back.places.length, 1);
	assertEquals(back.places[0].notifications.sunset, { enabled: true, minutes: 30 });
	assertEquals((await call("DELETE", "/v1/subscription", undefined, auth)).status, 204);
	assertEquals((await call("GET", "/v1/subscription", undefined, auth)).status, 401);
});

Deno.test("refuses: other push hosts, bad keys, unknown settings and zemanim, out-of-range minutes, other sites", opts, async () => {
	const { call } = await setup();
	const good = await fakeBrowser("https://fcm.googleapis.com/fcm/send/ok");
	const base = { subscription: good.subscription, location: NYC, display: DISPLAY, notifications: { sunset: { enabled: true, minutes: 5 } } };
	const cases: [string, unknown, number][] = [
		["internal address", { ...base, subscription: { ...good.subscription, endpoint: "https://127.0.0.1/x" } }, 400],
		["arbitrary host", { ...base, subscription: { ...good.subscription, endpoint: "https://evil.example/fcm.googleapis.com" } }, 400],
		["look-alike host", { ...base, subscription: { ...good.subscription, endpoint: "https://fcm.googleapis.com.evil.example/x" } }, 400],
		["http", { ...base, subscription: { ...good.subscription, endpoint: "http://fcm.googleapis.com/x" } }, 400],
		["port", { ...base, subscription: { ...good.subscription, endpoint: "https://fcm.googleapis.com:8443/x" } }, 400],
		["bad p256dh", { ...base, subscription: { ...good.subscription, keys: { p256dh: "AAAA", auth: good.subscription.keys.auth } } }, 400],
		["unknown setting", { ...base, settings: { evil: "1" } }, 400],
		["setting with markup", { ...base, settings: { candles: "<b>" } }, 400],
		["unknown zeman", { ...base, notifications: { "../etc": { enabled: true, minutes: 1 } } }, 400],
		["minutes too large", { ...base, notifications: { sunset: { enabled: true, minutes: 99999 } } }, 400],
		["bad time zone", { ...base, location: { ...NYC, timeZone: "Mars/Olympus" } }, 400],
		["bad latitude", { ...base, location: { ...NYC, lat: 123 } }, 400],
	];
	// (invalid attempts count toward the hourly limit too, so each case comes from its own address)
	let n = 0;
	for (const [name, body, status] of cases)
		assertEquals((await call("POST", "/v1/subscribe", body, { ip: `192.0.2.${++n}` })).status, status, name);

	const res = await call("POST", "/v1/subscribe", base, { Origin: "https://evil.example" });
	assertEquals(res.status, 403, "another site's page");

	const big = await call("POST", "/v1/subscribe", { ...base, padding: "x".repeat(20000) });
	assertEquals(big.status, 400, "body too large");
});

Deno.test("rate limit per address, and a cap on all subscriptions", opts, async () => {
	const { call } = await setup({ subscribesPerIpPerHour: 3, maxSubscriptions: 4 });
	const statuses = [];
	for (let i = 0; i < 4; i++) {
		const b = await fakeBrowser(`https://fcm.googleapis.com/fcm/send/rl${i}`);
		statuses.push((await call("POST", "/v1/subscribe", { subscription: b.subscription, location: NYC, display: DISPLAY, notifications: {} }, { ip: "198.51.100.1" })).status);
	}
	assertEquals(statuses, [201, 201, 201, 429]);
	const more = [];
	for (let i = 0; i < 2; i++) {
		const b = await fakeBrowser(`https://fcm.googleapis.com/fcm/send/cap${i}`);
		more.push((await call("POST", "/v1/subscribe", { subscription: b.subscription, location: NYC, display: DISPLAY, notifications: {} }, { ip: `198.51.100.${10 + i}` })).status);
	}
	assertEquals(more, [201, 503]);
});

Deno.test("a subscription the push service reports gone is removed", opts, async () => {
	const { call, scheduler, store, setPushStatus } = await setup();
	const b = await fakeBrowser("https://web.push.apple.com/QGone");
	await call("POST", "/v1/subscribe", { subscription: b.subscription, location: NYC, display: DISPLAY, notifications: { sunset: { enabled: true, minutes: 1440 } } });
	assertEquals(store.count(), 1);
	setPushStatus(410);
	const item = store.db.prepare("SELECT fire_at FROM queue ORDER BY fire_at LIMIT 1").get() as { fire_at: number };
	await scheduler.sendDue(item.fire_at);
	assertEquals(store.count(), 0);
});

Deno.test("Hebrew wording, from the site's own text", opts, () => {
	const text = engine.text({ zman_at: 0, minutes: 75, title: "שקיעה", time_text: "18:11" }, "he", "ירושלים", -75 * 60_000);
	assertEquals(text, { title: "שקיעה בעוד שעה ו-15 דקות", body: "18:11 · ירושלים" });
});

const LA = { lat: 34.0522, lon: -118.2437, elevation: 90, timeZone: "America/Los_Angeles", name: "Los Angeles" };
const BROOKLYN = { lat: 40.6782, lon: -73.9442, elevation: 20, timeZone: "America/New_York", name: "Brooklyn" };
const keyOf = (l: { lat: number; lon: number }) => `${l.lat.toFixed(5)},${l.lon.toFixed(5)}`;

Deno.test("places: Los Angeles and Brooklyn side by side, each with its own choices; removing one keeps the other", opts, async () => {
	const { call, store } = await setup();
	const b = await fakeBrowser("https://fcm.googleapis.com/fcm/send/places");
	const res = await call("POST", "/v1/subscribe", { subscription: b.subscription, display: DISPLAY,
		places: [{ location: LA, notifications: { candleLighting: { enabled: true, minutes: 30 } } }] });
	assertEquals(res.status, 201);
	const auth = { Authorization: `Bearer ${(await res.json()).token}` };

	const put = await call("PUT", `/v1/places/${encodeURIComponent(keyOf(BROOKLYN))}`,
		{ location: BROOKLYN, settings: { candles: "18" }, notifications: { sunset: { enabled: true, minutes: 15 } } }, auth);
	assertEquals(put.status, 200);

	let back = await (await call("GET", "/v1/subscription", undefined, auth)).json();
	assertEquals(back.places.map((p: { key: string }) => p.key), [keyOf(LA), keyOf(BROOKLYN)]);
	assertEquals(back.places[0].notifications, { candleLighting: { enabled: true, minutes: 30 } });
	assertEquals(back.places[1].notifications, { sunset: { enabled: true, minutes: 15 } });
	assertEquals(back.places[1].settings, { candles: "18" });

	// each place's queue has its own zemanim (and, with the site's per-place core, its own tags)
	const queued = (placeKey: string) => (store.db.prepare(`SELECT DISTINCT q.zman_key AS k FROM queue q JOIN places p ON p.id = q.place_id
		WHERE p.place_key = ?`).all(placeKey) as { k: string }[]).map((r) => r.k).sort();
	assertEquals(queued(keyOf(BROOKLYN)), ["sunset"]);
	assertEquals(queued(keyOf(LA)).filter((k) => k !== "candleLighting"), [], "LA: only candle lighting chosen");
	if (engine.core.placeKey) {
		const tags = (store.db.prepare("SELECT DISTINCT tag FROM queue").all() as { tag: string }[]).map((r) => r.tag);
		assert(tags.filter((t) => t.startsWith("zman-sunset-")).every((t) => t.endsWith("@" + keyOf(BROOKLYN))), tags.join());
	}

	assertEquals((await call("DELETE", `/v1/places/${encodeURIComponent(keyOf(LA))}`, undefined, auth)).status, 204);
	back = await (await call("GET", "/v1/subscription", undefined, auth)).json();
	assertEquals(back.places.map((p: { key: string }) => p.key), [keyOf(BROOKLYN)]);
	assertEquals((await call("DELETE", `/v1/places/${encodeURIComponent(keyOf(LA))}`, undefined, auth)).status, 404);
	assertEquals(queued(keyOf(LA)), [], "LA's queue is gone");
});

Deno.test("places: a cap per browser, keys must match their location, only with the token", opts, async () => {
	const { call } = await setup();
	const b = await fakeBrowser("https://fcm.googleapis.com/fcm/send/cap");
	const auth = { Authorization: `Bearer ${(await (await call("POST", "/v1/subscribe", { subscription: b.subscription, display: DISPLAY })).json()).token}` };
	const at = (lat: number) => ({ ...NYC, lat });
	for (const lat of [40.1, 40.2, 40.3])
		assertEquals((await call("PUT", `/v1/places/${keyOf(at(lat))}`, { location: at(lat), notifications: {} }, auth)).status, 200);
	assertEquals((await call("PUT", `/v1/places/${keyOf(at(40.4))}`, { location: at(40.4), notifications: {} }, auth)).status, 409, "4th place");
	assertEquals((await call("PUT", `/v1/places/${keyOf(at(40.1))}`, { location: at(40.1), notifications: { sunset: { enabled: true, minutes: 5 } } }, auth)).status, 200, "changing one is fine");
	assertEquals((await call("PUT", `/v1/places/${keyOf(LA)}`, { location: BROOKLYN, notifications: {} }, auth)).status, 400, "key of another location");
	assertEquals((await call("PUT", `/v1/places/not-a-key`, { location: BROOKLYN, notifications: {} }, auth)).status, 400, "bad key");
	assertEquals((await call("PUT", `/v1/places/${keyOf(BROOKLYN)}`, { location: BROOKLYN, notifications: {} })).status, 401, "no token");
});

Deno.test("an old database (one location per browser) becomes one place per browser", opts, async () => {
	const { DatabaseSync } = await import("node:sqlite");
	await Deno.mkdir(new URL("./tmp/", import.meta.url), { recursive: true });
	const path = new URL(`./tmp/v1-${crypto.randomUUID()}.db`, import.meta.url).pathname;
	const old = new DatabaseSync(path);
	old.exec(`CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL UNIQUE,
		p256dh TEXT NOT NULL, auth TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL NOT NULL, time_zone TEXT NOT NULL,
		location_name TEXT NOT NULL, settings TEXT NOT NULL, notifications TEXT NOT NULL, display TEXT NOT NULL, created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL, computed_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE queue (id INTEGER PRIMARY KEY, subscription_id INTEGER, notif_id TEXT);
		CREATE TABLE sent (subscription_id INTEGER, notif_id TEXT, sent_at INTEGER);`);
	old.prepare(`INSERT INTO subscriptions VALUES (7, 'hash', 'https://fcm.googleapis.com/fcm/send/old', 'p', 'a', 40.7128, -74.006, 10,
		'America/New_York', 'New York', '{}', '{"sunset":{"enabled":true,"minutes":15}}', '{"language":"en"}', 1, 2, 0, 0)`).run();
	old.close();

	const store = new Store(path);
	assertEquals(store.byToken("hash")?.id, 7);
	const places = store.places(7);
	assertEquals(places.map((p) => [p.place_key, p.location_name, p.notifications]),
		[["40.71280,-74.00600", "New York", '{"sunset":{"enabled":true,"minutes":15}}']]);
	new Store(path); // opening it again changes nothing
	assertEquals(new Store(path).places(7).length, 1);
});
