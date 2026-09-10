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

	it('removes nested Convex transport prefixes before rethrowing a tool error', () => {
		const message =
			'The user has control of this browser. Ask them to give control back before browsing.';
		for (const error of [
			new Error(`Uncaught ConvexError: ${message}\n    at acquire`),
			new ConvexError(`Uncaught ConvexError: Uncaught ConvexError: ${message}\n    at acquire`)
		]) {
			expect(toAgentToolConvexError(error)).toMatchObject({ data: message, message });
		}
	});
});
