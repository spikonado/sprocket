import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type DocumentByName,
	type GenericDatabaseReader,
	type GenericDatabaseWriter
} from 'convex/server';
import { v, type Infer } from 'convex/values';
import type { DatabaseReader, DatabaseWriter } from '@convex/_generated/server';
import { vArtifactScope, vArtifactType } from '@convex/lib/validators';

/** Artifacts scanned per archive mutation. */
export const ARTIFACT_ARCHIVE_PAGE_SIZE = 8;
/** Version rows archived (or one metadata-only artifact) per mutation. */
export const ARTIFACT_ARCHIVE_MAX_VERSIONS = 4;
/** Pagination byte cap so a page of leftover content stays inside Convex read limits. */
export const ARTIFACT_ARCHIVE_MAX_BYTES_READ = 1_000_000;

const vLegacyArtifactDocument = v.object({
	threadId: v.id('threadRecords'),
	userId: v.string(),
	title: v.string(),
	type: vArtifactType,
	currentVersion: v.number(),
	createdById: v.id('runs'),
	createdAt: v.number(),
	updatedAt: v.number(),
	scope: v.optional(vArtifactScope),
	repositoryKey: v.optional(v.string()),
	registrationId: v.optional(v.string()),
	content: v.optional(v.string()),
	revision: v.optional(v.number())
});

const vActiveArtifactDocument = v.object({
	userId: v.string(),
	scope: vArtifactScope,
	repositoryKey: v.string(),
	threadId: v.optional(v.id('threadRecords')),
	registrationId: v.string(),
	content: v.string(),
	type: vArtifactType,
	title: v.string(),
	revision: v.number(),
	createdAt: v.number(),
	updatedAt: v.number(),
	currentVersion: v.optional(v.number()),
	createdById: v.optional(v.id('runs'))
});

export const vOldArtifactDocument = v.object({
	legacyArtifactId: v.string(),
	userId: v.string(),
	threadId: v.optional(v.id('threadRecords')),
	title: v.string(),
	type: v.optional(vArtifactType),
	currentVersion: v.optional(v.number()),
	createdById: v.optional(v.id('runs')),
	createdAt: v.number(),
	updatedAt: v.optional(v.number()),
	version: v.number(),
	content: v.string(),
	versionCreatedAt: v.number(),
	legacyVersionId: v.optional(v.string()),
	archivedAt: v.number()
});

export const vArchivePageResult = v.object({
	isDone: v.boolean(),
	continueCursor: v.union(v.string(), v.null()),
	archivedVersions: v.number(),
	deletedArtifacts: v.number(),
	scanned: v.number()
});

export type ArchivePageResult = Infer<typeof vArchivePageResult>;

export const stagingArtifactsTable = defineTable(
	v.union(vLegacyArtifactDocument, vActiveArtifactDocument)
)
	.index('by_threadId', ['threadId'])
	.index('by_threadId_title', ['threadId', 'title'])
	.index('by_userId_and_registrationId', ['userId', 'registrationId'])
	.index('by_userId_and_repositoryKey_and_scope', ['userId', 'repositoryKey', 'scope']);

export const artifactVersionsTable = defineTable({
	artifactId: v.id('artifacts'),
	userId: v.string(),
	version: v.number(),
	content: v.string(),
	createdAt: v.number()
}).index('by_artifactId_version', ['artifactId', 'version']);

const oldArtifactsTable = defineTable(vOldArtifactDocument)
	.index('by_legacyArtifactId_and_version', ['legacyArtifactId', 'version'])
	.index('by_threadId', ['threadId'])
	.index('by_userId', ['userId']);

export const archiveSchema = defineSchema({
	artifacts: stagingArtifactsTable,
	artifactVersions: artifactVersionsTable,
	oldArtifacts: oldArtifactsTable
});

export type ArchiveDataModel = DataModelFromSchemaDefinition<typeof archiveSchema>;
type ArchiveWriter = GenericDatabaseWriter<ArchiveDataModel>;
type ArchiveReader = GenericDatabaseReader<ArchiveDataModel>;
type ArchiveArtifact = DocumentByName<ArchiveDataModel, 'artifacts'>;
type ArchiveVersion = DocumentByName<ArchiveDataModel, 'artifactVersions'>;

export function asArchiveDb(db: DatabaseWriter): GenericDatabaseWriter<ArchiveDataModel>;
export function asArchiveDb(db: DatabaseReader): GenericDatabaseReader<ArchiveDataModel>;
export function asArchiveDb(
	db: DatabaseWriter | DatabaseReader
): GenericDatabaseWriter<ArchiveDataModel> | GenericDatabaseReader<ArchiveDataModel> {
	// SAFETY: staging overlay (and overlay tests) union legacy/active
	// `artifacts` and add `artifactVersions`. Generated DataModel is the
	// post-migration schema. This is the only conversion from DatabaseWriter/Reader.
	return db as GenericDatabaseWriter<ArchiveDataModel>;
}

function isActiveArtifact(artifact: ArchiveArtifact): boolean {
	return (
		artifact.scope !== undefined &&
		artifact.registrationId !== undefined &&
		artifact.repositoryKey !== undefined &&
		artifact.revision !== undefined &&
		artifact.content !== undefined
	);
}

const paginationBound = {
	numItems: ARTIFACT_ARCHIVE_PAGE_SIZE,
	maximumRowsRead: ARTIFACT_ARCHIVE_PAGE_SIZE,
	maximumBytesRead: ARTIFACT_ARCHIVE_MAX_BYTES_READ
} as const;

function artifactMetadata(artifact: ArchiveArtifact) {
	return {
		legacyArtifactId: artifact._id,
		userId: artifact.userId,
		threadId: artifact.threadId,
		title: artifact.title,
		type: artifact.type,
		currentVersion: artifact.currentVersion,
		createdById: artifact.createdById,
		createdAt: artifact.createdAt,
		updatedAt: artifact.updatedAt
	};
}

async function archiveVersionRow(
	db: ArchiveWriter,
	row: Infer<typeof vOldArtifactDocument>,
	versionId: ArchiveVersion['_id']
) {
	await db.insert('oldArtifacts', row);
	await db.delete('artifactVersions', versionId);
}

async function archiveLegacyArtifact(
	db: ArchiveWriter,
	artifact: ArchiveArtifact,
	archivedAt: number,
	budget: number
): Promise<{ archived: number; deletedArtifact: boolean; remaining: boolean }> {
	const versions = await db
		.query('artifactVersions')
		.withIndex('by_artifactId_version', (q) => q.eq('artifactId', artifact._id))
		.take(budget);
	for (const version of versions) {
		await archiveVersionRow(
			db,
			{
				...artifactMetadata(artifact),
				version: version.version,
				content: version.content,
				versionCreatedAt: version.createdAt,
				legacyVersionId: version._id,
				archivedAt
			},
			version._id
		);
	}
	const leftoverVersion = await db
		.query('artifactVersions')
		.withIndex('by_artifactId_version', (q) => q.eq('artifactId', artifact._id))
		.first();
	if (leftoverVersion) {
		return { archived: versions.length, deletedArtifact: false, remaining: true };
	}
	if (versions.length === 0) {
		await db.insert('oldArtifacts', {
			...artifactMetadata(artifact),
			version: artifact.currentVersion ?? 0,
			content: '',
			versionCreatedAt: artifact.createdAt,
			archivedAt
		});
	}
	await db.delete('artifacts', artifact._id);
	return {
		archived: versions.length === 0 ? 1 : versions.length,
		deletedArtifact: true,
		remaining: false
	};
}

async function archiveOrphanVersions(db: ArchiveWriter, archivedAt: number, budget: number) {
	if (budget < 1) return 0;
	const versions = await db.query('artifactVersions').take(budget);
	for (const version of versions) {
		await archiveVersionRow(
			db,
			{
				legacyArtifactId: version.artifactId,
				userId: version.userId,
				title: '',
				createdAt: version.createdAt,
				version: version.version,
				content: version.content,
				versionCreatedAt: version.createdAt,
				legacyVersionId: version._id,
				archivedAt
			},
			version._id
		);
	}
	return versions.length;
}

export async function runArchivePage(
	db: ArchiveWriter,
	args: { cursor: string | null }
): Promise<ArchivePageResult> {
	const archivedAt = Date.now();
	const page = await db.query('artifacts').paginate({
		cursor: args.cursor,
		...paginationBound
	});
	let budget = ARTIFACT_ARCHIVE_MAX_VERSIONS;
	let archivedVersions = 0;
	let deletedArtifacts = 0;
	let incomplete = false;

	for (const artifact of page.page) {
		if (isActiveArtifact(artifact)) continue;
		if (budget < 1) {
			incomplete = true;
			break;
		}
		const result = await archiveLegacyArtifact(db, artifact, archivedAt, budget);
		archivedVersions += result.archived;
		budget -= Math.max(result.archived, 1);
		if (result.deletedArtifact) deletedArtifacts += 1;
		if (result.remaining) {
			incomplete = true;
			break;
		}
	}

	if (!incomplete && page.isDone) {
		archivedVersions += await archiveOrphanVersions(db, archivedAt, budget);
		if (await db.query('artifactVersions').first()) incomplete = true;
	}

	const isDone = page.isDone && !incomplete;
	return {
		isDone,
		continueCursor: isDone ? null : incomplete ? args.cursor : page.continueCursor,
		archivedVersions,
		deletedArtifacts,
		scanned: page.page.length
	};
}

export async function leftoverLegacyPresent(db: ArchiveReader, cursor: string | null) {
	if (await db.query('artifactVersions').first()) {
		return { leftover: true, isDone: true, continueCursor: null };
	}
	const page = await db.query('artifacts').paginate({
		cursor,
		...paginationBound
	});
	return {
		leftover: page.page.some((artifact) => !isActiveArtifact(artifact)),
		isDone: page.isDone,
		continueCursor: page.isDone ? null : page.continueCursor
	};
}
