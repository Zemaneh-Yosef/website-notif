// The site's refraction data (forecast, horizon, haze) per place, loaded through the site's own
// refraction-data.js from the local refraction server, and kept in memory. One load per place serves every
// subscriber there, so the weather services see a request per place every few hours, not one per person.

import type { RefractionData, ZmanimEngine } from "./zmanim.ts";

/** Load again after this (the site's FORECAST_TTL_MS is 3 h; haze forecasts update twice a day) */
const REFRESH_MS = 3 * 60 * 60 * 1000;
/** After a failure, wait this long before trying the place again */
const RETRY_MS = 30 * 60 * 1000;
/** Loads at once, to be gentle with the weather services */
const CONCURRENCY = 2;

interface Entry {
	data: RefractionData | null;
	loadedAt: number;
	failedAt: number;
	loading: Promise<void> | null;
	/** bumped whenever `data` changes: part of the calculator cache key */
	version: number;
}

export class RefractionCache {
	#entries = new Map<string, Entry>();
	#running = 0;
	#waiting: (() => void)[] = [];

	constructor(
		private engine: ZmanimEngine,
		private serverUrl: string,
		/** called when a place's data changed, so its subscribers are planned again */
		private onUpdate: (lat: number, lon: number) => void,
		private log: (msg: string) => void = console.log,
	) {}

	static key(lat: number, lon: number, humidity: boolean) {
		return `${lat},${lon},${humidity ? "h" : "-"}`;
	}

	/**
	 * What is known for a place now (null before its first load), with an id for the calculator cache;
	 * starts a load in the background when there is none yet or it is old
	 */
	get(lat: number, lon: number, humidity: boolean, now = Date.now()): { data: RefractionData | null; id: string } {
		const key = RefractionCache.key(lat, lon, humidity);
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { data: null, loadedAt: 0, failedAt: 0, loading: null, version: 0 };
			this.#entries.set(key, entry);
		}
		const due = now - entry.loadedAt >= REFRESH_MS && now - entry.failedAt >= RETRY_MS;
		if (due && !entry.loading)
			entry.loading = this.#load(lat, lon, humidity, entry).finally(() => { entry!.loading = null; });
		return { data: entry.data, id: `${key}#${entry.version}` };
	}

	/** Wait for a place's load in progress (tests, and the first plan of a new subscriber) */
	async settled(lat: number, lon: number, humidity: boolean) {
		await this.#entries.get(RefractionCache.key(lat, lon, humidity))?.loading;
	}

	async #load(lat: number, lon: number, humidity: boolean, entry: Entry) {
		if (this.#running >= CONCURRENCY) await new Promise<void>((resolve) => this.#waiting.push(resolve));
		this.#running++;
		try {
			const data = await this.engine.loadRefraction(lat, lon, { serverUrl: this.serverUrl, humidity, force: true });
			const changed = !entry.data || data.forecastFetchedAt !== entry.data.forecastFetchedAt
				|| !!data.horizon !== !!entry.data.horizon || !!data.haze !== !!entry.data.haze;
			entry.data = data;
			entry.loadedAt = Date.now();
			if (changed) {
				entry.version++;
				this.onUpdate(lat, lon);
			}
			if (data.notes?.length) this.log(`refraction ${lat},${lon}: ${data.notes.join("; ")}`);
		} catch (e) {
			entry.failedAt = Date.now();
			this.log(`refraction ${lat},${lon} failed: ${(e as Error).message}`);
		} finally {
			this.#running--;
			this.#waiting.shift()?.();
		}
	}

	/** Forget places nobody is subscribed at any more */
	retain(keys: Set<string>) {
		for (const key of this.#entries.keys())
			if (!keys.has(key)) this.#entries.delete(key);
	}
}
