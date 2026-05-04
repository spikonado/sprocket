import { describe, expect, it } from 'vitest';

import {
	formatCompactCount,
	formatRelativeTime,
	formatWorkspaceSubtitle,
	truncatePreview
} from '$lib/format';

describe('workspace formatting helpers', () => {
	it('formats large counts compactly', () => {
		expect(formatCompactCount(15320)).toBe('15.3k');
	});

	it('builds a git subtitle with dirty state', () => {
		expect(formatWorkspaceSubtitle('main', true)).toBe('Git main • dirty');
	});

	it('truncates long previews', () => {
		expect(truncatePreview('a'.repeat(180), 24)).toBe('aaaaaaaaaaaaaaaaaaaaaaaa...');
	});

	it('formats relative times compactly', () => {
		expect(formatRelativeTime(60_000, 120_000)).toBe('1m ago');
		expect(formatRelativeTime(7_200_000, 10_800_000)).toBe('1h ago');
	});
});
