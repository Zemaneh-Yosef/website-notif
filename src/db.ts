// SQLite through Deno's built-in node:sqlite (no FFI, no packages): needs read/write on the database only.
//
// A subscription is one browser (its push endpoint, keys, token and display options); it has places, each with
// its own location, zemanim settings and per-zeman choices. The queue and the sent log are per place.

import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

export interface SubscriptionRow {
	id: number;
	token_hash: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	/** JSON: { language, hourCycle, seconds, locale } */
	display: string;
	created_at: number;
	updated_at: number;
	failures: number;
}

export interface PlaceRow {
	id: number;
	subscription_id: number;
	/** the site's placeKey(lat, lon): coordinates to 5 decimals */
	place_key: string;
	lat: number;
	lon: number;
	elevation: number;
	time_zone: string;
	location_name: string;
	/** JSON: the zemanim settings (ZMANIM_SETTING_KEYS → string) */
	settings: string;
	/** JSON: zeman key → { enabled, minutes } */
	notifications: string;
	created_at: number;
	updated_at: number;
	computed_at: number;
}

export interface QueuedRow {
	id: number;
	subscription_id: number;
	place_id: number;
	/** zeman key @ zeman instant @ minutes: what makes a notification the same one (within a place) */
	notif_id: string;
	zman_key: string;
	zman_at: number;
	fire_at: number;
	minutes: number;
	title: string;
	time_text: string;
	tag: string;
	attempts: number;
	next_try_at: number;
}

export type PlaceFields = Pick<PlaceRow, "lat" | "lon" | "elevation" | "time_zone" | "location_name" | "settings" | "notifications">;

export class Store {
	db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.#migrate();
	}

	#migrate() {
		const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		if (version >= SCHEMA_VERSION) return;
		const hasV1 = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").get()
			&& (this.db.prepare("PRAGMA table_info(subscriptions)").all() as { name: string }[]).some((c) => c.name === "lat");

		this.db.exec("PRAGMA foreign_keys = OFF; BEGIN");
		try {
			if (hasV1) this.db.exec("ALTER TABLE subscriptions RENAME TO subscriptions_v1; DROP TABLE IF EXISTS queue; DROP TABLE IF EXISTS sent;");
			this.db.exec(`
				CREATE TABLE subscriptions (
					id INTEGER PRIMARY KEY,
					token_hash TEXT NOT NULL UNIQUE,
					endpoint TEXT NOT NULL UNIQUE,
					p256dh TEXT NOT NULL,
					auth TEXT NOT NULL,
					display TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					failures INTEGER NOT NULL DEFAULT 0
				);
				CREATE TABLE places (
					id INTEGER PRIMARY KEY,
					subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
					place_key TEXT NOT NULL,
					lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL NOT NULL,
					time_zone TEXT NOT NULL,
					location_name TEXT NOT NULL,
					settings TEXT NOT NULL,
					notifications TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					computed_at INTEGER NOT NULL DEFAULT 0,
					UNIQUE (subscription_id, place_key)
				);
				CREATE INDEX places_stale ON places (computed_at);
				CREATE INDEX places_at ON places (lat, lon);
				CREATE TABLE queue (
					id INTEGER PRIMARY KEY,
					subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
					place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
					notif_id TEXT NOT NULL,
					zman_key TEXT NOT NULL,
					zman_at INTEGER NOT NULL,
					fire_at INTEGER NOT NULL,
					minutes INTEGER NOT NULL,
					title TEXT NOT NULL,
					time_text TEXT NOT NULL,
					tag TEXT NOT NULL,
					attempts INTEGER NOT NULL DEFAULT 0,
					next_try_at INTEGER NOT NULL,
					UNIQUE (place_id, notif_id)
				);
				CREATE INDEX queue_due ON queue (next_try_at);
				CREATE TABLE sent (
					place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
					notif_id TEXT NOT NULL,
					sent_at INTEGER NOT NULL,
					PRIMARY KEY (place_id, notif_id)
				);
				CREATE INDEX sent_at ON sent (sent_at);
			`);
			if (hasV1) {
				// one browser with one location → that browser with that one place
				this.db.exec(`INSERT INTO subscriptions (id, token_hash, endpoint, p256dh, auth, display, created_at, updated_at, failures)
					SELECT id, token_hash, endpoint, p256dh, auth, display, created_at, updated_at, failures FROM subscriptions_v1`);
				const insert = this.db.prepare(`INSERT INTO places (subscription_id, place_key, lat, lon, elevation, time_zone, location_name,
					settings, notifications, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
				for (const r of this.db.prepare("SELECT * FROM subscriptions_v1").all() as Record<string, any>[]) // deno-lint-ignore no-explicit-any
					insert.run(r.id, placeKey(r.lat, r.lon), r.lat, r.lon, r.elevation, r.time_zone, r.location_name, r.settings, r.notifications,
						r.created_at, r.updated_at);
				this.db.exec("DROP TABLE subscriptions_v1");
			}
			this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT; PRAGMA foreign_keys = ON;`);
		} catch (e) {
			this.db.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
			throw e;
		}
	}

	// ─── Subscriptions (browsers) ───

	count(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM subscriptions").get() as { n: number }).n);
	}

	countPlaces(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM places").get() as { n: number }).n);
	}

	byToken(tokenHash: string): SubscriptionRow | undefined {
		return this.db.prepare("SELECT * FROM subscriptions WHERE token_hash = ?").get(tokenHash) as SubscriptionRow | undefined;
	}

	byId(id: number): SubscriptionRow | undefined {
		return this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
	}

	/** Insert, or take over the one with the same endpoint (the browser lost its token): its places are kept */
	upsert(row: Pick<SubscriptionRow, "token_hash" | "endpoint" | "p256dh" | "auth" | "display" | "created_at" | "updated_at">): number {
		const existing = this.endpointOwner(row.endpoint);
		if (existing !== null) {
			this.db.prepare("UPDATE subscriptions SET token_hash = ?, p256dh = ?, auth = ?, display = ?, updated_at = ?, failures = 0 WHERE id = ?")
				.run(row.token_hash, row.p256dh, row.auth, row.display, row.updated_at, existing);
			return existing;
		}
		const result = this.db.prepare(`INSERT INTO subscriptions (token_hash, endpoint, p256dh, auth, display, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.token_hash, row.endpoint, row.p256dh, row.auth, row.display, row.created_at, row.updated_at);
		return Number(result.lastInsertRowid);
	}

	update(id: number, fields: Partial<Omit<SubscriptionRow, "id">>) {
		const keys = Object.keys(fields);
		if (!keys.length) return;
		this.db.prepare(`UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
			// deno-lint-ignore no-explicit-any
			.run(...keys.map((k) => (fields as any)[k]), id);
	}

	delete(id: number) {
		this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
	}

	endpointOwner(endpoint: string): number | null {
		const row = this.db.prepare("SELECT id FROM subscriptions WHERE endpoint = ?").get(endpoint) as { id: number } | undefined;
		return row ? Number(row.id) : null;
	}

	// ─── Places ───

	places(subscriptionId: number): PlaceRow[] {
		return this.db.prepare("SELECT * FROM places WHERE subscription_id = ? ORDER BY created_at, id").all(subscriptionId) as unknown as PlaceRow[];
	}

	place(subscriptionId: number, key: string): PlaceRow | undefined {
		return this.db.prepare("SELECT * FROM places WHERE subscription_id = ? AND place_key = ?").get(subscriptionId, key) as PlaceRow | undefined;
	}

	placeById(id: number): PlaceRow | undefined {
		return this.db.prepare("SELECT * FROM places WHERE id = ?").get(id) as PlaceRow | undefined;
	}

	/** Add or change a place; it is planned again on the next tick (or right away by the caller) */
	upsertPlace(subscriptionId: number, key: string, fields: PlaceFields, now: number): number {
		const existing = this.place(subscriptionId, key);
		if (existing) {
			this.db.prepare(`UPDATE places SET lat = ?, lon = ?, elevation = ?, time_zone = ?, location_name = ?, settings = ?,
				notifications = ?, updated_at = ?, computed_at = 0 WHERE id = ?`).run(fields.lat, fields.lon, fields.elevation, fields.time_zone,
				fields.location_name, fields.settings, fields.notifications, now, existing.id);
			return Number(existing.id);
		}
		const result = this.db.prepare(`INSERT INTO places (subscription_id, place_key, lat, lon, elevation, time_zone, location_name,
			settings, notifications, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(subscriptionId, key, fields.lat,
			fields.lon, fields.elevation, fields.time_zone, fields.location_name, fields.settings, fields.notifications, now, now);
		return Number(result.lastInsertRowid);
	}

	deletePlace(subscriptionId: number, key: string): boolean {
		return Number(this.db.prepare("DELETE FROM places WHERE subscription_id = ? AND place_key = ?").run(subscriptionId, key).changes) > 0;
	}

	/** Places whose plan is older than `before` (oldest first) */
	stalePlaces(before: number, limit: number): PlaceRow[] {
		return this.db.prepare("SELECT * FROM places WHERE computed_at < ? ORDER BY computed_at LIMIT ?").all(before, limit) as unknown as PlaceRow[];
	}

	/** New refraction data for a location: plan its places again */
	replanAt(lat: number, lon: number) {
		this.db.prepare("UPDATE places SET computed_at = 0 WHERE lat = ? AND lon = ?").run(lat, lon);
	}

	distinctPlaces(): { lat: number; lon: number; settings: string }[] {
		return this.db.prepare("SELECT DISTINCT lat, lon, settings FROM places").all() as { lat: number; lon: number; settings: string }[];
	}

	// ─── Queue ───

	/** Replace what is still to be sent for a place; already sent notifications are kept out */
	replaceQueue(place: PlaceRow, items: Omit<QueuedRow, "id" | "subscription_id" | "place_id" | "attempts" | "next_try_at">[], computedAt: number) {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM queue WHERE place_id = ?").run(place.id);
			const insert = this.db.prepare(`INSERT OR IGNORE INTO queue (subscription_id, place_id, notif_id, zman_key, zman_at, fire_at, minutes,
				title, time_text, tag, next_try_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE NOT EXISTS (SELECT 1 FROM sent WHERE place_id = ? AND notif_id = ?)`);
			for (const it of items)
				insert.run(place.subscription_id, place.id, it.notif_id, it.zman_key, it.zman_at, it.fire_at, it.minutes, it.title, it.time_text,
					it.tag, it.fire_at, place.id, it.notif_id);
			this.db.prepare("UPDATE places SET computed_at = ? WHERE id = ?").run(computedAt, place.id);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	due(now: number, limit: number): QueuedRow[] {
		return this.db.prepare("SELECT * FROM queue WHERE next_try_at <= ? ORDER BY next_try_at LIMIT ?").all(now, limit) as unknown as QueuedRow[];
	}

	sentToday(placeId: number, since: number): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM sent WHERE place_id = ? AND sent_at >= ?").get(placeId, since) as { n: number }).n);
	}

	markSent(item: QueuedRow, now: number) {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("INSERT OR IGNORE INTO sent (place_id, notif_id, sent_at) VALUES (?, ?, ?)").run(item.place_id, item.notif_id, now);
			this.db.prepare("DELETE FROM queue WHERE id = ?").run(item.id);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	retryLater(item: QueuedRow, at: number) {
		this.db.prepare("UPDATE queue SET attempts = attempts + 1, next_try_at = ? WHERE id = ?").run(at, item.id);
	}

	drop(item: QueuedRow) {
		this.db.prepare("DELETE FROM queue WHERE id = ?").run(item.id);
	}

	prune(now: number, inactiveBefore: number | null) {
		this.db.prepare("DELETE FROM sent WHERE sent_at < ?").run(now - 3 * 24 * 60 * 60 * 1000);
		if (inactiveBefore === null) return 0;
		const removed = this.db.prepare("DELETE FROM subscriptions WHERE updated_at < ?").run(inactiveBefore);
		return Number(removed.changes);
	}
}

/** The site's placeKey (core/notificationText.js), for migrating rows written before places existed */
function placeKey(lat: number, lon: number) {
	return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}
