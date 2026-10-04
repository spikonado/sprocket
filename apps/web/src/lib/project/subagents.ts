import type { Doc, Id } from '@convex/_generated/dataModel';

export type ThreadTreeLink = Pick<Doc<'threadRecords'>, '_id' | 'parentThreadId'>;

export function isRootThread(thread: Pick<ThreadTreeLink, 'parentThreadId'>): boolean {
	return thread.parentThreadId === undefined;
}

export function collapseThreadBranch(
	expandedThreadIds: readonly string[],
	rootId: Id<'threadRecords'>,
	threads: readonly ThreadTreeLink[]
): string[] {
	const childrenByParent = new Map<string, string[]>();

	for (const thread of threads) {
		if (thread.parentThreadId === undefined) continue;

		const children = childrenByParent.get(thread.parentThreadId);

		if (children) children.push(thread._id);
		else childrenByParent.set(thread.parentThreadId, [thread._id]);
	}

	const collapsed = new Set<string>([rootId]);
	const stack: string[] = [rootId];

	while (stack.length > 0) {
		const parentId = stack.pop()!;

		for (const childId of childrenByParent.get(parentId) ?? []) {
			if (collapsed.has(childId)) continue;
			collapsed.add(childId);
			stack.push(childId);
		}
	}

	return expandedThreadIds.filter((threadId) => !collapsed.has(threadId));
}

export function subagentBadgeLabel(descendantCount: number, subtreeActive: boolean): string | null {
	if (descendantCount === 0) return null;

	const count = descendantCount === 1 ? '1 subagent' : `${descendantCount} subagents`;

	return subtreeActive ? `${count} · Working` : count;
}
