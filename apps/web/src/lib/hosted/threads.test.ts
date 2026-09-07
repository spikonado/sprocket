import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '$convex/_generated/dataModel';
import { snapshotThreadsFromPage, collectThreadSnapshot } from '$lib/hosted/threads';

function thread(id: string, userId = 'user_alice'): Doc<'threadRecords'> {
	return {
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		_id: id as Id<'threadRecords'>,
		_creationTime: 1,
		userId,
		submissionId: id,
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
		lastMessageAt: 1
	};
}

describe('snapshotThreadsFromPage', () => {
	it('keeps the selected thread when it is not on the current page', () => {
		const page = [thread('newer')];
		const selected = thread('older');
		expect(snapshotThreadsFromPage(page, selected).map((row) => row._id)).toEqual([
			'newer',
			'older'
		]);
		expect(snapshotThreadsFromPage(page, page[0])).toEqual(page);
		expect(snapshotThreadsFromPage(page, null)).toEqual(page);
	});

	it('dedups overlapping pages and ignores another user', () => {
		const pages = [
			{ page: [thread('a'), thread('b')], selected: thread('older') },
			{ page: [thread('b'), thread('c')], selected: null }
		];
		expect(collectThreadSnapshot({ userId: 'user_alice', pages })?.map((row) => row._id)).toEqual([
			'a',
			'b',
			'c',
			'older'
		]);
		expect(
			collectThreadSnapshot({
				userId: 'user_alice',
				pages: [{ page: [thread('x', 'user_bob')], selected: null }]
			})
		).toBeNull();
	});
});
