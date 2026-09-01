import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { executionSecretHash } from '@convex/lib/auth';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

const machine = {
	installationId: 'installation-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	architecture: 'x86_64',
	appVersion: '0.3.2'
};

describe('machine sessions', () => {
	it('supersedes a process session and fails each of its active runs atomically', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const first = await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash: await executionSecretHash('credential-a')
		});
		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'session-run',
			executionSecret: 'run-secret',
			prompt: 'Run locally',
			installationId: machine.installationId,
			executorSessionId: first.sessionId
		});

		const second = await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-b',
			credentialHash: await executionSecretHash('credential-b')
		});

		const state = await t.run(async (ctx) => ({
			first: await ctx.db.get('machineSessions', first.sessionId),
			run: await ctx.db.get('runs', run.runId),
			binding: await ctx.db
				.query('machineSessionRuns')
				.withIndex('by_runId', (query) => query.eq('runId', run.runId))
				.unique()
		}));
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(state.first?.supersededAt).toBeTypeOf('number');
		expect(state.run).toMatchObject({
			status: 'failed',
			lastError: 'The executor session ended before this run finished.'
		});
		expect(state.binding?.active).toBe(false);
	});

	it('rejects a superseded process that tries to become current again', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const credentialHash = await executionSecretHash('credential-a');
		await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash
		});
		await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-b',
			credentialHash: await executionSecretHash('credential-b')
		});

		await expect(
			asUser.mutation(api.machineSessions.register, {
				...machine,
				processSessionId: 'process-a',
				credentialHash
			})
		).rejects.toThrow('Process session is no longer active.');
	});

	it('authenticates heartbeats with the process credential', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash: await executionSecretHash('credential-a')
		});

		await expect(
			t.mutation(api.machineSessions.heartbeat, {
				processSessionId: 'process-a',
				credential: 'wrong'
			})
		).rejects.toThrow('Machine session is not active.');
		await expect(
			t.mutation(api.machineSessions.heartbeat, {
				processSessionId: 'process-a',
				credential: 'credential-a'
			})
		).resolves.toBeNull();
	});

	it('does not let an ended process register again', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const credentialHash = await executionSecretHash('credential-a');
		await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash
		});
		await t.mutation(api.machineSessions.end, {
			processSessionId: 'process-a',
			credential: 'credential-a'
		});

		await expect(
			asUser.mutation(api.machineSessions.register, {
				...machine,
				processSessionId: 'process-a',
				credentialHash
			})
		).rejects.toThrow('Process session is no longer active.');
	});
});
