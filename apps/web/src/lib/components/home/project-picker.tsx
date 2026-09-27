import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { ArrowLeft, Folder, LoaderCircle } from 'lucide-react';
import type { DesktopApi, FilesystemBrowseEntry } from '$lib/types/sprocket';
import {
	getBrowseLeafPathSegment,
	isFilesystemBrowseQuery,
	isWindowsVolumeListQuery,
	resolveWorkspacePathFromBrowse,
	withTrailingPathSeparator,
	workspacePathRequiresCreation
} from '$lib/workspace/paths';
import './project-picker.css';

type RecentProjectPath = {
	workspacePath: string;
	displayName: string;
};
type ProjectPickerDesktopApi = Pick<DesktopApi, 'browseFilesystem' | 'resolveWorkspacePath'>;

export type ProjectSelection = {
	workspacePath: string;
	displayName: string;
	repositoryKey: string;
};

export default function ProjectPicker({
	open,
	desktopApi,
	mode = 'add',
	expectedDisplayName,
	recentProjectPaths = [],
	onClose,
	onSelect
}: {
	open: boolean;
	desktopApi: ProjectPickerDesktopApi;
	mode?: 'add' | 'reconnect';
	expectedDisplayName?: string;
	recentProjectPaths?: RecentProjectPath[];
	onClose: () => void;
	onSelect: (selection: ProjectSelection) => void | Promise<void>;
}) {
	const [query, setQueryState] = useState('~/');
	const [browseEntries, setBrowseEntries] = useState<FilesystemBrowseEntry[]>([]);
	const [browseParentPath, setBrowseParentPath] = useState('');
	const [volumeList, setVolumeList] = useState(false);
	const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
	const [isLoadingBrowse, setIsLoadingBrowse] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [browseQuery, setBrowseQuery] = useState<string | null>(null);
	const [opened, setOpened] = useState(false);
	const queryRef = useRef('~/');
	const volumeListRef = useRef(false);
	const pathInputRef = useRef<HTMLInputElement | null>(null);
	const directoryListRef = useRef<HTMLDivElement | null>(null);
	const browseRequestIdRef = useRef(0);
	const lastBrowseQueryRef = useRef<string | null>(null);
	const scrollHighlightRef = useRef(false);

	const setQuery = useCallback((next: string) => {
		queryRef.current = next;
		setQueryState(next);
	}, []);
	const setVolumeListState = useCallback((next: boolean) => {
		volumeListRef.current = next;
		setVolumeList(next);
	}, []);

	const loadBrowse = useCallback(
		async (partialPath: string) => {
			const requestId = ++browseRequestIdRef.current;
			lastBrowseQueryRef.current = partialPath;
			setIsLoadingBrowse(true);

			try {
				const result = await desktopApi.browseFilesystem({
					partialPath: partialPath.trim().length > 0 ? partialPath : '~/'
				});

				if (requestId !== browseRequestIdRef.current || partialPath !== queryRef.current) {
					return;
				}

				setBrowseParentPath(result.parentPath);
				setBrowseEntries(result.entries);
				setVolumeListState(result.volumeList === true);
				setBrowseQuery(partialPath);
				setErrorMessage(null);
			} catch (error) {
				if (requestId !== browseRequestIdRef.current || partialPath !== queryRef.current) {
					return;
				}

				setBrowseParentPath('');
				setBrowseEntries([]);
				setVolumeListState(false);
				setBrowseQuery(partialPath);
				lastBrowseQueryRef.current = null;
				setErrorMessage(error instanceof Error ? error.message : 'Failed to browse directories.');
			} finally {
				if (requestId === browseRequestIdRef.current) {
					setIsLoadingBrowse(false);
				}
			}
		},
		[desktopApi, setVolumeListState]
	);

	const browseFilterQuery = getBrowseLeafPathSegment(query).toLowerCase();
	const browseStateIsCurrent = query === browseQuery;
	const currentBrowseParentPath = browseStateIsCurrent ? browseParentPath : '';
	const currentBrowseEntries = browseStateIsCurrent ? browseEntries : [];
	const filteredEntries = useMemo(() => {
		if (!browseStateIsCurrent) {
			return [];
		}

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
		return browseEntries.filter(
			(entry) =>
				entry.name !== '..' &&
				entry.name.toLowerCase().startsWith(browseFilterQuery) &&
				(showHidden || !entry.name.startsWith('.'))
		);
	}, [browseStateIsCurrent, volumeList, query, browseEntries, browseFilterQuery]);
	const selectedPath = query.trim();
	const resolvedWorkspacePath = resolveWorkspacePathFromBrowse({
		query,
		browseParentPath: currentBrowseParentPath,
		browseEntries: currentBrowseEntries
	});
	const willCreateDirectory = workspacePathRequiresCreation({
		query,
		browseParentPath: currentBrowseParentPath,
		browseEntries: currentBrowseEntries
	});
	const canSubmit =
		browseStateIsCurrent &&
		!volumeList &&
		!errorMessage &&
		resolvedWorkspacePath.length > 0 &&
		(isFilesystemBrowseQuery(selectedPath) || currentBrowseParentPath.length > 0);
	const submitLabel = mode === 'reconnect' ? 'Reconnect' : willCreateDirectory ? 'Create & add' : 'Add';
	const parentEntry = currentBrowseEntries.find((entry) => entry.name === '..');
	const displayedEntries = useMemo(() => {
		if (filteredEntries.length > 0) {
			return filteredEntries;
		}

		const leaf = getBrowseLeafPathSegment(query).replace(/[\\/]+$/, '');
		if (!leaf || browseFilterQuery.length === 0) {
			return filteredEntries;
		}

		const parentName = currentBrowseParentPath.split(/[/\\]/).filter(Boolean).at(-1);
		if (parentName && parentName.toLowerCase() === leaf.toLowerCase()) {
			return [{ name: parentName, fullPath: currentBrowseParentPath }];
		}

		return filteredEntries;
	}, [filteredEntries, query, browseFilterQuery, currentBrowseParentPath]);
	const emptyListMessage =
		isLoadingBrowse || !browseStateIsCurrent
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
						: 'No matching directories in this path.';
	const highlightedEntryIndex = displayedEntries.findIndex(
		(entry) => entry.fullPath === highlightedPath
	);
	const highlightedEntry =
		highlightedEntryIndex < 0 ? undefined : displayedEntries[highlightedEntryIndex];

	useEffect(() => {
		if (!open) {
			setOpened(false);
			return;
		}

		if (opened) {
			return;
		}

		setOpened(true);
		setQuery('~/');
		setHighlightedPath(null);
		setErrorMessage(null);
		setVolumeListState(false);
		setBrowseQuery(null);
		void loadBrowse('~/');
	}, [open, opened, loadBrowse, setQuery, setVolumeListState]);

	useEffect(() => {
		if (opened) {
			pathInputRef.current?.focus();
		}
	}, [opened]);

	useEffect(() => {
		if (!open || !opened) {
			return;
		}

		const nextQuery = query;
		if (nextQuery === lastBrowseQueryRef.current) {
			return;
		}

		const timeout = window.setTimeout(() => {
			if (volumeListRef.current && isWindowsVolumeListQuery(nextQuery)) {
				return;
			}

			void loadBrowse(nextQuery);
		}, 180);

		return () => {
			window.clearTimeout(timeout);
		};
	}, [open, opened, query, loadBrowse]);

	useEffect(() => {
		if (!open || isLoadingBrowse || displayedEntries.length === 0) {
			return;
		}

		if (!displayedEntries.some((entry) => entry.fullPath === highlightedPath)) {
			setHighlightedPath(displayedEntries[0]?.fullPath ?? null);
		}
	}, [open, isLoadingBrowse, displayedEntries, highlightedPath]);

	useEffect(() => {
		if (!open || !scrollHighlightRef.current) {
			return;
		}

		scrollHighlightRef.current = false;
		const option = directoryListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
		option?.scrollIntoView?.({ block: 'nearest' });
	}, [open, highlightedPath, displayedEntries]);

	function selectEntry(entry: FilesystemBrowseEntry) {
		const nextQuery = withTrailingPathSeparator(entry.fullPath);
		setQuery(nextQuery);
		setHighlightedPath(null);
		void loadBrowse(nextQuery);
	}

	function selectRecentProjectPath(recent: RecentProjectPath) {
		const nextQuery = withTrailingPathSeparator(recent.workspacePath);
		setQuery(nextQuery);
		setHighlightedPath(recent.workspacePath);
		void loadBrowse(nextQuery);
	}

	async function confirmSelection() {
		if (volumeList) {
			return;
		}

		const workspacePath = resolvedWorkspacePath;
		if (!workspacePath) {
			setErrorMessage('Enter a project directory path.');
			return;
		}

		setIsSubmitting(true);
		setErrorMessage(null);

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
			setErrorMessage(
				error instanceof Error ? error.message : 'Failed to open the selected project.'
			);
		} finally {
			setIsSubmitting(false);
		}
	}

	function moveHighlight(offset: -1 | 1) {
		if (displayedEntries.length === 0) {
			return;
		}

		const currentIndex =
			highlightedEntryIndex < 0 ? (offset === 1 ? -1 : 0) : highlightedEntryIndex;
		const nextIndex = (currentIndex + offset + displayedEntries.length) % displayedEntries.length;
		scrollHighlightRef.current = true;
		setHighlightedPath(displayedEntries[nextIndex]?.fullPath ?? null);
	}

	function navigateBack() {
		if (!parentEntry || isLoadingBrowse) {
			return;
		}

		selectEntry(parentEntry);
	}

	function backspaceShouldNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (!(event.target instanceof HTMLInputElement)) {
			return true;
		}

		return browseFilterQuery.length === 0;
	}

	function handleDialogKeydown(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (event.defaultPrevented || event.nativeEvent.isComposing) {
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

	if (!open) {
		return null;
	}

	return (
		<div
			className="bg-overlay fixed inset-0 z-50 flex items-start justify-center px-4 pt-[7vh] backdrop-blur-[2px]"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div
				className="border-border bg-popover text-foreground flex h-[min(34rem,80vh)] w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-[1.4rem] border shadow-2xl"
				role="dialog"
				aria-modal="true"
				aria-label={mode === 'reconnect' ? 'Reconnect project' : 'Add project'}
				tabIndex={-1}
				onKeyDown={handleDialogKeydown}
			>
				<header className="flex-none px-4 pt-3 pb-2">
					<div className="flex min-h-10 items-center gap-1.5">
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-8 shrink-0 items-center justify-center rounded-lg transition disabled:pointer-events-none disabled:opacity-30"
							aria-label="Go to parent directory"
							disabled={!parentEntry || isLoadingBrowse}
							onClick={navigateBack}
						>
							<ArrowLeft className="size-4" strokeWidth={2} />
						</button>
						<input
							className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
							ref={pathInputRef}
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder="Enter a project path"
							aria-label="Project directory path"
							aria-controls="project-picker-directories"
							aria-activedescendant={
								highlightedEntryIndex < 0
									? undefined
									: `project-picker-directory-${highlightedEntryIndex}`
							}
							aria-autocomplete="list"
							aria-expanded="true"
							role="combobox"
							autoComplete="off"
							spellCheck={false}
						/>
						{isLoadingBrowse && (
							<LoaderCircle className="text-muted-foreground pointer-events-none size-4 shrink-0 animate-spin" />
						)}
						<button
							type="button"
							className="border-border text-foreground bg-hover-fill hover:bg-hover-fill-strong flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-40"
							data-project-submit
							disabled={!canSubmit || isSubmitting}
							onClick={() => {
								void confirmSelection();
							}}
						>
							<span>{isSubmitting ? 'Working…' : submitLabel}</span>
							{!isSubmitting && (
								<kbd className="text-muted-foreground font-sans text-xs">Ctrl Enter</kbd>
							)}
						</button>
					</div>
					{mode === 'reconnect' && expectedDisplayName && (
						<p className="text-muted-foreground px-9 pb-1 text-xs">
							Reconnect <span className="text-muted-foreground">{expectedDisplayName}</span> to a
							local directory
						</p>
					)}
				</header>

				{recentProjectPaths.length > 0 && (
					<div className="border-hairline flex flex-wrap gap-1.5 border-b px-5 py-2">
						{recentProjectPaths.map((recent) => (
							<button
								key={recent.workspacePath}
								type="button"
								className="text-muted-foreground hover:text-foreground hover:bg-hover-fill rounded-md px-2 py-0.5 text-[11px] transition"
								onClick={() => {
									selectRecentProjectPath(recent);
								}}
							>
								{recent.displayName}
							</button>
						))}
					</div>
				)}

				<div className="text-muted-foreground flex-none px-6 pt-3 pb-1 text-sm">Directories</div>
				<div
					id="project-picker-directories"
					className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
					ref={directoryListRef}
					role="listbox"
					aria-label="Directories"
					aria-busy={isLoadingBrowse}
				>
					{displayedEntries.length === 0 ? (
						<p className="text-muted-foreground px-3 py-8 text-center text-sm">
							{emptyListMessage}
						</p>
					) : (
						displayedEntries.map((entry, index) => (
							<button
								key={entry.fullPath}
								id={`project-picker-directory-${index}`}
								type="button"
								className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-base transition ${
									highlightedPath === entry.fullPath
										? 'text-foreground bg-hover-fill-strong'
										: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
								}`}
								role="option"
								aria-selected={highlightedPath === entry.fullPath}
								onClick={() => {
									selectEntry(entry);
								}}
								onPointerMove={() => {
									setHighlightedPath(entry.fullPath);
								}}
							>
								<Folder className="text-muted-foreground size-5 shrink-0" strokeWidth={1.8} />
								<span className="truncate">{entry.name}</span>
							</button>
						))
					)}
				</div>

				{errorMessage && (
					<p className="text-destructive border-t border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm">
						{errorMessage}
					</p>
				)}

				<footer className="text-muted-foreground border-hairline flex-none border-t px-5 py-3 text-sm">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<span className="flex items-center gap-1.5">
							<kbd className="shortcut-key">↑</kbd>
							<kbd className="shortcut-key">↓</kbd> Navigate
						</span>
						<span className="flex items-center gap-1.5">
							<kbd className="shortcut-key">Enter</kbd> Select
						</span>
						<span className="flex items-center gap-1.5">
							<kbd className="shortcut-key">Backspace</kbd> Back
						</span>
						<span className="flex items-center gap-1.5">
							<kbd className="shortcut-key">Esc</kbd> Close
						</span>
					</div>
				</footer>
			</div>
		</div>
	);
}
