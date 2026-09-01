import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus, type vRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { reconcileTerminalRunPages } from '@convex/lib/runTerminal';
import { cancelWebToolWork } from '@convex/webToolPool';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { resolveRequestedFinalizeStatus } from '@convex/lib/runCancellation';

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
	if (args.expectedStatus && run.status !== args.expectedStatus) {
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
	if (run.executorSessionId) {
		const sessionRun = await ctx.db
			.query('machineSessionRuns')
			.withIndex('by_runId', (query) => query.eq('runId', run._id))
			.unique();
		if (sessionRun?.active) {
			await ctx.db.patch('machineSessionRuns', sessionRun._id, { active: false });
		}
	}

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
			await ctx.db.patch('runs', run._id, { activeJobId: undefined });
		}
		return true;
	}

	await ctx.db.patch('runs', run._id, {
		status: finalStatus,
		claimExpiresAt: undefined,
		lastError: args.lastError,
		activeJobId: undefined,
		completedAt
	});

	const latest = await ctx.db.get('runs', run._id);
	if (!latest) {
		return true;
	}
	await reconcileTerminalRunPages(ctx, latest, {
		lastError: args.lastError,
		completedAt
	});
	return true;
}
