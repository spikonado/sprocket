import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('chat.latestRunForThread', () => {
	it('returns only the active executor job', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'latest-run-job-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'latest-run-job', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'latest-run-claim',
			runId,
			executionSecret
		});
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId: 'latest-run-claim',
			runId,
			kind: 'exec_command',
			callId: 'active-call',
			payload: { cmd: 'sleep 10' },
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'exec_command',
				callId: 'historical-call',
				payload: { cmd: 'large historical result' },
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				completedAt: 2,
				result: {
					command: 'large historical result',
					cwd: '/',
					exitCode: 0,
					success: true,
					running: false,
					timedOut: false,
					output: 'x'.repeat(10_000),
					truncated: false
				},
				sequence: 1
			});
		});

		const latest = await asUser.query(api.chat.latestRunForThread, { threadId });
		expect(latest.activeJob?._id).toBe(jobId);
		expect(latest.activeJob?.callId).toBe('active-call');
	});
});
