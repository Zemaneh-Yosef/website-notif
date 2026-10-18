// Web Push with only WebCrypto: VAPID (RFC 8292) and message encryption (RFC 8291, aes128gcm / RFC 8188).
// No third-party packages, so nothing outside Deno itself handles the private key.

const enc = new TextEncoder();

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto takes */
type Bytes = Uint8Array<ArrayBuffer>;

export function b64urlDecode(s: string): Bytes {
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function b64urlEncode(bytes: Bytes | ArrayBuffer): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (const b of u8) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Bytes[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let i = 0;
	for (const p of parts) { out.set(p, i); i += p.length; }
	return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF with a single block of output (all RFC 8291 needs), truncated to `length` */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** An uncompressed P-256 point (0x04 || x || y) as the x / y of a JWK */
function pointToJwk(point: Bytes) {
	if (point.length !== 65 || point[0] !== 4) throw new Error("not an uncompressed P-256 public key");
	return { kty: "EC", crv: "P-256", x: b64urlEncode(point.slice(1, 33)), y: b64urlEncode(point.slice(33, 65)) };
}

export interface PushKeys { p256dh: string; auth: string }

export interface EncryptOptions {
	/** for tests: a fixed sender key pair (private scalar and public point, base64url) and salt */
	senderPrivate?: string;
	senderPublic?: string;
	salt?: Bytes;
	recordSize?: number;
}

/** The encrypted body for a push message (RFC 8291 §4: one aes128gcm record) */
export async function encryptPayload(plaintext: Bytes, keys: PushKeys, options: EncryptOptions = {}): Promise<Bytes> {
	const uaPublic = b64urlDecode(keys.p256dh);
	const authSecret = b64urlDecode(keys.auth);
	if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");
	const uaKey = await crypto.subtle.importKey("jwk", pointToJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);

	let asPrivate: CryptoKey, asPublic: Bytes;
	if (options.senderPrivate && options.senderPublic) {
		asPublic = b64urlDecode(options.senderPublic);
		asPrivate = await crypto.subtle.importKey("jwk", { ...pointToJwk(asPublic), d: options.senderPrivate },
			{ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	} else {
		const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
		asPrivate = pair.privateKey;
		asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	}

	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
	const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

	const rs = options.recordSize ?? 4096;
	// one record: the plaintext, then the 0x02 delimiter of the last record
	if (plaintext.length + 1 + 16 > rs) throw new Error("payload too large for one record");
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey,
		concat(plaintext, new Uint8Array([2]))));

	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, rs);
	header[20] = asPublic.length;
	return concat(header, asPublic, ciphertext);
}

// ─── VAPID ────────────────────────────────────────────────────────────────────

/** Read a SEC1 "EC PRIVATE KEY" PEM (what `openssl ecparam -genkey` writes): its private scalar and public point */
export function parseEcPrivateKeyPem(pem: string): { d: Bytes; publicKey: Bytes | null } {
	const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	if (/BEGIN PRIVATE KEY/.test(pem)) throw new Error("PKCS#8 key: use the SEC1 key written by `openssl ecparam -genkey -noout`");

	let i = 0;
	const readLen = () => {
		let len = der[i++];
		if (len & 0x80) {
			const n = len & 0x7f;
			len = 0;
			for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
		}
		return len;
	};
	if (der[i++] !== 0x30) throw new Error("bad key: no SEQUENCE");
	readLen();
	if (der[i++] !== 0x02) throw new Error("bad key: no version");
	const versionLen = readLen();
	i += versionLen;
	if (der[i++] !== 0x04) throw new Error("bad key: no private key");
	const dLen = readLen();
	const d = der.slice(i, i + dLen);
	i += dLen;

	let publicKey: Bytes | null = null;
	while (i < der.length) {
		const tag = der[i++];
		const len = readLen();
		if (tag === 0xa1) {
			// [1] { BIT STRING: 0 unused bits, then the point }
			if (der[i] !== 0x03) throw new Error("bad key: public key is not a BIT STRING");
			let j = i + 1;
			let bitLen = der[j++];
			if (bitLen & 0x80) { j += bitLen & 0x7f; bitLen = 0; }
			publicKey = der.slice(j + 1, i + len);
		}
		i += len;
	}
	if (d.length !== 32) throw new Error("not a P-256 private key");
	return { d, publicKey };
}

export class Vapid {
	#key: CryptoKey;
	readonly publicKey: string;
	readonly subject: string;
	#tokens = new Map<string, { header: string; until: number }>();

	private constructor(key: CryptoKey, publicKey: string, subject: string) {
		this.#key = key;
		this.publicKey = publicKey;
		this.subject = subject;
	}

	static async fromPem(pem: string, expectedPublicKey: string, subject: string): Promise<Vapid> {
		const { d, publicKey } = parseEcPrivateKeyPem(pem);
		if (!publicKey) throw new Error("the VAPID key file has no public key");
		const encoded = b64urlEncode(publicKey);
		if (encoded !== expectedPublicKey)
			throw new Error("the VAPID public key in the config doesn't match the private key file");
		if (!/^mailto:|^https:/.test(subject)) throw new Error("VAPID subject must be mailto: or https:");
		const key = await crypto.subtle.importKey("jwk", { ...pointToJwk(publicKey), d: b64urlEncode(d) },
			{ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
		return new Vapid(key, encoded, subject);
	}

	/** The Authorization header for a push service (a JWT per origin, reused for up to 12 hours) */
	async authorization(endpoint: string, now = Date.now()): Promise<string> {
		const audience = new URL(endpoint).origin;
		const cached = this.#tokens.get(audience);
		if (cached && cached.until > now + 60_000) return cached.header;

		const exp = Math.floor(now / 1000) + 12 * 60 * 60;
		const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
		const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: this.subject })));
		const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#key, enc.encode(`${header}.${claims}`));
		const value = `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${this.publicKey}`;
		this.#tokens.set(audience, { header: value, until: exp * 1000 });
		return value;
	}
}

export interface PushMessage {
	endpoint: string;
	keys: PushKeys;
	payload: unknown;
	/** seconds the push service may hold it while the device is offline */
	ttl: number;
	urgency?: "very-low" | "low" | "normal" | "high";
	/** replaces a still-undelivered message with the same topic (≤ 32 base64url characters) */
	topic?: string;
}

export type PushResult =
	| { ok: true; status: number }
	| { ok: false; status: number; gone: boolean; retryAfterMs: number | null; detail: string };

export async function sendPush(vapid: Vapid, message: PushMessage, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
	const body = await encryptPayload(enc.encode(JSON.stringify(message.payload)), message.keys);
	const headers: Record<string, string> = {
		"Authorization": await vapid.authorization(message.endpoint),
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		"TTL": String(Math.max(0, Math.floor(message.ttl))),
		"Urgency": message.urgency ?? "high",
	};
	if (message.topic) headers["Topic"] = message.topic;

	const response = await fetchImpl(message.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000), redirect: "error" });
	const detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 300);
	if (!response.ok) {
		const retry = response.headers.get("retry-after");
		const retryAfterMs = retry ? (Number.isFinite(+retry) ? +retry * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : null;
		return { ok: false, status: response.status, gone: response.status === 404 || response.status === 410, retryAfterMs, detail };
	}
	await response.body?.cancel();
	return { ok: true, status: response.status };
}
