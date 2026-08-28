import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';

type OwnerScopedTable = 'threadRecords' | 'runs';

async function assertOwned<TableName extends OwnerScopedTable>(
	record: Doc<TableName> | null,
	userId: string,
	errorMessage: string
): Promise<Doc<TableName>> {
	if (!record || record.userId !== userId) {
		throw new Error(errorMessage);
	}
	return record;
}

export async function getOwnedThreadRecord(
	db: DatabaseReader,
	userId: string,
	threadRecordId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	return await assertOwned<'threadRecords'>(
		await db.get('threadRecords', threadRecordId),
		userId,
		'Thread not found.'
	);
}

export async function getOwnedRun(
	db: DatabaseReader,
	userId: string,
	runId: Id<'runs'>
): Promise<Doc<'runs'>> {
	return await assertOwned<'runs'>(await db.get('runs', runId), userId, 'Run not found.');
}
