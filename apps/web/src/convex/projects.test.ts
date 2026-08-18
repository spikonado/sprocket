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

describe('projects.listMine ordering', () => {
	it('orders by creation, not by which project was re-selected most recently', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_order' });

		const older = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/older',
			displayName: 'older',
			connectedClientId: 'client-1'
		});
		const newer = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/newer',
			displayName: 'newer',
			connectedClientId: 'client-1'
		});

		// Re-selecting the older project must not move it above the newer one.
		await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/older',
			displayName: 'older',
			connectedClientId: 'client-1'
		});

		const projects = await asUser.query(api.projects.listMine, {});
		expect(projects.map((project) => project._id)).toEqual([newer!._id, older!._id]);
	});
});

describe('projects.heartbeatAttached', () => {
	it('tracks liveness in projectConnections without mutating the project row', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_heartbeat' });

		const project = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		const before = await t.run(async (ctx) => ctx.db.get(project!._id));

		await asUser.mutation(api.projects.heartbeatAttached, {
			clientId: 'client-1',
			projectIds: [project!._id]
		});

		const after = await t.run(async (ctx) => ctx.db.get(project!._id));
		expect(after).toEqual(before);

		const listed = await asUser.query(api.projects.listMine, {});
		expect(listed.find((entry) => entry._id === project!._id)?.executorStatus).toBe('connected');
	});

	it('drops the connection row when the client stops attaching the project', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_detach' });

		const project = await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		await asUser.mutation(api.projects.heartbeatAttached, {
			clientId: 'client-1',
			projectIds: []
		});

		const listed = await asUser.query(api.projects.listMine, {});
		expect(listed.find((entry) => entry._id === project!._id)?.executorStatus).toBe('disconnected');
	});

	it('omits executorStatus for slim callers', async () => {
		const t = initConvexTest();
		const asUser = t.withIdentity({ subject: 'user_slim' });

		await asUser.mutation(api.projects.upsertSelected, {
			repositoryKey: 'github.com/spikonado/sprocket',
			displayName: 'sprocket',
			connectedClientId: 'client-1'
		});

		const slim = await asUser.query(api.projects.listMine, { slim: true });
		expect(slim).toHaveLength(1);
		expect(slim[0]).not.toHaveProperty('executorStatus');

		const legacy = await asUser.query(api.projects.listMine, {});
		expect(legacy[0]?.executorStatus).toBe('connected');
	});
});
