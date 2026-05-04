import type { Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { ExecutorJobResult } from '@convex/lib/validators';

export async function patchRunFinalState(
	ctx: MutationCtx,
	runId: Id<'runs'>,
	args: {
		status: 'completed' | 'failed' | 'cancelled';
		lastError?: string;
	}
) {
	const patch: Record<string, unknown> = {
		status: args.status,
		activeJobId: undefined,
		completedAt: Date.now()
	};
	if (args.lastError !== undefined) {
		patch.lastError = args.lastError;
	}

	await ctx.db.patch(runId, patch);
}

export async function patchJobFinalState(
	ctx: MutationCtx,
	jobId: Id<'executorJobs'>,
	args: {
		status: 'completed' | 'failed' | 'cancelled';
		result?: ExecutorJobResult;
		error?: string;
	}
) {
	const patch: Record<string, unknown> = {
		status: args.status,
		completedAt: Date.now()
	};
	if (args.result !== undefined) {
		patch.result = args.result;
	}
	if (args.error !== undefined) {
		patch.error = args.error;
	}

	await ctx.db.patch(jobId, patch);
}
