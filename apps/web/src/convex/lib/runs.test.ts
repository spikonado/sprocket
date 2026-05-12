import { describe, expect, it } from 'vitest';
import { assertThreadCanStartRun } from '@convex/lib/runs';

describe('assertThreadCanStartRun', () => {
	it('allows a thread with no prior run', () => {
		expect(() => assertThreadCanStartRun(null)).not.toThrow();
	});

	it('allows a thread whose latest run is final', () => {
		expect(() => assertThreadCanStartRun('completed')).not.toThrow();
		expect(() => assertThreadCanStartRun('failed')).not.toThrow();
		expect(() => assertThreadCanStartRun('cancelled')).not.toThrow();
	});

	it('rejects a thread with an active run', () => {
		expect(() => assertThreadCanStartRun('queued')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
		expect(() => assertThreadCanStartRun('running')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
		expect(() => assertThreadCanStartRun('awaiting_executor')).toThrow(
			'Finish or cancel the active run before sending another message.'
		);
	});
});
