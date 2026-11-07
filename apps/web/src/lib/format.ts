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

const DAY_MS = 86_400_000;

function plural(count: number, unit: string) {
	return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function formatExpiresIn(remainingMs: number): string {
	if (remainingMs < DAY_MS) return 'today';
	const days = Math.round(remainingMs / DAY_MS);

	if (days < 60) return `in ${plural(days, 'day')}`;
	const months = Math.round(days / 30.4375);

	if (months < 24) return `in ${plural(months, 'month')}`;

	return `in ${plural(Math.round(days / 365.25), 'year')}`;
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
