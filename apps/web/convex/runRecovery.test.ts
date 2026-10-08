import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { executionSecretHash } from '@convex/lib/auth';
import { RUN_CLAIM_LEASE_DURATION_MS } from '@convex/lib/runLease';
import { AUTOMATIC_RECOVERY_SUBMISSION_PREFIX } from '@convex/lib/runRecovery';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

afterEach(() => vi.useRealTimers());

async function setup() {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const machineId = 'recovery-machine';
	await asUser.mutation(api.machines.tryRegister, {
		machineId,
		credentialHash: await executionSecretHash('machine-secret'),
		friendlyName: 'Workstation',
		platform: 'linux',
		platformVersion: 'test',
		architecture: 'x86_64',
		hostname: 'workstation',
		appVersion: 'test'
	});
	const submissionId = 'interrupted-submission';

	const { runId } = await insertQueuedRun(t, asUser, {
		threadId,
		submissionId,
		executionSecret: 'run-secret',
		prompt: 'Build it',
		machineId
	});

	const queryArgs = { submissionId, machineId };

	const recoveryArgs = {
		threadId,
		submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}next`,
		executionSecret: 'next-secret',
		prompt: '',
		machineId,
		continuationOfRunId: runId
	};

	const abandon = () =>
		asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'run-secret',
			text: '',
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});

	return { t, asUser, threadId, runId, queryArgs, recoveryArgs, abandon };
}

describe('automatic run recovery', () => {
	it('recovers a lease-expired run once without replaying the prompt', async () => {
		vi.useFakeTimers();
		const { t, asUser, threadId, runId, queryArgs, recoveryArgs } = await setup();
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			executionSecret: 'run-secret',
			claimId: 'stalled-agent'
		});
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'pending' });
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_LEASE_DURATION_MS);
		await t.finishInProgressScheduledFunctions();
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({
			state: 'recover',
			runId,
			threadId
		});
		await asUser.mutation(api.machines.tryRegister, {
			machineId: queryArgs.machineId,
			credentialHash: await executionSecretHash('new-process'),
			friendlyName: 'Workstation',
			platform: 'linux',
			platformVersion: 'test',
			architecture: 'x86_64',
			hostname: 'workstation',
			appVersion: 'test'
		});
		const continuation = await insertQueuedRun(t, asUser, recoveryArgs);
		expect(continuation.promptPart).toBeUndefined();
		expect(await insertQueuedRun(t, asUser, recoveryArgs)).toMatchObject({
			created: false,
			runId: continuation.runId
		});
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		expect(
			await asUser.query(api.runRecovery.state, {
				...queryArgs,
				submissionId: recoveryArgs.submissionId,
				continuationOfRunId: runId
			})
		).toEqual({ state: 'pending' });
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts).toHaveLength(1);
		expect(parts.parts[0]?.runId).toBe(runId);
	});

	it('reconciles a crash before the recovery submission commits', async () => {
		const { asUser, runId, queryArgs, recoveryArgs, abandon } = await setup();
		await abandon();
		expect(
			await asUser.query(api.runRecovery.state, {
				...queryArgs,
				submissionId: recoveryArgs.submissionId,
				continuationOfRunId: runId
			})
		).toEqual({ state: 'missing' });
		expect(
			await asUser.query(api.runRecovery.state, {
				...queryArgs,
				submissionId: 'never-submitted'
			})
		).toEqual({ state: 'discard' });
	});

	it.each(['completed', 'cancelled', 'failed'] as const)(
		'does not recover an ordinary %s result',
		async (status) => {
			const { t, asUser, runId, queryArgs, recoveryArgs } = await setup();
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret: 'run-secret',
				text: '',
				status,
				lastError: 'provider failure'
			});
			expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
			expect(await asUser.mutation(api.agentRuntime.requestCancellation, { runId })).toBe(false);
			expect(
				(await t.run((ctx) => ctx.db.get('runs', runId)))?.cancellationRequestedAt
			).toBeUndefined();
			await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow();
		}
	);

	it('honors cancellation, archives, and machine/user ownership', async () => {
		const { t, asUser, threadId, runId, queryArgs, recoveryArgs, abandon } = await setup();
		await abandon();
		expect(
			await asUser.query(api.runRecovery.state, {
				...queryArgs,
				machineId: 'other-machine'
			})
		).toEqual({ state: 'discard' });
		expect(
			await t.withIdentity({ subject: 'other-user' }).query(api.runRecovery.state, {
				...queryArgs,
				submissionId: 'missing',
				continuationOfRunId: runId
			})
		).toEqual({ state: 'discard' });
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { archivedAt: Date.now() }));
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow(
			'This run cannot recover automatically.'
		);
		await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { archivedAt: undefined }));
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow(
			'This run cannot recover automatically.'
		);
	});

	it('does not reopen an archived root through recovery of a subagent', async () => {
		const { t, asUser, threadId, queryArgs, recoveryArgs, abandon } = await setup();
		const root = await seedOwnedThread(t);
		await abandon();

		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { parentThreadId: root.threadId });
			await ctx.db.patch('threadRecords', root.threadId, { archivedAt: Date.now() });
		});
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow(
			'This run cannot recover automatically.'
		);
	});

	it('rejects a recovery if a user starts newer work after the eligibility check', async () => {
		const { t, asUser, threadId, runId, queryArgs, recoveryArgs, abandon } = await setup();
		await abandon();
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toMatchObject({
			state: 'recover'
		});

		const newer = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'user-follow-up',
			executionSecret: 'user-secret',
			prompt: 'Do this instead'
		});

		expect(newer.runId).not.toBe(runId);
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow(
			'Stop the current run or wait for it to finish before sending another message.'
		);
	});
});
