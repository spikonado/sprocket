import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('model catalog', () => {
	it('rejects the retired static catalog query', async () => {
		const t = initConvexTest();
		await expect(t.query(api.modelCatalog.get, {})).rejects.toThrow(
			'This Sprocket version is no longer supported. Update to the latest Sprocket release.'
		);
	});
});
