// Configuration: one JSON file (see deploy/config.example.json), passed as the first argument.
// No environment variables, so the service runs without --allow-env.

export interface Config {
	listen: { hostname: string; port: number };
	/** origins allowed to call the API (CORS) */
	allowedOrigins: string[];
	/** the calendar, for the page a notification opens */
	siteOrigin: string;
	vapid: { privateKeyFile: string; publicKey: string; subject: string };
	/** the refraction server (hanetz), reached locally */
	refractionServer: string;
	database: string;
	/** the vendored copy of the site (scripts/update.sh) */
	siteDir: string;
	/** sent as User-Agent to the weather services and GitHub */
	userAgent: string;
	limits: Limits;
}

export interface Limits {
	/** largest request body, bytes */
	maxBodyBytes: number;
	/** all subscriptions together */
	maxSubscriptions: number;
	/** new subscriptions per IP address per hour */
	subscribesPerIpPerHour: number;
	/** updates and deletes per IP address per hour */
	updatesPerIpPerHour: number;
	/** notifications sent to one subscription per day, whatever its settings */
	maxNotificationsPerDay: number;
	/**
	 * remove a subscription not updated for this many days; null (the default) = never, so someone who never
	 * opens the site again keeps getting notifications. Revoked subscriptions go when the push service says so.
	 */
	inactiveDays: number | null;
}

const DEFAULT_LIMITS: Limits = {
	maxBodyBytes: 16 * 1024,
	maxSubscriptions: 50_000,
	subscribesPerIpPerHour: 10,
	updatesPerIpPerHour: 120,
	maxNotificationsPerDay: 40,
	inactiveDays: null,
};

export async function loadConfig(path: string): Promise<Config> {
	const raw = JSON.parse(await Deno.readTextFile(path));
	const required = ["listen", "allowedOrigins", "siteOrigin", "vapid", "refractionServer", "database", "siteDir", "userAgent"];
	for (const key of required)
		if (!(key in raw)) throw new Error(`config: missing "${key}"`);
	return { ...raw, limits: { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) } };
}
