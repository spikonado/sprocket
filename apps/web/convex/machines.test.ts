import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { executionSecretHash } from '@convex/lib/auth';
import { MACHINE_ONLINE_THRESHOLD_MS } from '@convex/lib/machineRuns';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

const machine = {
	machineId: 'machine-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	platformVersion: '6.12.1',
	architecture: 'x86_64',
	hostname: 'workbench',
	appVersion: '0.3.2'
};

afterEach(() => vi.useRealTimers());

describe('machines', () => {
	it('returns a retry delay without changing the live process or its runs', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'busy-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		const original = await t.run((ctx) => ctx.db.query('machines').unique());
		const args = { ...machine, processId: 'process-b' };

		vi.advanceTimersByTime(30_000);
		expect(await asUser.mutation(api.machines.registerProcess, args)).toEqual({
			status: 'busy',
			retryAfterMs: MACHINE_ONLINE_THRESHOLD_MS - 30_000 + 1
		});
		expect(await t.run((ctx) => ctx.db.query('machines').unique())).toEqual(original);
		expect(await t.run((ctx) => ctx.db.get('runs', run.runId))).toMatchObject({ status: 'queued' });

		await asUser.mutation(api.machines.heartbeatProcess, {
			machineId: machine.machineId,
			processId: 'process-a'
		});
		vi.advanceTimersByTime(MACHINE_ONLINE_THRESHOLD_MS);
		expect(await asUser.mutation(api.machines.registerProcess, args)).toEqual({
			status: 'busy',
			retryAfterMs: 1
		});
		vi.advanceTimersByTime(1);
		expect(await asUser.mutation(api.machines.registerProcess, args)).toEqual({
			status: 'registered',
			machineId: machine.machineId,
			userId: 'user_alice'
		});
		expect(await t.run((ctx) => ctx.db.get('runs', run.runId))).toMatchObject({ status: 'failed' });
		expect(await t.run((ctx) => ctx.db.query('machines').unique())).toMatchObject({
			_id: original?._id,
			processId: 'process-b',
			runIds: []
		});

		for (const mutation of [api.machines.heartbeatProcess, api.machines.endProcess]) {
			await expect(
				asUser.mutation(mutation, { machineId: machine.machineId, processId: 'process-a' })
			).rejects.toThrow('Machine is not active.');
		}

		await expect(
			asUser.mutation(api.machines.heartbeatProcess, {
				machineId: machine.machineId,
				processId: 'process-b'
			})
		).resolves.toBeNull();
	});

	it('keeps registration retries from the same process idempotent', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = { ...machine, processId: 'process-a' };
		const registered = await asUser.mutation(api.machines.registerProcess, args);

		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'retry-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		expect(await asUser.mutation(api.machines.registerProcess, args)).toEqual(registered);
		expect(await t.run((ctx) => ctx.db.get('runs', run.runId))).toMatchObject({ status: 'queued' });
		expect(await t.run((ctx) => ctx.db.query('machines').unique())).toMatchObject({
			runIds: [run.runId]
		});
	});

	it('requires authentication for every process call', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		await expect(
			t.mutation(api.machines.registerProcess, { ...machine, processId: 'process-b' })
		).rejects.toThrow('Authentication required.');

		for (const mutation of [api.machines.heartbeatProcess, api.machines.endProcess]) {
			await expect(
				t.mutation(mutation, { machineId: machine.machineId, processId: 'process-a' })
			).rejects.toThrow('Authentication required.');
		}
	});

	it('lets a new process take over after the previous one goes stale', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'stale-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		await asUser.mutation(api.agentRuntime.start, {
			runId: run.runId,
			executionSecret: 'run-secret',
			claimId: 'machine-claim'
		});

		vi.advanceTimersByTime(90_001);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-b' });
		expect(await t.run(async (ctx) => ctx.db.get('runs', run.runId))).toMatchObject({
			status: 'failed',
			lastError: 'The local agent stopped responding before this run finished.'
		});
	});

	it('accepts heartbeats only from the registered process of the signed-in user', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const { asUser: asOtherUser } = await seedOwnedThread(t, 'other-user');
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		await expect(
			asOtherUser.mutation(api.machines.heartbeatProcess, {
				machineId: machine.machineId,
				processId: 'process-a'
			})
		).rejects.toThrow('Machine is not active.');
		await expect(
			asUser.mutation(api.machines.heartbeatProcess, {
				machineId: machine.machineId,
				processId: 'wrong'
			})
		).rejects.toThrow('Machine is not active.');
		await expect(
			asUser.mutation(api.machines.heartbeatProcess, {
				machineId: machine.machineId,
				processId: 'process-a'
			})
		).resolves.toBeNull();
	});

	it('ends a machine by failing its runs as recoverable and clearing lastSeenAt', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'end-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			machineId: machine.machineId
		});

		const processArgs = { machineId: machine.machineId, processId: 'process-a' };
		await asUser.mutation(api.machines.endProcess, processArgs);
		expect(await t.run(async (ctx) => ctx.db.get('runs', run.runId))).toMatchObject({
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		expect((await asUser.query(api.machines.listMine, {}))[0]).toMatchObject({
			machineId: machine.machineId,
			online: false
		});
		await expect(asUser.mutation(api.machines.heartbeatProcess, processArgs)).rejects.toThrow(
			'Machine is not active.'
		);
	});

	it('keeps released clients working with their credential', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const credentialHash = await executionSecretHash('credential-a');
		const legacyArgs = { userId: 'user_alice', machineId: machine.machineId };
		await asUser.mutation(api.machines.tryRegister, { ...machine, credentialHash });

		await expect(
			t.mutation(api.machines.heartbeat, { ...legacyArgs, credential: credentialHash })
		).rejects.toThrow('Machine is not active.');
		await expect(
			t.mutation(api.machines.heartbeat, { ...legacyArgs, credential: 'credential-a' })
		).resolves.toBeNull();
		await t.mutation(api.machines.end, { ...legacyArgs, credential: 'credential-a' });
		expect((await asUser.query(api.machines.listMine, {}))[0]?.online).toBe(false);
	});

	it('allows one local machine identity to register for different users', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const { asUser: asOtherUser } = await seedOwnedThread(t, 'other-user');
		const args = { ...machine, processId: 'shared-process' };

		await asUser.mutation(api.machines.registerProcess, args);
		await asOtherUser.mutation(api.machines.registerProcess, args);

		expect(await asUser.query(api.machines.listMine, {})).toHaveLength(1);
		expect(await asOtherUser.query(api.machines.listMine, {})).toHaveLength(1);
	});

	it('reports only recently heartbeated machines as online', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });

		vi.advanceTimersByTime(90_000);
		expect(await asUser.query(api.machines.listMine, {})).toEqual([
			{
				...machine,
				lastSeenAt: Date.parse('2026-01-01T00:00:00.000Z'),
				online: true
			}
		]);

		vi.advanceTimersByTime(1);
		expect((await asUser.query(api.machines.listMine, {}))[0]?.online).toBe(false);

		await asUser.mutation(api.machines.heartbeatProcess, {
			machineId: machine.machineId,
			processId: 'process-a'
		});
		expect((await asUser.query(api.machines.listMine, {}))[0]?.online).toBe(true);
	});
});
