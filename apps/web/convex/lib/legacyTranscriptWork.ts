import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { completionSourceKey } from '@convex/lib/transcriptParts';
import type { TranscriptCompletionItem } from '@convex/lib/validators';

type PersistedWork = Doc<'threadTranscriptParts'>['work'];

type CompletionWork = {
	work: PersistedWork;
	toolInvocations: { callId: string; toolInvocationId: string; sectionKey?: string }[];
};

function legacySectionOrdinal(sectionKey: string): number {
	const suffix = /:section:(\d+)$/u.exec(sectionKey)?.[1];
	const ordinal = suffix === undefined ? NaN : Number(suffix);

	if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
		throw new Error('Invalid legacy section key.');
	}

	return ordinal;
}

function hasText(items: TranscriptCompletionItem[]): boolean {
	return items.some((item) => item.type === 'text' && item.text.trim().length > 0);
}

export async function deriveLegacyCompletionWork(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		claimId: string;
		attemptSeq: number;
		streamId: string;
		items: TranscriptCompletionItem[];
	}
): Promise<CompletionWork> {
	const existing = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_sourceKey', (query) =>
			query
				.eq('threadId', args.threadId)
				.eq('sourceKey', completionSourceKey(args.runId, args.streamId))
		)
		.unique();

	let work: PersistedWork;

	if (existing) {
		work = existing.work;
	} else {
		let openSection: string | undefined;
		let nextOrdinal = 1;
		let closed = false;

		const firstPart = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (query) =>
				query.eq('threadId', args.threadId).eq('runId', args.runId)
			)
			.first();

		if (firstPart) {
			for await (const part of ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_kind_number', (query) =>
					query
						.eq('threadId', args.threadId)
						.eq('kind', 'completion')
						.gte('number', firstPart.number)
				)
				.order('desc')) {
				if (part.runId !== args.runId || !part.completion) continue;
				const range = part.work.ranges.at(-1);

				if (!range) {
					closed ||= hasText(part.completion.items);
					continue;
				}

				const sectionOrdinal = legacySectionOrdinal(range.sectionKey);
				nextOrdinal = sectionOrdinal + 1;

				if (
					!closed &&
					range.sectionKey.startsWith(`agent:${args.runId}:${args.claimId}:`) &&
					!hasText(part.completion.items.slice(range.end))
				) {
					openSection = range.sectionKey;
				}

				break;
			}
		}

		work = { ranges: [] };

		for (const [index, item] of args.items.entries()) {
			if (item.type === 'text') {
				if (item.text.trim() && openSection) {
					openSection = undefined;
				}

				continue;
			}

			if (item.type === 'reasoning' && !item.text.trim()) continue;

			if (!openSection) {
				const sectionOrdinal = nextOrdinal++;
				openSection = `agent:${args.runId}:${args.claimId}:${args.attemptSeq}:section:${sectionOrdinal}`;
			}

			const lastRange = work.ranges.at(-1);

			if (lastRange?.end === index && lastRange.sectionKey === openSection) {
				lastRange.end++;
			} else {
				work.ranges.push({ start: index, end: index + 1, sectionKey: openSection });
			}
		}
	}

	const toolInvocations = args.items.flatMap((item, index) => {
		if (item.type !== 'tool-call') return [];

		if (!item.toolInvocationId) {
			throw new Error('Missing canonical tool invocation ID.');
		}

		const range = work.ranges.find((range) => range.start <= index && index < range.end);

		if (!range) throw new Error('Canonical tool call has no legacy section.');

		return [
			{ callId: item.callId, toolInvocationId: item.toolInvocationId, sectionKey: range.sectionKey }
		];
	});

	return { work, toolInvocations };
}

/** Current agents omit sections, so their jobs take the section of their saved call item. */
export async function legacyCallSectionKey(
	ctx: MutationCtx,
	args: { run: Doc<'runs'>; streamId: string; toolInvocationId: string; callId?: string }
): Promise<string> {
	const completion = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_sourceKey', (query) =>
			query
				.eq('threadId', args.run.threadId)
				.eq('sourceKey', completionSourceKey(args.run._id, args.streamId))
		)
		.unique();

	const items = completion?.completion?.items ?? [];

	const index = items.findIndex(
		(item) => item.type === 'tool-call' && item.toolInvocationId === args.toolInvocationId
	);

	const item = items[index];
	const range = completion?.work.ranges.find(({ start, end }) => start <= index && index < end);

	if (
		item?.type !== 'tool-call' ||
		!range ||
		(args.callId !== undefined && item.callId !== args.callId)
	) {
		throw new Error('Tool invocation does not match a saved completion call.');
	}

	return range.sectionKey;
}
