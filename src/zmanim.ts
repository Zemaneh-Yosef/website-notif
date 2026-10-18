// The site's own zmanim code (vendored at the pinned commit by scripts/update.sh), run for one subscriber:
// the same calculation, list, settings rules and notification wording as the calendar.

// deno-lint-ignore-file no-explicit-any
type Lang = "he" | "en" | "he-Latn";

export interface Display { language: Lang; hourCycle: "h11" | "h12" | "h23"; seconds: boolean; locale: string }
export interface NotificationPref { enabled: boolean; minutes: number }
export interface Location { lat: number; lon: number; elevation: number; timeZone: string; name: string }

export interface Planned {
	notif_id: string;
	zman_key: string;
	zman_at: number;
	fire_at: number;
	minutes: number;
	title: string;
	time_text: string;
	tag: string;
}

export interface RefractionData { provider: any; horizon: any; haze: any; forecastFetchedAt: number | null; notes: string[] }

export class ZmanimEngine {
	readonly commit!: string;
	readonly core!: any;
	readonly KosherZmanim!: any;
	readonly list!: Record<string, any>;
	readonly settingKeys!: readonly string[];
	readonly loadRefraction!: (lat: number, lon: number, options: Record<string, unknown>) => Promise<RefractionData>;
	/** calculators kept between recomputes (their visible sunrises are cached inside), newest last */
	#days = new Map<string, any>();

	private constructor(fields: Pick<ZmanimEngine, "commit" | "core" | "KosherZmanim" | "list" | "settingKeys" | "loadRefraction">) {
		Object.assign(this, fields);
	}

	static async load(siteDir: string): Promise<ZmanimEngine> {
		const root = new URL(`file://${await Deno.realPath(siteDir)}/`);
		// the site's Temporal polyfill, so dates behave exactly as on the site
		await import(new URL("assets/libraries/temporal-polyfill/global.min.js", root).href);
		const KosherZmanim = await import(new URL("assets/libraries/kosherZmanim/kosher-zmanim.js", root).href);
		const core = await import(new URL("assets/js/core/zmanimCore.js", root).href);
		const refraction = await import(new URL("assets/js/refraction-data.js", root).href);
		const data = JSON.parse(await Deno.readTextFile(new URL("zmanim.json", root)));
		const commit = (await Deno.readTextFile(new URL("COMMIT", root))).trim();
		return new ZmanimEngine({
			commit, core, KosherZmanim,
			list: core.zmanimListFromData(data),
			settingKeys: core.ZMANIM_SETTING_KEYS,
			loadRefraction: refraction.loadRefraction,
		});
	}

	/** Whether the refraction for these settings includes humidity (part of what is loaded) */
	wantsHumidity(settings: Record<string, string>): boolean {
		return this.core.zemanimSettings(this.core.settingSourceFrom(settings)).refraction.humidity();
	}

	#day(location: Location, settings: Record<string, string>, display: Display, refraction: RefractionData | null, refractionId: string) {
		const id = JSON.stringify([location.lat, location.lon, location.elevation, location.timeZone, settings, display, refractionId]);
		let day = this.#days.get(id);
		if (day) {
			this.#days.delete(id);
		} else {
			const geoLocation = new this.KosherZmanim.GeoLocation(location.name, location.lat, location.lon, location.elevation, location.timeZone);
			day = new this.core.ZmanimDay({
				geoLocation,
				settings: this.core.zemanimSettings(this.core.settingSourceFrom(settings)),
				zmanimList: this.list,
				dtF: this.core.timeFormat(display),
				refraction: refraction
					? { atmosphereProvider: refraction.provider, horizon: refraction.horizon, haze: refraction.haze ?? null }
					: undefined,
			});
		}
		this.#days.set(id, day);
		while (this.#days.size > 500) this.#days.delete(this.#days.keys().next().value!);
		return day;
	}

	/**
	 * The notifications to send in the window [now - grace, now + horizon]: one per enabled zeman, at its time
	 * as shown minus the chosen minutes (or right away if that has passed but the zeman hasn't)
	 */
	plan(input: {
		location: Location;
		settings: Record<string, string>;
		notifications: Record<string, NotificationPref>;
		display: Display;
		refraction: RefractionData | null;
		refractionId: string;
		/** the site's placeKey(): part of the tag, so the same zeman at two places doesn't replace one another */
		placeKey: string;
		now: number;
		horizonMs: number;
		graceMs: number;
	}): Planned[] {
		const enabled = Object.entries(input.notifications).filter(([key, pref]) => pref.enabled && key in this.list);
		if (!enabled.length) return [];

		const day = this.#day(input.location, input.settings, input.display, input.refraction, input.refractionId);
		const today = Temporal.Instant.fromEpochMilliseconds(input.now).toZonedDateTimeISO(input.location.timeZone).toPlainDate();
		const until = input.now + input.horizonMs;
		const planned: Planned[] = [];

		// yesterday too: a zeman just after midnight can belong to the previous day's list (Ḥatzot Layla)
		for (let offset = -1; offset <= Math.ceil(input.horizonMs / 86_400_000) + 1; offset++) {
			for (const zman of day.shownOn(today.add({ days: offset }), input.display.language)) {
				const pref = input.notifications[zman.key];
				if (!pref?.enabled) continue;
				const zmanAt = zman.time.epochMilliseconds;
				const fireAt = zmanAt - pref.minutes * 60_000;
				if (zmanAt + input.graceMs <= input.now || fireAt > until) continue;
				planned.push({
					notif_id: `${zman.key}@${zman.time.toInstant().toString()}@${pref.minutes}`,
					zman_key: zman.key,
					zman_at: zmanAt,
					fire_at: Math.max(fireAt, input.now),
					minutes: pref.minutes,
					title: this.core.plainText(zman.title),
					time_text: zman.timeText,
					tag: this.core.notificationTag(zman.key, zman.time, input.placeKey),
				});
			}
		}
		return planned;
	}

	/** The notification's text when it goes out (the minutes left, if it is sent late) */
	text(item: { zman_at: number; minutes: number; title: string; time_text: string }, language: Lang, locationName: string, now: number) {
		const minutesLeft = Math.max(0, Math.min(item.minutes, Math.ceil((item.zman_at - now) / 60_000)));
		return this.core.notificationText({ title: item.title, timeText: item.time_text }, minutesLeft, language, locationName || null);
	}
}
