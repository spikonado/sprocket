import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus, type vRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { reconcileTerminalRunPages } from '@convex/lib/runTerminal';
import { cancelWebToolWork } from '@convex/webToolPool';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '@convex/lib/runLease';
import { resolveRequestedFinalizeStatus } from '@convex/lib/runCancellation';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import { detachRunFromMachine } from '@convex/lib/machineRuns';
import { getRunWithExecution, patchRunExecution } from '@convex/lib/runExecution';

type FinalizeRunArgs = {
	text: string;
	status: Infer<typeof vRunFinalStatus>;
	lastError?: string;
};

type FinalizeExpectationArgs = {
	expectedStatus?: Infer<typeof vRunStatus>;
	expectedClaimId?: string;
};

export function matchesFinalizeExpectations(
	run: Doc<'runs'>,
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
	run: Doc<'runs'>,
	args: FinalizeRunArgs
): Promise<boolean> {
	const alreadyFinal = isRunFinalStatus(run.status);
	const finalStatus = alreadyFinal ? run.status : resolveRequestedFinalizeStatus(run, args.status);
	const completedAt = run.completedAt ?? Date.now();
	const lastError = alreadyFinal ? run.lastError : args.lastError;
	await cancelWebToolWork(ctx, run._id);
	await detachRunFromMachine(ctx, run);

	if (alreadyFinal) {
		await reconcileTerminalRunPages(
			ctx,
			{ ...run, status: finalStatus, lastError, completedAt },
			{
				lastError,
				completedAt
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
	await setRunAndThreadStatus(ctx, run, finalStatus, {
		lastError: args.lastError,
		completedAt
	});
	const latest = await getRunWithExecution(ctx.db, run._id);
	if (!latest) {
		return true;
	}
	await reconcileTerminalRunPages(ctx, latest, {
		lastError: args.lastError,
		completedAt
	});
	return true;
}
