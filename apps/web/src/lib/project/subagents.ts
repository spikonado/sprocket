import type { Doc, Id } from '@convex/_generated/dataModel';

export function isRootThread(thread: Pick<Doc<'threadRecords'>, 'parentThreadId'>): boolean {
	return thread.parentThreadId === undefined;
}

export function collapseThreadBranch(
	expandedThreadIds: readonly string[],
	rootId: Id<'threadRecords'>,
	childrenByParent: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
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

export function subagentSummaryLabel(
	descendantCount: number,
	workingCount: number,
	descendantsActive: boolean
): string | null {
	if (workingCount > 0) {
		return `${subagentCountLabel(workingCount)} · Working`;
	}

	if (descendantCount > 0 && !descendantsActive) {
		return subagentCountLabel(descendantCount);
	}

	return null;
}

function subagentCountLabel(count: number): string {
	return `${count} ${count === 1 ? 'subagent' : 'subagents'}`;
}
