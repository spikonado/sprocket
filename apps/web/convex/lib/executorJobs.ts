import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';
import {
	isRunFinalStatus,
	vMandateChargeResult,
	type ExecutorJobResult
} from '@convex/lib/validators';
import { patchRunExecution, type ExecutionRun } from '@convex/lib/runExecution';
import type { Infer } from 'convex/values';

function isMandateChargeResult(
	result: ExecutorJobResult
): result is Infer<typeof vMandateChargeResult> {
	if (result === null || Array.isArray(result)) return false;

	if (Object.getPrototypeOf(result) !== Object.prototype) return false;

	return 'chargeId' in result && 'transactionId' in result;
}

export function persistExecutorJobResult(
	kind: string,
	result: ExecutorJobResult
): ExecutorJobResult {
	if (kind !== 'mandate_charge') return result;

	if (!isMandateChargeResult(result)) {
		throw new Error('mandate_charge result must be a charge handle.');
	}

	return {
		chargeId: result.chargeId,
		transactionId: result.transactionId
	};
}

export async function applyExecutorJobSuccess(
	ctx: MutationCtx,
	args: {
		job: Doc<'executorJobs'>;
		run: ExecutionRun;
		result: ExecutorJobResult;
		claimId: string;
	}
): Promise<boolean> {
	if (args.job.status === 'cancelled' || args.job.status === 'failed') {
		return false;
	}

	if (args.job.status === 'completed') {
		await recordToolTranscript(ctx, {
			threadId: args.run.threadId,
			userId: args.run.userId,
			runId: args.run._id,
			job: args.job
		});

		return true;
	}

	if (isRunFinalStatus(args.run.status) || args.run.cancellationRequestedAt !== undefined) {
		return false;
	}

	if (!ownsActiveRunClaim(args.run, args.claimId, Date.now())) {
		return false;
	}

	const result = persistExecutorJobResult(args.job.kind, args.result);

	const settledJob = {
		...args.job,
		status: 'completed' as const,
		result
	};

	await ctx.db.patch('executorJobs', args.job._id, {
		status: settledJob.status,
		result,
		completedAt: Date.now()
	});

	if (args.run.activeJobId === args.job._id) {
		await patchRunExecution(ctx, args.run._id, { activeJobId: undefined });
	}

	await recordToolTranscript(ctx, {
		threadId: args.run.threadId,
		userId: args.run.userId,
		runId: args.run._id,
		job: settledJob
	});

	return true;
}

export async function applyExecutorJobFailure(
	ctx: MutationCtx,
	args: {
		job: Doc<'executorJobs'>;
		run: ExecutionRun;
		error: string;
		claimId: string;
	}
): Promise<boolean> {
	if (
		args.job.status === 'cancelled' ||
		args.job.status === 'completed' ||
		args.job.status === 'failed'
	) {
		return false;
	}

	if (!ownsActiveRunClaim(args.run, args.claimId, Date.now())) {
		return false;
	}

	const completedAt = Date.now();

	const settledJob = {
		...args.job,
		status: 'failed' as const,
		error: args.error
	};

	await ctx.db.patch('executorJobs', args.job._id, {
		status: settledJob.status,
		error: args.error,
		completedAt
	});

	if (
		args.run.cancellationRequestedAt === undefined &&
		!isRunFinalStatus(args.run.status) &&
		args.run.activeJobId === args.job._id
	) {
		await patchRunExecution(ctx, args.run._id, { activeJobId: undefined });
	}

	await recordToolTranscript(ctx, {
		threadId: args.run.threadId,
		userId: args.run.userId,
		runId: args.run._id,
		job: settledJob
	});

	return true;
}
