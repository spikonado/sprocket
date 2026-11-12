import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('repositoryKeys.move', () => {
	it("moves the user's threads and artifacts to the new key and keeps their cwd", async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);

		const artifactId = await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { cwd: '/alpha/sub' });

			return await ctx.db.insert('artifacts', {
				userId: subject,
				scope: 'project',
				repositoryKey: 'alpha',
				registrationId: 'artifact-1',
				content: '# Notes',
				title: 'Notes',
				revision: 1,
				updatedAt: Date.now()
			});
		});

		await asUser.mutation(api.repositoryKeys.move, {
			from: 'alpha',
			to: 'github.com/acme/alpha'
		});

		const [thread, artifact] = await t.run(
			async (ctx) =>
				[
					await ctx.db.get('threadRecords', threadId),
					await ctx.db.get('artifacts', artifactId)
				] as const
		);

		expect(thread).toMatchObject({ repositoryKey: 'github.com/acme/alpha', cwd: '/alpha/sub' });
		expect(artifact?.repositoryKey).toBe('github.com/acme/alpha');
	});
});
