import type { MutationCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { v, type Infer } from 'convex/values';
import { isRunFinalStatus, vRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { reconcileTerminalRun } from '@convex/lib/runTerminal';
import { internal } from '@convex/_generated/api';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '@convex/lib/runLease';
import { resolveRequestedFinalizeStatus } from '@convex/lib/runCancellation';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import { detachRunFromMachine } from '@convex/lib/machineRuns';
import {
	getRunWithExecution,
	patchRunExecution,
	type ExecutionRun
} from '@convex/lib/runExecution';
import { cancelRunLifecycleCheck } from '@convex/lib/runLifecycleSchedule';
import { usageLimitAfterFailure } from '@convex/lib/providerUsageLimit';

type FinalizeRunArgs = {
	text: string;
	status: Infer<typeof vRunFinalStatus>;
	lastError?: string;
	providerUsageLimit?: { resetsAt?: number };
};

export const vExecutorFinalizationResult = v.object({
	accepted: v.boolean(),
	outcome: v.union(
		v.null(),
		v.object({ status: vRunFinalStatus, error: v.union(v.null(), v.string()) })
	)
});

export async function executorFinalizationResult(
	ctx: MutationCtx,
	run: ExecutionRun,
	accepted: boolean
) {
	const finalized = accepted ? await ctx.db.get('runs', run._id) : run;

	return {
		accepted,
		outcome:
			finalized && isRunFinalStatus(finalized.status)
				? { status: finalized.status, error: finalized.lastError ?? null }
				: null
	};
}

type FinalizeExpectationArgs = {
	expectedStatus?: Infer<typeof vRunStatus>;
	expectedClaimId?: string;
};

export function matchesFinalizeExpectations(
	run: ExecutionRun,
	args: FinalizeExpectationArgs
): boolean {
	if (
		args.expectedStatus &&
		run.status !== args.expectedStatus &&
		!(isClaimedRunStatus(run.status) && isClaimedRunStatus(args.expectedStatus))
	) {
		return false;
	}

	if (
		args.expectedClaimId &&
		(run.claimId !== args.expectedClaimId || !isRunClaimLeaseActive(run, Date.now()))
	) {
		return false;
	}

	return true;
}

export async function finalizeRunRecord(
	ctx: MutationCtx,
	run: ExecutionRun,
	args: FinalizeRunArgs
): Promise<boolean> {
	const alreadyFinal = isRunFinalStatus(run.status);
	const finalStatus = alreadyFinal ? run.status : resolveRequestedFinalizeStatus(run, args.status);
	const completedAt = run.completedAt ?? Date.now();
	const lastError = alreadyFinal ? run.lastError : args.lastError;
	await cancelRunLifecycleCheck(ctx, run._id);
	await ctx.scheduler.runAfter(0, internal.firecrawlRequests.cancelRun, { runId: run._id });
	await detachRunFromMachine(ctx, run);

	if (alreadyFinal) {
		await reconcileTerminalRun(
			ctx,
			{ ...run, status: finalStatus, lastError, completedAt },
			{
				completedAt,
				jobCursor: -1,
				questionCursor: -1
			}
		);

		if (run.activeJobId) {
			await patchRunExecution(ctx, run._id, { activeJobId: undefined });
		}

		return true;
	}

	await patchRunExecution(ctx, run._id, {
		claimExpiresAt: undefined,
		activeJobId: undefined
	});

	let usageLimit: Doc<'runs'>['usageLimit'] =
		finalStatus === 'failed' && run.usageLimit
			? { attempts: run.usageLimit.attempts, deadlineAt: run.usageLimit.deadlineAt }
			: undefined;

	if (
		finalStatus === 'failed' &&
		args.providerUsageLimit !== undefined &&
		run.completionProvider === 'chatgpt' &&
		run.machineId !== undefined &&
		run.cancellationRequestedAt === undefined
	) {
		const thread = await ctx.db.get('threadRecords', run.threadId);

		if (thread?.userId === run.userId && thread.completionProvider === run.completionProvider) {
			usageLimit = usageLimitAfterFailure(
				run.usageLimit,
				args.providerUsageLimit.resetsAt,
				completedAt
			);
		}
	}

	if (run.usageLimit !== undefined || usageLimit !== undefined) {
		await ctx.db.patch('runs', run._id, { usageLimit });
	}

	await setRunAndThreadStatus(ctx, run, finalStatus, {
		lastError: args.lastError,
		completedAt
	});
	const latest = await getRunWithExecution(ctx.db, run._id);

	if (!latest) {
		return true;
	}

	await reconcileTerminalRun(ctx, latest, {
		completedAt,
		jobCursor: -1,
		questionCursor: -1
	});

	return true;
}
