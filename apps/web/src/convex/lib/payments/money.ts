/** Parse a Prava/agent decimal money string into integer minor units (cents).
 * Fixed-point, so "0.1" + "0.2" class errors can't leak into comparisons. */
export function parseMoneyMinor(value: string): number | undefined {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return undefined;
	const units = Number(match[1]);
	const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
	if (!Number.isSafeInteger(units) || !Number.isSafeInteger(fraction)) return undefined;
	const minor = units * 100 + fraction;
	return Number.isSafeInteger(minor) ? minor : undefined;
}

export function requireMoneyMinor(value: string, label: string): number {
	const minor = parseMoneyMinor(value);
	if (minor === undefined) {
		throw new Error(`${label} must be a non-negative decimal amount.`);
	}
	return minor;
}

/** Format integer minor units for Prava/agent/UI decimal strings. Minor units
 * only enter through parseMoneyMinor, so they are always non-negative. */
export function formatMoneyMinor(minor: number): string {
	return `${Math.floor(minor / 100)}.${(minor % 100).toString().padStart(2, '0')}`;
}
