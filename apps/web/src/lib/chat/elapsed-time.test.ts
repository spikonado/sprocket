import { describe, expect, it } from 'vitest';
import { elapsedSeconds } from './elapsed-time';

describe('elapsedSeconds', () => {
	it('does not turn missing or invalid timestamps into a duration', () => {
		expect(elapsedSeconds(undefined, 5_000)).toBeUndefined();
		expect(elapsedSeconds(0, 5_000)).toBeUndefined();
		expect(elapsedSeconds(1_000, undefined)).toBeUndefined();
		expect(elapsedSeconds(NaN, 5_000)).toBeUndefined();
		expect(elapsedSeconds(5_000, 4_000)).toBe(0);
	});
});
