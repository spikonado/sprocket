import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('model catalog', () => {
	it('omits usage policy unless requested', async () => {
		const t = initConvexTest();
		const catalog = await t.query(api.modelCatalog.get, {});
		expect(catalog.models.every((model) => model.usagePolicy === undefined)).toBe(true);

		const withPolicy = await t.query(api.modelCatalog.get, { includeUsagePolicy: true });
		expect(withPolicy.models.find((model) => model.id === 'stealth/ox-alpha')?.usagePolicy).toBe(
			'unlimited'
		);
		expect(
			withPolicy.models.find((model) => model.id === 'gpt-5.6-sol')?.usagePolicy
		).toBeUndefined();
	});
});
