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

type SubagentStatus = Doc<'threadRecords'>['status'];

export function subagentStatusRows(
	descendantCount: number,
	counts?: Record<SubagentStatus, number>
): { status: 'running' | 'completed'; label: string }[] {
	const queued = counts?.queued ?? 0;
	const running = counts?.running ?? 0;
	const finished = (counts?.completed ?? 0) + (counts?.failed ?? 0) + (counts?.cancelled ?? 0);
	const unknown = Math.max(0, descendantCount - queued - running - finished);
	const completed = finished + unknown;
	const rows: { status: 'running' | 'completed'; label: string }[] = [];

	if (running > 0) {
		rows.push({ status: 'running', label: subagentStatusLabel(running, 'Working') });
	}

	if (completed > 0) {
		rows.push({ status: 'completed', label: subagentStatusLabel(completed, 'Completed') });
	}

	return rows;
}

function subagentStatusLabel(count: number, label: string): string {
	return `${count} ${count === 1 ? 'subagent' : 'subagents'} · ${label}`;
}
