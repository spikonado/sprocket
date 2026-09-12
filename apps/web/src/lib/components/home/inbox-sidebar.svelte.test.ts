import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import InboxSidebar from './inbox-sidebar.svelte';
import { INBOX_STATES } from '$convex/lib/inboxState';
import type { Doc, Id } from '$convex/_generated/dataModel';

let component: ReturnType<typeof mount>;
beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
	if (component) await unmount(component);
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

function thread(state: Doc<'threadRecords'>['inboxState'], id = 'thread'): Doc<'threadRecords'> {
	// SAFETY: fixture IDs are opaque strings and never sent to Convex.
	return {
		_id: id as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'alice',
		repositoryKey: 'repo',
		submissionId: id,
		selectedModel: 'model',
		reasoningEffort: 'high',
		fastMode: false,
		title: id,
		lastMessageAt: 100,
		lastCompletedAt: 100,
		status: 'completed',
		inboxState: state
	};
}
function props(records: Doc<'threadRecords'>[]) {
	return {
		sections: INBOX_STATES.map((state) => ({
			state,
			rows: records.filter((row) => row.inboxState === state),
			count: records.filter((row) => row.inboxState === state).length,
			loading: false,
			canLoadMore: false,
			loadMore: vi.fn()
		})),
		projects: [{ repositoryKey: 'repo', displayName: 'Repository', workspacePath: '/repo' }],
		selectedProjects: [],
		currentThreadId: null,
		userId: 'alice',
		online: true,
		migrating: false,
		error: null,
		theme: 'dark' as const,
		onThemeChange: vi.fn(),
		onFilter: vi.fn(),
		onSelect: vi.fn(),
		onNew: vi.fn(),
		onAddProject: vi.fn(),
		onSettings: vi.fn(),
		onClose: vi.fn(),
		onChange: vi.fn().mockResolvedValue(undefined),
		onRename: vi.fn().mockResolvedValue(undefined)
	};
}
async function settle() {
	flushSync();
	await tick();
	flushSync();
}

it.each([undefined, 100])(
	'marks a wake event unread with completion timestamp %s',
	async (lastCompletedAt) => {
		localStorage.setItem('sprocket:inbox:alice', JSON.stringify({ visited: { thread: 200 } }));
		const input = props([{ ...thread('active'), lastCompletedAt, wokeAt: 200 }]);
		component = mount(InboxSidebar, { target: document.body, props: input });
		await settle();
		expect(document.querySelector('.inbox-status')).toBeNull();
		document.querySelector<HTMLButtonElement>('[aria-label="Actions for thread"]')!.click();
		await settle();
		[...document.querySelectorAll<HTMLButtonElement>('.inbox-context-menu button')]
			.find((button) => button.textContent?.trim() === 'Mark unread')!
			.click();
		await settle();
		expect(document.querySelector('.inbox-status')?.textContent).toBe('Woke');
		expect(localStorage.getItem('sprocket:inbox:alice')).toContain('"thread":199');
		expect(input.onChange).not.toHaveBeenCalled();
	}
);

it('renders without selecting a thread and protects pinned actions', async () => {
	const input = props([thread('pinned')]);
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	expect(input.onSelect).not.toHaveBeenCalled();
	document.querySelector<HTMLButtonElement>('[aria-label="Actions for thread"]')!.click();
	await settle();
	const menu = document.querySelector('.inbox-context-menu')!;
	expect(
		[...menu.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Settle')
			?.disabled
	).toBe(true);
	expect(menu.textContent).not.toContain('Snooze until');
});

it('jumps past unloaded sections without loading their remaining history', async () => {
	const input = props([thread('active', 'working'), thread('settled', 'old')]);
	input.sections[1]!.canLoadMore = true;
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	expect(document.getElementById('inbox-settled')).toBeNull();
	document.querySelector<HTMLButtonElement>('.inbox-jumps button[title="Settled"]')!.click();
	await settle();
	expect(document.getElementById('inbox-settled')?.textContent).toContain('old');
	expect(input.sections[1]!.loadMore).not.toHaveBeenCalled();
});

it('keeps a failed state change visible and does not offer a false undo', async () => {
	const input = props([thread('active')]);
	input.onChange.mockRejectedValue(new Error('Changed on another device'));
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	document.querySelector<HTMLButtonElement>('[aria-label="Settle thread"]')!.click();
	await settle();
	expect(document.querySelector('.inbox-notice')?.textContent).toContain(
		'Changed on another device'
	);
	expect(document.querySelector('.inbox-notice')?.textContent).not.toContain('Undo');
});

it('skips pinned threads in a mixed bulk settle', async () => {
	const input = props([thread('pinned', 'pin'), thread('active', 'active')]);
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	for (const button of document.querySelectorAll('.inbox-row-main'))
		button.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
	await settle();
	const button = [...document.querySelectorAll<HTMLButtonElement>('.inbox-bulk button')].find(
		(button) => button.textContent?.startsWith('Settle')
	)!;
	expect(button.textContent).toContain('1');
	button.click();
	await settle();
	expect(input.onChange).toHaveBeenCalledTimes(1);
	expect(input.onChange.mock.calls[0]?.[0]._id).toBe('active');
});

it('keeps cached history navigable but disables offline mutations', async () => {
	const input = props([thread('active')]);
	input.online = false;
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	document.querySelector<HTMLButtonElement>('[aria-label="Settle thread"]')!.click();
	document.querySelector<HTMLButtonElement>('.inbox-row-main')!.click();
	await settle();
	expect(input.onChange).not.toHaveBeenCalled();
	expect(input.onSelect).toHaveBeenCalledOnce();
});

it('returns focus to the actions button when closing the keyboard menu', async () => {
	const input = props([thread('active')]);
	component = mount(InboxSidebar, { target: document.body, props: input });
	await settle();
	const button = document.querySelector<HTMLButtonElement>('[aria-label="Actions for thread"]')!;
	button.click();
	await settle();
	document.activeElement!.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
	);
	await settle();
	expect(document.querySelector('.inbox-context-menu')).toBeNull();
	expect(document.activeElement).toBe(button);
});
