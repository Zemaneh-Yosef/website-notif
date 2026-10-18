// Zemaneh Yosef notification server: sends the calendar's zeman notifications by Web Push, so they arrive
// when the site is closed. Usage: deno run <permissions, see deploy/royzmanim-notif.service> src/main.ts <config.json>

import { createHandler } from "./api.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { DriftCheck } from "./drift.ts";
import { RefractionCache } from "./refraction.ts";
import { Scheduler } from "./scheduler.ts";
import { Vapid } from "./webpush.ts";
import { ZmanimEngine } from "./zmanim.ts";

const configPath = Deno.args[0];
if (!configPath) {
	console.error("usage: main.ts <config.json>");
	Deno.exit(2);
}

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const config = await loadConfig(configPath);

const vapid = await Vapid.fromPem(await Deno.readTextFile(config.vapid.privateKeyFile), config.vapid.publicKey, config.vapid.subject);
const engine = await ZmanimEngine.load(config.siteDir);
const store = new Store(config.database);

const refraction = new RefractionCache(engine, config.refractionServer, (lat, lon) => {
	// new forecast for a place: plan everyone there again on the next tick
	for (const id of store.atLocation(lat, lon)) store.update(id, { computed_at: 0 });
}, log);

const scheduler = new Scheduler(store, engine, refraction, vapid, config, log);
const drift = new DriftCheck(engine.commit, config.userAgent, log);

// daily: drop the sent log past 3 days (and, if configured, long-inactive subscriptions)
setInterval(() => {
	const now = Date.now();
	const removed = store.prune(now, config.limits.inactiveDays === null ? null : now - config.limits.inactiveDays * 86_400_000);
	if (removed) log(`removed ${removed} inactive subscription(s)`);
	// and forget the refraction data of places nobody is subscribed at any more
	const places = store.db.prepare("SELECT DISTINCT lat, lon, settings FROM subscriptions").all() as { lat: number; lon: number; settings: string }[];
	refraction.retain(new Set(places.map((p) => RefractionCache.key(p.lat, p.lon, engine.wantsHumidity(JSON.parse(p.settings))))));
}, 24 * 60 * 60 * 1000);

scheduler.start();
drift.start();

Deno.serve({
	hostname: config.listen.hostname,
	port: config.listen.port,
	onListen: ({ hostname, port }) =>
		log(`listening on ${hostname}:${port}; zmanim code at ${engine.commit.slice(0, 7)}; ${store.count()} subscription(s)`),
}, createHandler({ config, store, engine, scheduler, drift, publicKey: vapid.publicKey, log }));
