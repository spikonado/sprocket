'use node';

import { internal } from '@convex/_generated/api';
import { type Id } from '@convex/_generated/dataModel';
import { internalAction } from '@convex/_generated/server';
import { v } from 'convex/values';
import { isRunFinalStatus, vExecutorJobKind, vExecutorJobPayload } from '@convex/lib/validators';

const POLL_INTERVAL_MS = 200;
const MAX_WAIT_MS = 15 * 60 * 1000;

async function sleep(milliseconds: number) {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const invoke = internalAction({
	args: {
		runId: v.id('runs'),
		threadId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		kind: vExecutorJobKind,
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		const run = await ctx.runQuery(internal.executor.getRunForInternal, {
			runId: args.runId
		});
		if (!run) {
			throw new Error('Run not found.');
		}
		if (isRunFinalStatus(run.status)) {
			throw new Error('Run cancelled.');
		}

		const jobId = (await ctx.runMutation(internal.executor.enqueueJob, args)) as Id<'executorJobs'>;
		const startedAt = Date.now();

		while (Date.now() - startedAt < MAX_WAIT_MS) {
			const latestRun = await ctx.runQuery(internal.executor.getRunForInternal, {
				runId: args.runId
			});
			if (!latestRun) {
				throw new Error('Run disappeared while waiting for executor.');
			}
			if (isRunFinalStatus(latestRun.status)) {
				await ctx.runMutation(internal.executor.cancelJob, {
					jobId,
					error: 'Cancelled while waiting for executor result.'
				});
				throw new Error('Run cancelled.');
			}

			const job = (await ctx.runQuery(internal.executor.getJobForInternal, {
				jobId
			})) as {
				status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
				result?: unknown;
				error?: string;
			} | null;
			if (!job) {
				throw new Error('Executor job not found.');
			}

			switch (job.status) {
				case 'completed':
					return job.result;
				case 'failed':
				case 'cancelled':
					throw new Error(job.error ?? `Executor job ${job.status}.`);
				default:
					break;
			}

			await sleep(POLL_INTERVAL_MS);
		}

		await ctx.runMutation(internal.executor.cancelJob, {
			jobId,
			error: 'Executor job timed out while waiting for a desktop client.'
		});
		throw new Error('Timed out waiting for the desktop executor.');
	}
});
