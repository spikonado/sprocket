import { describe, expect, it } from 'vitest';
import { coercePersistedReasoningEffort, coercePersistedServiceTier } from '@convex/lib/models';

describe('model configuration', () => {
	it('keeps valid service tiers and replaces unknown values', () => {
		expect(coercePersistedServiceTier('fast')).toBe('fast');
		expect(coercePersistedServiceTier('unknown')).toBe('standard');
	});

	it('keeps stored reasoning effort when it is still a known id', () => {
		expect(coercePersistedReasoningEffort('max')).toBe('max');
		expect(coercePersistedReasoningEffort('high')).toBe('high');
	});
});
