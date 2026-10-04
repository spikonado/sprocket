import { expect, it } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import { collapseThreadBranch, mergeSelectedThreadSummary } from '$lib/project/subagents';
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

it('collapses a branch including every expanded descendant', () => {
	const threads = [thread('a', 'root'), thread('a1', 'a'), thread('b', 'root')];

	expect(collapseThreadBranch(['root', 'a', 'a1', 'b'], thread('a')._id, threads)).toEqual([
		'root',
		'b'
	]);
	expect(collapseThreadBranch(['root', 'b'], thread('a')._id, threads)).toEqual(['root', 'b']);
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
