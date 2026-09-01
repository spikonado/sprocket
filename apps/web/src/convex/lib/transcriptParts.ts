import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type {
	TranscriptCompletionBody,
	TranscriptPromptBody,
	TranscriptToolBody
} from '@convex/lib/validators';

const MAX_TRANSCRIPT_PARTS_PER_QUERY = 100;

export function promptSourceKey(runId: Id<'runs'>): string {
	return `prompt:${runId}`;
}

export function completionSourceKey(runId: Id<'runs'>, streamId: string): string {
	return `completion:${runId}:${streamId}`;
}

export type ToolTranscriptPhase = 'started' | 'finished';

export function newToolInvocationId(): string {
	return crypto.randomUUID();
}

export function toolInvocationIdForJob(job: {
	_id: Id<'executorJobs'>;
	toolInvocationId?: string;
}): string {
	return job.toolInvocationId ?? job._id;
}

export function toolSourceKey(toolInvocationId: string, phase: ToolTranscriptPhase): string {
	return `tool:${toolInvocationId}:${phase}`;
}

export function isTranscriptToolTerminalStatus(
	status: TranscriptToolBody['status']
): status is 'completed' | 'failed' | 'cancelled' {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export async function getTranscriptState(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadTranscriptStates'> | null> {
	return await ctx.db
		.query('threadTranscriptStates')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.unique();
}

export async function getOrCreateTranscriptState(
	ctx: MutationCtx,
	args: { threadId: Id<'threadRecords'>; userId: string }
): Promise<Doc<'threadTranscriptStates'>> {
	const existing = await getTranscriptState(ctx, args.threadId);
	if (existing) {
		return existing;
	}
	const stateId = await ctx.db.insert('threadTranscriptStates', {
		threadId: args.threadId,
		userId: args.userId,
		totalParts: 0
	});
	const created = await ctx.db.get('threadTranscriptStates', stateId);
	if (!created) {
		throw new Error('Failed to create transcript state.');
	}
	return created;
}

type AppendTranscriptPartArgs = {
	threadId: Id<'threadRecords'>;
	userId: string;
	sourceKey: string;
	kind: Doc<'threadTranscriptParts'>['kind'];
	runId: Id<'runs'>;
	prompt?: TranscriptPromptBody;
	completion?: TranscriptCompletionBody;
	tool?: TranscriptToolBody;
};

type TranscriptPartInsert = {
	threadId: Id<'threadRecords'>;
	userId: string;
	number: number;
	sourceKey: string;
	kind: Doc<'threadTranscriptParts'>['kind'];
	runId: Id<'runs'>;
	prompt?: TranscriptPromptBody;
	completion?: TranscriptCompletionBody;
	tool?: TranscriptToolBody;
};

export async function appendTranscriptPart(
	ctx: MutationCtx,
	args: AppendTranscriptPartArgs
): Promise<{ part: Doc<'threadTranscriptParts'>; inserted: boolean }> {
	const existing = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_sourceKey', (query) =>
			query.eq('threadId', args.threadId).eq('sourceKey', args.sourceKey)
		)
		.unique();
	if (existing) {
		return { part: existing, inserted: false };
	}

	const state = await getOrCreateTranscriptState(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	const number = state.totalParts;
	const part: TranscriptPartInsert = {
		threadId: args.threadId,
		userId: args.userId,
		number,
		sourceKey: args.sourceKey,
		kind: args.kind,
		runId: args.runId
	};
	if (args.prompt) part.prompt = args.prompt;
	if (args.completion) part.completion = args.completion;
	if (args.tool) part.tool = args.tool;
	const partId = await ctx.db.insert('threadTranscriptParts', part);
	await ctx.db.patch('threadTranscriptStates', state._id, { totalParts: number + 1 });
	const inserted = await ctx.db.get('threadTranscriptParts', partId);
	if (!inserted) {
		throw new Error('Failed to create transcript part.');
	}
	return { part: inserted, inserted: true };
}

export async function loadTranscriptPartsByNumbers(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>,
	numbers: number[]
): Promise<Doc<'threadTranscriptParts'>[]> {
	if (numbers.length > MAX_TRANSCRIPT_PARTS_PER_QUERY) {
		throw new Error(`Request at most ${MAX_TRANSCRIPT_PARTS_PER_QUERY} transcript parts.`);
	}
	const unique = [...new Set(numbers)].filter((value) => Number.isInteger(value) && value >= 0);
	const byNumber = new Map<number, Doc<'threadTranscriptParts'>>();
	await Promise.all(
		unique.map(async (number) => {
			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) =>
					query.eq('threadId', threadId).eq('number', number)
				)
				.unique();
			if (part) {
				byNumber.set(number, part);
			}
		})
	);
	return numbers.flatMap((number) => {
		const part = byNumber.get(number);
		return part ? [part] : [];
	});
}

export async function attachmentMetaForUploads(
	ctx: MutationCtx | QueryCtx,
	imageUploadIds: Id<'imageUploads'>[] | undefined
): Promise<TranscriptPromptBody['imageUploads']> {
	if (!imageUploadIds || imageUploadIds.length === 0) {
		return [];
	}
	return (
		await Promise.all(
			imageUploadIds.map(async (imageUploadId) => {
				const upload = await ctx.db.get('imageUploads', imageUploadId);
				if (!upload) {
					return null;
				}
				return {
					imageUploadId: upload._id,
					name: upload.name,
					mediaType: upload.mediaType,
					size: upload.size,
					storageId: upload.storageId
				};
			})
		)
	).filter((attachment) => attachment !== null);
}

export async function hydrateTranscriptPartUrls(
	ctx: MutationCtx | QueryCtx,
	parts: Doc<'threadTranscriptParts'>[]
): Promise<Doc<'threadTranscriptParts'>[]> {
	return await Promise.all(
		parts.map(async (part) => {
			if (!part.prompt || part.prompt.imageUploads.length === 0) {
				return part;
			}
			const imageUploads = await Promise.all(
				part.prompt.imageUploads.map(async (upload) => {
					const url = await ctx.storage.getUrl(upload.storageId);
					return url ? { ...upload, url } : upload;
				})
			);
			return {
				...part,
				prompt: { ...part.prompt, imageUploads }
			};
		})
	);
}
