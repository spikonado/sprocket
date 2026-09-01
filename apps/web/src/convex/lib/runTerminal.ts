import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { cancelExecutorJobsForTerminalRun } from '@convex/lib/runs';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';
import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import type { Infer } from 'convex/values';

const TERMINAL_CLEANUP_PAGE_SIZE = 16;

type TerminalCleanupResult = {
	done: boolean;
	nextSequence: number;
};

async function cancelExecutorJobsPage(
	ctx: MutationCtx,
	args: {
		runId: Id<'runs'>;
		runStatus: Infer<typeof vRunStatus>;
		lastError?: string;
		completedAt: number;
		afterSequence: number;
	}
): Promise<TerminalCleanupResult> {
	const jobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) =>
			query.eq('runId', args.runId).gt('sequence', args.afterSequence)
		)
		.take(TERMINAL_CLEANUP_PAGE_SIZE);
	const finalizedJobs = cancelExecutorJobsForTerminalRun({
		jobs,
		runStatus: args.runStatus,
		lastError: args.lastError,
		completedAt: args.completedAt
	});
	for (const [index, job] of jobs.entries()) {
		const finalizedJob = finalizedJobs[index];
		if (finalizedJob === job) continue;
		await ctx.db.patch('executorJobs', job._id, {
			status: finalizedJob.status,
			error: finalizedJob.error,
			completedAt: finalizedJob.completedAt
		});
	}
	const last = jobs.at(-1);
	return {
		done: jobs.length < TERMINAL_CLEANUP_PAGE_SIZE,
		nextSequence: last?.sequence ?? args.afterSequence
	};
}

async function cancelPendingQuestionsPage(
	ctx: MutationCtx,
	args: { runId: Id<'runs'>; completedAt: number; afterSequence: number }
): Promise<TerminalCleanupResult> {
	const questions = await ctx.db
		.query('agentQuestions')
		.withIndex('by_runId_sequence', (query) =>
			query.eq('runId', args.runId).gt('sequence', args.afterSequence)
		)
		.take(TERMINAL_CLEANUP_PAGE_SIZE);
	for (const question of questions) {
		if (question.status === 'pending') {
			await ctx.db.patch('agentQuestions', question._id, {
				status: 'cancelled',
				answeredAt: args.completedAt
			});
		}
	}
	const last = questions.at(-1);
	return {
		done: questions.length < TERMINAL_CLEANUP_PAGE_SIZE,
		nextSequence: last?.sequence ?? args.afterSequence
	};
}

async function recordToolTranscriptsPage(
	ctx: MutationCtx,
	args: {
		run: Doc<'runs'>;
		afterSequence: number;
	}
): Promise<TerminalCleanupResult> {
	if (!isRunFinalStatus(args.run.status)) {
		return { done: true, nextSequence: args.afterSequence };
	}
	const jobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) =>
			query.eq('runId', args.run._id).gt('sequence', args.afterSequence)
		)
		.take(TERMINAL_CLEANUP_PAGE_SIZE);
	for (const job of jobs) {
		await recordToolTranscript(ctx, {
			threadId: args.run.threadId,
			userId: args.run.userId,
			runId: args.run._id,
			job
		});
	}
	const last = jobs.at(-1);
	return {
		done: jobs.length < TERMINAL_CLEANUP_PAGE_SIZE,
		nextSequence: last?.sequence ?? args.afterSequence
	};
}

export async function advanceTerminalCleanup(
	ctx: MutationCtx,
	args: {
		run: Doc<'runs'>;
		lastError?: string;
		completedAt: number;
		jobCursor: number;
		questionCursor: number;
		transcriptCursor: number;
	}
): Promise<{
	done: boolean;
	jobCursor: number;
	questionCursor: number;
	transcriptCursor: number;
}> {
	const jobs = await cancelExecutorJobsPage(ctx, {
		runId: args.run._id,
		runStatus: args.run.status,
		lastError: args.lastError,
		completedAt: args.completedAt,
		afterSequence: args.jobCursor
	});
	if (!jobs.done) {
		return {
			done: false,
			jobCursor: jobs.nextSequence,
			questionCursor: args.questionCursor,
			transcriptCursor: args.transcriptCursor
		};
	}
	const questions = await cancelPendingQuestionsPage(ctx, {
		runId: args.run._id,
		completedAt: args.completedAt,
		afterSequence: args.questionCursor
	});
	if (!questions.done) {
		return {
			done: false,
			jobCursor: jobs.nextSequence,
			questionCursor: questions.nextSequence,
			transcriptCursor: args.transcriptCursor
		};
	}
	const latest = await ctx.db.get('runs', args.run._id);
	if (!latest || !isRunFinalStatus(latest.status)) {
		return {
			done: true,
			jobCursor: jobs.nextSequence,
			questionCursor: questions.nextSequence,
			transcriptCursor: args.transcriptCursor
		};
	}
	const transcripts = await recordToolTranscriptsPage(ctx, {
		run: latest,
		afterSequence: args.transcriptCursor
	});
	return {
		done: transcripts.done,
		jobCursor: jobs.nextSequence,
		questionCursor: questions.nextSequence,
		transcriptCursor: transcripts.nextSequence
	};
}

export async function reconcileTerminalRunPages(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	args: { lastError?: string; completedAt: number }
): Promise<void> {
	let jobCursor = -1;
	let questionCursor = -1;
	let transcriptCursor = -1;
	for (;;) {
		const page = await advanceTerminalCleanup(ctx, {
			run,
			lastError: args.lastError,
			completedAt: args.completedAt,
			jobCursor,
			questionCursor,
			transcriptCursor
		});
		if (page.done) {
			return;
		}
		jobCursor = page.jobCursor;
		questionCursor = page.questionCursor;
		transcriptCursor = page.transcriptCursor;
	}
}
