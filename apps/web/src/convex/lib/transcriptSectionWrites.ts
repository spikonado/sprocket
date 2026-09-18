import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';

export type PersistedWork = NonNullable<Doc<'threadTranscriptParts'>['work']>;

type SectionMetadata = {
	sectionKey: string;
	sectionOrdinal: number;
	closed: boolean;
};

function entryKey(
	partNumber: number,
	start: number,
	sectionKey: string,
	toolInvocationId?: string
) {
	return toolInvocationId
		? `tool:${partNumber}:${toolInvocationId}`
		: `range:${partNumber}:${start}:${sectionKey}`;
}

function validateOrdinal(value: number) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid section ordinal.');
}

export function sectionDisplayOrder(
	startedAt: number,
	runId: string,
	sectionOrdinal: number
): string {
	return `${String(startedAt).padStart(16, '0')}:${runId}:${String(sectionOrdinal).padStart(12, '0')}`;
}

async function persistedSectionDisplayOrder(
	ctx: MutationCtx,
	runId: Id<'runs'>,
	sectionOrdinal: number
): Promise<string> {
	const run = await ctx.db.get('runs', runId);
	if (!run) throw new Error('Section run not found.');
	return sectionDisplayOrder(run.startedAt, run._id, sectionOrdinal);
}

async function updateSummary(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		partNumber: number;
		start: number;
		end: number;
		metadata: SectionMetadata;
		itemDelta: number;
		pendingDelta: number;
		startedAt?: number;
		completedAt?: number;
	}
) {
	validateOrdinal(args.metadata.sectionOrdinal);
	const displayOrder = await persistedSectionDisplayOrder(
		ctx,
		args.runId,
		args.metadata.sectionOrdinal
	);
	const existing = await ctx.db
		.query('threadTranscriptWorkSections')
		.withIndex('by_threadId_and_key', (q) =>
			q.eq('threadId', args.threadId).eq('key', args.metadata.sectionKey)
		)
		.unique();
	const first = { part: args.partNumber, item: args.start };
	const end = { part: args.partNumber, item: args.end };
	if (!existing) {
		await ctx.db.insert('threadTranscriptWorkSections', {
			threadId: args.threadId,
			key: args.metadata.sectionKey,
			runId: args.runId,
			sectionOrdinal: args.metadata.sectionOrdinal,
			displayOrder,
			first,
			end,
			closed: args.metadata.closed,
			provisional: false,
			itemCount: Math.max(1, args.itemDelta),
			pendingTools: Math.max(0, args.pendingDelta),
			startedAt: args.startedAt,
			completedAt: args.pendingDelta > 0 ? undefined : args.completedAt
		});
		return;
	}
	if (
		existing.runId !== args.runId ||
		(existing.displayOrder !== undefined && existing.displayOrder !== displayOrder) ||
		(existing.sectionOrdinal !== undefined &&
			existing.sectionOrdinal !== args.metadata.sectionOrdinal)
	) {
		throw new Error('Section identity conflicts with an existing section.');
	}
	const pendingTools = Math.max(0, existing.pendingTools + args.pendingDelta);
	await ctx.db.patch('threadTranscriptWorkSections', existing._id, {
		sectionOrdinal: args.metadata.sectionOrdinal,
		displayOrder,
		end:
			existing.end.part > end.part ||
			(existing.end.part === end.part && existing.end.item >= end.item)
				? existing.end
				: end,
		closed: existing.closed || args.metadata.closed,
		itemCount: existing.itemCount + args.itemDelta,
		pendingTools,
		startedAt: existing.startedAt ?? args.startedAt,
		completedAt: pendingTools === 0 ? (args.completedAt ?? existing.completedAt) : undefined
	});
}

async function insertEntry(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		partNumber: number;
		sectionKey: string;
		start: number;
		end: number;
		toolInvocationId?: string;
		sectionOrdinal: number;
		closed: boolean;
	}
) {
	const key = entryKey(args.partNumber, args.start, args.sectionKey, args.toolInvocationId);
	const existing = await ctx.db
		.query('threadTranscriptMemberships')
		.withIndex('by_threadId_and_entryKey', (q) =>
			q.eq('threadId', args.threadId).eq('entryKey', key)
		)
		.unique();
	if (existing) {
		if (
			existing.runId !== args.runId ||
			existing.partNumber !== args.partNumber ||
			existing.sectionKey !== args.sectionKey ||
			existing.start !== args.start ||
			existing.end !== args.end ||
			existing.toolInvocationId !== args.toolInvocationId ||
			existing.sectionOrdinal !== args.sectionOrdinal ||
			existing.closed !== args.closed
		) {
			throw new Error('Conflicting transcript section retry.');
		}
		return false;
	}
	await ctx.db.insert('threadTranscriptMemberships', { ...args, entryKey: key });
	return true;
}

export async function writeCompletionSectionData(
	ctx: MutationCtx,
	args: {
		part: Doc<'threadTranscriptParts'>;
		work: PersistedWork;
		sections: SectionMetadata[];
		representedCallIds?: Set<string>;
		preserveExistingSummaries?: boolean;
	}
) {
	const metadata = new Map(args.sections.map((section) => [section.sectionKey, section]));
	if (metadata.size !== args.sections.length) throw new Error('Duplicate section metadata.');
	let previousEnd = 0;
	for (const range of args.work.ranges) {
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < previousEnd ||
			range.end <= range.start ||
			range.end > (args.part.completion?.items.length ?? 0)
		) {
			throw new Error('Invalid completion work range.');
		}
		previousEnd = range.end;
		const section = metadata.get(range.sectionKey);
		if (!section) throw new Error('Completion work range has no section metadata.');
		const existingSummary = args.preserveExistingSummaries
			? await ctx.db
					.query('threadTranscriptWorkSections')
					.withIndex('by_threadId_and_key', (q) =>
						q.eq('threadId', args.part.threadId).eq('key', range.sectionKey)
					)
					.unique()
			: null;
		if (
			await insertEntry(ctx, {
				threadId: args.part.threadId,
				runId: args.part.runId,
				partNumber: args.part.number,
				sectionKey: range.sectionKey,
				start: range.start,
				end: range.end,
				sectionOrdinal: section.sectionOrdinal,
				closed: section.closed
			})
		) {
			const preserveExisting = existingSummary?.linkedParts !== undefined;
			const representedTools =
				args.part.completion?.items
					.slice(range.start, range.end)
					.filter((item) => item.type === 'tool-call' && args.representedCallIds?.has(item.callId))
					.length ?? 0;
			await updateSummary(ctx, {
				threadId: args.part.threadId,
				runId: args.part.runId,
				partNumber: args.part.number,
				start: range.start,
				end: range.end,
				metadata: section,
				itemDelta: preserveExisting ? 0 : range.end - range.start - representedTools,
				pendingDelta: 0
			});
		}
	}
}

export async function writeToolSectionData(
	ctx: MutationCtx,
	args: {
		part: Doc<'threadTranscriptParts'>;
		sectionKey: string;
		sectionOrdinal: number;
		toolInvocationId: string;
		started: boolean;
		occurredAt?: number;
		preserveExistingSummary?: boolean;
	}
) {
	if (
		!(await insertEntry(ctx, {
			threadId: args.part.threadId,
			runId: args.part.runId,
			partNumber: args.part.number,
			sectionKey: args.sectionKey,
			start: 0,
			end: 1,
			toolInvocationId: args.toolInvocationId,
			sectionOrdinal: args.sectionOrdinal,
			closed: false
		}))
	) {
		return;
	}
	const existingSummary = args.preserveExistingSummary
		? await ctx.db
				.query('threadTranscriptWorkSections')
				.withIndex('by_threadId_and_key', (q) =>
					q.eq('threadId', args.part.threadId).eq('key', args.sectionKey)
				)
				.unique()
		: null;
	await updateSummary(ctx, {
		threadId: args.part.threadId,
		runId: args.part.runId,
		partNumber: args.part.number,
		start: 0,
		end: 1,
		metadata: {
			sectionKey: args.sectionKey,
			sectionOrdinal: args.sectionOrdinal,
			closed: false
		},
		itemDelta: 0,
		pendingDelta: existingSummary?.linkedParts !== undefined ? 0 : args.started ? 1 : -1,
		startedAt: args.started ? args.occurredAt : undefined,
		completedAt: args.started ? undefined : args.occurredAt
	});
}
