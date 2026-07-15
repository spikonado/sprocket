import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '$lib/format';

describe('format helpers', () => {
	it('formats relative times compactly', () => {
		expect(formatRelativeTime(60_000, 120_000)).toBe('1m ago');
		expect(formatRelativeTime(7_200_000, 10_800_000)).toBe('1h ago');
	});
});
