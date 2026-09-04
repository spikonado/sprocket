import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { absorbDuplicateArtifact } from '@convex/lib/artifactAbsorb';
import { threadProcessedTokens } from '@convex/lib/threadUsage';

function pickEarliestThread(rows: Array<Doc<'threadRecords'>>): Doc<'threadRecords'> | null {
	if (rows.length === 0) return null;
	return [...rows].sort(
		(a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id)
	)[0];
}

/** Move every dependent of `dropId` onto `keepId`, then delete `dropId`.
 * Used when concurrent create races leave two threadRecords for one submission. */
export async function absorbDuplicateThread(
	ctx: MutationCtx,
	keepId: Id<'threadRecords'>,
	dropId: Id<'threadRecords'>
): Promise<void> {
	if (keepId === dropId) return;

	const dropRuns = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', dropId))
		.collect();
	for (const run of dropRuns) {
		await ctx.db.patch('runs', run._id, { threadId: keepId });
	}

	const dropJobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', dropId))
		.collect();
	for (const job of dropJobs) {
		await ctx.db.patch('executorJobs', job._id, { threadId: keepId });
	}

	const dropQuestions = await ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', dropId))
		.collect();
	for (const question of dropQuestions) {
		await ctx.db.patch('agentQuestions', question._id, { threadId: keepId });
	}

	const dropArtifacts = await ctx.db
		.query('artifacts')
		.withIndex('by_threadId', (query) => query.eq('threadId', dropId))
		.collect();
	for (const artifact of dropArtifacts) {
		const clash = await ctx.db
			.query('artifacts')
			.withIndex('by_threadId_title', (query) =>
				query.eq('threadId', keepId).eq('title', artifact.title)
			)
			.first();
		if (clash) {
			await absorbDuplicateArtifact(ctx, clash._id, artifact._id);
		} else {
			await ctx.db.patch('artifacts', artifact._id, { threadId: keepId });
		}
	}

	const dropSessions = await ctx.db
		.query('browserSessions')
		.withIndex('by_thread', (query) => query.eq('threadId', dropId))
		.collect();
	for (const session of dropSessions) {
		const keepSession = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', keepId))
			.first();
		if (keepSession) {
			const preferDrop =
				session.startedAt > keepSession.startedAt ||
				(session.startedAt === keepSession.startedAt &&
					session._id.localeCompare(keepSession._id) > 0);
			if (preferDrop) {
				await ctx.db.patch('browserSessions', keepSession._id, {
					runId: session.runId,
					lastUsedRunId: session.lastUsedRunId,
					browserbaseSessionId: session.browserbaseSessionId,
					liveViewUrl: session.liveViewUrl,
					startedAt: session.startedAt
				});
			} else if (session.liveViewUrl && !keepSession.liveViewUrl) {
				await ctx.db.patch('browserSessions', keepSession._id, {
					liveViewUrl: session.liveViewUrl
				});
			}
			await ctx.db.delete('browserSessions', session._id);
		} else {
			await ctx.db.patch('browserSessions', session._id, { threadId: keepId });
		}
	}

	const keepStates = await ctx.db
		.query('threadTranscriptStates')
		.withIndex('by_threadId', (query) => query.eq('threadId', keepId))
		.collect();
	const dropStates = await ctx.db
		.query('threadTranscriptStates')
		.withIndex('by_threadId', (query) => query.eq('threadId', dropId))
		.collect();
	const keepState = keepStates[0] ?? null;
	for (const extra of keepStates.slice(1)) {
		await ctx.db.delete('threadTranscriptStates', extra._id);
	}
	const dropState = dropStates[0] ?? null;
	for (const extra of dropStates.slice(1)) {
		await ctx.db.delete('threadTranscriptStates', extra._id);
	}

	let nextNumber = keepState?.totalParts ?? 0;
	const dropParts = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_number', (query) => query.eq('threadId', dropId))
		.collect();
	for (const part of dropParts) {
		const sourceClash = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_sourceKey', (query) =>
				query.eq('threadId', keepId).eq('sourceKey', part.sourceKey)
			)
			.first();
		if (sourceClash) {
			await ctx.db.delete('threadTranscriptParts', part._id);
			continue;
		}
		const number = nextNumber;
		nextNumber += 1;
		await ctx.db.patch('threadTranscriptParts', part._id, {
			threadId: keepId,
			number
		});
	}
	if (dropState) {
		if (keepState) {
			await ctx.db.patch('threadTranscriptStates', keepState._id, {
				totalParts: Math.max(keepState.totalParts, nextNumber)
			});
			await ctx.db.delete('threadTranscriptStates', dropState._id);
		} else {
			await ctx.db.patch('threadTranscriptStates', dropState._id, {
				threadId: keepId,
				totalParts: nextNumber
			});
		}
	}

	let droppedDuplicateTokens = 0;
	const dropEvents = await ctx.db
		.query('threadUsageEvents')
		.withIndex('by_threadId_eventId', (query) => query.eq('threadId', dropId))
		.collect();
	for (const event of dropEvents) {
		const clash = await ctx.db
			.query('threadUsageEvents')
			.withIndex('by_threadId_eventId', (query) =>
				query.eq('threadId', keepId).eq('eventId', event.eventId)
			)
			.first();
		if (clash) {
			droppedDuplicateTokens += event.processedTokens;
			await threadProcessedTokens.deleteIfExists(ctx, event);
			await ctx.db.delete('threadUsageEvents', event._id);
			continue;
		}
		await threadProcessedTokens.deleteIfExists(ctx, event);
		await ctx.db.patch('threadUsageEvents', event._id, { threadId: keepId });
		const moved = await ctx.db.get('threadUsageEvents', event._id);
		if (moved) {
			await threadProcessedTokens.insertIfDoesNotExist(ctx, moved);
		}
	}

	const dropUsageRows = await ctx.db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', dropId))
		.collect();
	const keepUsageRows = await ctx.db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', keepId))
		.collect();
	let keepUsage = keepUsageRows[0] ?? null;
	for (const extra of keepUsageRows.slice(1)) {
		await ctx.db.delete('threadUsage', extra._id);
	}
	for (const row of dropUsageRows) {
		if (keepUsage) {
			const totalTokensProcessed = Math.max(
				0,
				keepUsage.totalTokensProcessed + row.totalTokensProcessed - droppedDuplicateTokens
			);
			droppedDuplicateTokens = 0;
			const contextTokens = keepUsage.contextTokens ?? row.contextTokens;
			await ctx.db.patch('threadUsage', keepUsage._id, {
				totalTokensProcessed,
				contextTokens
			});
			keepUsage = { ...keepUsage, totalTokensProcessed, contextTokens };
			await ctx.db.delete('threadUsage', row._id);
		} else {
			const totalTokensProcessed = Math.max(0, row.totalTokensProcessed - droppedDuplicateTokens);
			droppedDuplicateTokens = 0;
			await ctx.db.patch('threadUsage', row._id, {
				threadId: keepId,
				totalTokensProcessed
			});
			keepUsage = { ...row, threadId: keepId, totalTokensProcessed };
		}
	}

	await ctx.db.delete('threadRecords', dropId);
}

/** Collapse extra threadRecords that share a user+submission onto the earliest row. */
export async function collapseDuplicateSubmissionThreads(
	ctx: MutationCtx,
	userId: string,
	submissionId: string,
	keepId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	const rows = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_submissionId', (query) =>
			query.eq('userId', userId).eq('submissionId', submissionId)
		)
		.collect();
	const primary = pickEarliestThread(rows);
	const keep = primary ?? (await ctx.db.get('threadRecords', keepId));
	if (!keep) throw new Error('Thread not found.');
	for (const row of rows) {
		if (row._id !== keep._id) {
			await absorbDuplicateThread(ctx, keep._id, row._id);
		}
	}
	return (await ctx.db.get('threadRecords', keep._id)) ?? keep;
}
