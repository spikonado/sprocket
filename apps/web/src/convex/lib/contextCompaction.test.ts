import { describe, expect, it } from 'vitest';
import { applyContextCompaction, shouldCompactContext } from './contextCompaction';

describe('context compaction', () => {
	it('replaces the compacted prefix and retains later turns', () => {
		const messages = [
			{ role: 'user' as const, content: 'old request' },
			{ role: 'assistant' as const, content: 'old response' },
			{ role: 'user' as const, content: 'new request' }
		];
		const compacted = applyContextCompaction(messages, {
			summary: 'The old request is complete.',
			messageCount: 2
		});

		expect(compacted).toHaveLength(2);
		expect(compacted[0]).toMatchObject({ role: 'user' });
		expect(JSON.stringify(compacted[0])).toContain('The old request is complete.');
		expect(compacted[1]).toEqual(messages[2]);
	});

	it('uses reported usage and a conservative preflight estimate', () => {
		expect(
			shouldCompactContext({ inputTokens: 90, autoCompactTokenLimit: 100, messages: [] })
		).toBe(false);
		expect(
			shouldCompactContext({ inputTokens: 100, autoCompactTokenLimit: 100, messages: [] })
		).toBe(true);
		expect(
			shouldCompactContext({
				inputTokens: 0,
				autoCompactTokenLimit: 100,
				messages: [{ role: 'user', content: 'x'.repeat(400) }]
			})
		).toBe(true);
	});
});
