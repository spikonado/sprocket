import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Doc, Id } from '$convex/_generated/dataModel';
import { INBOX_STATES } from '$convex/lib/inboxState';
import InboxSidebar from './inbox-sidebar.svelte';

let component: ReturnType<typeof mount>;

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
	if (component) await unmount(component);
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

function thread(settled = false, status: Doc<'threadRecords'>['status'] = 'completed') {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const record: Doc<'threadRecords'> = {
		_id: 'thread' as Id<'threadRecords'>,
		_creationTime: 1,
		userId: 'alice',
		repositoryKey: 'repo',
		submissionId: 'submission',
		selectedModel: 'model',
		reasoningEffort: 'high' as const,
		fastMode: false,
		title: 'Thread',
		lastMessageAt: Date.now(),
		status
	};
	if (settled) record.archivedAt = Date.now();
	return record;
}

function props(records: Doc<'threadRecords'>[]) {
	return {
		sections: INBOX_STATES.map((state) => ({
			state,
			rows: records.filter((row) => (row.archivedAt === undefined) === (state === 'unsettled')),
			loading: false,
			canLoadMore: false,
			loadMore: vi.fn()
		})),
		projects: [
			{ repositoryKey: 'repo', displayName: 'Repository', workspacePath: '/repo' },
			{ repositoryKey: 'other', displayName: 'Other project', workspacePath: '/other' }
		],
		models: [{ id: 'model', label: 'Model Name', provider: 'openai' }],
		selectedProjects: [],
		currentThreadId: null,
		mutationsEnabled: true,
		theme: 'dark' as const,
		onThemeChange: vi.fn(),
		onFilter: vi.fn(),
		onSelect: vi.fn(),
		onNew: vi.fn(),
		onAddProject: vi.fn(),
		onSettings: vi.fn(),
		onChange: vi.fn().mockResolvedValue(undefined),
		onRename: vi.fn().mockResolvedValue(undefined)
	};
}

async function render(records: Doc<'threadRecords'>[]) {
	const input = props(records);
	component = mount(InboxSidebar, { target: document.body, props: input });
	flushSync();
	await tick();
	return input;
}

it('settles an idle thread without offering snooze actions', async () => {
	const input = await render([thread()]);
	document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!.click();
	await tick();

	expect(input.onChange).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'settled'
	);
	expect(document.body.textContent).not.toContain('Snooze');
	expect(document.querySelector('.inbox-notice')).toBeNull();
});

it('renders simple navigation and non-collapsible sections', async () => {
	const input = await render([thread(), thread(true)]);
	const newThread = [...document.querySelectorAll<HTMLButtonElement>('.inbox-menu-item')].find(
		(button) => button.textContent?.includes('New thread')
	);

	expect(newThread).toBeTruthy();
	expect(newThread?.querySelector('.lucide-square-pen')).toBeTruthy();
	newThread?.click();
	expect(input.onNew).toHaveBeenCalledOnce();
	expect(document.querySelector('.inbox-jumps')).toBeNull();
	expect(document.querySelector('[aria-label="Close sidebar"]')).toBeNull();
	expect(document.querySelector('#inbox-unsettled .inbox-section-heading')).toBeNull();
	expect(document.querySelector('#inbox-settled .inbox-section-heading')?.textContent).toBe(
		'Settled'
	);
	expect(document.querySelector('#inbox-settled .inbox-section-heading')).not.toBeInstanceOf(
		HTMLButtonElement
	);
	expect(document.querySelector('[aria-label^="Actions for"]')).toBeNull();
});

it('does not render empty thread sections', async () => {
	await render([]);

	expect(document.querySelector('#inbox-unsettled')).toBeNull();
	expect(document.querySelector('#inbox-settled')).toBeNull();
	expect(document.body.textContent).not.toContain('No settled threads');
	expect(document.body.textContent).not.toContain('No unsettled threads');
});

it('shows project, title, age, provider, and model name without a model slug', async () => {
	await render([thread()]);
	const row = document.querySelector('.inbox-row')!;

	expect(row.querySelector('.inbox-row-meta')?.textContent).toContain('Repository');
	expect(row.querySelector('.inbox-row-title')?.textContent).toBe('Thread');
	expect(row.querySelector('.inbox-row-model')?.textContent).toContain('Model Name');
	expect(row.querySelector('.inbox-row-model svg')).toBeTruthy();
	expect(row.textContent).not.toContain('model');
	expect(row.textContent).not.toContain('submission');
	expect(row.querySelector('.inbox-row-main')?.getAttribute('title')).not.toContain('model');
});

it('filters the project picker and selects one project', async () => {
	const input = await render([thread()]);
	document.querySelector<HTMLDetailsElement>('details')!.open = true;
	await tick();
	const search = document.querySelector<HTMLInputElement>('.inbox-project-search input')!;
	expect(search.placeholder).toBe('Search projects');
	search.value = 'repo';
	search.dispatchEvent(new InputEvent('input', { bubbles: true }));
	await tick();
	const options = [...document.querySelectorAll<HTMLButtonElement>('.inbox-project-option')];
	const project = options.find((button) => button.textContent?.trim() === 'Repository')!;

	expect(options.some((button) => button.textContent?.trim() === 'Other project')).toBe(false);
	project.click();
	expect(input.onFilter).toHaveBeenCalledWith(['repo']);
});

it('puts the add-project action beside the project selector', async () => {
	const input = await render([thread()]);
	const action = document.querySelector<HTMLButtonElement>('[aria-label="Create or add project"]')!;

	expect(action.closest('.inbox-project-controls')).toBeTruthy();
	expect(action.closest('.inbox-project-menu')).toBeNull();
	action.click();
	expect(input.onAddProject).toHaveBeenCalledOnce();
});

it('shows an icon for every thread menu action without selection controls', async () => {
	await render([thread()]);
	document
		.querySelector('.inbox-row')!
		.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
	await tick();
	const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

	expect(actions.map((action) => action.textContent?.trim())).toEqual([
		'Settle',
		'Rename',
		'Copy thread ID'
	]);
	expect(actions.every((action) => action.querySelector('svg'))).toBe(true);
	expect(document.body.textContent).not.toContain('Select thread');
	expect(document.body.textContent).not.toContain('Deselect thread');
});

it('opens the thread menu from the keyboard', async () => {
	await render([thread()]);
	const rowButton = document.querySelector<HTMLButtonElement>('.inbox-row-main')!;

	rowButton.dispatchEvent(
		new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })
	);
	await tick();

	expect(document.querySelector('.inbox-context-menu')).toBeTruthy();
	expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
});

it('renames a thread inline', async () => {
	const input = await render([thread()]);
	document
		.querySelector('.inbox-row')!
		.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
	await tick();
	const renameAction = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
		(action) => action.textContent?.trim() === 'Rename'
	)!;

	renameAction.click();
	await tick();
	const renameInput = document.querySelector<HTMLInputElement>('[aria-label="Rename thread"]')!;
	expect(renameInput.closest('.inbox-row')).toBeTruthy();
	expect(document.querySelector('dialog')).toBeNull();
	renameInput.value = 'Updated thread';
	renameInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
	renameInput.closest('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));
	await tick();

	expect(input.onRename).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'Updated thread'
	);
});

it('does not allow a running thread to settle', async () => {
	const input = await render([thread(false, 'running')]);
	const settleButton = document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!;

	expect(settleButton.disabled).toBe(true);
	settleButton.click();
	await tick();
	expect(input.onChange).not.toHaveBeenCalled();
});

it('unsettles a settled thread', async () => {
	const input = await render([thread(true)]);
	const unsettleButton = document.querySelector<HTMLButtonElement>(
		'[aria-label="Unsettle Thread"]'
	)!;
	expect(unsettleButton.querySelector('.lucide-rotate-ccw')).toBeTruthy();
	unsettleButton.click();
	await tick();

	expect(input.onChange).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'unsettled'
	);
	expect(document.querySelector('.inbox-notice')).toBeNull();
});
it('shows a failed settle', async () => {
	const input = await render([thread()]);
	input.onChange.mockRejectedValue(new Error('Changed elsewhere'));
	document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!.click();
	await tick();
	await tick();

	expect(document.querySelector('.inbox-notice')?.textContent).toContain('Changed elsewhere');
});
