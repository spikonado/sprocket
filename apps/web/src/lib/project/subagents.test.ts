import { expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	collapseThreadBranch,
	collectSubtreeDescendantIds,
	expandThreadAncestors,
	isRootThread,
	mergeSelectedThreadSummary,
	subagentBadgeLabel
} from '$lib/project/subagents';
import { threadRecordToSummary } from '$lib/project/threads';
import type { Doc } from '@convex/_generated/dataModel';

function thread(id: string, parentThreadId?: string): Doc<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return {
		_id: id as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'alice',
		repositoryKey: 'repo',
		submissionId: 'submission',
		selectedModel: 'model',
		reasoningEffort: 'high',
		fastMode: false,
		title: id,
		lastMessageAt: 1,
		status: 'completed',
		parentThreadId: parentThreadId as Id<'threadRecords'> | undefined
	};
}

it('identifies roots by the absence of a parent', () => {
	expect(isRootThread(thread('root'))).toBe(true);
	expect(isRootThread(thread('child', 'root'))).toBe(false);
});

it('collects all descendants recursively, not only direct children', () => {
	const threads = [
		thread('root'),
		thread('a', 'root'),
		thread('b', 'root'),
		thread('a1', 'a'),
		thread('a1x', 'a1'),
		thread('other')
	];

	expect([...collectSubtreeDescendantIds(thread('root')._id, threads)].sort()).toEqual([
		'a',
		'a1',
		'a1x',
		'b'
	]);
	expect(collectSubtreeDescendantIds(thread('other')._id, threads).size).toBe(0);
});

it('terminates cycles and only collects threads reachable from the starting thread', () => {
	const threads = [
		thread('root', 'grandchild'),
		thread('child', 'root'),
		thread('grandchild', 'child'),
		thread('other', 'other-child'),
		thread('other-child', 'other')
	];

	expect([...collectSubtreeDescendantIds(thread('root')._id, threads)].sort()).toEqual([
		'child',
		'grandchild',
		'root'
	]);
});

it('collapses a branch including every expanded descendant', () => {
	const threads = [thread('a', 'root'), thread('a1', 'a'), thread('b', 'root')];

	expect(collapseThreadBranch(['root', 'a', 'a1', 'b'], thread('a')._id, threads)).toEqual([
		'root',
		'b'
	]);
	expect(collapseThreadBranch(['root', 'b'], thread('a')._id, threads)).toEqual(['root', 'b']);
});

it('expands ancestor chains without duplicates', () => {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const ancestors = ['a', 'b', 'c'] as Id<'threadRecords'>[];

	expect(expandThreadAncestors(['a'], ancestors)).toEqual(['a', 'b', 'c']);
	expect(expandThreadAncestors([], [])).toEqual([]);
});

it('formats the descendant badge with singular, plural, and Working', () => {
	expect(subagentBadgeLabel(0, false)).toBeNull();
	expect(subagentBadgeLabel(1, false)).toBe('1 subagent');
	expect(subagentBadgeLabel(5, false)).toBe('5 subagents');
	expect(subagentBadgeLabel(1, true)).toBe('1 subagent · Working');
	expect(subagentBadgeLabel(5, true)).toBe('5 subagents · Working');
});

it('keeps the selected child summary resolvable outside the root inbox page', () => {
	const root = thread('root');
	const child = thread('child', 'root');
	const summaries = [threadRecordToSummary(root)];

	const merged = mergeSelectedThreadSummary(summaries, child, threadRecordToSummary);

	expect(merged.map((summary) => summary.threadId)).toEqual(['child', 'root']);
	expect(mergeSelectedThreadSummary(summaries, root, threadRecordToSummary)).toBe(summaries);
	expect(mergeSelectedThreadSummary(summaries, null, threadRecordToSummary)).toBe(summaries);
});
