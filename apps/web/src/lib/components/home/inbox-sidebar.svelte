<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		Check,
		ChevronDown,
		FolderPlus,
		MoreHorizontal,
		PanelLeftClose,
		Plus,
		Settings,
		X
	} from '@lucide/svelte';
	import type { Doc, Id } from '$convex/_generated/dataModel';
	import { inboxState, type InboxState } from '$convex/lib/inboxState';
	import type { Project } from '$lib/types/sprocket';
	import type { SprocketTheme } from '$lib/theme';
	import type { InboxSectionData } from '$lib/project/inbox.svelte';
	import { hasActiveRun } from '$lib/project/threads';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import AppUpdate from './app-update.svelte';
	import InboxLoadMore from './inbox-load-more.svelte';
	import SidebarTopActions from './sidebar-top-actions.svelte';

	type Thread = Doc<'threadRecords'>;
	type Props = {
		sections: InboxSectionData[];
		projects: Project[];
		selectedProjects: string[];
		currentThreadId: Id<'threadRecords'> | null;
		mutationsEnabled: boolean;
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onFilter: (keys: string[]) => void;
		onSelect: (thread: Thread) => void;
		onNew: () => void;
		onAddProject: () => void;
		onSettings: () => void;
		onClose: () => void;
		onChange: (thread: Thread, state: InboxState) => Promise<void>;
		onRename: (thread: Thread, title: string) => Promise<void>;
	};

	let {
		sections,
		projects,
		selectedProjects,
		currentThreadId,
		mutationsEnabled,
		theme,
		onThemeChange,
		onFilter,
		onSelect,
		onNew,
		onAddProject,
		onSettings,
		onClose,
		onChange,
		onRename
	}: Props = $props();

	const labels = {
		unsettled: 'Unsettled',
		settled: 'Settled'
	} satisfies Record<InboxState, string>;
	let collapsed = $state<Partial<Record<InboxState, boolean>>>({});
	let selected = $state<Id<'threadRecords'>[]>([]);
	let anchor = $state<Id<'threadRecords'> | null>(null);
	let dragging = $state<Thread | null>(null);
	let menu = $state<{ thread: Thread; x: number; y: number } | null>(null);
	let menuTrigger: HTMLElement | null = null;
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let undo = $state<Array<{ thread: Thread; previous: InboxState }>>([]);
	let renameDialog: HTMLDialogElement;
	let renameThread = $state<Thread | null>(null);
	let renameTitle = $state('');
	let renaming = $state(false);
	let now = $state(Date.now());

	const rows = $derived(
		sections.flatMap((section) => (collapsed[section.state] ? [] : section.rows))
	);
	const selectedRows = $derived(rows.filter((thread) => selected.includes(thread._id)));
	const selectedUnsettled = $derived(selectedRows.filter((thread) => canChange(thread, 'settled')));
	const selectedSettled = $derived(selectedRows.filter((thread) => canChange(thread, 'unsettled')));
	const dragTargets = $derived(
		dragging ? (selected.includes(dragging._id) ? selectedRows : [dragging]) : []
	);

	onMount(() => {
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		const visibleIds = new Set(rows.map((thread) => thread._id));
		const remaining = selected.filter((id) => visibleIds.has(id));
		if (remaining.length !== selected.length) selected = remaining;
	});

	function projectName(thread: Thread) {
		return (
			projects.find((project) => project.repositoryKey === thread.repositoryKey)?.displayName ??
			thread.repositoryKey
		);
	}

	function age(at: number) {
		const minutes = Math.max(0, Math.floor((now - at) / 60_000));
		if (minutes < 1) return 'now';
		if (minutes < 60) return `${minutes}m`;
		if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
		return `${Math.floor(minutes / 1440)}d`;
	}

	function runStatus(thread: Thread) {
		if (threadHasActiveRun(thread)) {
			return thread.status === 'queued' ? 'Starting' : 'Working';
		}
		return thread.status === 'failed' ? 'Failed' : null;
	}

	function threadHasActiveRun(thread: Thread) {
		return hasActiveRun({ status: thread.status ?? 'completed' });
	}

	function choose(event: MouseEvent, thread: Thread) {
		if (event.detail > 1) return;
		if (event.shiftKey && anchor) {
			const start = rows.findIndex((row) => row._id === anchor);
			const end = rows.findIndex((row) => row._id === thread._id);
			selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1).map((row) => row._id);
			return;
		}
		if (event.metaKey || event.ctrlKey) {
			selected = selected.includes(thread._id)
				? selected.filter((id) => id !== thread._id)
				: [...selected, thread._id];
			anchor = thread._id;
			return;
		}
		selected = [];
		anchor = thread._id;
		onSelect(thread);
	}

	function canChange(thread: Thread, state: InboxState) {
		return inboxState(thread) !== state && (state !== 'settled' || !threadHasActiveRun(thread));
	}

	async function change(targets: Thread[], state: InboxState) {
		if (!mutationsEnabled || busy) return;
		closeMenu();
		busy = true;
		notice = null;
		const completed: typeof undo = [];
		const errors: string[] = [];
		for (const thread of targets) {
			if (!canChange(thread, state)) continue;
			try {
				await onChange(thread, state);
				completed.push({ thread, previous: inboxState(thread) });
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Could not update thread.');
			}
		}
		undo = completed;
		busy = false;
		selected = [];
		if (errors.length) notice = errors.join(' ');
		else if (completed.length)
			notice = `${completed.length === 1 ? 'Thread' : `${completed.length} threads`} updated.`;
	}

	async function undoChange() {
		if (!mutationsEnabled || busy) return;
		busy = true;
		const changes = undo;
		undo = [];
		const errors: string[] = [];
		for (const item of changes) {
			try {
				await onChange(item.thread, item.previous);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Could not undo change.');
			}
		}
		notice = errors.length ? errors.join(' ') : 'Change undone.';
		busy = false;
	}

	function canDrop(state: InboxState) {
		return mutationsEnabled && !busy && dragTargets.some((thread) => canChange(thread, state));
	}

	function dropThreads(event: DragEvent, state: InboxState) {
		event.preventDefault();
		if (canDrop(state)) void change(dragTargets, state);
		dragging = null;
	}

	async function jump(state: InboxState) {
		collapsed[state] = false;
		await tick();
		document.getElementById(`inbox-${state}`)?.scrollIntoView({ block: 'start' });
	}

	function closeMenu() {
		const trigger = menuTrigger;
		menu = null;
		menuTrigger = null;
		trigger?.focus();
	}

	function openMenu(event: MouseEvent, thread: Thread) {
		event.preventDefault();
		menuTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		const rect = menuTrigger?.getBoundingClientRect();
		menu = {
			thread,
			x: Math.min(event.clientX || rect?.left || 8, window.innerWidth - 230),
			y: Math.min(event.clientY || rect?.bottom || 8, window.innerHeight - 260)
		};
		void tick().then(() =>
			document
				.querySelector<HTMLButtonElement>('.inbox-context-menu button:not(:disabled)')
				?.focus()
		);
	}

	function navigateMenu(event: KeyboardEvent) {
		if (event.key === 'Tab' || event.key === 'Escape') {
			event.preventDefault();
			closeMenu();
			return;
		}
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		if (!(event.currentTarget instanceof HTMLElement)) return;
		const buttons = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
		];
		const index = buttons.findIndex((button) => button === document.activeElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? buttons.length - 1
					: (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
		buttons[next]?.focus();
	}

	function keydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape') {
			if (menu) closeMenu();
			else if (selected.length) selected = [];
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			onNew();
		}
		if (
			event.target instanceof Element &&
			event.target.closest('input, textarea, [contenteditable="true"], dialog')
		)
			return;
		if (
			(event.metaKey || event.ctrlKey) &&
			event.key.toLowerCase() === 'a' &&
			event.target instanceof Element &&
			event.target.closest('.inbox-sidebar')
		) {
			event.preventDefault();
			selected = rows.map((row) => row._id);
		}
		if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
			const index = rows.findIndex((thread) => thread._id === currentThreadId);
			const row = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
			if (row) {
				event.preventDefault();
				onSelect(row);
			}
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<aside class="inbox-sidebar" aria-label="Thread inbox">
	<header class="flex items-center gap-2 px-4 pt-4 pb-3">
		<BrandMark size="sm" class="mr-auto" />
		<SidebarTopActions {theme} {onThemeChange} />
		<button class="inbox-icon" type="button" aria-label="Close sidebar" onclick={onClose}>
			<PanelLeftClose size={16} />
		</button>
	</header>

	<div class="px-3 pb-3">
		<button class="inbox-new" type="button" onclick={onNew}>
			<Plus size={17} />
			<span>New thread</span>
			<kbd class="ml-auto opacity-40">⌘ N</kbd>
		</button>
		<details class="relative mt-2">
			<summary class="inbox-filter">
				{selectedProjects.length
					? `${selectedProjects.length} project${selectedProjects.length === 1 ? '' : 's'}`
					: 'All projects'}
				<ChevronDown size={14} />
			</summary>
			<div class="inbox-project-menu">
				<button class="inbox-menu-item" type="button" onclick={() => onFilter([])}>
					All projects
					{#if selectedProjects.length === 0}<Check size={14} />{/if}
				</button>
				{#each projects as project (project.repositoryKey)}
					<label class="inbox-menu-item">
						<input
							type="checkbox"
							checked={selectedProjects.includes(project.repositoryKey)}
							onchange={(event) =>
								onFilter(
									event.currentTarget.checked
										? [...selectedProjects, project.repositoryKey]
										: selectedProjects.filter((key) => key !== project.repositoryKey)
								)}
						/>
						<span class="truncate">{project.displayName}</span>
					</label>
				{/each}
				<button class="inbox-menu-item" type="button" onclick={onAddProject}>
					<FolderPlus size={14} />Create/Add project
				</button>
			</div>
		</details>
		<nav class="inbox-jumps" aria-label="Jump to section">
			{#each sections as section (section.state)}
				<button
					type="button"
					onclick={() => void jump(section.state)}
					ondragover={(event) => {
						if (canDrop(section.state)) event.preventDefault();
					}}
					ondrop={(event) => dropThreads(event, section.state)}
				>
					{labels[section.state]}
				</button>
			{/each}
		</nav>
	</div>

	{#if selectedRows.length}
		<div class="inbox-bulk">
			<span>{selectedRows.length} selected</span>
			{#if selectedUnsettled.length}
				<button
					type="button"
					disabled={!mutationsEnabled || busy}
					onclick={() => void change(selectedUnsettled, 'settled')}
					>Settle {selectedUnsettled.length}</button
				>
			{/if}
			{#if selectedSettled.length}
				<button
					type="button"
					disabled={!mutationsEnabled || busy}
					onclick={() => void change(selectedSettled, 'unsettled')}
					>Unsettle {selectedSettled.length}</button
				>
			{/if}
			<button type="button" aria-label="Clear selection" onclick={() => (selected = [])}>
				<X size={14} />
			</button>
		</div>
	{/if}

	<div class="inbox-scroll">
		{#each sections as section (section.state)}
			<section
				id={`inbox-${section.state}`}
				ondragover={(event) => {
					if (canDrop(section.state)) event.preventDefault();
				}}
				ondrop={(event) => dropThreads(event, section.state)}
				aria-label={labels[section.state]}
			>
				<button
					type="button"
					class="inbox-section-heading"
					aria-expanded={!collapsed[section.state]}
					onclick={() => (collapsed[section.state] = !collapsed[section.state])}
				>
					<ChevronDown size={12} class={collapsed[section.state] ? '-rotate-90' : ''} />
					<span>{labels[section.state]}</span>
				</button>
				{#if !collapsed[section.state]}
					{#each section.rows as thread (thread._id)}
						{@const stateLabel = runStatus(thread)}
						<div
							class:inbox-row-selected={thread._id === currentThreadId ||
								selected.includes(thread._id)}
							class="inbox-row"
							draggable={mutationsEnabled && !busy}
							ondragstart={(event) => {
								dragging = thread;
								event.dataTransfer?.setData('text/plain', thread._id);
							}}
							ondragend={() => (dragging = null)}
							oncontextmenu={(event) => openMenu(event, thread)}
							role="group"
							aria-label={thread.title ?? 'New thread'}
						>
							<button
								class="inbox-row-main"
								type="button"
								title={`${thread.title ?? 'New thread'}\n${projectName(thread)} · ${thread.selectedModel}\n${new Date(thread.lastMessageAt).toLocaleString()}`}
								onclick={(event) => choose(event, thread)}
								ondblclick={() => {
									if (!mutationsEnabled || busy) return;
									renameThread = thread;
									renameTitle = thread.title ?? '';
									renameDialog.showModal();
								}}
								aria-current={thread._id === currentThreadId ? 'page' : undefined}
							>
								<span class="inbox-row-title"
									><span class="truncate">{thread.title ?? 'New thread'}</span></span
								>
								<span class="inbox-row-meta">
									<span class="truncate">{projectName(thread)}</span>
									<span class="truncate opacity-60">{thread.selectedModel}</span>
								</span>
								<span class="inbox-row-bottom">
									{#if stateLabel}
										<span
											class:inbox-working={threadHasActiveRun(thread)}
											class:inbox-attention={thread.status === 'failed'}
											class="inbox-status">{stateLabel}</span
										>
									{/if}
									<span class="ml-auto">{age(thread.lastMessageAt)}</span>
								</span>
							</button>
							<div class="inbox-row-actions">
								{#if section.state === 'unsettled'}
									<button
										class="inbox-icon"
										type="button"
										disabled={!mutationsEnabled || busy || !canChange(thread, 'settled')}
										aria-label={`Settle ${thread.title ?? 'thread'}`}
										onclick={() => void change([thread], 'settled')}><Check size={14} /></button
									>
								{:else}
									<button
										class="inbox-icon"
										type="button"
										disabled={!mutationsEnabled || busy}
										aria-label={`Unsettle ${thread.title ?? 'thread'}`}
										onclick={() => void change([thread], 'unsettled')}><Plus size={14} /></button
									>
								{/if}
								<button
									class="inbox-icon"
									type="button"
									aria-label={`Actions for ${thread.title ?? 'thread'}`}
									onclick={(event) => openMenu(event, thread)}><MoreHorizontal size={15} /></button
								>
							</div>
						</div>
					{/each}
					{#if section.rows.length === 0 && !section.loading && !section.error}
						<p class="inbox-empty">No {labels[section.state].toLowerCase()} threads</p>
					{/if}
					<InboxLoadMore {section} />
				{/if}
			</section>
		{/each}
	</div>

	{#if notice}
		<div class="inbox-notice" role="status">
			<span>{notice}</span>
			{#if undo.length}
				<button
					type="button"
					disabled={!mutationsEnabled || busy}
					onclick={() => void undoChange()}
				>
					Undo
				</button>
			{/if}
			<button
				type="button"
				aria-label="Dismiss notification"
				onclick={() => {
					notice = null;
					undo = [];
				}}><X size={13} /></button
			>
		</div>
	{/if}

	<footer class="inbox-footer">
		<button class="inbox-menu-item" type="button" onclick={onSettings}>
			<Settings size={15} />Settings
		</button>
		<AppUpdate />
	</footer>
</aside>

{#if menu}
	{@const thread = menu.thread}
	{@const targets = selected.includes(thread._id) ? selectedRows : [thread]}
	<button
		class="fixed inset-0 z-[200] cursor-default"
		type="button"
		aria-label="Close thread actions"
		onclick={closeMenu}
	></button>
	<div
		class="inbox-context-menu"
		style:left={`${Math.max(8, menu.x)}px`}
		style:top={`${Math.max(8, menu.y)}px`}
		role="menu"
		tabindex="-1"
		onkeydown={navigateMenu}
	>
		{#if inboxState(thread) === 'unsettled'}
			<button
				type="button"
				role="menuitem"
				disabled={!mutationsEnabled || busy || !targets.every((row) => canChange(row, 'settled'))}
				onclick={() => void change(targets, 'settled')}><Check size={14} />Settle</button
			>
		{:else}
			<button
				type="button"
				role="menuitem"
				disabled={!mutationsEnabled || busy}
				onclick={() => void change(targets, 'unsettled')}>Unsettle</button
			>
		{/if}
		<button
			type="button"
			role="menuitem"
			disabled={!mutationsEnabled || targets.length !== 1}
			onclick={() => {
				renameThread = thread;
				renameTitle = thread.title ?? '';
				menu = null;
				renameDialog.showModal();
			}}>Rename</button
		>
		<button
			type="button"
			role="menuitem"
			onclick={() => {
				selected = selected.includes(thread._id)
					? selected.filter((id) => id !== thread._id)
					: [...selected, thread._id];
				anchor = thread._id;
				menu = null;
			}}>{selected.includes(thread._id) ? 'Deselect thread' : 'Select thread'}</button
		>
		<button
			type="button"
			role="menuitem"
			onclick={() => {
				void navigator.clipboard.writeText(thread._id).catch(() => {
					notice = 'Could not copy thread ID.';
				});
				menu = null;
			}}>Copy thread ID</button
		>
	</div>
{/if}

<dialog bind:this={renameDialog} class="inbox-dialog" onclose={() => (renameThread = null)}>
	<form
		onsubmit={async (event) => {
			event.preventDefault();
			if (!renameThread || !renameTitle.trim() || !mutationsEnabled || renaming) return;
			renaming = true;
			try {
				await onRename(renameThread, renameTitle.trim());
				renameDialog.close();
			} catch (error) {
				notice = error instanceof Error ? error.message : 'Could not rename thread.';
			} finally {
				renaming = false;
			}
		}}
	>
		<label for="inbox-rename">Rename thread</label>
		<input id="inbox-rename" bind:value={renameTitle} required maxlength="300" />
		<div class="mt-4 flex justify-end gap-3">
			<button type="button" onclick={() => renameDialog.close()}>Cancel</button>
			<button type="submit" disabled={!mutationsEnabled || renaming}>Save</button>
		</div>
	</form>
</dialog>
