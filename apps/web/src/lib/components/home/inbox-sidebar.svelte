<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { z } from 'zod';
	import {
		Check,
		ChevronDown,
		Clock,
		FolderPlus,
		MoreHorizontal,
		PanelLeftClose,
		Pin,
		Plus,
		Settings,
		X
	} from '@lucide/svelte';
	import type { Doc, Id } from '$convex/_generated/dataModel';
	import type { Project } from '$lib/types/sprocket';
	import type { SprocketTheme } from '$lib/theme';
	import type { InboxSectionData } from '$lib/project/inbox.svelte';
	import { INBOX_STATES, inboxState, runningStatus, type InboxState } from '$convex/lib/inboxState';
	import {
		canChangeInboxState,
		INBOX_LABELS,
		snoozePresets,
		snoozeWakeLabel
	} from '$lib/project/inbox';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import SidebarTopActions from './sidebar-top-actions.svelte';
	import AppUpdate from './app-update.svelte';
	import InboxLoadMore from './inbox-load-more.svelte';

	type Thread = Doc<'threadRecords'>;
	type Props = {
		sections: InboxSectionData[];
		projects: Project[];
		selectedProjects: string[];
		currentThreadId: Id<'threadRecords'> | null;
		userId: string;
		online: boolean;
		migrating: boolean;
		error: string | null;
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onFilter: (keys: string[]) => void;
		onSelect: (thread: Thread) => void;
		onNew: () => void;
		onAddProject: () => void;
		onSettings: () => void;
		onClose: () => void;
		onChange: (thread: Thread, state: InboxState, until?: number, undo?: boolean) => Promise<void>;
		onRename: (thread: Thread, title: string) => Promise<void>;
	};
	let {
		sections,
		projects,
		selectedProjects,
		currentThreadId,
		userId,
		online,
		migrating,
		error,
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
	let collapsed = $state<Partial<Record<InboxState, boolean>>>({});
	let visited = $state<Record<string, number>>({});
	let selected = $state<string[]>([]);
	let anchor = $state<string | null>(null);
	let dragging = $state<Thread | null>(null);
	let menu = $state<{ thread: Thread; x: number; y: number } | null>(null);
	let menuTrigger: HTMLElement | null = null;
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let undo = $state<
		Array<{ thread: Thread; previous: InboxState; current: InboxState; currentUntil?: number }>
	>([]);
	let renameDialog: HTMLDialogElement;
	let renameThread = $state<Thread | null>(null);
	let renameTitle = $state('');
	let renaming = $state(false);
	let now = $state(Date.now());
	function sectionVisible(index: number) {
		return sections
			.slice(0, index)
			.every(
				(previous) =>
					collapsed[previous.state] ||
					previous.error ||
					(!previous.canLoadMore && !previous.loading)
			);
	}
	const rows = $derived(
		sections.flatMap((section, index) =>
			collapsed[section.state] || !sectionVisible(index) ? [] : section.rows
		)
	);
	const selectedRows = $derived(rows.filter((thread) => selected.includes(thread._id)));
	const dragTargets = $derived(
		dragging ? (selected.includes(dragging._id) ? selectedRows : [dragging]) : []
	);
	function canDrop(state: InboxState) {
		return (
			online &&
			!busy &&
			dragTargets.length > 0 &&
			dragTargets.every((thread) => canChangeInboxState(thread, state))
		);
	}
	function dropThreads(event: DragEvent, state: InboxState) {
		event.preventDefault();
		if (dragging && canDrop(state)) {
			if (state === 'snoozed') openMenu(event, dragging);
			else void change(dragTargets, state);
		}
		dragging = null;
	}
	const key = $derived(`sprocket:inbox:${userId}`);
	const preferences = z.object({
		visited: z.record(z.string(), z.number()).default({}),
		collapsed: z.record(z.string(), z.boolean()).default({})
	});
	onMount(() => {
		try {
			const stored = preferences.safeParse(JSON.parse(localStorage.getItem(key) ?? '{}'));
			if (stored.success) {
				visited = stored.data.visited;
				collapsed = Object.fromEntries(
					INBOX_STATES.map((state) => [state, stored.data.collapsed[state] === true])
				);
			}
		} catch {
			/* Corrupt local preferences do not prevent navigation. */
		}
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);
		return () => clearInterval(timer);
	});
	$effect(() => {
		try {
			localStorage.setItem(key, JSON.stringify({ visited, collapsed }));
		} catch {
			/* Storage may be disabled. */
		}
	});
	$effect(() => {
		const current = rows.find((thread) => thread._id === currentThreadId);
		if (current) {
			const at = Math.max(current.lastCompletedAt ?? 0, current.wokeAt ?? 0);
			untrack(() => {
				if (visited[current._id] === undefined || at > visited[current._id])
					visited = { ...visited, [current._id]: at };
			});
		}
	});
	$effect(() => {
		const remaining = selected.filter((id) => rows.some((row) => row._id === id));
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
		return minutes < 1
			? 'now'
			: minutes < 60
				? `${minutes}m`
				: minutes < 1440
					? `${Math.floor(minutes / 60)}h`
					: `${Math.floor(minutes / 1440)}d`;
	}
	function status(thread: Thread) {
		if (thread.hasPendingQuestion) return 'Needs input';
		if (runningStatus(thread.status)) return thread.status === 'queued' ? 'Starting' : 'Working';
		if (thread.status === 'failed') return 'Failed';
		if (thread.wokeAt && thread.wokeAt > (visited[thread._id] ?? 0)) return 'Woke';
		if (visited[thread._id] !== undefined && (thread.lastCompletedAt ?? 0) > visited[thread._id])
			return 'Completed';
		return null;
	}
	function choose(event: MouseEvent, thread: Thread) {
		if (event.detail > 1) return;
		if (event.shiftKey && anchor) {
			const start = rows.findIndex((row) => row._id === anchor);
			const end = rows.findIndex((row) => row._id === thread._id);
			selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1).map((row) => row._id);
		} else if (
			event.metaKey ||
			event.ctrlKey ||
			(selected.length > 0 && matchMedia('(pointer: coarse)').matches)
		) {
			selected = selected.includes(thread._id)
				? selected.filter((id) => id !== thread._id)
				: [...selected, thread._id];
			anchor = thread._id;
		} else {
			selected = [];
			anchor = thread._id;
			visited = {
				...visited,
				[thread._id]: Math.max(thread.lastCompletedAt ?? 0, thread.wokeAt ?? 0)
			};
			onSelect(thread);
		}
	}
	async function change(targets: Thread[], state: InboxState, until?: number) {
		if (!online || busy) return;
		closeMenu();
		busy = true;
		notice = null;
		const completed: typeof undo = [];
		const errors: string[] = [];
		for (const thread of targets) {
			if (inboxState(thread) === state && (state !== 'snoozed' || thread.snoozedUntil === until))
				continue;
			try {
				await onChange(thread, state, until);
				completed.push({
					thread,
					previous: inboxState(thread),
					current: state,
					currentUntil: until
				});
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Could not update thread.');
			}
		}
		undo = completed;
		busy = false;
		selected = [];
		notice = errors.length
			? errors.join(' ')
			: `${completed.length === 1 ? 'Thread' : `${completed.length} threads`} updated.`;
	}
	async function undoChange() {
		if (!online || busy) return;
		busy = true;
		const changes = undo;
		undo = [];
		const errors: string[] = [];
		for (const item of changes) {
			try {
				let thread = { ...item.thread, inboxState: item.current, snoozedUntil: item.currentUntil };
				if (
					item.current === 'pinned' &&
					(item.previous === 'snoozed' || item.previous === 'settled')
				) {
					await onChange(thread, 'active', undefined, true);
					thread = { ...thread, inboxState: 'active' };
				}
				const previous =
					item.previous === 'snoozed' && (item.thread.snoozedUntil ?? 0) <= Date.now()
						? 'active'
						: item.previous;
				await onChange(thread, previous, item.thread.snoozedUntil, true);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : 'Could not undo change.');
			}
		}
		notice = errors.length ? errors.join(' ') : 'Change undone.';
		busy = false;
	}
	async function jump(state: InboxState) {
		for (const earlier of INBOX_STATES.slice(0, INBOX_STATES.indexOf(state)))
			collapsed[earlier] = true;
		collapsed[state] = false;
		await tick();
		document.getElementById(`inbox-${state}`)?.scrollIntoView({ block: 'start' });
	}
	function closeMenu() {
		menu = null;
		menuTrigger?.focus();
	}
	function openMenu(event: MouseEvent, thread: Thread) {
		event.preventDefault();
		menuTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		const rect = menuTrigger?.getBoundingClientRect();
		menu = {
			thread,
			x: Math.min(event.clientX || rect?.left || 8, window.innerWidth - 230),
			y: Math.min(event.clientY || rect?.bottom || 8, window.innerHeight - 350)
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
			else if (matchMedia('(max-width: 767px)').matches) onClose();
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
		if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
			const row = rows[Number(event.key) - 1];
			if (row) {
				event.preventDefault();
				onSelect(row);
			}
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
		<BrandMark size="sm" class="mr-auto" /><SidebarTopActions
			{theme}
			{onThemeChange}
			disabled={!online}
		/><button class="inbox-icon" aria-label="Close sidebar" onclick={onClose}
			><PanelLeftClose size={16} /></button
		>
	</header>
	<div class="px-3 pb-3">
		<button class="inbox-new" onclick={onNew}
			><Plus size={17} /><span>New thread</span><kbd class="ml-auto opacity-40">⌘ N</kbd></button
		>
		<details class="relative mt-2">
			<summary class="inbox-filter"
				>{selectedProjects.length
					? `${selectedProjects.length} project${selectedProjects.length === 1 ? '' : 's'}`
					: 'All projects'}<ChevronDown size={14} /></summary
			>
			<div class="inbox-project-menu">
				<button class="inbox-menu-item" onclick={() => onFilter([])}
					>All projects {#if !selectedProjects.length}<Check size={14} />{/if}</button
				>
				{#each projects as project (project.repositoryKey)}<label class="inbox-menu-item"
						><input
							type="checkbox"
							checked={selectedProjects.includes(project.repositoryKey)}
							onchange={(event) =>
								onFilter(
									event.currentTarget.checked
										? [...selectedProjects, project.repositoryKey]
										: selectedProjects.filter((key) => key !== project.repositoryKey)
								)}
						/><span class="truncate">{project.displayName}</span></label
					>{/each}
				<button class="inbox-menu-item" onclick={onAddProject}
					><FolderPlus size={14} />Create/Add project</button
				>
			</div>
		</details>
		<nav class="inbox-jumps" aria-label="Jump to section">
			{#each sections as section (section.state)}<button
					onclick={() => void jump(section.state)}
					ondragover={(event) => {
						if (canDrop(section.state)) event.preventDefault();
					}}
					ondrop={(event) => dropThreads(event, section.state)}
					title={INBOX_LABELS[section.state]}
					>{INBOX_LABELS[section.state]} <span>{section.count}</span></button
				>{/each}
		</nav>
	</div>
	{#if !online}<p class="inbox-note">Offline. Showing cached threads.</p>{/if}
	{#if migrating}<p class="inbox-note" role="status">Preparing existing thread history…</p>{/if}
	{#if error}<p class="inbox-note text-destructive" role="alert">{error}</p>{/if}
	{#if selectedRows.length}<div class="inbox-bulk">
			<span>{selectedRows.length} selected</span><button
				disabled={!online || busy}
				onclick={() => void change(selectedRows, 'pinned')}>Pin</button
			><button
				disabled={!online ||
					busy ||
					!selectedRows.some((thread) => canChangeInboxState(thread, 'settled'))}
				onclick={() =>
					void change(
						selectedRows.filter((thread) => canChangeInboxState(thread, 'settled')),
						'settled'
					)}
				>Settle {selectedRows.filter((thread) => canChangeInboxState(thread, 'settled'))
					.length}</button
			><button aria-label="Clear selection" onclick={() => (selected = [])}><X size={14} /></button>
		</div>{/if}
	<div class="inbox-scroll">
		{#each sections as section, index (section.state)}
			{#if sectionVisible(index)}
				<section
					id={`inbox-${section.state}`}
					ondragover={(event) => {
						if (canDrop(section.state)) event.preventDefault();
					}}
					ondrop={(event) => dropThreads(event, section.state)}
					aria-label={INBOX_LABELS[section.state]}
				>
					<button
						class="inbox-section-heading"
						aria-expanded={!collapsed[section.state]}
						onclick={() => (collapsed[section.state] = !collapsed[section.state])}
						><ChevronDown size={12} class={collapsed[section.state] ? '-rotate-90' : ''} /><span
							>{INBOX_LABELS[section.state]}</span
						><span class="ml-auto tabular-nums">{section.count}</span></button
					>
					{#if !collapsed[section.state]}
						{#each section.rows as thread (thread._id)}
							{@const stateLabel = status(thread)}
							{@const rich =
								(section.state === 'active' || section.state === 'pinned') && stateLabel !== null}
							<div
								class:inbox-row-rich={rich}
								class:inbox-row-selected={thread._id === currentThreadId ||
									selected.includes(thread._id)}
								class="inbox-row"
								draggable={online && !busy}
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
									title={`${thread.title ?? 'New thread'}\n${projectName(thread)} · ${thread.selectedModel}\n${new Date(thread.lastMessageAt).toLocaleString()}`}
									onclick={(event) => choose(event, thread)}
									ondblclick={() => {
										if (!online || busy) return;
										renameThread = thread;
										renameTitle = thread.title ?? '';
										renameDialog.showModal();
									}}
									aria-current={thread._id === currentThreadId ? 'page' : undefined}
								>
									<span class="inbox-row-title"
										>{#if section.state === 'pinned'}<Pin size={12} />{/if}<span class="truncate"
											>{thread.title ?? 'New thread'}</span
										></span
									>
									{#if rich}<span class="inbox-row-meta"
											><span class="truncate">{projectName(thread)}</span><span
												class="truncate opacity-60">{thread.selectedModel}</span
											></span
										>{/if}
									<span class="inbox-row-bottom"
										>{#if stateLabel}<span
												class:inbox-working={runningStatus(thread.status)}
												class:inbox-attention={thread.hasPendingQuestion ||
													thread.status === 'failed'}
												class="inbox-status">{stateLabel}</span
											>{/if}<span
											class="ml-auto"
											title={new Date(
												section.state === 'snoozed'
													? (thread.snoozedUntil ?? thread.lastMessageAt)
													: thread.lastMessageAt
											).toLocaleString()}
											>{section.state === 'snoozed' && thread.snoozedUntil
												? snoozeWakeLabel(thread.snoozedUntil, now)
												: age(
														runningStatus(thread.status)
															? (thread.lastRunStartedAt ?? thread.lastMessageAt)
															: thread.lastMessageAt
													)}</span
										></span
									>
								</button>
								<div class="inbox-row-actions">
									{#if section.state === 'active'}<button
											class="inbox-icon"
											disabled={!online || busy || !canChangeInboxState(thread, 'settled')}
											aria-label={`Settle ${thread.title}`}
											onclick={() => void change([thread], 'settled')}><Check size={14} /></button
										>{:else if section.state === 'settled' || section.state === 'snoozed'}<button
											class="inbox-icon"
											disabled={!online || busy}
											aria-label={section.state === 'settled' ? 'Unsettle thread' : 'Wake thread'}
											onclick={() => void change([thread], 'active')}><Plus size={14} /></button
										>{/if}
									<button
										class="inbox-icon"
										aria-label={`Actions for ${thread.title}`}
										onclick={(event) => openMenu(event, thread)}
										><MoreHorizontal size={15} /></button
									>
								</div>
							</div>
						{/each}
						{#if !section.rows.length && !section.loading}<p class="inbox-empty">
								No {INBOX_LABELS[section.state].toLowerCase()} threads
							</p>{/if}
						<InboxLoadMore {section} />
					{/if}
				</section>
			{/if}
		{/each}
	</div>
	{#if notice}<div class="inbox-notice" role="status">
			<span>{notice}</span>{#if undo.length}<button
					disabled={!online || busy}
					onclick={() => void undoChange()}>Undo</button
				>{/if}<button
				aria-label="Dismiss notification"
				onclick={() => {
					notice = null;
					undo = [];
				}}><X size={13} /></button
			>
		</div>{/if}
	<footer class="inbox-footer">
		<button class="inbox-menu-item" onclick={onSettings}><Settings size={15} />Settings</button
		><AppUpdate />
	</footer>
</aside>

{#if menu}
	{@const thread = menu.thread}
	{@const targets = selected.includes(thread._id) ? selectedRows : [thread]}
	<button
		class="fixed inset-0 z-[200] cursor-default"
		aria-label="Close thread actions"
		onclick={closeMenu}
	></button>
	<div
		class="inbox-context-menu"
		style:left={`${Math.max(8, menu.x)}px`}
		style:top={`${Math.max(8, menu.y)}px`}
		style:max-height={`calc(100dvh - ${Math.max(8, menu.y) + 8}px)`}
		role="menu"
		tabindex="-1"
		onkeydown={navigateMenu}
	>
		{#if inboxState(thread) === 'pinned'}<button
				role="menuitem"
				disabled={!online || busy}
				onclick={() => void change(targets, 'active')}>Unpin</button
			>{:else}<button
				role="menuitem"
				disabled={!online || busy}
				onclick={() => void change(targets, 'pinned')}><Pin size={14} />Pin</button
			>{/if}
		{#if inboxState(thread) !== 'active' && inboxState(thread) !== 'pinned'}<button
				role="menuitem"
				disabled={!online || busy}
				onclick={() => void change(targets, 'active')}
				>{inboxState(thread) === 'settled' ? 'Unsettle' : 'Wake now'}</button
			>{/if}
		<button
			role="menuitem"
			disabled={!online || busy || !targets.every((row) => canChangeInboxState(row, 'settled'))}
			onclick={() => void change(targets, 'settled')}><Check size={14} />Settle</button
		>
		{#if targets.every((row) => canChangeInboxState(row, 'snoozed'))}<p class="inbox-menu-label">
				<Clock size={12} />Snooze until
			</p>
			{#each snoozePresets() as preset (preset.label)}<button
					role="menuitem"
					disabled={!online || busy}
					onclick={() => void change(targets, 'snoozed', preset.until)}
					>{preset.label}<span class="ml-auto text-xs opacity-50"
						>{new Date(preset.until).toLocaleTimeString([], {
							hour: 'numeric',
							minute: '2-digit'
						})}</span
					></button
				>{/each}{/if}
		<button
			role="menuitem"
			disabled={!online || targets.length !== 1}
			onclick={() => {
				renameThread = thread;
				renameTitle = thread.title ?? '';
				menu = null;
				renameDialog.showModal();
			}}>Rename</button
		>
		<button
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
			role="menuitem"
			onclick={() => {
				for (const row of targets) {
					const latestActivity = Math.max(row.lastCompletedAt ?? 0, row.wokeAt ?? 0);
					if (latestActivity) visited[row._id] = latestActivity - 1;
				}
				menu = null;
			}}>Mark unread</button
		>
		<button
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
			if (!renameThread || !renameTitle.trim() || !online || renaming) return;
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
		<label for="inbox-rename">Rename thread</label><input
			id="inbox-rename"
			bind:value={renameTitle}
			required
			maxlength="300"
		/>
		<div class="mt-4 flex justify-end gap-3">
			<button type="button" onclick={() => renameDialog.close()}>Cancel</button><button
				type="submit"
				disabled={!online || renaming}>Save</button
			>
		</div>
	</form>
</dialog>
