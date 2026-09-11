import { describe, expect, it } from 'vitest';

import { formatCountdownDuration, formatRemainingDuration } from '$lib/format';

describe('format helpers', () => {
	it('formats remaining durations up to the next unit', () => {
		expect(formatRemainingDuration(0)).toBe('1m');
		expect(formatRemainingDuration(30 * 60_000)).toBe('30m');
		expect(formatRemainingDuration(3 * 3_600_000)).toBe('3h');
		expect(formatRemainingDuration(50 * 3_600_000)).toBe('2d 2h');
		expect(formatRemainingDuration(72 * 3_600_000)).toBe('3d');
	});

	it('counts down with second precision under an hour', () => {
		expect(formatCountdownDuration(-5)).toBe('0s');
		expect(formatCountdownDuration(45_000)).toBe('45s');
		expect(formatCountdownDuration(90_000)).toBe('1m 30s');
		expect(formatCountdownDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m');
		expect(formatCountdownDuration(50 * 3_600_000)).toBe('2d 2h');
	});
});
