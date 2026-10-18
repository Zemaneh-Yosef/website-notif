// Plans each subscriber's notifications and sends them when due.
//
// Planning runs the site's calculation for the next two days and stores what to send; it is redone when the
// subscriber changes anything, when their place's forecast is refreshed, and every few hours (which also
// rolls the window past midnight). Sending checks the queue every 30 seconds.

import type { Config } from "./config.ts";
import type { QueuedRow, Store, SubscriptionRow } from "./db.ts";
import type { RefractionCache } from "./refraction.ts";
import { b64urlEncode, sendPush, type Vapid } from "./webpush.ts";
import type { Display, Location, NotificationPref, ZmanimEngine } from "./zmanim.ts";

const TICK_MS = 30_000;
/** plan this far ahead */
const HORIZON_MS = 48 * 60 * 60 * 1000;
/** plan again after this, at the latest */
const REPLAN_MS = 6 * 60 * 60 * 1000;
/** a notification that can't go out until this long after its zeman is dropped (a late reminder is useless) */
export const GRACE_MS = 2 * 60 * 1000;
const PLANS_PER_TICK = 200;
const SENDS_PER_TICK = 500;
const SEND_CONCURRENCY = 8;

export function parsed(row: SubscriptionRow) {
	return {
		location: { lat: row.lat, lon: row.lon, elevation: row.elevation, timeZone: row.time_zone, name: row.location_name } as Location,
		settings: JSON.parse(row.settings) as Record<string, string>,
		notifications: JSON.parse(row.notifications) as Record<string, NotificationPref>,
		display: JSON.parse(row.display) as Display,
	};
}

export class Scheduler {
	#timer: ReturnType<typeof setInterval> | null = null;
	#busy = false;

	constructor(
		private store: Store,
		private engine: ZmanimEngine,
		private refraction: RefractionCache,
		private vapid: Vapid,
		private config: Config,
		private log: (msg: string) => void = console.log,
		private fetchImpl: typeof fetch = fetch,
	) {}

	start() {
		this.#timer = setInterval(() => this.tick().catch((e) => this.log(`tick failed: ${e?.stack ?? e}`)), TICK_MS);
		queueMicrotask(() => this.tick().catch((e) => this.log(`tick failed: ${e?.stack ?? e}`)));
	}

	stop() {
		if (this.#timer !== null) clearInterval(this.#timer);
	}

	/** Plan one subscriber now; returns how many notifications are queued */
	plan(row: SubscriptionRow, now = Date.now()): number {
		const sub = parsed(row);
		const humidity = this.engine.wantsHumidity(sub.settings);
		const { data, id } = this.refraction.get(sub.location.lat, sub.location.lon, humidity, now);
		const planned = this.engine.plan({ ...sub, refraction: data, refractionId: id, now, horizonMs: HORIZON_MS, graceMs: GRACE_MS });
		this.store.replaceQueue(row.id, planned, now);
		return planned.length;
	}

	async tick(now = Date.now()) {
		if (this.#busy) return;
		this.#busy = true;
		try {
			for (const row of this.store.stale(now - REPLAN_MS, PLANS_PER_TICK)) {
				try {
					this.plan(row, now);
				} catch (e) {
					// keep it from blocking the others; it is tried again after REPLAN_MS
					this.store.update(row.id, { computed_at: now });
					this.log(`planning subscription ${row.id} failed: ${(e as Error)?.stack ?? e}`);
				}
				await new Promise((r) => setTimeout(r, 0)); // let requests in between
			}
			await this.sendDue(Date.now());
		} finally {
			this.#busy = false;
		}
	}

	async sendDue(now: number) {
		const due = this.store.due(now, SENDS_PER_TICK);
		for (let i = 0; i < due.length; i += SEND_CONCURRENCY)
			await Promise.all(due.slice(i, i + SEND_CONCURRENCY).map((item) => this.#send(item, now)));
	}

	async #send(item: QueuedRow, now: number) {
		if (item.zman_at + GRACE_MS <= now) return this.store.drop(item);
		const row = this.store.byId(item.subscription_id);
		if (!row) return;
		if (this.store.sentToday(row.id, now - 24 * 60 * 60 * 1000) >= this.config.limits.maxNotificationsPerDay) {
			this.log(`subscription ${row.id}: daily limit reached, dropped ${item.notif_id}`);
			return this.store.drop(item);
		}

		const sub = parsed(row);
		const { title, body } = this.engine.text(item, sub.display.language, sub.location.name, now);
		const topic = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.tag)))).slice(0, 32);

		let result;
		try {
			result = await sendPush(this.vapid, {
				endpoint: row.endpoint,
				keys: { p256dh: row.p256dh, auth: row.auth },
				payload: { v: 1, title, body, tag: item.tag, timestamp: item.zman_at, url: this.#calendarUrl(sub.location) },
				ttl: Math.ceil((item.zman_at + GRACE_MS - now) / 1000),
				urgency: "high",
				topic,
			}, this.fetchImpl);
		} catch (e) {
			return this.#retry(item, now, null, `network: ${(e as Error).message}`);
		}

		if (result.ok) {
			this.store.markSent(item, now);
			if (row.failures) this.store.update(row.id, { failures: 0 });
			return;
		}
		if (result.gone) {
			this.log(`subscription ${row.id}: push service says it is gone (${result.status}); removed`);
			return this.store.delete(row.id);
		}
		if (result.status === 429 || result.status >= 500)
			return this.#retry(item, now, result.retryAfterMs, `${result.status} ${result.detail}`);

		// 400 / 403 / 413…: this message won't go through as it is
		this.store.drop(item);
		this.store.update(row.id, { failures: row.failures + 1 });
		this.log(`subscription ${row.id}: push refused (${result.status} ${result.detail})`);
		if (row.failures + 1 >= 20) {
			this.log(`subscription ${row.id}: refused 20 times in a row; removed`);
			this.store.delete(row.id);
		}
	}

	#retry(item: QueuedRow, now: number, retryAfterMs: number | null, why: string) {
		const at = now + Math.min(Math.max(retryAfterMs ?? 30_000 * 2 ** item.attempts, 30_000), 5 * 60_000);
		if (at >= item.zman_at + GRACE_MS) {
			this.log(`gave up on ${item.notif_id} (${why})`);
			return this.store.drop(item);
		}
		this.store.retryLater(item, at);
	}

	#calendarUrl(loc: Location) {
		const url = new URL("/calendar", this.config.siteOrigin);
		url.search = new URLSearchParams({
			lat: String(loc.lat), long: String(loc.lon), elevation: String(loc.elevation),
			locationName: loc.name, timeZone: loc.timeZone,
		}).toString();
		return url.href;
	}
}
