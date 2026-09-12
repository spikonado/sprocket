import { mutation, query, type MutationCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from './lib/access';
import { getUserId } from './lib/auth';
import { getOrCreateTranscriptState, getTranscriptState } from './lib/transcriptParts';
import { checkPosition, workBatch } from './lib/workSections';
import { transcriptHistoryFromNumber } from './lib/contextHandoff';
import { isRunFinalStatus } from './lib/validators';

export const state = query({
	args: { threadId: v.id('threadRecords') },
	handler: async (ctx, { threadId }) => {
		const thread = await getOwnedThreadRecord(ctx.db, await getUserId(ctx), threadId);
		const transcript = await getTranscriptState(ctx, threadId);
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
			.order('desc')
			.first();
		return {
			totalParts: transcript?.totalParts ?? 0,
			through: transcript?.workThrough ?? { part: 0, item: 0 },
			historyFromNumber: await transcriptHistoryFromNumber(ctx, thread),
			contextSummary: thread.contextSummary ?? null,
			activeRunId:
				run && ['queued', 'running', 'awaiting_executor'].includes(run.status) ? run._id : null
		};
	}
});

export const sections = query({
	args: { threadId: v.id('threadRecords'), after: v.string(), before: v.optional(v.string()) },
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);
		const rows = await ctx.db
			.query('threadTranscriptWorkSections')
			.withIndex('by_threadId_and_key', (q) => {
				const range = q.eq('threadId', args.threadId).gt('key', args.after);
				return args.before === undefined ? range : range.lte('key', args.before);
			})
			.take(129);
		return { rows: rows.slice(0, 128), split: rows.length > 128 ? rows[63].key : null };
	}
});

export const memberships = query({
	args: { threadId: v.id('threadRecords'), start: v.number() },
	handler: async (ctx, { threadId, start }) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), threadId);
		checkPosition({ part: start, item: 0 });
		return (
			await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) =>
					q
						.eq('threadId', threadId)
						.gte('number', start)
						.lt('number', start + 8)
				)
				.take(8)
		).map((part) => ({ number: part.number, work: part.work ?? null }));
	}
});

export async function applyWorkBatch(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	batch: Infer<typeof workBatch>
) {
	checkPosition(batch.expected);
	checkPosition(batch.through);
	const state = await getTranscriptState(ctx, threadId);
	if (!state) throw new Error('Transcript not found.');
	const through = state.workThrough ?? { part: 0, item: 0 };
	if (through.part !== batch.expected.part || through.item !== batch.expected.item) return false;
	const finished = batch.finishedRunId !== undefined;
	if (
		batch.through.part < through.part ||
		(batch.through.part === through.part && batch.through.item < through.item) ||
		batch.through.part > through.part + 1 ||
		batch.through.part > state.totalParts ||
		batch.sections.length + batch.removed.length > 256 ||
		batch.memberships.length > 256
	)
		throw new Error('Invalid work batch.');
	if (
		new Set([...batch.sections.map((row) => row.key), ...batch.removed]).size !==
			batch.sections.length + batch.removed.length ||
		new Set(batch.memberships.map((link) => link.number)).size !== batch.memberships.length
	)
		throw new Error('Duplicate work assignments.');
	const parts = new Map<number, Doc<'threadTranscriptParts'> | null>();
	const loadPart = async (number: number) => {
		if (parts.has(number)) return parts.get(number) ?? null;
		const part = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (q) => q.eq('threadId', threadId).eq('number', number))
			.unique();
		parts.set(number, part);
		return part;
	};
	if (batch.finishedRunId !== undefined) {
		const run = await ctx.db.get('runs', batch.finishedRunId);
		if (
			run?.threadId !== threadId ||
			!isRunFinalStatus(run.status) ||
			compare(batch.through, through) !== 0 ||
			batch.memberships.length ||
			batch.removed.length ||
			!batch.sections.length
		)
			throw new Error('Invalid work finalization.');
	} else {
		const input = await loadPart(through.part);
		if (!input) throw new Error('Work input not found.');
		const itemCount = Math.max(1, input.completion?.items.length ?? 1);
		if (
			compare(batch.through, through) <= 0 ||
			through.item >= itemCount ||
			(batch.through.part === through.part && batch.through.item >= itemCount) ||
			(batch.through.part > through.part && batch.through.item !== 0)
		)
			throw new Error('Invalid work checkpoint.');
		const membership = batch.memberships.find((link) => link.number === input.number);
		if (
			membership?.processed !== (batch.through.part > through.part ? itemCount : batch.through.item)
		)
			throw new Error('Work checkpoint has no matching membership.');
	}
	const rows = new Map<string, Doc<'threadTranscriptWorkSections'> | null>();
	const section = async (key: string) => {
		if (rows.has(key)) return rows.get(key) ?? null;
		const row = await ctx.db
			.query('threadTranscriptWorkSections')
			.withIndex('by_threadId_and_key', (q) => q.eq('threadId', threadId).eq('key', key))
			.unique();
		rows.set(key, row);
		return row;
	};
	const resolve = async (key: string, runId: Id<'runs'>) => {
		if (batch.removed.includes(key)) throw new Error('Cannot remove a linked section.');
		const row = await section(key);
		if (!row) throw new Error('Work section not found.');
		if (row.runId !== runId) throw new Error('Work membership belongs to another run.');
		return row;
	};
	for (const row of batch.sections) {
		checkPosition(row.first);
		checkPosition(row.end);
		if (
			row.key !== `work-${row.first.part}-${row.first.item}` ||
			row.first.item >= 8192 ||
			compare(row.end, batch.through) > 0 ||
			compare(row.first, row.end) >= 0 ||
			!Number.isSafeInteger(row.itemCount) ||
			row.itemCount < 1 ||
			row.itemCount > 0xffffffff ||
			!Number.isInteger(row.pendingTools) ||
			row.pendingTools < 0 ||
			row.pendingTools > row.itemCount ||
			[row.startedAt, row.completedAt].some(
				(value) => value !== undefined && (!Number.isFinite(value) || value < 0)
			) ||
			(row.startedAt !== undefined &&
				row.completedAt !== undefined &&
				row.completedAt < row.startedAt) ||
			(row.pendingTools > 0 && row.completedAt !== undefined)
		)
			throw new Error('Invalid work section.');
		const run = await ctx.db.get('runs', row.runId);
		if (run?.threadId !== threadId) throw new Error('Work section belongs to another thread.');
		const old = await section(row.key);
		if (
			old &&
			(old.runId !== row.runId ||
				compare(old.first, row.first) !== 0 ||
				compare(row.end, old.end) < 0 ||
				(old.closed && !row.closed))
		)
			throw new Error('Work section identity changed.');
		const firstPart = await loadPart(row.first.part);
		if (
			!firstPart ||
			firstPart.runId !== row.runId ||
			row.provisional !== !!firstPart.tool ||
			(row.provisional && (row.itemCount !== 1 || row.first.item !== 0 || !row.closed))
		)
			throw new Error('Invalid work section source.');
		if (
			finished &&
			(!old ||
				row.runId !== batch.finishedRunId ||
				!row.closed ||
				row.pendingTools !== 0 ||
				compare(old.end, row.end) !== 0 ||
				row.itemCount !== old.itemCount ||
				row.startedAt !== old.startedAt ||
				row.completedAt !== (old.pendingTools > 0 ? undefined : old.completedAt))
		)
			throw new Error('Invalid finished work section.');
		if (old) {
			await ctx.db.replace('threadTranscriptWorkSections', old._id, {
				threadId,
				...row,
				linkedParts: old.linkedParts
			});
			rows.set(row.key, { ...old, ...row });
		} else {
			const id = await ctx.db.insert('threadTranscriptWorkSections', {
				threadId,
				...row,
				linkedParts: 0
			});
			rows.set(row.key, await ctx.db.get('threadTranscriptWorkSections', id));
		}
	}
	for (const link of batch.memberships) {
		checkPosition({ part: link.number, item: 0 });
		if (link.number > through.part) throw new Error('Cannot link unprocessed transcript parts.');
		const part = await loadPart(link.number);
		if (!part) throw new Error('Linked transcript part not found.');
		let end = 0;
		const ranges = [];
		for (const [index, range] of link.ranges.entries()) {
			if (
				!Number.isInteger(range.start) ||
				!Number.isInteger(range.end) ||
				range.start < end ||
				range.end <= range.start ||
				range.end > (part.completion?.items.length ?? 0) ||
				range.end > link.processed
			)
				throw new Error('Invalid work range.');
			const previousRange = part.work?.ranges[index];
			if (previousRange) {
				if (
					previousRange.start !== range.start ||
					previousRange.sectionKey !== range.sectionKey ||
					previousRange.end > range.end ||
					(index < (part.work?.ranges.length ?? 0) - 1 && previousRange.end !== range.end)
				)
					throw new Error('Cannot rewrite processed completion membership.');
				if (previousRange.end === range.end) {
					ranges.push(previousRange);
					end = range.end;
					continue;
				}
			}
			if ((previousRange?.end ?? range.start) < (part.work?.processed ?? 0))
				throw new Error('Cannot rewrite processed completion membership.');
			for (const item of part.completion?.items.slice(
				previousRange?.end ?? range.start,
				range.end
			) ?? [])
				if (item.type !== 'tool-call' && !(item.type === 'reasoning' && item.text.trim()))
					throw new Error('Work range contains a non-work item.');
			end = range.end;
			const row = await resolve(range.sectionKey, part.runId);
			if (
				row.provisional ||
				compare(row.first, { part: link.number, item: range.start }) > 0 ||
				compare(row.end, { part: link.number, item: range.end }) < 0
			)
				throw new Error('Work range exceeds its display boundaries.');
			ranges.push(range);
		}
		if (
			!Number.isInteger(link.processed) ||
			link.processed < 1 ||
			link.processed > Math.max(1, part.completion?.items.length ?? 1)
		)
			throw new Error('Invalid work membership checkpoint.');
		const work: NonNullable<Doc<'threadTranscriptParts'>['work']> = {
			ranges,
			processed: link.processed
		};
		if (
			part.work &&
			(link.processed < part.work.processed ||
				ranges.length < part.work.ranges.length ||
				(link.number < through.part && link.processed !== part.work.processed))
		)
			throw new Error('Cannot rewrite processed completion membership.');
		if (link.sectionKey !== undefined) {
			if (!part.tool) throw new Error('Only tool events have a direct section link.');
			await resolve(link.sectionKey, part.runId);
			work.sectionKey = link.sectionKey;
		}
		if (part.work?.sectionKey !== work.sectionKey) {
			if (part.work?.sectionKey !== undefined) {
				const previous = await section(part.work.sectionKey);
				if (
					!previous?.provisional ||
					!batch.removed.includes(previous.key) ||
					work.sectionKey === undefined
				)
					throw new Error('Only provisional tool membership can move.');
			} else if (link.number < through.part) {
				throw new Error('Cannot rewrite processed tool membership.');
			}
			for (const [key, delta] of [
				[part.work?.sectionKey, -1],
				[work.sectionKey, 1]
			] as const) {
				if (key === undefined) continue;
				const row = await section(key);
				if (!row || row.linkedParts + delta < 0) throw new Error('Invalid work reference count.');
				const linkedParts = row.linkedParts + delta;
				await ctx.db.patch('threadTranscriptWorkSections', row._id, { linkedParts });
				rows.set(key, { ...row, linkedParts });
			}
		}
		await ctx.db.patch('threadTranscriptParts', part._id, { work });
	}
	for (const key of batch.removed) {
		const old = await section(key);
		if (old) {
			if (!old.provisional) throw new Error('Cannot remove a canonical work section.');
			if (old.linkedParts !== 0) throw new Error('Cannot remove a referenced work section.');
			await ctx.db.delete('threadTranscriptWorkSections', old._id);
		}
	}
	await ctx.db.patch('threadTranscriptStates', state._id, { workThrough: batch.through });
	return true;
}

function compare(left: { part: number; item: number }, right: { part: number; item: number }) {
	return left.part - right.part || left.item - right.item;
}

export const commit = mutation({
	args: { threadId: v.id('threadRecords'), batch: workBatch },
	returns: v.boolean(),
	handler: async (ctx, { threadId, batch }) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, threadId);
		await getOrCreateTranscriptState(ctx, { threadId, userId });
		return await applyWorkBatch(ctx, threadId, batch);
	}
});
