import { describe, expect, it } from 'vitest';
import {
	ONLY_LATEST_RUN_CAN_CONTINUE,
	RUN_CANNOT_CONTINUE,
	assertContinuableParent,
	isContinuableRunStatus
} from '@convex/lib/runResume';
import type { Id } from '@convex/_generated/dataModel';

// SAFETY: Convex IDs are opaque strings; these values never leave this pure unit test.
const runOne = 'run-1' as Id<'runs'>;
// SAFETY: Convex IDs are opaque strings; these values never leave this pure unit test.
const runTwo = 'run-2' as Id<'runs'>;

function run(id: Id<'runs'>, status: 'failed' | 'cancelled' | 'completed' | 'queued') {
	return { _id: id, status };
}

describe('continuable parents', () => {
	it('allows only the latest failed or cancelled run', () => {
		expect(isContinuableRunStatus('failed')).toBe(true);
		expect(isContinuableRunStatus('cancelled')).toBe(true);
		expect(isContinuableRunStatus('completed')).toBe(false);
		expect(isContinuableRunStatus('queued')).toBe(false);
		expect(assertContinuableParent(run(runOne, 'failed'), runOne)._id).toBe(runOne);
		expect(() => assertContinuableParent(run(runOne, 'completed'), runOne)).toThrow(
			RUN_CANNOT_CONTINUE
		);
		expect(() => assertContinuableParent(run(runTwo, 'failed'), runOne)).toThrow(
			ONLY_LATEST_RUN_CAN_CONTINUE
		);
		expect(() => assertContinuableParent(null, runOne)).toThrow(ONLY_LATEST_RUN_CAN_CONTINUE);
	});
});
