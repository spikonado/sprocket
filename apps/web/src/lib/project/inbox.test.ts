import { describe, expect, it } from 'vitest';
import { normalizeRepositoryKeys } from './inbox.svelte';

describe('normalizeRepositoryKeys', () => {
	it('deduplicates and sorts repository keys without changing the input', () => {
		const repositoryKeys = ['zeta', 'alpha', 'zeta', 'beta', 'alpha'];

		expect(normalizeRepositoryKeys(repositoryKeys)).toEqual(['alpha', 'beta', 'zeta']);
		expect(repositoryKeys).toEqual(['zeta', 'alpha', 'zeta', 'beta', 'alpha']);
	});
});
