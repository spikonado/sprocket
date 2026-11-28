import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('explicit artifact bindings', () => {
	it('loads only requested same-user artifacts across projects and follows transfers and deletion', async () => {
		const t = initConvexTest();
		const alice = t.withIdentity({ subject: 'user_alice' });

		const ids = await t.run(async (ctx) => {
			const ids = [];

			for (const [userId, repositoryKey] of [
				['user_alice', 'first'],
				['user_alice', 'second'],
				['user_bob', 'first']
			]) {
				ids.push(
					await ctx.db.insert('artifacts', {
						userId,
						repositoryKey,
						scope: 'project',
						registrationId: `${userId}-${repositoryKey}`,
						title: 'notes.md',
						content: 'initial',
						revision: 1,
						updatedAt: 1
					})
				);
			}

			return ids;
		});

		const args = { artifactIds: [ids[1], ids[2]] };

		await expect(t.query(api.artifactBindings.getArtifacts, args)).rejects.toThrow(
			/authentication required/i
		);
		await expect(t.query(api.artifactBindings.getState, args)).rejects.toThrow(
			/authentication required/i
		);
		expect(await alice.query(api.artifactBindings.getArtifacts, args)).toEqual([
			expect.objectContaining({ _id: ids[1], repositoryKey: 'second', content: 'initial' })
		]);
		await alice.mutation(api.artifacts.transferArtifact, {
			artifactId: ids[1],
			repositoryKey: 'third'
		});
		expect(await alice.query(api.artifactBindings.getState, args)).toEqual([
			{ artifactId: ids[1], repositoryKey: 'third', revision: 2 }
		]);
		expect(
			await alice.mutation(api.artifacts.syncArtifact, {
				artifactId: ids[1],
				repositoryKey: 'third',
				expectedRevision: 2,
				content: 'local edit'
			})
		).toBe(true);
		expect(await alice.query(api.artifactBindings.getArtifacts, args)).toEqual([
			expect.objectContaining({ _id: ids[1], content: 'local edit', revision: 3 })
		]);
		await alice.mutation(api.artifacts.deleteArtifact, {
			artifactId: ids[1],
			repositoryKey: 'third'
		});
		expect(await alice.query(api.artifactBindings.getState, args)).toEqual([]);
		expect(await alice.query(api.artifactBindings.getArtifacts, args)).toEqual([]);
		await expect(
			alice.query(api.artifactBindings.getArtifacts, { artifactIds: Array(9).fill(ids[0]) })
		).rejects.toThrow(/at most 8/i);
	});
});
