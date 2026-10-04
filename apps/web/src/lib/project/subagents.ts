import type { Doc, Id } from '@convex/_generated/dataModel';
import type { ThreadSummary } from '$lib/types/sprocket';

export type ThreadTreeLink = Pick<Doc<'threadRecords'>, '_id'> & {
	parentThreadId?: Id<'threadRecords'>;
};

export function isRootThread(thread: Pick<ThreadTreeLink, 'parentThreadId'>): boolean {
	return thread.parentThreadId === undefined;
}

function collectSubtreeDescendantIds(
	rootId: Id<'threadRecords'>,
	threads: readonly ThreadTreeLink[]
): Set<string> {
	const childrenByParent = new Map<string, string[]>();

	for (const thread of threads) {
		if (thread.parentThreadId === undefined) continue;

		const children = childrenByParent.get(thread.parentThreadId);

		if (children) children.push(thread._id);
		else childrenByParent.set(thread.parentThreadId, [thread._id]);
	}

	const descendants = new Set<string>();
	const stack: string[] = [rootId];

	while (stack.length > 0) {
		const parentId = stack.pop()!;

		for (const childId of childrenByParent.get(parentId) ?? []) {
			if (descendants.has(childId)) continue;
			descendants.add(childId);
			stack.push(childId);
		}
	}

	return descendants;
}

export function subagentBadgeLabel(descendantCount: number, subtreeActive: boolean): string | null {
	if (descendantCount === 0) return null;

	const count = descendantCount === 1 ? '1 subagent' : `${descendantCount} subagents`;

	return subtreeActive ? `${count} · Working` : count;
}

export function collapseThreadBranch(
	expandedThreadIds: readonly string[],
	rootId: Id<'threadRecords'>,
	threads: readonly ThreadTreeLink[]
): string[] {
	const collapsed = collectSubtreeDescendantIds(rootId, threads);

	return expandedThreadIds.filter((threadId) => threadId !== rootId && !collapsed.has(threadId));
}

// The selected child only renders nested under its parent, so it is absent
// from the root-only inbox page; keep it resolvable.
export function mergeSelectedThreadSummary(
	summaries: ThreadSummary[],
	selectedThread: Doc<'threadRecords'> | null,
	toSummary: (record: Doc<'threadRecords'>) => ThreadSummary
): ThreadSummary[] {
	if (!selectedThread || summaries.some((thread) => thread.threadId === selectedThread._id)) {
		return summaries;
	}

	return [toSummary(selectedThread), ...summaries];
}
