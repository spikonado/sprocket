import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('projects.upsertSelected', () => {
	it('reuses the same project when the git repository key matches', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_repo' });

		const first = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});
		const second = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-2'
		});

		expect(first?._id).toBeDefined();
		expect(second?._id).toBe(first?._id);
		expect(second?.repositoryKey).toBe('github.com/spikonado/sprocket');
	});

	it('keeps distinct repositories with the same display name separate', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_repo_forks' });

		const upstream = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});
		const fork = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/alice/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		expect(upstream?._id).toBeDefined();
		expect(fork?._id).toBeDefined();
		expect(fork?._id).not.toBe(upstream?._id);
	});

	it('does not treat a local no-origin project as a different git repository', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_local_identity' });

		const local = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		const git = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		expect(local?._id).toBeDefined();
		expect(git?._id).toBeDefined();
		expect(git?._id).not.toBe(local?._id);
		expect(local?.repositoryKey).toBe('sprocket');
		expect(git?.repositoryKey).toBe('github.com/spikonado/sprocket');
	});

	it('updates the display name when reopening the same repository key', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_rename' });

		const first = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'old-checkout',
			connectedClientId: 'client-1'
		});
		const second = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		expect(second?._id).toBe(first?._id);
		expect(second?.displayName).toBe('sprocket');
	});

	it('creates a separate project when reconnecting with a new repository key', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_reconnect_new_key' });

		const existing = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/old',
			displayName: 'repo-linked-threads',
			connectedClientId: 'client-1'
		});

		const reconnected = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		expect(existing?._id).toBeDefined();
		expect(reconnected?._id).toBeDefined();
		expect(reconnected?._id).not.toBe(existing?._id);
		expect(reconnected?.repositoryKey).toBe('github.com/spikonado/sprocket');

		const projects = await asUser.query(api.projects.listMine, {});
		const oldProject = projects.find((project) => project._id === existing!._id);
		expect(oldProject?.repositoryKey).toBe('github.com/spikonado/old');
	});
});
