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

const subagentStatuses = [
	{ status: 'queued', label: 'Starting' },
	{ status: 'running', label: 'Working' },
	{ status: 'completed', label: 'Completed' },
	{ status: 'failed', label: 'Failed' },
	{ status: 'cancelled', label: 'Cancelled' }
] satisfies { status: SubagentStatus; label: string }[];

export function subagentStatusRows(
	descendantCount: number,
	counts?: Record<SubagentStatus, number>
): { status: SubagentStatus | 'unknown'; label: string }[] {
	const rows: { status: SubagentStatus | 'unknown'; label: string }[] = [];
	let counted = 0;

	for (const { status, label } of subagentStatuses) {
		const count = counts?.[status] ?? 0;

		if (count === 0) continue;
		counted += count;
		rows.push({ status, label: subagentStatusLabel(count, label) });
	}

	if (counted < descendantCount) {
		rows.push({
			status: 'unknown',
			label: subagentStatusLabel(descendantCount - counted, 'Status updating')
		});
	}

	return rows;
}

function subagentStatusLabel(count: number, label: string): string {
	return `${count} ${count === 1 ? 'subagent' : 'subagents'} · ${label}`;
}
