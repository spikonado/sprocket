import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.useRealTimers());

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
		const session = await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash: await executionSecretHash('credential-a')
		});

		await expect(
			t.mutation(api.machineSessions.heartbeat, {
				sessionId: session.sessionId,
				credential: 'wrong'
			})
		).rejects.toThrow('Machine session is not active.');
		await expect(
			t.mutation(api.machineSessions.heartbeat, {
				sessionId: session.sessionId,
				credential: 'credential-a'
			})
		).resolves.toBeNull();
	});

	it('does not let an ended process register again', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const credentialHash = await executionSecretHash('credential-a');
		const session = await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-a',
			credentialHash
		});
		await t.mutation(api.machineSessions.end, {
			sessionId: session.sessionId,
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

	it('allows one local process identity to register for different users', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const { asUser: asOtherUser } = await seedOwnedThread(t, 'other-user');
		const credentialHash = await executionSecretHash('shared-process-credential');

		const first = await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'shared-process',
			credentialHash
		});
		const second = await asOtherUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'shared-process',
			credentialHash
		});

		expect(second.sessionId).not.toBe(first.sessionId);
	});

	it('reports current installation metadata and only recent active sessions as online', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const first = await asUser.mutation(api.machineSessions.register, {
			...machine,
			platformVersion: '6.12.1',
			hostname: 'workbench',
			processSessionId: 'process-a',
			credentialHash: await executionSecretHash('credential-a')
		});

		vi.advanceTimersByTime(90_000);
		expect(await asUser.query(api.machineSessions.listMine, {})).toEqual([
			{
				...machine,
				platformVersion: '6.12.1',
				hostname: 'workbench',
				lastSeenAt: Date.parse('2026-01-01T00:00:00.000Z'),
				online: true
			}
		]);

		vi.advanceTimersByTime(1);
		expect((await asUser.query(api.machineSessions.listMine, {}))[0]?.online).toBe(false);

		await t.mutation(api.machineSessions.heartbeat, {
			sessionId: first.sessionId,
			credential: 'credential-a'
		});
		expect((await asUser.query(api.machineSessions.listMine, {}))[0]?.online).toBe(true);

		await asUser.mutation(api.machineSessions.register, {
			...machine,
			processSessionId: 'process-b',
			credentialHash: await executionSecretHash('credential-b')
		});
		await t.run(async (ctx) => {
			const installation = await ctx.db
				.query('installations')
				.withIndex('by_userId_and_installationId', (query) =>
					query.eq('userId', 'user_alice').eq('installationId', machine.installationId)
				)
				.unique();
			if (!installation) throw new Error('Expected installation fixture.');
			await ctx.db.patch('installations', installation._id, { currentSessionId: first.sessionId });
		});
		expect((await asUser.query(api.machineSessions.listMine, {}))[0]?.online).toBe(false);

		await t.run(async (ctx) => {
			await ctx.db.patch('machineSessions', first.sessionId, {
				supersededAt: undefined,
				revokedAt: Date.now()
			});
		});
		expect((await asUser.query(api.machineSessions.listMine, {}))[0]?.online).toBe(false);
	});
});
