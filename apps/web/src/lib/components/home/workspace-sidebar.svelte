<script lang="ts">
	import {
		ChevronRight,
		Folder,
		FolderOpen,
		LoaderCircle,
		LogIn,
		LogOut,
		SquarePen,
		Trash2
	} from '@lucide/svelte';
	import { formatRelativeTime } from '$lib/format';
	import type { Id } from '$convex/_generated/dataModel';
	import type { ThreadSummary, WorkspaceThreadGroup } from '$lib/types/sprocket';

	type Props = {
		isAuthenticated: boolean;
		isWaitingForBrowserSignIn?: boolean;
		currentWorkspaceName: string | null;
		currentThreadId: Id<'threadRecords'> | null;
		groups: WorkspaceThreadGroup[];
		onChooseWorkspace: () => void;
		onReconnectWorkspace: (workspaceSessionId: Id<'workspaceSessions'>) => void;
		onAccountAction: () => void;
		onStartThreadDraft: (workspaceName: string) => void;
		onSelectThread: (thread: ThreadSummary) => void;
		onDeleteThread: (thread: ThreadSummary) => void;
	};

	let {
		isAuthenticated,
		isWaitingForBrowserSignIn = false,
		currentWorkspaceName,
		currentThreadId,
		groups,
		onChooseWorkspace,
		onReconnectWorkspace,
		onAccountAction,
		onStartThreadDraft,
		onSelectThread,
		onDeleteThread
	}: Props = $props();

	const DEFAULT_VISIBLE_THREAD_COUNT = 6;
	const sidebarPanelClass =
		'min-h-0 overflow-hidden border-r border-white/6 bg-[linear-gradient(180deg,rgba(24,28,38,0.96),rgba(18,21,29,0.98))]';
	let expandedProjects = $state<Record<string, boolean>>({});
	let collapsedProjects = $state<Record<string, boolean>>({});

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
</script>

<aside class={sidebarPanelClass}>
	<div class="flex h-full min-h-0 flex-col overflow-hidden">
		<header class="flex items-center justify-between px-3.5 pt-3 pb-2.5">
			<div class="min-w-0">
				<p class="truncate text-[1.05rem] font-semibold tracking-tighter text-white">Sprocket</p>
			</div>
			{#if isWaitingForBrowserSignIn}
				<span
					class="flex h-8 w-8 items-center justify-center rounded-full border border-sky-400/20 bg-sky-400/10 text-sky-200"
					title="Complete sign-in in your browser"
					aria-label="Waiting for browser sign-in"
				>
					<LoaderCircle class="size-3.5 animate-spin" />
				</span>
			{:else}
				<button
					type="button"
					class="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/2 text-slate-300 transition hover:border-white/12 hover:bg-white/5 hover:text-white"
					onclick={onAccountAction}
					aria-label={isAuthenticated ? 'Sign out' : 'Sign in'}
				>
					{#if isAuthenticated}
						<LogOut class="size-3.5" />
					{:else}
						<LogIn class="size-3.5" />
					{/if}
				</button>
			{/if}
		</header>

		<div class="border-b border-white/6 px-3.5 pb-3">
			<button
				type="button"
				class="flex h-8 w-full min-w-0 items-center gap-2 rounded-full border border-white/8 bg-white/3 px-3 text-[12px] text-slate-200 transition hover:border-white/12 hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-50"
				onclick={onChooseWorkspace}
			>
				<FolderOpen class="size-3.5 shrink-0 text-slate-400" />
				<span class="truncate">Add project</span>
			</button>
		</div>

		<div class="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
			<div class="mb-3 px-2">
				<p class="text-[10px] tracking-[0.24em] text-slate-500 uppercase">Projects</p>
			</div>

			{#if groups.length === 0}
				<div
					class="rounded-3xl border border-dashed border-white/8 bg-white/2 px-4 py-4 text-sm leading-6 text-slate-400"
				>
					Choose a workspace to start organizing threads by project.
				</div>
			{:else}
				<div class="space-y-4">
					{#each groups as group (group.key)}
						<section class="space-y-1.5">
							<div class="group relative flex items-center px-2">
								<button
									type="button"
									class={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1 pr-8 text-left transition ${
										group.workspaceName === currentWorkspaceName
											? 'text-white'
											: 'text-slate-300 hover:text-white'
									}`}
									onclick={() => {
										toggleProjectCollapsed(group.key);
									}}
									aria-label={isProjectCollapsed(group.key)
										? `Expand ${group.workspaceName} threads`
										: `Collapse ${group.workspaceName} threads`}
									title={isProjectCollapsed(group.key)
										? `Expand ${group.workspaceName} threads`
										: `Collapse ${group.workspaceName} threads`}
								>
									<ChevronRight
										class={`size-3 shrink-0 text-slate-500 transition-transform ${
											isProjectCollapsed(group.key) ? '' : 'rotate-90'
										}`}
									/>
									<Folder class="size-4 shrink-0 text-slate-500" />
									<p class="truncate text-[0.88rem] font-medium tracking-[-0.02em]">
										{group.workspaceName}
									</p>
									{#if workspaceStatusLabel(group)}
										<span
											class={`rounded-full px-1.5 py-0.5 text-[10px] ${
												group.localWorkspaceAvailability === 'unavailable'
													? 'border border-amber-500/20 bg-amber-500/10 text-amber-100'
													: 'border border-sky-500/20 bg-sky-500/10 text-sky-100'
											}`}
										>
											{workspaceStatusLabel(group)}
										</span>
									{/if}
									{#if group.activeThreadCount > 0}
										<span
											class="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200"
										>
											{group.activeThreadCount}
										</span>
									{/if}
								</button>

								<button
									type="button"
									class="absolute top-0.5 right-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/6 hover:text-white focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
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
									title={group.localWorkspaceAvailability === 'available'
										? `Create thread in ${group.workspaceName}`
										: (group.localWorkspaceError ?? `Reconnect ${group.workspaceName}`)}
								>
									{#if group.localWorkspaceAvailability === 'available'}
										<SquarePen class="size-4" />
									{:else}
										<FolderOpen class="size-4" />
									{/if}
								</button>
							</div>

							{#if !isProjectCollapsed(group.key)}
								<div class="ml-5 border-l border-white/6 pl-3">
									{#if group.localWorkspaceAvailability === 'unavailable' || group.localWorkspaceAvailability === 'unlinked'}
										<p class="pb-2 text-[12px] leading-5 text-slate-500">
											{group.localWorkspaceError ??
												(group.localWorkspaceAvailability === 'unlinked'
													? 'This workspace needs a local directory attached before you can use it.'
													: 'This workspace needs to be reconnected.')}
										</p>
									{/if}
									{#if group.threads.length === 0}
										<p class="py-1.5 text-[12px] text-slate-500">No threads yet</p>
									{:else}
										{@const projectExpanded = isProjectExpanded(group.key)}
										{@const visibleThreads = projectExpanded
											? group.threads
											: group.threads.slice(0, DEFAULT_VISIBLE_THREAD_COUNT)}
										{@const hasHiddenThreads = group.threads.length > DEFAULT_VISIBLE_THREAD_COUNT}
										<div class="space-y-1">
											{#each visibleThreads as thread (thread.threadId)}
												<div class="group flex items-start gap-1">
													<button
														type="button"
														class={`flex min-w-0 flex-1 items-start justify-between gap-2 rounded-xl px-2 py-1.5 text-left transition ${
															thread.threadId === currentThreadId
																? 'bg-white/6 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
																: 'text-slate-400 hover:bg-white/3 hover:text-slate-200'
														}`}
														onclick={() => {
															onSelectThread(thread);
														}}
													>
														<div class="min-w-0 flex-1">
															<div class="flex items-center gap-1.5">
																{#if thread.hasActiveRun}
																	<span
																		class="mt-px size-2 shrink-0 animate-pulse rounded-full bg-emerald-400"
																		aria-label="Thread has an active run"
																	></span>
																{/if}
																<p class="truncate text-[13px] leading-5">{thread.title}</p>
															</div>
														</div>
														<span class="shrink-0 pt-0.5 text-[11px] text-slate-500">
															{formatRelativeTime(thread.lastMessageAt)}
														</span>
													</button>
													<button
														type="button"
														class={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/8 bg-white/3 text-slate-500 transition ${
															thread.threadId === currentThreadId
																? 'opacity-100 hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-rose-200'
																: 'opacity-0 group-hover:opacity-100 hover:border-rose-400/40 hover:bg-rose-400/10 hover:text-rose-200 focus-visible:opacity-100'
														} disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/3 disabled:text-slate-600 disabled:opacity-40`}
														onclick={() => {
															onDeleteThread(thread);
														}}
														disabled={thread.hasActiveRun}
														aria-label={`Delete ${thread.title}`}
														title={thread.hasActiveRun
															? 'Finish or cancel the active run before deleting.'
															: `Delete ${thread.title}`}
													>
														<Trash2 class="size-3" />
													</button>
												</div>
											{/each}

											{#if hasHiddenThreads}
												<button
													type="button"
													class="px-2 py-1 text-[12px] text-slate-500 transition hover:text-slate-300"
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
	</div>
</aside>

<style>
	.sidebar-scroll-area {
		scrollbar-width: none;
	}
	.sidebar-scroll-area::-webkit-scrollbar {
		display: none;
	}
</style>
