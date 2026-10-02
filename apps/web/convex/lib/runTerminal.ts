import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { cancelExecutorJobsForTerminalRun } from '@convex/lib/runs';
import { cancelCloudToolJob } from '@convex/lib/toolJobs';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';

const TERMINAL_CLEANUP_BATCH_SIZE = 16;

const READ_RESERVE_BYTES = 6 * 1024 * 1024;

const WRITE_RESERVE_BYTES = 4 * 1024 * 1024;

async function hasCleanupHeadroom(ctx: MutationCtx): Promise<boolean> {
	const metrics = await ctx.meta.getTransactionMetrics();

	// Reserve enough for the next maximum-sized job, its transcript/section
	// reads, and whatever work the caller still has to do inline.
	return (
		metrics.bytesRead.remaining > READ_RESERVE_BYTES &&
		metrics.bytesWritten.remaining > WRITE_RESERVE_BYTES &&
		metrics.databaseQueries.remaining > 100 &&
		metrics.documentsWritten.remaining > 100
	);
}

export async function reconcileTerminalRun(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	args: { completedAt: number; jobCursor: number; questionCursor: number | null }
): Promise<void> {
	let { jobCursor, questionCursor } = args;
	let processed = 0;

	async function scheduleContinuation() {
		await ctx.scheduler.runAfter(0, internal.runCleanup.continueCleanup, {
			runId: run._id,
			completedAt: args.completedAt,
			jobCursor,
			questionCursor
		});
	}

	if (!(await hasCleanupHeadroom(ctx))) {
		await scheduleContinuation();

		return;
	}

	if (questionCursor !== null) {
		const afterQuestion = questionCursor;

		const questions = ctx.db
			.query('agentQuestions')
			.withIndex('by_runId_sequence', (query) =>
				query.eq('runId', run._id).gt('sequence', afterQuestion)
			);

		for await (const question of questions) {
			if (question.status === 'pending') {
				await ctx.db.patch(
					'agentQuestions',
					question._id,
					run.status === 'cancelled'
						? { status: 'cancelled', answeredAt: args.completedAt }
						: { requiresContinuation: true }
				);
			}

			questionCursor = question.sequence;
			processed++;

			if (processed >= TERMINAL_CLEANUP_BATCH_SIZE || !(await hasCleanupHeadroom(ctx))) {
				await scheduleContinuation();

				return;
			}
		}

		questionCursor = null;
	}

	const jobs = ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) =>
			query.eq('runId', run._id).gt('sequence', jobCursor)
		);

	for await (const job of jobs) {
		await cancelCloudToolJob(ctx, job);

		const [finalizedJob] = cancelExecutorJobsForTerminalRun({
			jobs: [job],
			runStatus: run.status,
			lastError: run.lastError,
			completedAt: args.completedAt
		});

		if (finalizedJob !== job) {
			await ctx.db.patch('executorJobs', job._id, {
				status: finalizedJob.status,
				error: finalizedJob.error,
				completedAt: finalizedJob.completedAt
			});
		}

		await recordToolTranscript(ctx, {
			threadId: run.threadId,
			userId: run.userId,
			runId: run._id,
			job: finalizedJob
		});
		jobCursor = job.sequence;
		processed++;

		if (processed >= TERMINAL_CLEANUP_BATCH_SIZE || !(await hasCleanupHeadroom(ctx))) {
			await scheduleContinuation();

			return;
		}
	}
}
