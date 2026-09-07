import { api } from '$convex/_generated/api';
import type { Doc } from '$convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';

export type HostedThreadListPage = Pick<
	FunctionReturnType<typeof api.hostedThreads.listPage>,
	'page' | 'selected'
>;

export function snapshotThreadsFromPage(
	page: HostedThreadListPage['page'],
	selected: HostedThreadListPage['selected']
): Doc<'threadRecords'>[] {
	if (!selected || page.some((thread) => thread._id === selected._id)) {
		return page;
	}
	return [...page, selected];
}

/** Returns null when a page belongs to another user so callers drop the stale snapshot. */
export function collectThreadSnapshot(args: {
	userId: string;
	pages: HostedThreadListPage[];
}): Doc<'threadRecords'>[] | null {
	const byId = new Map<string, Doc<'threadRecords'>>();
	let selected: Doc<'threadRecords'> | null = null;
	for (const page of args.pages) {
		for (const thread of page.page) {
			if (thread.userId !== args.userId) return null;
			if (!byId.has(thread._id)) byId.set(thread._id, thread);
		}
		if (page.selected) {
			if (page.selected.userId !== args.userId) return null;
			selected = page.selected;
		}
	}
	return snapshotThreadsFromPage([...byId.values()], selected);
}
