import { describe, expect, it } from 'vitest';

import { formatElapsedDuration } from '$lib/format';

describe('format helpers', () => {
	it('formats elapsed durations', () => {
		expect(formatElapsedDuration(0)).toBe('0s');
		expect(formatElapsedDuration(45)).toBe('45s');
		expect(formatElapsedDuration(60)).toBe('1m 0s');
		expect(formatElapsedDuration(125)).toBe('2m 5s');
	});
});
