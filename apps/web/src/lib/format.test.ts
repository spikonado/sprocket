import { describe, expect, it } from 'vitest';

import { formatElapsedDuration, formatRemainingDuration } from '$lib/format';

describe('format helpers', () => {
	it('formats elapsed durations', () => {
		expect(formatElapsedDuration(0)).toBe('0s');
		expect(formatElapsedDuration(45)).toBe('45s');
		expect(formatElapsedDuration(60)).toBe('1m 0s');
		expect(formatElapsedDuration(125)).toBe('2m 5s');
	});

	it('formats remaining durations up to the next unit', () => {
		expect(formatRemainingDuration(0)).toBe('1m');
		expect(formatRemainingDuration(30 * 60_000)).toBe('30m');
		expect(formatRemainingDuration(3 * 3_600_000)).toBe('3h');
		expect(formatRemainingDuration(50 * 3_600_000)).toBe('2d 2h');
		expect(formatRemainingDuration(72 * 3_600_000)).toBe('3d');
	});
});
