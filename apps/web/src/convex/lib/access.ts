import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { pickPrimaryUser, type OwnerKeys } from './auth';

type OwnedTableName = 'threadRecords' | 'runs';

/**
 * Expand a stored owner field into the key pair that can match it. Rows
 * written pre-migration carry the legacy subject; post-migration rows carry
 * the tokenIdentifier. When a users row links the two, a stored key of either
 * form validates rows of both forms; rows without a users record only match
 * their own literal key.
 */
export async function resolveStoredOwnerKeys(
	db: DatabaseReader,
	userId: string
): Promise<OwnerKeys> {
	const subjectRows = await db
		.query('users')
		.withIndex('by_subject', (query) => query.eq('subject', userId))
		.collect();
	const bySubject = pickPrimaryUser(subjectRows);
	if (bySubject) {
		return { userId: bySubject.tokenIdentifier, subject: bySubject.subject };
	}
	const tokenRows = await db
		.query('users')
		.withIndex('by_tokenIdentifier', (query) => query.eq('tokenIdentifier', userId))
		.collect();
	const byToken = pickPrimaryUser(tokenRows);
	if (byToken) {
		return { userId: byToken.tokenIdentifier, subject: byToken.subject };
	}
	return { userId, subject: userId };
}

async function assertOwned<TableName extends OwnedTableName>(
	record: Doc<TableName> | null,
	keys: OwnerKeys,
	errorMessage: string
): Promise<Doc<TableName>> {
	if (!record || (record.userId !== keys.userId && record.userId !== keys.subject)) {
		throw new Error(errorMessage);
	}
	return record;
}

export async function getOwnedThreadRecord(
	db: DatabaseReader,
	keys: OwnerKeys,
	threadRecordId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	return await assertOwned<'threadRecords'>(
		await db.get('threadRecords', threadRecordId),
		keys,
		'Thread not found.'
	);
}

export async function getOwnedRun(
	db: DatabaseReader,
	keys: OwnerKeys,
	runId: Id<'runs'>
): Promise<Doc<'runs'>> {
	return await assertOwned<'runs'>(await db.get('runs', runId), keys, 'Run not found.');
}

/** Ownership gate keyed by a stored row's own userId field (executor-side
 * capability paths hold the run's userId, not the caller identity). Legacy
 * pre-migration rows carry the subject; expansion covers both forms. */
export async function getOwnedThreadRecordForStoredUserId(
	db: DatabaseReader,
	userId: string,
	threadRecordId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	return await assertOwned<'threadRecords'>(
		await db.get('threadRecords', threadRecordId),
		await resolveStoredOwnerKeys(db, userId),
		'Thread not found.'
	);
}
