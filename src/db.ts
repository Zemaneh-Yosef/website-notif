// SQLite through Deno's built-in node:sqlite (no FFI, no packages): needs read/write on the database only.

import { DatabaseSync } from "node:sqlite";

export interface SubscriptionRow {
	id: number;
	token_hash: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	lat: number;
	lon: number;
	elevation: number;
	time_zone: string;
	location_name: string;
	/** JSON: the zemanim settings (ZMANIM_SETTING_KEYS → string) */
	settings: string;
	/** JSON: zeman key → { enabled, minutes } */
	notifications: string;
	/** JSON: { language, hourCycle, seconds, locale } */
	display: string;
	created_at: number;
	updated_at: number;
	computed_at: number;
	failures: number;
}

export interface QueuedRow {
	id: number;
	subscription_id: number;
	/** zeman key @ zeman instant @ minutes: what makes a notification the same one */
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

export class Store {
	db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS subscriptions (
				id INTEGER PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				endpoint TEXT NOT NULL UNIQUE,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL NOT NULL,
				time_zone TEXT NOT NULL,
				location_name TEXT NOT NULL,
				settings TEXT NOT NULL,
				notifications TEXT NOT NULL,
				display TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				computed_at INTEGER NOT NULL DEFAULT 0,
				failures INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS queue (
				id INTEGER PRIMARY KEY,
				subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
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
				UNIQUE (subscription_id, notif_id)
			);
			CREATE INDEX IF NOT EXISTS queue_due ON queue (next_try_at);
			CREATE TABLE IF NOT EXISTS sent (
				subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
				notif_id TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				PRIMARY KEY (subscription_id, notif_id)
			);
			CREATE INDEX IF NOT EXISTS sent_at ON sent (sent_at);
		`);
	}

	count(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM subscriptions").get() as { n: number }).n);
	}

	byToken(tokenHash: string): SubscriptionRow | undefined {
		return this.db.prepare("SELECT * FROM subscriptions WHERE token_hash = ?").get(tokenHash) as SubscriptionRow | undefined;
	}

	byId(id: number): SubscriptionRow | undefined {
		return this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
	}

	/** Insert, or replace the one with the same endpoint (the browser lost its token) */
	upsert(row: Omit<SubscriptionRow, "id" | "computed_at" | "failures">): number {
		const existing = this.db.prepare("SELECT id FROM subscriptions WHERE endpoint = ?").get(row.endpoint) as { id: number } | undefined;
		if (existing) {
			this.db.prepare(`UPDATE subscriptions SET token_hash = ?, p256dh = ?, auth = ?, lat = ?, lon = ?, elevation = ?,
				time_zone = ?, location_name = ?, settings = ?, notifications = ?, display = ?, updated_at = ?, failures = 0
				WHERE id = ?`).run(row.token_hash, row.p256dh, row.auth, row.lat, row.lon, row.elevation, row.time_zone,
				row.location_name, row.settings, row.notifications, row.display, row.updated_at, existing.id);
			return Number(existing.id);
		}
		const result = this.db.prepare(`INSERT INTO subscriptions (token_hash, endpoint, p256dh, auth, lat, lon, elevation,
			time_zone, location_name, settings, notifications, display, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(row.token_hash, row.endpoint, row.p256dh, row.auth, row.lat, row.lon, row.elevation, row.time_zone,
				row.location_name, row.settings, row.notifications, row.display, row.created_at, row.updated_at);
		return Number(result.lastInsertRowid);
	}

	update(id: number, fields: Partial<SubscriptionRow>) {
		const keys = Object.keys(fields).filter((k) => k !== "id");
		if (!keys.length) return;
		this.db.prepare(`UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
			// deno-lint-ignore no-explicit-any
			.run(...keys.map((k) => (fields as any)[k]), id);
	}

	delete(id: number) {
		this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
	}

	/** Endpoint already used by another subscription (an update moving to it) */
	endpointOwner(endpoint: string): number | null {
		const row = this.db.prepare("SELECT id FROM subscriptions WHERE endpoint = ?").get(endpoint) as { id: number } | undefined;
		return row ? Number(row.id) : null;
	}

	/** Subscriptions whose schedule is older than `before` (oldest first) */
	stale(before: number, limit: number): SubscriptionRow[] {
		return this.db.prepare("SELECT * FROM subscriptions WHERE computed_at < ? ORDER BY computed_at LIMIT ?").all(before, limit) as unknown as SubscriptionRow[];
	}

	atLocation(lat: number, lon: number): number[] {
		return (this.db.prepare("SELECT id FROM subscriptions WHERE lat = ? AND lon = ?").all(lat, lon) as { id: number }[]).map((r) => Number(r.id));
	}

	/** Replace what is still to be sent for a subscription; already sent notifications are kept out */
	replaceQueue(subscriptionId: number, items: Omit<QueuedRow, "id" | "subscription_id" | "attempts" | "next_try_at">[], computedAt: number) {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM queue WHERE subscription_id = ?").run(subscriptionId);
			const insert = this.db.prepare(`INSERT OR IGNORE INTO queue (subscription_id, notif_id, zman_key, zman_at, fire_at, minutes,
				title, time_text, tag, next_try_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE NOT EXISTS (SELECT 1 FROM sent WHERE subscription_id = ? AND notif_id = ?)`);
			for (const it of items)
				insert.run(subscriptionId, it.notif_id, it.zman_key, it.zman_at, it.fire_at, it.minutes, it.title, it.time_text, it.tag,
					it.fire_at, subscriptionId, it.notif_id);
			this.db.prepare("UPDATE subscriptions SET computed_at = ? WHERE id = ?").run(computedAt, subscriptionId);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	due(now: number, limit: number): QueuedRow[] {
		return this.db.prepare("SELECT * FROM queue WHERE next_try_at <= ? ORDER BY next_try_at LIMIT ?").all(now, limit) as unknown as QueuedRow[];
	}

	sentToday(subscriptionId: number, since: number): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM sent WHERE subscription_id = ? AND sent_at >= ?").get(subscriptionId, since) as { n: number }).n);
	}

	markSent(item: QueuedRow, now: number) {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("INSERT OR IGNORE INTO sent (subscription_id, notif_id, sent_at) VALUES (?, ?, ?)").run(item.subscription_id, item.notif_id, now);
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
