import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';

describe('agent tool error surfacing', () => {
	it('passes ConvexErrors through untouched', () => {
		const error = new ConvexError('Mandate not found.');
		expect(toAgentToolConvexError(error)).toBe(error);
	});

	it('strips the production uncaught-error prefix', () => {
		const error = toAgentToolConvexError(new Error('Uncaught Error: Exa search failed.'));
		expect(error).toBeInstanceOf(ConvexError);
		expect(error.message).toBe('Exa search failed.');
	});

	it('keeps control-flow sentinel wording', () => {
		const error = toAgentToolConvexError(new Error(RUN_NO_LONGER_ACTIVE));
		expect(error.message).toBe(RUN_NO_LONGER_ACTIVE);
	});
});
