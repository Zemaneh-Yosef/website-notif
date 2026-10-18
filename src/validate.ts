// Everything a client sends is checked here, against fixed lists and ranges. The server never takes text
// from a client into a notification other than the place's name (shortened, control characters removed),
// and never sends a request anywhere but a known push service.

import { b64urlDecode } from "./webpush.ts";
import type { Display, Location, NotificationPref } from "./zmanim.ts";

export class Invalid extends Error {}

/** The push services browsers use. A subscription for any other host is refused (no requests to arbitrary URLs). */
const PUSH_HOSTS: (string | RegExp)[] = [
	"fcm.googleapis.com", // Chrome, Edge on Android, Samsung Internet, Opera, Brave
	"updates.push.services.mozilla.com", // Firefox
	"web.push.apple.com", // Safari (macOS, and iOS / iPadOS from the Home Screen)
	/^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
];

export const PUSH_HOST_PERMISSIONS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PushSubscriptionInput { endpoint: string; p256dh: string; auth: string }

export function subscription(value: unknown): PushSubscriptionInput {
	if (!isObject(value) || typeof value.endpoint !== "string" || !isObject(value.keys))
		throw new Invalid("subscription: expected { endpoint, keys: { p256dh, auth } }");
	if (value.endpoint.length > 2048) throw new Invalid("subscription: endpoint too long");
	let url: URL;
	try { url = new URL(value.endpoint); } catch { throw new Invalid("subscription: endpoint is not a URL"); }
	if (url.protocol !== "https:" || url.port || url.username || url.password)
		throw new Invalid("subscription: endpoint must be a plain https URL");
	if (!PUSH_HOSTS.some((h) => typeof h === "string" ? h === url.hostname : h.test(url.hostname)))
		throw new Invalid("subscription: not a known push service");

	const { p256dh, auth } = value.keys;
	if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 100 || auth.length > 40)
		throw new Invalid("subscription: bad keys");
	let pub: Uint8Array, secret: Uint8Array;
	try { pub = b64urlDecode(p256dh); secret = b64urlDecode(auth); } catch { throw new Invalid("subscription: keys are not base64url"); }
	if (pub.length !== 65 || pub[0] !== 4) throw new Invalid("subscription: p256dh is not a P-256 public key");
	if (secret.length !== 16) throw new Invalid("subscription: auth must be 16 bytes");
	return { endpoint: url.href, p256dh, auth };
}

const TIME_ZONES = new Set(Intl.supportedValuesOf("timeZone"));

export function location(value: unknown): Location {
	if (!isObject(value)) throw new Invalid("location: expected an object");
	const { lat, lon, elevation, timeZone, name } = value;
	if (typeof lat !== "number" || !(lat >= -90 && lat <= 90)) throw new Invalid("location: bad latitude");
	if (typeof lon !== "number" || !(lon >= -180 && lon <= 180)) throw new Invalid("location: bad longitude");
	const elev = elevation === undefined || elevation === null ? 0 : elevation;
	if (typeof elev !== "number" || !(elev >= -500 && elev <= 9000)) throw new Invalid("location: bad elevation");
	if (typeof timeZone !== "string" || !(TIME_ZONES.has(timeZone) || timeZone === "UTC")) throw new Invalid("location: unknown time zone");
	const cleanName = typeof name === "string"
		// deno-lint-ignore no-control-regex
		? name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 100)
		: "";
	return { lat, lon, elevation: elev, timeZone, name: cleanName };
}

/** Settings: only the keys that change the zemanim (the site's ZMANIM_SETTING_KEYS), as short plain strings */
export function settings(value: unknown, allowed: readonly string[]): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isObject(value)) throw new Invalid("settings: expected an object");
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value)) {
		if (!allowed.includes(key)) throw new Invalid(`settings: unknown setting "${key}"`);
		if (v === null || v === undefined || v === "") continue;
		if (typeof v !== "string" || v.length > 32 || !/^[A-Za-z0-9.+-]*$/.test(v)) throw new Invalid(`settings: bad value for "${key}"`);
		out[key] = v;
	}
	return out;
}

export function notifications(value: unknown, zmanimKeys: readonly string[]): Record<string, NotificationPref> {
	if (!isObject(value)) throw new Invalid("notifications: expected an object");
	const out: Record<string, NotificationPref> = {};
	for (const [key, pref] of Object.entries(value)) {
		if (!zmanimKeys.includes(key)) throw new Invalid(`notifications: unknown zeman "${key}"`);
		if (!isObject(pref) || typeof pref.enabled !== "boolean") throw new Invalid(`notifications: bad entry for "${key}"`);
		const minutes = pref.minutes === undefined ? 15 : pref.minutes;
		if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
			throw new Invalid(`notifications: minutes for "${key}" must be a whole number from 0 to 1440`);
		out[key] = { enabled: pref.enabled, minutes };
	}
	return out;
}

export function display(value: unknown): Display {
	if (!isObject(value)) throw new Invalid("display: expected an object");
	const { language, hourCycle, seconds, locale } = value;
	if (language !== "he" && language !== "en" && language !== "he-Latn") throw new Invalid("display: bad language");
	if (hourCycle !== "h11" && hourCycle !== "h12" && hourCycle !== "h23") throw new Invalid("display: bad hourCycle");
	let cleanLocale = language === "he" ? "he" : "en";
	if (locale !== undefined && locale !== null) {
		if (typeof locale !== "string" || locale.length > 35) throw new Invalid("display: bad locale");
		try { [cleanLocale] = Intl.getCanonicalLocales(locale); } catch { throw new Invalid("display: bad locale"); }
	}
	return { language, hourCycle, seconds: seconds === true, locale: cleanLocale };
}

/** The site's placeKey(lat, lon) (core/notificationText.js): coordinates to 5 decimals */
export function placeKeyOf(lat: number, lon: number) {
	return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/** A place key from a URL; it must be the one of the place's location */
export function placeKey(value: string, loc?: Location): string {
	let key: string;
	try { key = decodeURIComponent(value); } catch { throw new Invalid("place: bad key"); }
	if (!/^-?\d{1,3}\.\d{5},-?\d{1,3}\.\d{5}$/.test(key)) throw new Invalid("place: bad key");
	if (loc && placeKeyOf(loc.lat, loc.lon) !== key) throw new Invalid("place: the key doesn't match the location");
	return key;
}
