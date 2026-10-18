// Tiny assertions, so the tests need no downloaded packages
export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
	if (!cond) throw new Error(msg);
}
export function assertEquals(actual: unknown, expected: unknown, msg?: string) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${msg ?? "not equal"}\n  actual:   ${a}\n  expected: ${e}`);
}
