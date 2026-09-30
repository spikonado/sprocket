import { act, useState, type ComponentProps } from 'react';
import { fireEvent, render as renderView } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { INBOX_STATES } from '@convex/lib/inboxState';
import InboxSidebar from './inbox-sidebar';

type SidebarProps = Omit<
	ComponentProps<typeof InboxSidebar>,
	'settledOpen' | 'onSettledOpenChange'
>;
type Thread = Doc<'threadRecords'>;

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function thread(settled = false, status: Thread['status'] = 'completed') {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const record: Thread = {
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

function props(records: Thread[]) {
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
		onClose: vi.fn(),
		onChange: vi.fn().mockResolvedValue(undefined),
		onRename: vi.fn().mockResolvedValue(undefined)
	};
}

function Harness(input: SidebarProps) {
	const [settledOpen, setSettledOpen] = useState(false);
	return <InboxSidebar {...input} settledOpen={settledOpen} onSettledOpenChange={setSettledOpen} />;
}

async function render(records: Thread[]) {
	const input = props(records);
	renderView(<Harness {...input} />);
	await act(async () => {});
	return input;
}

async function flush() {
	await act(async () => {});
}

it('settles an idle thread without offering snooze actions', async () => {
	const input = await render([thread()]);
	act(() => {
		document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!.click();
	});
	await flush();

	expect(input.onChange).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'settled'
	);
	expect(document.body.textContent).not.toContain('Snooze');
	expect(document.querySelector('.inbox-notice')).toBeNull();
});

it('renders simple navigation and a collapsible settled section', async () => {
	const input = await render([thread(), thread(true)]);
	const newThread = [...document.querySelectorAll<HTMLButtonElement>('.inbox-menu-item')].find(
		(button) => button.textContent?.includes('New thread')
	);

	expect(newThread).toBeTruthy();
	expect(newThread?.querySelector('.lucide-square-pen')).toBeTruthy();
	act(() => {
		newThread?.click();
	});
	expect(input.onNew).toHaveBeenCalledOnce();
	expect(document.querySelector('.inbox-jumps')).toBeNull();
	expect(document.querySelector('#inbox-unsettled .inbox-section-heading')).toBeNull();
	const settledHeading = document.querySelector<HTMLButtonElement>(
		'#inbox-settled .inbox-section-heading'
	)!;
	expect(settledHeading.textContent?.trim()).toBe('Settled Threads');
	expect(settledHeading.getAttribute('aria-expanded')).toBe('false');
	expect(document.querySelector('#inbox-settled .inbox-row')).toBeNull();
	act(() => {
		settledHeading.click();
	});
	await flush();
	expect(settledHeading.getAttribute('aria-expanded')).toBe('true');
	expect(document.querySelector('#inbox-settled .inbox-row')).toBeTruthy();
	expect(localStorage.getItem('sprocket.inbox.settled-open')).toBe('true');
});

it('restores the settled section preference from local storage', async () => {
	localStorage.setItem('sprocket.inbox.settled-open', 'true');
	await render([thread(true)]);

	expect(
		document.querySelector('#inbox-settled .inbox-section-heading')?.getAttribute('aria-expanded')
	).toBe('true');
	expect(document.querySelector('#inbox-settled .inbox-row')).toBeTruthy();
});

it('closes the sidebar from the top action and from the brand mark', async () => {
	const input = await render([thread()]);

	act(() => {
		document.querySelector<HTMLButtonElement>('[aria-label="Close sidebar"]')!.click();
	});
	expect(input.onClose).toHaveBeenCalledOnce();

	const brand = document.querySelector<HTMLButtonElement>('header [aria-label="Close sidebar"]')!;
	act(() => {
		brand.click();
	});
	expect(input.onClose).toHaveBeenCalledTimes(2);
});

it('loads more threads only after the user clicks Show more', async () => {
	const input = props([thread()]);
	const unsettled = input.sections.find((section) => section.state === 'unsettled')!;
	unsettled.canLoadMore = true;
	renderView(<Harness {...input} />);
	await flush();

	const showMore = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === 'Show more'
	)!;
	expect(showMore).toBeTruthy();
	expect(unsettled.loadMore).not.toHaveBeenCalled();
	act(() => {
		showMore.click();
	});
	expect(unsettled.loadMore).toHaveBeenCalledOnce();
});

it('starts a new thread with Alt+N', async () => {
	const input = await render([]);

	act(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true }));
	});

	expect(input.onNew).toHaveBeenCalledOnce();
});

it('does not render empty thread rows', async () => {
	await render([]);

	expect(document.querySelector('#inbox-unsettled')).toBeNull();
	expect(document.querySelector('#inbox-settled .inbox-section-heading')).toBeTruthy();
	expect(document.querySelector('#inbox-settled .inbox-row')).toBeNull();
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
	act(() => {
		document.querySelector<HTMLDetailsElement>('details')!.open = true;
	});
	const search = document.querySelector<HTMLInputElement>('.inbox-project-search input')!;
	expect(search.placeholder).toBe('Search projects');
	fireEvent.change(search, { target: { value: 'repo' } });
	const options = [...document.querySelectorAll<HTMLButtonElement>('.inbox-project-option')];
	const project = options.find((button) => button.textContent?.trim() === 'Repository')!;

	expect(options.some((button) => button.textContent?.trim() === 'Other project')).toBe(false);
	act(() => {
		project.click();
	});
	expect(input.onFilter).toHaveBeenCalledWith(['repo']);
});

it('puts the add-project action beside the project selector', async () => {
	const input = await render([thread()]);
	const action = document.querySelector<HTMLButtonElement>('[aria-label="Create or add project"]')!;

	expect(action.closest('.inbox-project-controls')).toBeTruthy();
	expect(action.closest('.inbox-project-menu')).toBeNull();
	act(() => {
		action.click();
	});
	expect(input.onAddProject).toHaveBeenCalledOnce();
});

it('shows an icon for every thread menu action without selection controls', async () => {
	await render([thread()]);
	act(() => {
		document
			.querySelector('.inbox-row')!
			.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
	});
	await flush();
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

it('does not attach keyboard context-menu behavior to thread rows', async () => {
	await render([thread()]);
	const rowButton = document.querySelector<HTMLButtonElement>('.inbox-row-main')!;

	act(() => {
		rowButton.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' }));
	});
	await flush();

	expect(rowButton.hasAttribute('aria-haspopup')).toBe(false);
	expect(document.querySelector('.inbox-context-menu')).toBeNull();
});

it('labels settle and unsettle controls with tooltips', async () => {
	localStorage.setItem('sprocket.inbox.settled-open', 'true');
	await render([thread(), thread(true)]);

	expect(document.querySelector('[aria-label="Settle Thread"]')?.getAttribute('data-tooltip')).toBe(
		'Settle'
	);
	expect(
		document.querySelector('[aria-label="Unsettle Thread"]')?.getAttribute('data-tooltip')
	).toBe('Unsettle');
});

it('renames a thread inline', async () => {
	const input = await render([thread()]);
	act(() => {
		document
			.querySelector('.inbox-row')!
			.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
	});
	await flush();
	const renameAction = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
		(action) => action.textContent?.trim() === 'Rename'
	)!;

	act(() => {
		renameAction.click();
	});
	await flush();
	const renameInput = document.querySelector<HTMLInputElement>('[aria-label="Rename thread"]')!;
	expect(renameInput.closest('.inbox-row')).toBeTruthy();
	expect(document.querySelector('dialog')).toBeNull();
	fireEvent.change(renameInput, { target: { value: 'Updated thread' } });
	fireEvent.submit(renameInput.closest('form')!);
	await flush();

	expect(input.onRename).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'Updated thread'
	);
});

it('does not allow a running thread to settle', async () => {
	const input = await render([thread(false, 'running')]);
	const settleButton = document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!;

	expect(settleButton.disabled).toBe(true);
	act(() => {
		settleButton.click();
	});
	await flush();
	expect(input.onChange).not.toHaveBeenCalled();
});

it('unsettles a settled thread', async () => {
	localStorage.setItem('sprocket.inbox.settled-open', 'true');
	const input = await render([thread(true)]);
	const unsettleButton = document.querySelector<HTMLButtonElement>(
		'[aria-label="Unsettle Thread"]'
	)!;
	expect(unsettleButton.querySelector('.lucide-rotate-ccw')).toBeTruthy();
	act(() => {
		unsettleButton.click();
	});
	await flush();

	expect(input.onChange).toHaveBeenCalledWith(
		expect.objectContaining({ _id: 'thread' }),
		'unsettled'
	);
	expect(document.querySelector('.inbox-notice')).toBeNull();
});
it('shows a failed settle', async () => {
	const input = await render([thread()]);
	input.onChange.mockRejectedValue(new Error('Changed elsewhere'));
	act(() => {
		document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')!.click();
	});
	await flush();
	await flush();

	expect(document.querySelector('.inbox-notice')?.textContent).toContain('Changed elsewhere');
});
