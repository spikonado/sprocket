import { describe, expect, it } from 'vitest';
import {
	extractUsageLimitExceededMessage,
	usageLimitExhaustedMessage,
	USAGE_LIMIT_EXCEEDED_PREFIX
} from '@convex/lib/usageLimitErrors';

describe('usage limit exhausted messages', () => {
	it('builds a readable sentence with period, meter, and reset time', () => {
		expect(
			usageLimitExhaustedMessage({ meterId: 'modelUsage', period: 'weekly', resetsIn: '5d 3h' })
		).toBe(
			`${USAGE_LIMIT_EXCEEDED_PREFIX}You've used all of your weekly model usage. Your limit resets in 5d 3h.`
		);
	});

	it('is detected inside executor-wrapped failure messages', () => {
		const message = usageLimitExhaustedMessage({
			meterId: 'modelUsage',
			period: 'monthly',
			resetsIn: '2h'
		});
		expect(extractUsageLimitExceededMessage(`Provider error: ${message}`)).toBe(
			"You've used all of your monthly model usage. Your limit resets in 2h."
		);
	});

	it('keeps only the first line when failure text carries trailing context', () => {
		expect(
			extractUsageLimitExceededMessage(
				`${USAGE_LIMIT_EXCEEDED_PREFIX}You've used all of your weekly model usage.\nCaused by: boom`
			)
		).toBe("You've used all of your weekly model usage.");
	});

	it('ignores unrelated failures', () => {
		expect(extractUsageLimitExceededMessage('Run is cancelled.')).toBeNull();
		expect(extractUsageLimitExceededMessage('[Request ID] Server Error')).toBeNull();
	});
});
