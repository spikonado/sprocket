import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';

type OwnerScopedTable = 'workspaceSessions' | 'threadRecords' | 'runs';

async function getOwnedRecord<TableName extends OwnerScopedTable>(
	db: DatabaseReader,
	userId: string,
	id: Id<TableName>,
	errorMessage: string
): Promise<Doc<TableName>> {
	const record: Doc<TableName> | null = await db.get(id);
	if (!record || record.userId !== userId) {
		throw new Error(errorMessage);
	}
	return record;
}

export async function getWorkspaceSessionByUserAndPath(
	db: DatabaseReader,
	userId: string,
	workspacePath: string
): Promise<Doc<'workspaceSessions'> | null> {
	return await db
		.query('workspaceSessions')
		.withIndex('by_user_workspacePath', (query) =>
			query.eq('userId', userId).eq('workspacePath', workspacePath)
		)
		.unique();
}

export async function getOwnedWorkspaceSession(
	db: DatabaseReader,
	userId: string,
	workspaceSessionId: Id<'workspaceSessions'>
): Promise<Doc<'workspaceSessions'>> {
	return await getOwnedRecord<'workspaceSessions'>(
		db,
		userId,
		workspaceSessionId,
		'Workspace session not found.'
	);
}

export async function getOwnedThreadRecord(
	db: DatabaseReader,
	userId: string,
	threadRecordId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	return await getOwnedRecord<'threadRecords'>(db, userId, threadRecordId, 'Thread not found.');
}

export async function getOwnedRun(
	db: DatabaseReader,
	userId: string,
	runId: Id<'runs'>
): Promise<Doc<'runs'>> {
	return await getOwnedRecord<'runs'>(db, userId, runId, 'Run not found.');
}

export async function getOwnedExecutorJob(
	db: DatabaseReader,
	userId: string,
	jobId: Id<'executorJobs'>
): Promise<Doc<'executorJobs'>> {
	const job: Doc<'executorJobs'> | null = await db.get(jobId);
	if (!job) {
		throw new Error('Job not found.');
	}
	await getOwnedWorkspaceSession(db, userId, job.workspaceSessionId);
	return job;
}
