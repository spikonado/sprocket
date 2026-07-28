<script lang="ts">
	import { CornerLeftUp, Folder, FolderPlus, LoaderCircle } from '@lucide/svelte';
	import type { DesktopApi, FilesystemBrowseEntry } from '$lib/types/sprocket';
	import {
		appendBrowsePathSegment,
		getBrowseLeafPathSegment,
		isFilesystemBrowseQuery,
		resolveWorkspacePathFromBrowse,
		workspacePathRequiresCreation
	} from '$lib/workspace/paths';

	type RecentProjectPath = {
		workspacePath: string;
		displayName: string;
	};

	type Props = {
		open: boolean;
		desktopApi: DesktopApi;
		mode?: 'add' | 'reconnect';
		expectedDisplayName?: string;
		recentProjectPaths?: RecentProjectPath[];
		onClose: () => void;
		onSelect: (selection: ProjectSelection) => void | Promise<void>;
	};

	export type ProjectSelection = {
		workspacePath: string;
		displayName: string;
		repositoryKey: string;
	};

	let {
		open,
		desktopApi,
		mode = 'add',
		expectedDisplayName,
		recentProjectPaths = [],
		onClose,
		onSelect
	}: Props = $props();

	let query = $state('~/');
	let browseEntries = $state<FilesystemBrowseEntry[]>([]);
	let browseParentPath = $state('');
	let highlightedPath = $state<string | null>(null);
	let isLoadingBrowse = $state(false);
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let browseRequestId = 0;
	let opened = $state(false);

	const browseFilterQuery = $derived(getBrowseLeafPathSegment(query).toLowerCase());
	const filteredEntries = $derived.by(() => {
		const showHidden = browseFilterQuery.startsWith('.');
		return browseEntries.filter(
			(entry) =>
				entry.name.toLowerCase().startsWith(browseFilterQuery) &&
				(showHidden || !entry.name.startsWith('.'))
		);
	});
	const selectedPath = $derived(query.trim());
	const resolvedWorkspacePath = $derived(
		resolveWorkspacePathFromBrowse({
			query,
			browseParentPath,
			browseEntries
		})
	);
	const willCreateDirectory = $derived(
		workspacePathRequiresCreation({
			query,
			browseParentPath,
			browseEntries
		})
	);
	const canSubmit = $derived(
		resolvedWorkspacePath.length > 0 &&
			(isFilesystemBrowseQuery(selectedPath) || browseParentPath.length > 0)
	);
	const submitLabel = $derived(
		mode === 'reconnect' ? 'Reconnect' : willCreateDirectory ? 'Create & add' : 'Add'
	);
	const displayedEntries = $derived.by(() => {
		if (filteredEntries.length > 0) {
			return filteredEntries;
		}

		const leaf = getBrowseLeafPathSegment(query).replace(/[\\/]+$/, '');
		if (!leaf || browseFilterQuery.length === 0) {
			return filteredEntries;
		}

		const parentName = browseParentPath.split(/[/\\]/).filter(Boolean).at(-1);
		if (parentName && parentName.toLowerCase() === leaf.toLowerCase()) {
			return [{ name: parentName, fullPath: browseParentPath }];
		}

		return filteredEntries;
	});
	const emptyListMessage = $derived(
		isLoadingBrowse
			? 'Loading directories…'
			: resolvedWorkspacePath.length > 0 && !willCreateDirectory
				? mode === 'reconnect'
					? 'Press Enter to reconnect this directory.'
					: 'Press Enter to add this directory.'
				: willCreateDirectory
					? mode === 'reconnect'
						? 'Press Enter to create and reconnect this directory.'
						: 'Press Enter to create and add this directory.'
					: 'No matching directories in this path.'
	);

	$effect(() => {
		if (!open) {
			opened = false;
			return;
		}

		if (opened) {
			return;
		}

		opened = true;
		query = '~/';
		highlightedPath = null;
		errorMessage = null;
		void loadBrowse(query);
	});

	$effect(() => {
		if (!open || !opened) {
			return;
		}

		const nextQuery = query;
		const timeout = window.setTimeout(() => {
			void loadBrowse(nextQuery);
		}, 180);

		return () => {
			window.clearTimeout(timeout);
		};
	});

	async function loadBrowse(partialPath: string) {
		const requestId = ++browseRequestId;
		isLoadingBrowse = true;

		try {
			const result = await desktopApi.browseFilesystem({
				partialPath: partialPath.trim().length > 0 ? partialPath : '~/'
			});

			if (requestId !== browseRequestId) {
				return;
			}

			browseParentPath = result.parentPath;
			browseEntries = result.entries;
			errorMessage = null;
		} catch (error) {
			if (requestId !== browseRequestId) {
				return;
			}

			errorMessage = error instanceof Error ? error.message : 'Failed to browse directories.';
		} finally {
			if (requestId === browseRequestId) {
				isLoadingBrowse = false;
			}
		}
	}

	function selectEntry(entry: FilesystemBrowseEntry) {
		if (entry.name === '..') {
			query = `${entry.fullPath}/`;
			highlightedPath = entry.fullPath;
			return;
		}

		query = appendBrowsePathSegment(
			browseParentPath.endsWith('/') || browseParentPath.endsWith('\\')
				? browseParentPath
				: `${browseParentPath}/`,
			entry.name
		);
		highlightedPath = entry.fullPath;
	}

	function selectRecentProjectPath(recent: RecentProjectPath) {
		query = `${recent.workspacePath}/`;
		highlightedPath = recent.workspacePath;
	}

	async function confirmSelection() {
		const workspacePath = resolvedWorkspacePath;
		if (!workspacePath) {
			errorMessage = 'Enter a project directory path.';
			return;
		}

		isSubmitting = true;
		errorMessage = null;

		try {
			const resolution = await desktopApi.resolveWorkspacePath({
				workspacePath,
				createIfMissing: willCreateDirectory
			});

			await onSelect({
				workspacePath: resolution.workspacePath,
				displayName: resolution.displayName,
				repositoryKey: resolution.repositoryKey
			});
			onClose();
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : 'Failed to open the selected project.';
		} finally {
			isSubmitting = false;
		}
	}

	function handleDialogKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}

		if (event.key === 'Enter' && !event.shiftKey && canSubmit && !isSubmitting) {
			event.preventDefault();
			void confirmSelection();
		}
	}
</script>

{#if open}
	<div
		class="bg-overlay fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh] backdrop-blur-[2px]"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onClose();
			}
		}}
	>
		<div
			class="border-border bg-popover text-foreground flex max-h-[min(32rem,70vh)] w-full max-w-xl min-w-0 flex-col overflow-hidden rounded-2xl border shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="project-picker-title"
			tabindex="-1"
			onkeydown={handleDialogKeydown}
		>
			<div class="border-hairline border-b px-2.5 py-1.5">
				<div class="relative flex items-center">
					<div class="text-muted-foreground pointer-events-none flex items-center ps-2">
						<FolderPlus class="size-4" />
					</div>
					<input
						id="project-picker-title"
						class="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-2 ps-2 pe-28 text-sm outline-none"
						bind:value={query}
						placeholder="Enter project path (e.g. ~/projects/my-robot)"
						autocomplete="off"
						spellcheck={false}
					/>
					{#if isLoadingBrowse}
						<LoaderCircle
							class="text-muted-foreground pointer-events-none absolute inset-e-24 top-1/2 size-4 -translate-y-1/2 animate-spin"
						/>
					{/if}
					<button
						type="button"
						class="border-border text-foreground bg-hover-fill hover:bg-hover-fill-strong absolute inset-e-2 top-1/2 -translate-y-1/2 rounded-md border px-2 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
						disabled={!canSubmit || isSubmitting}
						onclick={() => {
							void confirmSelection();
						}}
					>
						{isSubmitting ? 'Working…' : submitLabel}
					</button>
				</div>
				{#if mode === 'reconnect' && expectedDisplayName}
					<p class="text-muted-foreground px-2 pb-1 text-[11px]">
						Reconnect <span class="text-muted-foreground">{expectedDisplayName}</span> to a local directory
					</p>
				{/if}
			</div>

			{#if recentProjectPaths.length > 0}
				<div class="border-hairline flex flex-wrap gap-1.5 border-b px-3 py-2">
					{#each recentProjectPaths as recent (recent.workspacePath)}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground hover:bg-hover-fill rounded-md px-2 py-0.5 text-[11px] transition"
							onclick={() => {
								selectRecentProjectPath(recent);
							}}
						>
							{recent.displayName}
						</button>
					{/each}
				</div>
			{/if}

			<div class="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Directories">
				{#if displayedEntries.length === 0}
					<p class="text-muted-foreground px-3 py-8 text-center text-sm">
						{emptyListMessage}
					</p>
				{:else}
					{#each displayedEntries as entry (entry.fullPath)}
						<button
							type="button"
							class={`flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition ${
								highlightedPath === entry.fullPath
									? 'text-foreground bg-hover-fill-strong'
									: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
							}`}
							role="option"
							aria-selected={highlightedPath === entry.fullPath}
							onclick={() => {
								selectEntry(entry);
							}}
						>
							{#if entry.name === '..'}
								<CornerLeftUp class="text-muted-foreground size-4 shrink-0" />
							{:else}
								<Folder class="text-muted-foreground size-4 shrink-0" />
							{/if}
							<span class="truncate">{entry.name}</span>
						</button>
					{/each}
				{/if}
			</div>

			{#if errorMessage}
				<p class="text-destructive border-t border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm">
					{errorMessage}
				</p>
			{/if}

			<footer
				class="text-muted-foreground border-hairline flex items-center justify-between gap-3 border-t px-3 py-2 text-[11px]"
			>
				<div class="flex flex-wrap items-center gap-3">
					<span>↑↓ Navigate</span>
					<span>Enter {submitLabel}</span>
					<span>Esc Close</span>
				</div>
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground transition"
					onclick={onClose}
					disabled={isSubmitting}
				>
					Cancel
				</button>
			</footer>
		</div>
	</div>
{/if}
