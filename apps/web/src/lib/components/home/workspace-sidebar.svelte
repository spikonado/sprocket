<script lang="ts">
	import { Archive, ChevronRight, Folder, FolderOpen, Settings, SquarePen } from '@lucide/svelte';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import SidebarTopActions from '$lib/components/home/sidebar-top-actions.svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import type { SprocketTheme } from '$lib/theme';
	import type { ThreadSummary, WorkspaceThreadGroup } from '$lib/types/sprocket';
	import { isAgentLaunchPending, type PendingAgentLaunches } from '$lib/workspace/threads';

	type Props = {
		currentWorkspaceName: string | null;
		currentThreadId: Id<'threadRecords'> | null;
		groups: WorkspaceThreadGroup[];
		pendingAgentLaunches?: PendingAgentLaunches;
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onChooseWorkspace: () => void;
		onReconnectWorkspace: (workspaceSessionId: Id<'workspaceSessions'>) => void;
		onOpenSettings: () => void;
		onStartThreadDraft: (workspaceName: string) => void;
		onSelectThread: (thread: ThreadSummary) => void;
		onRenameThread: (threadId: Id<'threadRecords'>, title: string) => void;
		onArchiveThread: (threadId: Id<'threadRecords'>) => void;
	};

	let {
		currentWorkspaceName,
		currentThreadId,
		groups,
		pendingAgentLaunches = {},
		theme,
		onThemeChange,
		onChooseWorkspace,
		onReconnectWorkspace,
		onOpenSettings,
		onStartThreadDraft,
		onSelectThread,
		onRenameThread,
		onArchiveThread
	}: Props = $props();

	const DEFAULT_VISIBLE_THREAD_COUNT = 3;
	const sidebarActionButtonClass =
		'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium tracking-[-0.02em] text-foreground transition hover:bg-[var(--hover-fill)] hover:text-foreground';
	const sidebarActionIconClass = 'size-4 shrink-0 text-muted-foreground';
	let expandedProjects = $state<Record<string, boolean>>({});
	let collapsedProjects = $state<Record<string, boolean>>({});
	let hoveredThreadTitle = $state<string | null>(null);
	let hoveredThreadTooltip = $state<{ top: number; left: number } | null>(null);
	let renamingThreadId = $state<Id<'threadRecords'> | null>(null);
	let renameDraft = $state('');
	let renameOriginalTitle = $state('');
	let renameInput = $state<HTMLInputElement | null>(null);
	let contextMenu = $state<{
		threadId: Id<'threadRecords'>;
		title: string;
		x: number;
		y: number;
	} | null>(null);

	$effect(() => {
		if (!renamingThreadId || !renameInput) {
			return;
		}
		renameInput.focus();
		renameInput.select();
	});

	$effect(() => {
		if (!contextMenu) {
			return;
		}

		function closeOnPointerDown(event: PointerEvent) {
			const target = event.target;
			if (target instanceof Element && target.closest('[data-thread-context-menu]')) {
				return;
			}
			contextMenu = null;
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				contextMenu = null;
			}
		}

		window.addEventListener('pointerdown', closeOnPointerDown, true);
		window.addEventListener('keydown', closeOnEscape, true);
		return () => {
			window.removeEventListener('pointerdown', closeOnPointerDown, true);
			window.removeEventListener('keydown', closeOnEscape, true);
		};
	});

	function showThreadTooltip(event: MouseEvent | FocusEvent, title: string) {
		if (renamingThreadId) {
			return;
		}
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) {
			return;
		}
		const rect = target.getBoundingClientRect();
		hoveredThreadTitle = title;
		hoveredThreadTooltip = {
			top: rect.top + rect.height / 2,
			left: rect.right + 8
		};
	}

	function hideThreadTooltip() {
		hoveredThreadTitle = null;
		hoveredThreadTooltip = null;
	}

	function isProjectExpanded(groupKey: string) {
		return expandedProjects[groupKey] ?? false;
	}

	function toggleProjectExpanded(groupKey: string) {
		expandedProjects = {
			...expandedProjects,
			[groupKey]: !isProjectExpanded(groupKey)
		};
	}

	function isProjectCollapsed(groupKey: string) {
		return collapsedProjects[groupKey] ?? false;
	}

	function toggleProjectCollapsed(groupKey: string) {
		collapsedProjects = {
			...collapsedProjects,
			[groupKey]: !isProjectCollapsed(groupKey)
		};
	}

	function workspaceStatusLabel(group: WorkspaceThreadGroup) {
		if (group.localWorkspaceAvailability === 'unavailable') {
			return 'Missing';
		}

		if (group.localWorkspaceAvailability === 'unlinked') {
			return 'Link';
		}

		return null;
	}

	function beginRename(threadId: Id<'threadRecords'>, title: string) {
		contextMenu = null;
		hideThreadTooltip();
		renamingThreadId = threadId;
		renameDraft = title;
		renameOriginalTitle = title;
	}

	function cancelRename() {
		renamingThreadId = null;
		renameDraft = '';
		renameOriginalTitle = '';
	}

	function commitRename() {
		const threadId = renamingThreadId;
		if (!threadId) {
			return;
		}
		const nextTitle = renameDraft.trim();
		renamingThreadId = null;
		renameDraft = '';
		const previousTitle = renameOriginalTitle;
		renameOriginalTitle = '';
		if (nextTitle.length === 0 || nextTitle === previousTitle) {
			return;
		}
		onRenameThread(threadId, nextTitle);
	}

	function openContextMenu(event: MouseEvent, thread: ThreadSummary) {
		event.preventDefault();
		hideThreadTooltip();
		contextMenu = {
			threadId: thread.threadId,
			title: thread.title,
			x: event.clientX,
			y: event.clientY
		};
	}
</script>

<aside class="app-sidebar-panel">
	<div class="flex h-full min-h-0 flex-col overflow-hidden">
		<header class="flex items-center justify-between gap-2 px-3.5 pt-3 pb-4">
			<BrandMark size="sm" class="min-w-0" />
			<SidebarTopActions {theme} {onThemeChange} />
		</header>

		<div class="px-3.5 pb-1">
			<button type="button" class={sidebarActionButtonClass} onclick={onChooseWorkspace}>
				<FolderOpen class={sidebarActionIconClass} aria-hidden="true" />
				<span class="truncate">Add project</span>
			</button>
		</div>

		<div class="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
			<div class="mb-3 px-2">
				<p class="text-muted-foreground text-[10px] tracking-[0.24em] uppercase">Projects</p>
			</div>

			{#if groups.length === 0}
				<div
					class="text-muted-foreground rounded-3xl border border-dashed border-[var(--hairline)] bg-[var(--hover-fill)] px-4 py-4 text-sm leading-6"
				>
					Choose a project to start organizing threads.
				</div>
			{:else}
				<div class="space-y-4">
					{#each groups as group (group.key)}
						{@const statusLabel = workspaceStatusLabel(group)}
						<section class="space-y-1.5">
							<div class="group relative flex items-center px-2">
								<button
									type="button"
									class={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1 pr-8 text-left transition ${
										group.workspaceName === currentWorkspaceName
											? 'text-foreground'
											: 'text-muted-foreground hover:text-foreground'
									}`}
									onclick={() => {
										toggleProjectCollapsed(group.key);
									}}
									aria-label={isProjectCollapsed(group.key)
										? `Expand ${group.workspaceName} threads`
										: `Collapse ${group.workspaceName} threads`}
								>
									<ChevronRight
										class={`text-muted-foreground size-3 shrink-0 transition-transform ${
											isProjectCollapsed(group.key) ? '' : 'rotate-90'
										}`}
									/>
									<Folder class="text-muted-foreground size-4 shrink-0" />
									<p class="truncate text-[0.88rem] font-medium tracking-[-0.02em]">
										{group.workspaceName}
									</p>
									{#if statusLabel}
										<span
											class={`rounded-full px-1.5 py-0.5 text-[10px] ${
												group.localWorkspaceAvailability === 'unavailable'
													? 'border border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-200'
													: 'border border-sky-500/25 bg-sky-500/10 text-sky-800 dark:text-sky-200'
											}`}
										>
											{statusLabel}
										</span>
									{/if}
									{#if group.activeThreadCount > 0}
										<span
											class="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:text-emerald-200"
										>
											{group.activeThreadCount}
										</span>
									{/if}
								</button>

								<button
									type="button"
									class="text-muted-foreground hover:text-foreground absolute top-0.5 right-1 inline-flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition group-hover:opacity-100 hover:bg-[var(--hover-fill)] focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
									onclick={() => {
										if (group.localWorkspaceAvailability === 'available') {
											onStartThreadDraft(group.workspaceName);
											return;
										}

										if (group.workspaceSessionId) {
											onReconnectWorkspace(group.workspaceSessionId);
										}
									}}
									aria-label={group.localWorkspaceAvailability === 'available'
										? `Create thread in ${group.workspaceName}`
										: `Reconnect ${group.workspaceName}`}
								>
									{#if group.localWorkspaceAvailability === 'available'}
										<SquarePen class="size-4" />
									{:else}
										<FolderOpen class="size-4" />
									{/if}
								</button>
							</div>

							{#if !isProjectCollapsed(group.key)}
								<div class="ml-5 border-l border-[var(--hairline)] pl-3">
									{#if group.localWorkspaceAvailability === 'unavailable' || group.localWorkspaceAvailability === 'unlinked'}
										<p class="text-muted-foreground pb-2 text-[12px] leading-5">
											{group.localWorkspaceError ??
												(group.localWorkspaceAvailability === 'unlinked'
													? 'This project needs a local directory attached before you can use it.'
													: 'This project needs to be reconnected.')}
										</p>
									{/if}
									{#if group.threads.length === 0}
										<p class="text-muted-foreground py-1.5 text-[12px]">No threads yet</p>
									{:else}
										{@const projectExpanded = isProjectExpanded(group.key)}
										{@const visibleThreads = projectExpanded
											? group.threads
											: group.threads.slice(0, DEFAULT_VISIBLE_THREAD_COUNT)}
										{@const hasHiddenThreads = group.threads.length > DEFAULT_VISIBLE_THREAD_COUNT}
										<div class="space-y-0.5">
											{#each visibleThreads as thread (thread.threadId)}
												{@const isStartingAgent = isAgentLaunchPending(
													pendingAgentLaunches,
													thread.threadId
												)}
												{@const isSelected = thread.threadId === currentThreadId}
												{@const isRenaming = renamingThreadId === thread.threadId}
												{#if isRenaming}
													<form
														class="px-1"
														onsubmit={(event) => {
															event.preventDefault();
															commitRename();
														}}
													>
														<input
															bind:this={renameInput}
															bind:value={renameDraft}
															class="border-border text-foreground focus:border-ring h-9 w-full rounded-lg border bg-[var(--hover-fill)] px-2 text-[13px] outline-none"
															aria-label="Rename thread"
															onkeydown={(event) => {
																if (event.key === 'Escape') {
																	event.preventDefault();
																	cancelRename();
																}
															}}
															onblur={() => {
																commitRename();
															}}
														/>
													</form>
												{:else}
													<div class="group/thread relative">
														<button
															type="button"
															class={`${sidebarActionButtonClass} pr-8 ${
																isSelected
																	? 'text-foreground bg-[var(--hover-fill)]'
																	: 'text-muted-foreground'
															}`}
															aria-current={isSelected ? 'page' : undefined}
															onmouseenter={(event) => {
																showThreadTooltip(event, thread.title);
															}}
															onmouseleave={hideThreadTooltip}
															onfocus={(event) => {
																showThreadTooltip(event, thread.title);
															}}
															onblur={hideThreadTooltip}
															oncontextmenu={(event) => {
																openContextMenu(event, thread);
															}}
															onclick={() => {
																onSelectThread(thread);
															}}
														>
															{#if isStartingAgent}
																<span
																	class="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-300"
																	aria-label="Starting agent"
																></span>
															{:else if thread.hasActiveRun}
																<span
																	class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400"
																	aria-label="Thread has an active run"
																></span>
															{/if}
															<span class="truncate">{thread.title}</span>
														</button>
														<button
															type="button"
															class={`text-muted-foreground hover:text-foreground absolute top-1.5 right-1 inline-flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-[var(--hover-fill)] focus-visible:opacity-100 ${
																isSelected
																	? 'opacity-100'
																	: 'opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100'
															}`}
															aria-label={`Archive ${thread.title}`}
															onclick={(event) => {
																event.stopPropagation();
																hideThreadTooltip();
																onArchiveThread(thread.threadId);
															}}
														>
															<Archive class="size-3.5" aria-hidden="true" />
														</button>
													</div>
												{/if}
											{/each}

											{#if hasHiddenThreads}
												<button
													type="button"
													class="text-muted-foreground hover:text-muted-foreground px-2 py-1 text-[12px] transition"
													onclick={() => {
														toggleProjectExpanded(group.key);
													}}
												>
													{projectExpanded ? 'Show less' : 'Show more'}
												</button>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</section>
					{/each}
				</div>
			{/if}
		</div>

		<div class="px-3.5 pt-2 pb-4">
			<button type="button" class={sidebarActionButtonClass} onclick={onOpenSettings}>
				<Settings class={sidebarActionIconClass} aria-hidden="true" />
				Settings
			</button>
		</div>
	</div>
</aside>

{#if hoveredThreadTitle && hoveredThreadTooltip && !contextMenu && !renamingThreadId}
	<div
		class="bg-tooltip text-tooltip-foreground ring-border pointer-events-none fixed z-100 max-w-64 -translate-y-1/2 rounded-md px-2.5 py-1.5 text-[12px] leading-4 shadow-lg ring-1"
		style={`top: ${hoveredThreadTooltip.top}px; left: ${hoveredThreadTooltip.left}px;`}
		role="tooltip"
	>
		{hoveredThreadTitle}
	</div>
{/if}

{#if contextMenu}
	<div
		data-thread-context-menu
		class="bg-popover text-popover-foreground fixed z-110 min-w-36 rounded-lg border border-[var(--hairline)] py-1 shadow-xl"
		style={`top: ${contextMenu.y}px; left: ${contextMenu.x}px;`}
		role="menu"
	>
		<button
			type="button"
			class="text-foreground hover:text-foreground flex w-full px-3 py-1.5 text-left text-[13px] transition hover:bg-[var(--hover-fill)]"
			role="menuitem"
			onclick={() => {
				beginRename(contextMenu!.threadId, contextMenu!.title);
			}}
		>
			Rename
		</button>
	</div>
{/if}
