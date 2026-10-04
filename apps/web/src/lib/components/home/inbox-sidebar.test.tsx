import { act, useState, type ComponentProps } from 'react';
import { fireEvent, render as renderView } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { INBOX_STATES } from '@convex/lib/inboxState';
import InboxSidebar, { type SidebarChildrenResolver } from './inbox-sidebar';
import type {
	ThreadTreeSummary,
	ThreadTreeSummaryRead,
	UseExpandedThreads
} from '$lib/project/useThreadTree';

const treeSummaries = new Map<string, ThreadTreeSummary>();

const readTreeSummary: ThreadTreeSummaryRead = ({ threadId }) =>
	threadId ? treeSummaries.get(threadId) : undefined;

type SidebarProps = Omit<
	ComponentProps<typeof InboxSidebar>,
	'settledOpen' | 'onSettledOpenChange'
>;

type Thread = Doc<'threadRecords'>;

function expansionStub(initial: string[] = []): UseExpandedThreads {
	const expanded = new Set(initial);

	return {
		isExpanded: (threadId: Id<'threadRecords'>) => expanded.has(threadId),
		expand: vi.fn((threadId: Id<'threadRecords'>) => {
			expanded.add(threadId);
		}),
		revealAncestors: vi.fn(),
		registerChildren: vi.fn(),
		collapse: vi.fn((threadId: Id<'threadRecords'>) => {
			expanded.delete(threadId);
		})
	};
}

function childrenResolverStub(childrenByParent: Record<string, Thread[]> = {}) {
	return vi.fn<SidebarChildrenResolver>(({ threadId, renderRows }) =>
		renderRows(childrenByParent[threadId] ?? [])
	);
}

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
	localStorage.clear();
	treeSummaries.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type ThreadStatus = Thread['status'];

function thread(settled = false, status: ThreadStatus = 'completed') {
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
		onRename: vi.fn().mockResolvedValue(undefined),
		expansion: expansionStub(),
		resolveChildren: childrenResolverStub(),
		readTreeSummary
	};
}

function Harness(input: SidebarProps) {
	const [settledOpen, setSettledOpen] = useState(false);

	return <InboxSidebar {...input} settledOpen={settledOpen} onSettledOpenChange={setSettledOpen} />;
}

function NavigationHarness(input: SidebarProps) {
	const [currentThreadId, setCurrentThreadId] = useState<Id<'threadRecords'> | null>(null);

	return (
		<Harness
			{...input}
			currentThreadId={currentThreadId}
			onSelect={(record) => setCurrentThreadId(record._id)}
		/>
	);
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

it('keeps thread rows styled when selection moves by click and keyboard', async () => {
	const first = thread();

	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	const second = {
		...thread(),
		_id: 'second-thread' as Id<'threadRecords'>,
		title: 'Second thread'
	};

	const input = props([first, second]);
	const user = userEvent.setup();

	renderView(<NavigationHarness {...input} />);
	const buttons = [...document.querySelectorAll<HTMLButtonElement>('.inbox-row-main')];

	function expectSelected(button: HTMLButtonElement) {
		expect(button.getAttribute('aria-current')).toBe('page');
		expect(button.closest('.inbox-row.inbox-row-selected')).toBeTruthy();
		expect(document.querySelectorAll('.inbox-row')).toHaveLength(2);
		expect(document.querySelectorAll('.inbox-row-selected')).toHaveLength(1);
	}

	await user.click(buttons[0]);
	expectSelected(buttons[0]);
	await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
	expectSelected(buttons[1]);
	await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
	expectSelected(buttons[0]);
	await user.click(buttons[1]);
	expectSelected(buttons[1]);
});

it.each([
	{ status: 'queued', label: 'Starting', className: 'inbox-working' },
	{ status: 'running', label: 'Working', className: 'inbox-working' },
	{ status: 'failed', label: 'Failed', className: 'inbox-attention' }
] satisfies { status: ThreadStatus; label: string; className: string }[])(
	'styles the $label thread status',
	async ({ status, label, className }) => {
		await render([thread(false, status)]);
		const badge = document.querySelector(`.inbox-row-model .inbox-status.${className}`);

		expect(badge?.textContent).toBe(label);
	}
);

it('keeps the selected project filter styled for all projects and a single project', async () => {
	const input = props([thread()]);
	const view = renderView(<Harness {...input} />);

	function selectedLabel() {
		const selected = document.querySelector('.inbox-project-option.inbox-project-selected');
		expect(selected?.getAttribute('aria-pressed')).toBe('true');
		expect(document.querySelectorAll('.inbox-project-option')).toHaveLength(3);
		expect(document.querySelectorAll('.inbox-project-selected')).toHaveLength(1);

		return selected?.textContent;
	}

	expect(selectedLabel()).toBe('All projects');
	view.rerender(<Harness {...input} selectedProjects={['repo']} />);
	expect(selectedLabel()).toBe('Repository');
	view.rerender(<Harness {...input} selectedProjects={[]} />);
	expect(selectedLabel()).toBe('All projects');
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

function childThread(id: string, title: string, status: ThreadStatus = 'completed'): Thread {
	return {
		...thread(false, status),
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		_id: id as Id<'threadRecords'>,
		title,
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		parentThreadId: 'thread' as Id<'threadRecords'>
	};
}

it('shows descendant activity inside the thread button with a separate expansion control', async () => {
	treeSummaries.set('thread', { descendantCount: 5, anyActive: true, descendantsActive: true });
	const input = props([thread()]);
	renderView(<Harness {...input} />);
	await flush();

	const expansion = document.querySelector<HTMLButtonElement>('.inbox-subagents')!;

	const main = document.querySelector<HTMLButtonElement>('.inbox-row-main')!;

	expect(main.querySelector('.inbox-row-subagents')?.textContent).toBe('5 subagents · Working');
	expect(expansion.closest('.inbox-row')).toBe(main.closest('.inbox-row'));
	expect(main.contains(expansion)).toBe(false);
	expect(expansion.getAttribute('aria-expanded')).toBe('false');
	expect(expansion.getAttribute('aria-label')).toBe('Expand subagents of Thread');
	expect(expansion.querySelector('.lucide-chevron-right')).toBeTruthy();
	expect(document.querySelector('.inbox-children')).toBeNull();
	expect(input.resolveChildren).not.toHaveBeenCalled();

	act(() => {
		expansion.click();
	});

	expect(input.expansion.expand).toHaveBeenCalledWith('thread');
	expect(input.onSelect).not.toHaveBeenCalled();
	act(() => {
		main.click();
	});
	expect(input.onSelect).toHaveBeenCalledWith(expect.objectContaining({ _id: 'thread' }));
});

it('uses singular for one subagent and omits the row without descendants', async () => {
	treeSummaries.set('thread', { descendantCount: 1, anyActive: false, descendantsActive: false });
	const oneChild = props([thread()]);
	const oneChildView = renderView(<Harness {...oneChild} />);
	await flush();

	const badge = document.querySelector('.inbox-row-subagents')!;

	expect(badge.textContent).toBe('1 subagent');
	expect(badge.textContent).not.toContain('Working');
	expect(document.querySelector('.inbox-subagents-working')).toBeNull();

	treeSummaries.set('thread', { descendantCount: 0, anyActive: false, descendantsActive: false });
	oneChildView.unmount();
	renderView(<Harness {...props([thread()])} />);
	await flush();

	expect(document.querySelector('.inbox-row-subagents')).toBeNull();
	expect(document.querySelector('.inbox-subagents')).toBeNull();
});

it('renders and selects nested children with increasing indentation', async () => {
	const child = childThread('child', 'Child thread');

	const grandchild = {
		...childThread('grandchild', 'Grandchild thread'),
		// SAFETY: fixture strings are only compared as opaque Convex document ids.
		parentThreadId: 'child' as Id<'threadRecords'>
	};

	treeSummaries.set('thread', { descendantCount: 2, anyActive: false, descendantsActive: false });
	treeSummaries.set('child', { descendantCount: 1, anyActive: false, descendantsActive: false });

	const input = props([thread()]);
	input.expansion = expansionStub(['thread', 'child']);
	input.resolveChildren = childrenResolverStub({ thread: [child], child: [grandchild] });
	renderView(<NavigationHarness {...input} />);
	await flush();

	const expansionRows = [...document.querySelectorAll<HTMLButtonElement>('.inbox-subagents')];

	expect(
		expansionRows.map(
			(row) => row.closest('.inbox-row')?.querySelector('.inbox-row-subagents')?.textContent
		)
	).toEqual(['2 subagents', '1 subagent']);
	expect(expansionRows.every((row) => row.getAttribute('aria-expanded') === 'true')).toBe(true);

	const titles = [...document.querySelectorAll('.inbox-row-title')].map((row) => row.textContent);

	expect(titles).toEqual(['Thread', 'Child thread', 'Grandchild thread']);

	const childRow = [...document.querySelectorAll<HTMLElement>('.inbox-row')].find(
		(row) => row.getAttribute('aria-label') === 'Child thread'
	)!;

	const grandchildRow = [...document.querySelectorAll<HTMLElement>('.inbox-row')].find(
		(row) => row.getAttribute('aria-label') === 'Grandchild thread'
	)!;

	expect(Number(childRow.style.marginLeft.replace('px', ''))).toBeGreaterThan(0);
	expect(Number(grandchildRow.style.marginLeft.replace('px', ''))).toBeGreaterThan(
		Number(childRow.style.marginLeft.replace('px', ''))
	);
	const childMain = grandchildRow.querySelector<HTMLButtonElement>('.inbox-row-main')!;

	act(() => {
		childMain.click();
	});
	await flush();

	expect(childMain.getAttribute('aria-current')).toBe('page');
	expect(childMain.closest('.inbox-row-selected')).toBeTruthy();
});

it('collapses an expanded branch through the expansion control', async () => {
	treeSummaries.set('thread', { descendantCount: 1, anyActive: false, descendantsActive: false });
	const input = props([thread()]);
	input.expansion = expansionStub(['thread']);
	renderView(<Harness {...input} />);
	await flush();

	const expansion = document.querySelector<HTMLButtonElement>('.inbox-subagents')!;

	expect(expansion.getAttribute('aria-label')).toBe('Collapse subagents of Thread');
	expect(expansion.querySelector('.lucide-chevron-down')).toBeTruthy();

	act(() => {
		expansion.click();
	});

	expect(input.expansion.collapse).toHaveBeenCalledWith('thread');
});

it('hides settle and unsettle controls for child threads', async () => {
	const child = childThread('child', 'Child thread');
	treeSummaries.set('thread', { descendantCount: 1, anyActive: false, descendantsActive: false });

	const input = props([thread()]);
	input.expansion = expansionStub(['thread']);
	input.resolveChildren = childrenResolverStub({ thread: [child] });
	renderView(<Harness {...input} />);
	await flush();

	const childRow = [...document.querySelectorAll<HTMLElement>('.inbox-row')].find(
		(row) => row.getAttribute('aria-label') === 'Child thread'
	)!;

	expect(childRow.querySelector('[aria-label^="Settle"]')).toBeNull();
	expect(childRow.querySelector('[aria-label^="Unsettle"]')).toBeNull();
	expect(childRow.getAttribute('draggable')).toBe('false');

	act(() => {
		childRow.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })
		);
	});
	await flush();

	const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

	expect(actions.map((action) => action.textContent?.trim())).toEqual(['Rename', 'Copy thread ID']);
});

it.each([
	{
		status: 'completed',
		descendantCount: 2,
		descendantsActive: true,
		badge: '2 subagents · Working'
	},
	{ status: 'running', descendantCount: 2, descendantsActive: false, badge: '2 subagents' },
	{ status: 'running', descendantCount: 0, descendantsActive: false, badge: undefined },
	{ status: 'queued', descendantCount: 0, descendantsActive: false, badge: undefined }
] satisfies {
	status: ThreadStatus;
	descendantCount: number;
	descendantsActive: boolean;
	badge: string | undefined;
}[])(
	'blocks settling a $status root with descendant activity $descendantsActive',
	async ({ status, descendantCount, descendantsActive, badge }) => {
		if (descendantCount) {
			treeSummaries.set('thread', { descendantCount, anyActive: true, descendantsActive });
		}

		await render([thread(false, status)]);
		expect(document.querySelector('.inbox-row-subagents')?.textContent).toBe(badge);
		expect(document.querySelector('.inbox-subagents-working') !== null).toBe(descendantsActive);
		expect(
			document.querySelector<HTMLButtonElement>('[aria-label="Settle Thread"]')?.disabled
		).toBe(true);
		fireEvent.contextMenu(document.querySelector('.inbox-row')!);
		await flush();

		const settle = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
			(button) => button.textContent?.trim() === 'Settle'
		)!;

		expect(settle.disabled).toBe(true);
	}
);
