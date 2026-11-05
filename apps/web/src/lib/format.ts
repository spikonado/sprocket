export function formatRemainingDuration(remainingMs: number): string {
	const milliseconds = Math.max(0, remainingMs);
	const hours = Math.ceil(milliseconds / 3_600_000);

	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const restHours = hours % 24;

		return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
	}

	if (milliseconds >= 3_600_000) {
		return `${hours}h`;
	}

	return `${Math.max(1, Math.ceil(milliseconds / 60_000))}m`;
}

function currencyFormat(currency: string) {
	try {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency });
	} catch {
		return undefined;
	}
}

export function formatMajorAmount(amount: string, currency: string): string {
	const value = Number(amount);
	const format = currencyFormat(currency);

	return format && Number.isFinite(value)
		? format.format(value)
		: `${amount} ${currency.toUpperCase()}`;
}

export function formatMinorAmount(amount: number, currency: string): string {
	const format = currencyFormat(currency);

	if (!format) return `${amount} ${currency.toUpperCase()}`;

	return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}
