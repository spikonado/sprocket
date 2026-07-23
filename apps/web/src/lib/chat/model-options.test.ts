import { describe, expect, it } from 'vitest';
import { modelIds } from '$convex/lib/models';
import { modelOptionsForTier } from '$lib/chat/model-options';

describe('modelOptionsForTier', () => {
	it('does not lock models for pro', () => {
		const options = modelOptionsForTier('pro');
		expect(options.every((option) => !option.locked)).toBe(true);
		expect(options.map((option) => option.id)).toEqual([...modelIds]);
	});
});
