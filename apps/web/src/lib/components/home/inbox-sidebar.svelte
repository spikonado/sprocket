<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		Check,
		ChevronDown,
		Copy,
		FolderPlus,
		RotateCcw,
		Search,
		Settings,
		SquarePen,
		X
	} from '@lucide/svelte';
	import type { Doc, Id } from '$convex/_generated/dataModel';
	import type { CatalogModel } from '$convex/lib/uiModelCatalog';
	import { inboxState, type InboxState } from '$convex/lib/inboxState';
	import type { Project } from '$lib/types/sprocket';
	import type { SprocketTheme } from '$lib/theme';
	import type { InboxSectionData } from '$lib/project/inbox.svelte';
	import { hasActiveRun } from '$lib/project/threads';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
	import AppUpdate from './app-update.svelte';
	import InboxLoadMore from './inbox-load-more.svelte';
	import SidebarTopActions from './sidebar-top-actions.svelte';

	type Thread = Doc<'threadRecords'>;
	type Props = {
		sections: InboxSectionData[];
		projects: Project[];
		models: readonly Pick<CatalogModel, 'id' | 'label' | 'provider'>[];
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
		onChange: (thread: Thread, state: InboxState) => Promise<void>;
		onRename: (thread: Thread, title: string) => Promise<void>;
	};

	let {
		sections,
		projects,
		models,
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
		onChange,
		onRename
	}: Props = $props();

	const labels = {
		unsettled: 'Unsettled',
		settled: 'Settled'
	} satisfies Record<InboxState, string>;
	let dragging = $state<Thread | null>(null);
	let menu = $state<{ thread: Thread; x: number; y: number } | null>(null);
	let menuTrigger: HTMLElement | null = null;
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let renameThread = $state<Thread | null>(null);
	let renameTitle = $state('');
	let renameInput = $state<HTMLInputElement | null>(null);
	let now = $state(Date.now());
	let projectMenuOpen = $state(false);
	let projectSearch = $state('');

	const rows = $derived(sections.flatMap((section) => section.rows));
	const filteredProjects = $derived(
		projects.filter((project) =>
			project.displayName.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())
		)
	);
	const visibleSections = $derived(
		sections.filter(
			(section) => section.rows.length || section.loading || section.error || section.canLoadMore
		)
	);
	const projectFilterLabel = $derived(
		selectedProjects.length === 0
			? 'All projects'
			: selectedProjects.length === 1
				? (projects.find((project) => project.repositoryKey === selectedProjects[0])?.displayName ??
					'All projects')
				: `${selectedProjects.length} projects`
	);

	onMount(() => {
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!renameThread || !renameInput) return;
		renameInput.focus();
		renameInput.select();
	});

	function projectName(thread: Thread) {
		return (
			projects.find((project) => project.repositoryKey === thread.repositoryKey)?.displayName ??
			thread.repositoryKey
		);
	}

	function threadModel(thread: Thread) {
		return models.find((model) => model.id === thread.selectedModel);
	}

	function filterProjects(keys: string[]) {
		onFilter(keys);
		projectMenuOpen = false;
		projectSearch = '';
	}

	function addProject() {
		projectMenuOpen = false;
		projectSearch = '';
		onAddProject();
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

	function choose(thread: Thread) {
		onSelect(thread);
	}

	function beginRename(thread: Thread) {
		menu = null;
		renameThread = thread;
		renameTitle = thread.title ?? '';
	}

	function cancelRename() {
		renameThread = null;
		renameTitle = '';
	}

	async function commitRename() {
		if (!renameThread) return;
		const thread = renameThread;
		const title = renameTitle.trim();
		if (!title || title === (thread.title ?? '')) {
			cancelRename();
			return;
		}
		cancelRename();
		try {
			await onRename(thread, title);
		} catch (error) {
			notice = error instanceof Error ? error.message : 'Could not rename thread.';
		}
	}

	function canChange(thread: Thread, state: InboxState) {
		return inboxState(thread) !== state && (state !== 'settled' || !threadHasActiveRun(thread));
	}

	async function change(thread: Thread, state: InboxState) {
		if (!mutationsEnabled || busy) return;
		closeMenu();
		busy = true;
		notice = null;
		if (!canChange(thread, state)) {
			busy = false;
			return;
		}
		try {
			await onChange(thread, state);
		} catch (error) {
			notice = error instanceof Error ? error.message : 'Could not update thread.';
		} finally {
			busy = false;
		}
	}

	function canDrop(state: InboxState) {
		return mutationsEnabled && !busy && dragging !== null && canChange(dragging, state);
	}

	function dropThreads(event: DragEvent, state: InboxState) {
		event.preventDefault();
		if (dragging && canDrop(state)) void change(dragging, state);
		dragging = null;
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
	</header>

	<div class="px-3 pb-3">
		<button class="inbox-menu-item" type="button" onclick={onNew}>
			<SquarePen size={15} />New thread
		</button>
		<div class="inbox-project-controls">
			<details bind:open={projectMenuOpen}>
				<summary class="inbox-filter">
					<span class="truncate">{projectFilterLabel}</span>
					<ChevronDown size={14} />
				</summary>
				<div class="inbox-project-menu">
					<label class="inbox-project-search">
						<Search size={14} />
						<input
							bind:value={projectSearch}
							aria-label="Search projects"
							placeholder="Search projects"
						/>
					</label>
					<div class="inbox-project-list">
						<button
							class:inbox-project-selected={selectedProjects.length === 0}
							class="inbox-project-option"
							type="button"
							aria-pressed={selectedProjects.length === 0}
							onclick={() => filterProjects([])}>All projects</button
						>
						{#each filteredProjects as project (project.repositoryKey)}
							<button
								class:inbox-project-selected={selectedProjects.length === 1 &&
									selectedProjects[0] === project.repositoryKey}
								class="inbox-project-option"
								type="button"
								aria-pressed={selectedProjects.length === 1 &&
									selectedProjects[0] === project.repositoryKey}
								onclick={() => filterProjects([project.repositoryKey])}
								>{project.displayName}</button
							>
						{/each}
					</div>
				</div>
			</details>
			<button
				class="inbox-icon inbox-add-project-button"
				type="button"
				aria-label="Create or add project"
				onclick={addProject}
			>
				<FolderPlus size={17} />
			</button>
		</div>
	</div>

	<div class="inbox-scroll">
		{#each visibleSections as section (section.state)}
			<section
				id={`inbox-${section.state}`}
				ondragover={(event) => {
					if (canDrop(section.state)) event.preventDefault();
				}}
				ondrop={(event) => dropThreads(event, section.state)}
				aria-label={labels[section.state]}
			>
				{#if section.state === 'settled'}
					<h2 class="inbox-section-heading">Settled</h2>
				{/if}
				{#each section.rows as thread (thread._id)}
					{@const stateLabel = runStatus(thread)}
					{@const model = threadModel(thread)}
					{@const isRenaming = renameThread?._id === thread._id}
					<div
						class:inbox-row-selected={thread._id === currentThreadId}
						class="inbox-row"
						draggable={mutationsEnabled && !busy && !isRenaming}
						ondragstart={(event) => {
							dragging = thread;
							event.dataTransfer?.setData('text/plain', thread._id);
						}}
						ondragend={() => (dragging = null)}
						oncontextmenu={(event) => openMenu(event, thread)}
						role="group"
						aria-label={thread.title ?? 'New thread'}
					>
						{#if isRenaming}
							<form
								class="inbox-row-main"
								onsubmit={(event) => {
									event.preventDefault();
									void commitRename();
								}}
							>
								<span class="inbox-row-meta">
									<span class="truncate">{projectName(thread)}</span>
									<span class="inbox-row-age shrink-0">{age(thread.lastMessageAt)}</span>
								</span>
								<input
									bind:this={renameInput}
									bind:value={renameTitle}
									class="inbox-row-rename-input"
									aria-label="Rename thread"
									maxlength="300"
									onkeydown={(event) => {
										if (event.key !== 'Escape') return;
										event.preventDefault();
										cancelRename();
									}}
									onblur={() => void commitRename()}
								/>
								<span class="inbox-row-model">
									{#if model}
										<ProviderLogo provider={model.provider} className="size-3.5 shrink-0" />
										<span class="truncate">{model.label}</span>
									{:else}
										<span class="truncate">Unknown model</span>
									{/if}
								</span>
							</form>
						{:else}
							<button
								class="inbox-row-main"
								type="button"
								title={`${thread.title ?? 'New thread'}\n${projectName(thread)}\n${new Date(thread.lastMessageAt).toLocaleString()}`}
								onclick={() => choose(thread)}
								ondblclick={() => {
									if (!mutationsEnabled || busy) return;
									beginRename(thread);
								}}
								aria-current={thread._id === currentThreadId ? 'page' : undefined}
							>
								<span class="inbox-row-meta">
									<span class="truncate">{projectName(thread)}</span>
									<span class="inbox-row-age shrink-0">{age(thread.lastMessageAt)}</span>
								</span>
								<span class="inbox-row-title truncate">{thread.title ?? 'New thread'}</span>
								<span class="inbox-row-model">
									{#if model}
										<ProviderLogo provider={model.provider} className="size-3.5 shrink-0" />
										<span class="truncate">{model.label}</span>
									{:else}
										<span class="truncate">Unknown model</span>
									{/if}
									{#if stateLabel}
										<span
											class:inbox-working={threadHasActiveRun(thread)}
											class:inbox-attention={thread.status === 'failed'}
											class="inbox-status">{stateLabel}</span
										>
									{/if}
								</span>
							</button>
						{/if}
						{#if !isRenaming}<div class="inbox-row-actions">
								{#if section.state === 'unsettled'}
									<button
										class="inbox-icon inbox-row-state-action"
										type="button"
										disabled={!mutationsEnabled || busy || !canChange(thread, 'settled')}
										aria-label={`Settle ${thread.title ?? 'thread'}`}
										onclick={() => void change(thread, 'settled')}><Check size={14} /></button
									>
								{:else}
									<button
										class="inbox-icon inbox-row-state-action"
										type="button"
										disabled={!mutationsEnabled || busy}
										aria-label={`Unsettle ${thread.title ?? 'thread'}`}
										onclick={() => void change(thread, 'unsettled')}><RotateCcw size={14} /></button
									>
								{/if}
							</div>{/if}
					</div>
				{/each}
				<InboxLoadMore {section} />
			</section>
		{/each}
	</div>

	{#if notice}
		<div class="inbox-notice" role="status">
			<span>{notice}</span>
			<button type="button" aria-label="Dismiss notification" onclick={() => (notice = null)}
				><X size={13} /></button
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
				disabled={!mutationsEnabled || busy || !canChange(thread, 'settled')}
				onclick={() => void change(thread, 'settled')}><Check size={14} />Settle</button
			>
		{:else}
			<button
				type="button"
				role="menuitem"
				disabled={!mutationsEnabled || busy}
				onclick={() => void change(thread, 'unsettled')}><RotateCcw size={14} />Unsettle</button
			>
		{/if}
		<button
			type="button"
			role="menuitem"
			disabled={!mutationsEnabled}
			onclick={() => beginRename(thread)}><SquarePen size={14} />Rename</button
		>
		<button
			type="button"
			role="menuitem"
			onclick={() => {
				void navigator.clipboard.writeText(thread._id).catch(() => {
					notice = 'Could not copy thread ID.';
				});
				menu = null;
			}}><Copy size={14} />Copy thread ID</button
		>
	</div>
{/if}
