import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import {
	ensureAssistantToolPartsFromJobs,
	joinAssistantTextParts,
	toPersistableExecutorToolJobs,
	type AssistantPart
} from '@convex/lib/assistantParts';
import { isRunFinalStatus, type vRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { appendThreadMessage, getThreadMessage } from '@convex/lib/threadMessages';
import { reconcileTerminalRunPages } from '@convex/lib/runTerminal';
import { cancelWebToolWork } from '@convex/webToolPool';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';

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
	userId: string,
	run: Doc<'runs'>,
	args: FinalizeRunArgs
): Promise<boolean> {
	const alreadyFinal = isRunFinalStatus(run.status);
	const finalStatus = alreadyFinal ? run.status : args.status;
	const completedAt = run.completedAt ?? Date.now();
	const lastError = alreadyFinal ? run.lastError : args.lastError;
	await cancelWebToolWork(ctx, run._id);

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

	const responseMessageId =
		run.responseMessageId ??
		(await appendThreadMessage(ctx, {
			threadId: run.threadId,
			runId: run._id,
			userId,
			type: 'response',
			text: ''
		}));
	const message = run.responseMessageId
		? await getThreadMessage(ctx, run.responseMessageId)
		: undefined;

	await ctx.db.patch('runs', run._id, {
		status: finalStatus,
		claimExpiresAt: undefined,
		lastError: args.lastError,
		activeJobId: undefined,
		completedAt,
		responseMessageId
	});

	const latest = await ctx.db.get('runs', run._id);
	if (!latest) {
		return true;
	}
	await reconcileTerminalRunPages(ctx, latest, {
		lastError: args.lastError,
		completedAt
	});

	const jobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
		.take(256);
	const nextParts: AssistantPart[] = ensureAssistantToolPartsFromJobs(
		message?.parts ?? [],
		toPersistableExecutorToolJobs(jobs)
	);
	const streamedText: string = joinAssistantTextParts(nextParts);
	await ctx.db.patch('threadMessages', responseMessageId, {
		text: streamedText || args.text,
		parts: nextParts
	});
	return true;
}
