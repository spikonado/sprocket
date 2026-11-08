import { describe, expect, it } from 'vitest';
import { formatExpiresIn } from './format';

const DAY = 86_400_000;

describe('formatExpiresIn', () => {
	it.each([
		[DAY - 1, 'today'],
		[DAY, 'in 1 day'],
		[30 * DAY - 60_000, 'in 30 days'],
		[59 * DAY, 'in 59 days'],
		[60 * DAY, 'in 2 months'],
		[365 * DAY, 'in 12 months'],
		[730 * DAY, 'in 2 years']
	])('formats %i ms as %s', (remainingMs, expected) => {
		expect(formatExpiresIn(remainingMs)).toBe(expected);
	});
});
