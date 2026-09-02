import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { executionSecretHash } from '@convex/lib/auth';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

const machine = {
	machineId: 'machine-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	architecture: 'x86_64',
	appVersion: '0.3.2'
};

afterEach(() => vi.useRealTimers());

describe('machines', () => {
	it('rejects a second process while the machine is still online', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash('credential-a')
		});
		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'machine-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		await expect(
			asUser.mutation(api.machines.register, {
				...machine,
				credentialHash: await executionSecretHash('credential-b')
			})
		).rejects.toThrow('Machine is already active on another process.');
		expect(await t.run(async (ctx) => ctx.db.get('runs', run.runId))).toMatchObject({
			status: 'queued'
		});
	});

	it('lets a new process take over after the previous one goes stale', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash('credential-a')
		});
		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'stale-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		vi.advanceTimersByTime(90_001);
		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash('credential-b')
		});
		expect(await t.run(async (ctx) => ctx.db.get('runs', run.runId))).toMatchObject({
			status: 'failed',
			lastError: 'The machine stopped before this run finished.'
		});
	});

	it('authenticates heartbeats with the process credential', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash('credential-a')
		});

		await expect(
			asUser.mutation(api.machines.heartbeat, {
				machineId: machine.machineId,
				credential: 'wrong'
			})
		).rejects.toThrow('Machine is not active.');
		await expect(
			asUser.mutation(api.machines.heartbeat, {
				machineId: machine.machineId,
				credential: 'credential-a'
			})
		).resolves.toBeNull();
	});

	it('ends a machine by failing its runs and clearing lastSeenAt', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash('credential-a')
		});
		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'end-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		await asUser.mutation(api.machines.end, {
			machineId: machine.machineId,
			credential: 'credential-a'
		});
		expect(await t.run(async (ctx) => ctx.db.get('runs', run.runId))).toMatchObject({
			status: 'failed'
		});
		expect((await asUser.query(api.machines.listMine, {}))[0]).toMatchObject({
			machineId: machine.machineId,
			online: false
		});
		await expect(
			asUser.mutation(api.machines.heartbeat, {
				machineId: machine.machineId,
				credential: 'credential-a'
			})
		).rejects.toThrow('Machine is not active.');
	});

	it('allows one local machine identity to register for different users', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const { asUser: asOtherUser } = await seedOwnedThread(t, 'other-user');
		const credentialHash = await executionSecretHash('shared-machine-credential');

		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash
		});
		await asOtherUser.mutation(api.machines.register, {
			...machine,
			credentialHash
		});

		expect(await asUser.query(api.machines.listMine, {})).toHaveLength(1);
		expect(await asOtherUser.query(api.machines.listMine, {})).toHaveLength(1);
	});

	it('reports only recently heartbeated machines as online', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.register, {
			...machine,
			platformVersion: '6.12.1',
			hostname: 'workbench',
			credentialHash: await executionSecretHash('credential-a')
		});

		vi.advanceTimersByTime(90_000);
		expect(await asUser.query(api.machines.listMine, {})).toEqual([
			{
				...machine,
				platformVersion: '6.12.1',
				hostname: 'workbench',
				lastSeenAt: Date.parse('2026-01-01T00:00:00.000Z'),
				online: true
			}
		]);

		vi.advanceTimersByTime(1);
		expect((await asUser.query(api.machines.listMine, {}))[0]?.online).toBe(false);

		await asUser.mutation(api.machines.heartbeat, {
			machineId: machine.machineId,
			credential: 'credential-a'
		});
		expect((await asUser.query(api.machines.listMine, {}))[0]?.online).toBe(true);
	});
});
