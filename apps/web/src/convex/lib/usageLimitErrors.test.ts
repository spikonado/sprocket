import { describe, expect, it } from 'vitest';
import {
	pickExhaustedUsageWindow,
	parseUsageLimitExceeded,
	usageLimitExhaustedMessage,
	usageLimitExhaustedSentence,
	USAGE_LIMIT_EXCEEDED_PREFIX
} from '@convex/lib/usageLimitErrors';

describe('usage limit exhausted messages', () => {
	it('round-trips structured detail through the sentinel message', () => {
		const message = usageLimitExhaustedMessage({
			meterId: 'modelUsage',
			period: 'weekly',
			resetsAt: 1_750_000_000_000
		});
		expect(message.startsWith(USAGE_LIMIT_EXCEEDED_PREFIX)).toBe(true);
		expect(parseUsageLimitExceeded(`Provider error: ${message}`)).toEqual({
			meterId: 'modelUsage',
			period: 'weekly',
			resetsAt: 1_750_000_000_000
		});
	});

	it('renders a readable sentence with period, meter, and reset countdown', () => {
		expect(
			usageLimitExhaustedSentence({ meterId: 'modelUsage', period: 'weekly', resetsIn: '5d 3h' })
		).toBe("You've used all of your weekly model usage. Your limit resets in 5d 3h.");
		expect(usageLimitExhaustedSentence({ meterId: 'modelUsage', period: 'monthly' })).toBe(
			"You've used all of your monthly model usage."
		);
	});

	it('rejects malformed payloads and unrelated failures', () => {
		expect(
			parseUsageLimitExceeded(
				`${USAGE_LIMIT_EXCEEDED_PREFIX}{"meterId":"modelUsage","period":"fortnightly","resetsAt":1}`
			)
		).toBeNull();
		expect(parseUsageLimitExceeded(USAGE_LIMIT_EXCEEDED_PREFIX + 'not json')).toBeNull();
		expect(parseUsageLimitExceeded('Run is cancelled.')).toBeNull();
		expect(parseUsageLimitExceeded('[Request ID] Server Error')).toBeNull();
	});

	it('picks the exhausted window that resets last', () => {
		expect(
			pickExhaustedUsageWindow([
				{
					id: 'modelUsage',
					windows: [
						{ period: 'weekly', used: 4_999, limit: 5_000, resetsAt: 1_000 },
						{ period: 'monthly', used: 15_000, limit: 15_000, resetsAt: 9_000 }
					]
				}
			])
		).toEqual({ meterId: 'modelUsage', period: 'monthly', resetsAt: 9_000 });
		expect(
			pickExhaustedUsageWindow([
				{ id: 'modelUsage', windows: [{ period: 'weekly', used: 0, limit: 5_000, resetsAt: null }] }
			])
		).toBeNull();
	});

	it('never blocks zero-limit windows and prefers known reset times', () => {
		expect(
			pickExhaustedUsageWindow([
				{
					id: 'modelUsage',
					windows: [
						{ period: 'weekly', used: 5_000, limit: 0, resetsAt: null },
						{ period: 'monthly', used: 15_000, limit: 15_000, resetsAt: 7_000 }
					]
				}
			])
		).toEqual({ meterId: 'modelUsage', period: 'monthly', resetsAt: 7_000 });
	});
});
