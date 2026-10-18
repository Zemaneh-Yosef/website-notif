// Warns when the site's zmanim code has changed since the pinned commit, so a logic change on the site
// doesn't silently leave notifications out of step. Uses GitHub's public API (no key; 60 requests an hour,
// this makes one).

const SITE = "Zemaneh-Yosef/royzmanimwebsite";

/** What the vendored code is made of: a change to any of these can change a notification */
export const ZMANIM_PATHS = [
	"assets/js/core/", "assets/js/ROYZmanim.js", "assets/js/WebsiteCalendar.js", "assets/js/WebsiteLimudCalendar.js",
	"assets/js/tekufot.js", "assets/js/refraction-data.js", "assets/js/refraction-snapshot.js", "assets/js/misc/",
	"assets/libraries/kosherZmanim/", "assets/libraries/n2words.esm.js", "assets/libraries/light-pollution-client.js",
	"assets/libraries/temporal-polyfill/", "_data/zmanim.yml",
];

export interface DriftState {
	checkedAt: number | null;
	/** commits on the site's main branch since the pin */
	behindBy: number | null;
	/** zmanim files changed since the pin (empty = in step) */
	changedFiles: string[];
	error: string | null;
}

export class DriftCheck {
	state: DriftState = { checkedAt: null, behindBy: null, changedFiles: [], error: null };
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(private commit: string, private userAgent: string, private log: (msg: string) => void = console.log, private fetchImpl: typeof fetch = fetch) {}

	start() {
		this.check();
		this.#timer = setInterval(() => this.check(), 60 * 60 * 1000);
	}

	stop() {
		if (this.#timer !== null) clearInterval(this.#timer);
	}

	async check() {
		try {
			const response = await this.fetchImpl(`https://api.github.com/repos/${SITE}/compare/${this.commit}...main`, {
				headers: { "Accept": "application/vnd.github+json", "User-Agent": this.userAgent, "X-GitHub-Api-Version": "2022-11-28" },
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
			const compare = await response.json() as { ahead_by: number; files?: { filename: string }[] };
			const changed = (compare.files ?? []).map((f) => f.filename)
				.filter((name) => ZMANIM_PATHS.some((p) => p.endsWith("/") ? name.startsWith(p) : name === p));
			this.state = { checkedAt: Date.now(), behindBy: compare.ahead_by, changedFiles: changed, error: null };
			if (changed.length)
				this.log(`WARNING: the site's zmanim code changed since the pinned commit ${this.commit.slice(0, 7)} ` +
					`(${changed.length} file(s): ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}). ` +
					`Notifications may differ from the site until you run scripts/update.sh --latest and restart.`);
		} catch (e) {
			this.state = { ...this.state, checkedAt: Date.now(), error: (e as Error).message };
			this.log(`drift check failed: ${(e as Error).message}`);
		}
	}
}
