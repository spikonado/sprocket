import { describe, expect, it } from 'vitest';
import { isActiveRunStatus } from '@convex/lib/runs';

describe('isActiveRunStatus', () => {
	it('marks queued, running, and awaiting_executor as active', () => {
		expect(isActiveRunStatus('queued')).toBe(true);
		expect(isActiveRunStatus('running')).toBe(true);
		expect(isActiveRunStatus('awaiting_executor')).toBe(true);
		expect(isActiveRunStatus('completed')).toBe(false);
		expect(isActiveRunStatus('failed')).toBe(false);
		expect(isActiveRunStatus('cancelled')).toBe(false);
	});
});
