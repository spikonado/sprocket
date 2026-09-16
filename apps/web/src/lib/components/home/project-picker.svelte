<script lang="ts">
	import { ArrowLeft, Folder, LoaderCircle } from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { DesktopApi, FilesystemBrowseEntry } from '$lib/types/sprocket';
	import {
		getBrowseLeafPathSegment,
		isFilesystemBrowseQuery,
		isWindowsVolumeListQuery,
		resolveWorkspacePathFromBrowse,
		withTrailingPathSeparator,
		workspacePathRequiresCreation
	} from '$lib/workspace/paths';

	type RecentProjectPath = {
		workspacePath: string;
		displayName: string;
	};
	type ProjectPickerDesktopApi = Pick<DesktopApi, 'browseFilesystem' | 'resolveWorkspacePath'>;

	type Props = {
		open: boolean;
		desktopApi: ProjectPickerDesktopApi;
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
	let volumeList = $state(false);
	let highlightedPath = $state<string | null>(null);
	let isLoadingBrowse = $state(false);
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let pathInput = $state<HTMLInputElement | null>(null);
	let directoryList = $state<HTMLDivElement | null>(null);
	let browseRequestId = 0;
	let lastBrowseQuery: string | null = null;
	let opened = $state(false);

	const browseFilterQuery = $derived(getBrowseLeafPathSegment(query).toLowerCase());
	const filteredEntries = $derived.by(() => {
		if (volumeList) {
			const needle = query
				.trim()
				.replace(/^[\\/]+/, '')
				.toLowerCase();
			return browseEntries.filter(
				(entry) =>
					entry.name.toLowerCase().startsWith(needle) ||
					entry.fullPath.toLowerCase().startsWith(needle)
			);
		}

		const showHidden = browseFilterQuery.startsWith('.');
		return browseEntries.filter((entry) => {
			return (
				entry.name !== '..' &&
				entry.name.toLowerCase().startsWith(browseFilterQuery) &&
				(showHidden || !entry.name.startsWith('.'))
			);
		});
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
		!volumeList &&
			resolvedWorkspacePath.length > 0 &&
			(isFilesystemBrowseQuery(selectedPath) || browseParentPath.length > 0)
	);
	const submitLabel = $derived(
		mode === 'reconnect' ? 'Reconnect' : willCreateDirectory ? 'Create & add' : 'Add'
	);
	const parentEntry = $derived(browseEntries.find((entry) => entry.name === '..'));
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
			: volumeList
				? 'Select a drive.'
				: resolvedWorkspacePath.length > 0 && !willCreateDirectory
					? mode === 'reconnect'
						? 'Press Ctrl+Enter to reconnect this directory.'
						: 'Press Ctrl+Enter to add this directory.'
					: willCreateDirectory
						? mode === 'reconnect'
							? 'Press Ctrl+Enter to create and reconnect this directory.'
							: 'Press Ctrl+Enter to create and add this directory.'
						: 'No matching directories in this path.'
	);
	const highlightedEntryIndex = $derived(
		displayedEntries.findIndex((entry) => entry.fullPath === highlightedPath)
	);
	const highlightedEntry = $derived(
		highlightedEntryIndex < 0 ? undefined : displayedEntries[highlightedEntryIndex]
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
		volumeList = false;
		void loadBrowse(query);
		void tick().then(() => pathInput?.focus());
	});

	$effect(() => {
		if (!open) {
			return;
		}

		window.addEventListener('keydown', handleDialogKeydown);
		return () => window.removeEventListener('keydown', handleDialogKeydown);
	});

	$effect(() => {
		if (!open || !opened) {
			return;
		}

		const nextQuery = query;
		if (nextQuery === lastBrowseQuery) {
			return;
		}

		const timeout = window.setTimeout(() => {
			if (volumeList && isWindowsVolumeListQuery(nextQuery)) {
				return;
			}

			void loadBrowse(nextQuery);
		}, 180);

		return () => {
			window.clearTimeout(timeout);
		};
	});

	$effect(() => {
		if (!open || isLoadingBrowse || displayedEntries.length === 0) {
			return;
		}

		if (!displayedEntries.some((entry) => entry.fullPath === highlightedPath)) {
			highlightedPath = displayedEntries[0]?.fullPath ?? null;
		}
	});

	async function loadBrowse(partialPath: string) {
		const requestId = ++browseRequestId;
		lastBrowseQuery = partialPath;
		isLoadingBrowse = true;

		try {
			const result = await desktopApi.browseFilesystem({
				partialPath: partialPath.trim().length > 0 ? partialPath : '~/'
			});

			if (requestId !== browseRequestId || partialPath !== query) {
				return;
			}

			browseParentPath = result.parentPath;
			browseEntries = result.entries;
			volumeList = result.volumeList === true;
			errorMessage = null;
		} catch (error) {
			if (requestId !== browseRequestId || partialPath !== query) {
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
		const nextQuery = withTrailingPathSeparator(entry.fullPath);
		query = nextQuery;
		highlightedPath = null;
		void loadBrowse(nextQuery);
	}

	function selectRecentProjectPath(recent: RecentProjectPath) {
		const nextQuery = withTrailingPathSeparator(recent.workspacePath);
		query = nextQuery;
		highlightedPath = recent.workspacePath;
		void loadBrowse(nextQuery);
	}

	async function confirmSelection() {
		if (volumeList) {
			return;
		}

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

	function moveHighlight(offset: -1 | 1) {
		if (displayedEntries.length === 0) {
			return;
		}

		const currentIndex =
			highlightedEntryIndex < 0 ? (offset === 1 ? -1 : 0) : highlightedEntryIndex;
		const nextIndex = (currentIndex + offset + displayedEntries.length) % displayedEntries.length;
		highlightedPath = displayedEntries[nextIndex]?.fullPath ?? null;

		void tick().then(() => {
			const option = directoryList?.querySelector<HTMLElement>('[aria-selected="true"]');
			option?.scrollIntoView?.({ block: 'nearest' });
		});
	}

	function navigateBack() {
		if (!parentEntry || isLoadingBrowse) {
			return;
		}

		selectEntry(parentEntry);
	}

	function backspaceShouldNavigate(event: KeyboardEvent) {
		if (!(event.target instanceof HTMLInputElement)) {
			return true;
		}

		return browseFilterQuery.length === 0;
	}

	function handleDialogKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.isComposing) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}

		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSubmit && !isSubmitting) {
			event.preventDefault();
			void confirmSelection();
			return;
		}

		if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
			return;
		}

		if (isLoadingBrowse) {
			return;
		}

		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}

		if (event.key === 'Enter' && highlightedEntry) {
			if (event.target instanceof Element && event.target.closest('[data-project-submit]')) {
				return;
			}

			event.preventDefault();
			selectEntry(highlightedEntry);
			return;
		}

		if (event.key === 'Backspace' && parentEntry && backspaceShouldNavigate(event)) {
			event.preventDefault();
			navigateBack();
		}
	}
</script>

{#if open}
	<div
		class="bg-overlay fixed inset-0 z-50 flex items-start justify-center px-4 pt-[7vh] backdrop-blur-[2px]"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onClose();
			}
		}}
	>
		<div
			class="border-border bg-popover text-foreground flex h-[min(34rem,80vh)] w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-[1.4rem] border shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-label={mode === 'reconnect' ? 'Reconnect project' : 'Add project'}
			tabindex="-1"
		>
			<header class="flex-none px-4 pt-3 pb-2">
				<div class="flex min-h-10 items-center gap-1.5">
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-8 shrink-0 items-center justify-center rounded-lg transition disabled:pointer-events-none disabled:opacity-30"
						aria-label="Go to parent directory"
						disabled={!parentEntry || isLoadingBrowse}
						onclick={navigateBack}
					>
						<ArrowLeft class="size-4" strokeWidth={2} />
					</button>
					<input
						class="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
						bind:this={pathInput}
						bind:value={query}
						placeholder="Enter a project path"
						aria-label="Project directory path"
						aria-controls="project-picker-directories"
						aria-activedescendant={highlightedEntryIndex < 0
							? undefined
							: `project-picker-directory-${highlightedEntryIndex}`}
						aria-autocomplete="list"
						aria-expanded="true"
						role="combobox"
						autocomplete="off"
						spellcheck={false}
					/>
					{#if isLoadingBrowse}
						<LoaderCircle
							class="text-muted-foreground pointer-events-none size-4 shrink-0 animate-spin"
						/>
					{/if}
					<button
						type="button"
						class="border-border text-foreground bg-hover-fill hover:bg-hover-fill-strong flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-40"
						data-project-submit
						disabled={!canSubmit || isSubmitting}
						onclick={() => {
							void confirmSelection();
						}}
					>
						<span>{isSubmitting ? 'Working…' : submitLabel}</span>
						{#if !isSubmitting}
							<kbd class="text-muted-foreground font-sans text-xs">Ctrl Enter</kbd>
						{/if}
					</button>
				</div>
				{#if mode === 'reconnect' && expectedDisplayName}
					<p class="text-muted-foreground px-9 pb-1 text-xs">
						Reconnect <span class="text-muted-foreground">{expectedDisplayName}</span> to a local directory
					</p>
				{/if}
			</header>

			{#if recentProjectPaths.length > 0}
				<div class="border-hairline flex flex-wrap gap-1.5 border-b px-5 py-2">
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

			<div class="text-muted-foreground flex-none px-6 pt-3 pb-1 text-sm">Directories</div>
			<div
				id="project-picker-directories"
				class="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
				bind:this={directoryList}
				role="listbox"
				aria-label="Directories"
				aria-busy={isLoadingBrowse}
			>
				{#if displayedEntries.length === 0}
					<p class="text-muted-foreground px-3 py-8 text-center text-sm">
						{emptyListMessage}
					</p>
				{:else}
					{#each displayedEntries as entry, index (entry.fullPath)}
						<button
							id={`project-picker-directory-${index}`}
							type="button"
							class={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-base transition ${
								highlightedPath === entry.fullPath
									? 'text-foreground bg-hover-fill-strong'
									: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
							}`}
							role="option"
							aria-selected={highlightedPath === entry.fullPath}
							onclick={() => {
								selectEntry(entry);
							}}
							onpointermove={() => {
								highlightedPath = entry.fullPath;
							}}
						>
							<Folder class="text-muted-foreground size-5 shrink-0" strokeWidth={1.8} />
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

			<footer class="text-muted-foreground border-hairline flex-none border-t px-5 py-3 text-sm">
				<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
					<span class="flex items-center gap-1.5">
						<kbd class="shortcut-key">↑</kbd><kbd class="shortcut-key">↓</kbd> Navigate
					</span>
					<span class="flex items-center gap-1.5">
						<kbd class="shortcut-key">Enter</kbd> Select
					</span>
					<span class="flex items-center gap-1.5">
						<kbd class="shortcut-key">Backspace</kbd> Back
					</span>
					<span class="flex items-center gap-1.5">
						<kbd class="shortcut-key">Esc</kbd> Close
					</span>
				</div>
			</footer>
		</div>
	</div>
{/if}

<style>
	.shortcut-key {
		min-width: 1.6rem;
		border: 1px solid var(--border);
		border-radius: 0.35rem;
		background: var(--hover-fill-strong);
		padding: 0.12rem 0.35rem;
		color: var(--foreground);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		line-height: 1rem;
		text-align: center;
		box-shadow: inset 0 -1px 0 var(--hairline);
	}
</style>
