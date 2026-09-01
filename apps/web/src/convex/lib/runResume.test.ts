import { describe, expect, it } from 'vitest';
import {
	ONLY_LATEST_RUN_CAN_CONTINUE,
	RUN_CANNOT_CONTINUE,
	assertContinuableParent,
	isContinuableRunStatus
} from '@convex/lib/runResume';
import type { Id } from '@convex/_generated/dataModel';

function run(id: string, status: 'failed' | 'cancelled' | 'completed' | 'queued') {
	return { _id: id as Id<'runs'>, status };
}

describe('continuable parents', () => {
	it('allows only the latest failed or cancelled run', () => {
		expect(isContinuableRunStatus('failed')).toBe(true);
		expect(isContinuableRunStatus('cancelled')).toBe(true);
		expect(isContinuableRunStatus('completed')).toBe(false);
		expect(isContinuableRunStatus('queued')).toBe(false);
		expect(assertContinuableParent(run('run-1', 'failed'), 'run-1' as Id<'runs'>)._id).toBe(
			'run-1'
		);
		expect(() => assertContinuableParent(run('run-1', 'completed'), 'run-1' as Id<'runs'>)).toThrow(
			RUN_CANNOT_CONTINUE
		);
		expect(() => assertContinuableParent(run('run-2', 'failed'), 'run-1' as Id<'runs'>)).toThrow(
			ONLY_LATEST_RUN_CAN_CONTINUE
		);
		expect(() => assertContinuableParent(null, 'run-1' as Id<'runs'>)).toThrow(
			ONLY_LATEST_RUN_CAN_CONTINUE
		);
	});
});
