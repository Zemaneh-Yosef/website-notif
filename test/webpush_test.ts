import { assertEquals, assert } from "./assert.ts";
import { encryptPayload, b64urlEncode, b64urlDecode, parseEcPrivateKeyPem, Vapid } from "../src/webpush.ts";

// RFC 8291 §5: the worked example, byte for byte
Deno.test("RFC 8291 example", async () => {
	const body = await encryptPayload(new TextEncoder().encode("When I grow up, I want to be a watermelon"), {
		p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		auth: "BTBZMqHH6r4Tts7J_aSIgg",
	}, {
		senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
		senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
		salt: b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
	});
	assertEquals(b64urlEncode(body),
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

Deno.test("VAPID: SEC1 PEM from openssl, public key check, ES256 JWT that verifies", async () => {
	const pem = await Deno.readTextFile(new URL("./fixtures/vapid_private.pem", import.meta.url));
	const expected = (await Deno.readTextFile(new URL("./fixtures/vapid_public.txt", import.meta.url))).trim();
	const { publicKey } = parseEcPrivateKeyPem(pem);
	assertEquals(b64urlEncode(publicKey!), expected);

	const vapid = await Vapid.fromPem(pem, expected, "mailto:test@example.com");
	const header = await vapid.authorization("https://fcm.googleapis.com/fcm/send/abc");
	const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
	assert(m, header);
	const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
	assertEquals(claims.aud, "https://fcm.googleapis.com");
	assertEquals(claims.sub, "mailto:test@example.com");
	const pub = await crypto.subtle.importKey("raw", b64urlDecode(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	assert(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`)));

	let threw = false;
	try { await Vapid.fromPem(pem, "B" + expected.slice(1, -1) + "A", "mailto:x@y.z"); } catch { threw = true; }
	assert(threw, "a mismatched public key must be refused");
});
