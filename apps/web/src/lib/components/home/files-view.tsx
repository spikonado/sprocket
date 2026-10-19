import {
	prepareFileTreeInput,
	type ContextMenuItem,
	type ContextMenuOpenContext,
	type FileTreeDropResult,
	type FileTreeRenameEvent
} from '@pierre/trees';
import {
	FileTree,
	useFileTree,
	useFileTreeSearch,
	useFileTreeSelector,
	type UseFileTreeResult
} from '@pierre/trees/react';
import { FilePlus, FolderPlus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import ConfirmDialog from '$lib/components/home/confirm-dialog';
import { leafName, trimSlash } from '$lib/chat/side-panel';
import type { DesktopApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type FilesApi = Pick<
	DesktopApi,
	'listWorkspaceFiles' | 'createWorkspaceFile' | 'renameWorkspaceFile' | 'deleteWorkspaceFile'
>;

type FilesRoot = 'thread' | 'project';

type Props = {
	api: FilesApi | null;
	projectPath?: string;
	threadCwd?: string;
	/** Polls for outside changes only while the tab is active. */
	active: boolean;
	onOpenFile: (file: WorkspaceFileTarget) => void;
	onRenamed: (workspacePath: string, from: string, to: string) => void;
	onDeleted: (workspacePath: string, path: string) => void;
};

type ListingState = {
	path: string;
	count: number;
	scanning: boolean;
	truncated: boolean;
	error: string | null;
};

type Shown = { path: string; paths: readonly string[]; hash: string };

const ROOTS: { id: FilesRoot; label: string }[] = [
	{ id: 'thread', label: 'Thread' },
	{ id: 'project', label: 'Project' }
];

const LIST_POLL_MS = 2_500;

const SCAN_POLL_MS = 500;

const TOOL_BUTTON =
	'text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring shrink-0 rounded-md p-1 transition focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50';

type TreeModel = UseFileTreeResult['model'];

function parentDirectory(path: string) {
	const trimmed = trimSlash(path);

	return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

function samePaths(a: readonly string[], b: readonly string[]) {
	return a.length === b.length && a.every((path, index) => path === b[index]);
}

function expandedDirectories(model: TreeModel, paths: readonly string[]) {
	return paths.filter((path) => {
		if (!path.endsWith('/')) return false;
		const item = model.getItem(path);

		return item !== null && 'isExpanded' in item && item.isExpanded();
	});
}

/** Picks an unused `untitled` path inside `directory` (`''` or ending in `/`). */
function placeholderPath(model: TreeModel, directory: string, isFolder: boolean) {
	for (let index = 1; ; index++) {
		const name = index === 1 ? 'untitled' : `untitled-${index}`;

		if (!model.getItem(`${directory}${name}`) && !model.getItem(`${directory}${name}/`)) {
			return `${directory}${name}${isFolder ? '/' : ''}`;
		}
	}
}

export default function FilesView({
	api,
	projectPath,
	threadCwd,
	active,
	onOpenFile,
	onRenamed,
	onDeleted
}: Props) {
	const [root, setRoot] = useState<FilesRoot>('thread');
	const [refreshKey, setRefreshKey] = useState(0);
	const [listing, setListing] = useState<ListingState | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [deleteRequest, setDeleteRequest] = useState<{ path: string; root: string } | null>(null);
	const shown = useRef<Shown | null>(null);
	const forceReset = useRef(false);
	const mutations = useRef(0);
	/** A placeholder row for a new file or folder that is waiting for its name. */
	const pendingCreate = useRef<{ path: string; editing: boolean } | null>(null);
	const searchInput = useRef<HTMLInputElement>(null);

	const handlers = useRef<{
		rename: (event: FileTreeRenameEvent) => void;
		drop: (event: FileTreeDropResult) => void;
		create: (path: string) => void;
	}>({ rename: () => {}, drop: () => {}, create: () => {} });

	const canSwitchRoot = !!threadCwd && !!projectPath && threadCwd !== projectPath;
	const rootPath = canSwitchRoot && root === 'project' ? projectPath : (threadCwd ?? projectPath);
	const current = listing?.path === rootPath ? listing : null;

	const pendingDelete =
		deleteRequest && deleteRequest.root === rootPath ? deleteRequest.path : null;

	function requestDelete(path: string) {
		if (rootPath) setDeleteRequest({ path, root: rootPath });
	}

	const { model } = useFileTree({
		paths: [],
		search: false,
		fileTreeSearchMode: 'hide-non-matches',
		flattenEmptyDirectories: true,
		density: 'compact',
		icons: 'complete',
		stickyFolders: true,
		composition: {
			contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: 'when-needed' }
		},
		renaming: {
			onRename: (event) => handlers.current.rename(event),
			onError: setActionError
		},
		dragAndDrop: {
			onDropComplete: (event) => handlers.current.drop(event),
			onDropError: setActionError
		}
	});

	const search = useFileTreeSearch(model);
	const focusedPath = useFileTreeSelector(model, (tree) => tree.getFocusedPath());

	function resync() {
		forceReset.current = true;
		setRefreshKey((value) => value + 1);
	}

	async function mutate(work: (api: FilesApi, workspacePath: string) => Promise<void>) {
		if (!api || !rootPath) return;
		mutations.current++;
		setActionError(null);

		try {
			await work(api, rootPath);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : 'The file operation failed.');
			resync();
		} finally {
			mutations.current--;
		}
	}

	handlers.current.create = (path) => {
		const directory = path.endsWith('/');
		const target = trimSlash(path);

		void mutate(async (api, workspacePath) => {
			await api.createWorkspaceFile({ workspacePath, path: target, directory });

			if (!directory) onOpenFile({ workspacePath, path: target });
		});
	};

	handlers.current.rename = ({ sourcePath, destinationPath }) => {
		const from = trimSlash(sourcePath);
		const to = trimSlash(destinationPath);
		const pending = pendingCreate.current;

		if (pending && trimSlash(pending.path) === from) {
			pendingCreate.current = null;
			handlers.current.create(pending.path.endsWith('/') ? `${to}/` : to);

			return;
		}

		void mutate(async (api, workspacePath) => {
			await api.renameWorkspaceFile({ workspacePath, from, to });
			onRenamed(workspacePath, from, to);
		});
	};

	handlers.current.drop = ({ draggedPaths, target }) => {
		const directory = target.directoryPath ? `${trimSlash(target.directoryPath)}/` : '';

		void mutate(async (api, workspacePath) => {
			for (const dragged of draggedPaths) {
				const from = trimSlash(dragged);
				const to = `${directory}${leafName(dragged)}`;

				if (from === to) continue;
				await api.renameWorkspaceFile({ workspacePath, from, to });
				onRenamed(workspacePath, from, to);
			}
		});
	};

	function startCreate(isFolder: boolean, directory?: string) {
		if (pendingCreate.current) return;

		const focused = model.getFocusedPath();

		const parent =
			directory ??
			(focused === null ? '' : focused.endsWith('/') ? focused : parentDirectory(focused));

		const path = placeholderPath(model, parent, isFolder);

		search.setValue(null);
		model.add(path);
		pendingCreate.current = { path, editing: false };

		if (!model.startRenaming(path, { removeIfCanceled: true })) {
			pendingCreate.current = null;
			model.remove(path, { recursive: isFolder });
		}
	}

	function openPath(path: string) {
		if (!rootPath || path.endsWith('/')) return;
		onOpenFile({ workspacePath: rootPath, path });
	}

	function confirmDelete(path: string) {
		setDeleteRequest(null);
		model.remove(path, { recursive: path.endsWith('/') });
		const target = trimSlash(path);

		void mutate(async (api, workspacePath) => {
			await api.deleteWorkspaceFile({ workspacePath, path: target });
			onDeleted(workspacePath, target);
		});
	}

	// The tree reports a renamed placeholder through onRename and a cancelled one by
	// removing it. Accepting the suggested name reports neither, so watch for the
	// rename input closing while the placeholder is still in the tree.
	useEffect(
		() =>
			model.subscribe(() => {
				if (!pendingCreate.current) return;

				requestAnimationFrame(() => {
					const pending = pendingCreate.current;

					if (!pending) return;

					const editing = model
						.getFileTreeContainer()
						?.shadowRoot?.querySelector('[data-item-rename-input]');

					if (editing) {
						pending.editing = true;

						return;
					}

					if (!pending.editing) return;
					pendingCreate.current = null;

					if (model.getItem(pending.path)) handlers.current.create(pending.path);
				});
			}),
		[model]
	);

	useEffect(() => {
		if (!api || !rootPath || !active) return;
		const workspacePath = rootPath;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		if (shown.current && shown.current.path !== workspacePath) {
			model.resetPaths([]);
			shown.current = null;
		}

		async function poll() {
			let scanning = false;

			if (document.visibilityState === 'visible' && !pendingCreate.current) {
				const known = shown.current?.path === workspacePath ? shown.current : null;
				const knownHash = forceReset.current ? undefined : known?.hash;

				try {
					const result = await api!.listWorkspaceFiles(
						{ workspacePath, knownHash },
						controller.signal
					);

					if (controller.signal.aborted) return;
					scanning = result.scanning;

					// Optimistic tree edits win until their request settles.
					if (result.hash !== knownHash && mutations.current === 0 && !pendingCreate.current) {
						if (forceReset.current || !known || !samePaths(known.paths, result.paths)) {
							model.resetPaths({
								preparedInput: prepareFileTreeInput(result.paths, {
									flattenEmptyDirectories: true
								}),
								initialExpandedPaths: known ? expandedDirectories(model, known.paths) : []
							});
						}

						model.setGitStatus(result.gitStatus);
						shown.current = { path: workspacePath, paths: result.paths, hash: result.hash };
						forceReset.current = false;
					}

					setListing({
						path: workspacePath,
						count: shown.current?.path === workspacePath ? shown.current.paths.length : 0,
						scanning: result.scanning,
						truncated: result.truncated,
						error: null
					});
				} catch (error) {
					if (controller.signal.aborted) return;
					setListing({
						path: workspacePath,
						count: 0,
						scanning: false,
						truncated: false,
						error: error instanceof Error ? error.message : 'Could not list files.'
					});
				}
			}

			timer = setTimeout(poll, scanning ? SCAN_POLL_MS : LIST_POLL_MS);
		}

		void poll();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [api, rootPath, active, refreshKey, model]);

	const blockingStatus = !api
		? 'Files are available when Sprocket is connected to this machine.'
		: !rootPath
			? 'Select a project to browse its files.'
			: current?.error
				? current.error
				: !current || (current.scanning && current.count === 0)
					? 'Loading files…'
					: null;

	const matchIndex = focusedPath ? search.matchingPaths.indexOf(focusedPath) : -1;

	function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'Escape') {
			if (!search.value) return;
			event.preventDefault();
			event.stopPropagation();
			search.setValue(null);
		} else if (event.key === 'ArrowDown' || (event.key === 'Enter' && matchIndex === -1)) {
			event.preventDefault();
			search.focusNextMatch();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			search.focusPreviousMatch();
		} else if (event.key === 'Enter' && focusedPath) {
			event.preventDefault();
			openPath(focusedPath);
		}
	}

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
					event.preventDefault();
					searchInput.current?.select();
				}
			}}
		>
			<div className="border-hairline flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
				{canSwitchRoot ? (
					<div
						role="group"
						aria-label="Files root"
						className="bg-muted mr-1 flex shrink-0 rounded-full p-0.5 text-xs font-medium"
					>
						{ROOTS.map((item) => (
							<button
								key={item.id}
								type="button"
								aria-pressed={root === item.id}
								onClick={() => setRoot(item.id)}
								className={`focus-visible:ring-ring rounded-full px-2.5 py-0.5 transition focus-visible:ring-2 focus-visible:outline-none ${
									root === item.id
										? 'bg-background text-foreground shadow-sm'
										: 'text-muted-foreground hover:text-foreground'
								}`}
							>
								{item.label}
							</button>
						))}
					</div>
				) : null}
				<span
					className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-left text-[11px] [direction:rtl]"
					title={rootPath}
				>
					<bdi>{rootPath}</bdi>
				</span>
				<button
					type="button"
					onClick={() => startCreate(false)}
					disabled={blockingStatus !== null}
					aria-label="New file"
					title="New file"
					className={TOOL_BUTTON}
				>
					<FilePlus className="size-3.5" aria-hidden="true" />
				</button>
				<button
					type="button"
					onClick={() => startCreate(true)}
					disabled={blockingStatus !== null}
					aria-label="New folder"
					title="New folder"
					className={TOOL_BUTTON}
				>
					<FolderPlus className="size-3.5" aria-hidden="true" />
				</button>
				<button
					type="button"
					onClick={resync}
					disabled={!api || !rootPath}
					aria-label="Refresh files"
					title="Refresh files"
					className={TOOL_BUTTON}
				>
					<RefreshCw className="size-3.5" aria-hidden="true" />
				</button>
			</div>
			<div className="shrink-0 px-2 pt-2 pb-1">
				<div className="border-hairline bg-muted/60 focus-within:border-ring focus-within:bg-background flex h-7 items-center gap-1.5 rounded-md border px-2 transition">
					<Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
					<input
						ref={searchInput}
						type="text"
						value={search.value}
						onChange={(event) => search.setValue(event.target.value || null)}
						onKeyDown={onSearchKeyDown}
						placeholder="Search files"
						aria-label="Search files"
						spellCheck={false}
						autoComplete="off"
						className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
					/>
					{search.value ? (
						<>
							<span
								className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
								aria-live="polite"
							>
								{search.matchingPaths.length === 0
									? 'No matches'
									: matchIndex === -1
										? `${search.matchingPaths.length.toLocaleString()} matches`
										: `${matchIndex + 1} of ${search.matchingPaths.length.toLocaleString()}`}
							</span>
							<button
								type="button"
								onClick={() => {
									search.setValue(null);
									searchInput.current?.focus();
								}}
								aria-label="Clear search"
								title="Clear search"
								className="text-muted-foreground hover:text-foreground -mr-1 shrink-0 rounded p-0.5"
							>
								<X className="size-3" aria-hidden="true" />
							</button>
						</>
					) : null}
				</div>
			</div>
			{current?.truncated ? (
				<p role="status" className="text-muted-foreground px-3 py-1 text-xs">
					Showing the first {current.count.toLocaleString()} entries.
				</p>
			) : null}
			{actionError ? (
				<div
					role="alert"
					className="text-destructive mx-2 my-1 flex shrink-0 items-start gap-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs"
				>
					<span className="min-w-0 flex-1 wrap-break-word">{actionError}</span>
					<button
						type="button"
						onClick={() => setActionError(null)}
						aria-label="Dismiss error"
						className="hover:bg-hover-fill shrink-0 rounded p-0.5"
					>
						<X className="size-3" aria-hidden="true" />
					</button>
				</div>
			) : null}
			{blockingStatus || current?.count === 0 ? (
				<p
					role={current?.error ? 'alert' : 'status'}
					className="text-muted-foreground px-3 py-2 text-sm"
				>
					{blockingStatus ?? 'No files yet.'}
				</p>
			) : null}
			<FileTree
				model={model}
				hidden={blockingStatus !== null}
				className="workspace-file-tree min-h-0 flex-1"
				onClick={(event) => {
					const row = event.nativeEvent
						.composedPath()
						.find(
							(target): target is HTMLElement =>
								target instanceof HTMLElement && target.dataset.type === 'item'
						);

					if (row?.dataset.itemType === 'file' && row.dataset.itemPath) {
						openPath(row.dataset.itemPath);
					}
				}}
				onKeyDown={(event) => {
					const path = model.getFocusedPath();
					const origin = event.nativeEvent.composedPath()[0];

					if (!path || !(origin instanceof HTMLElement) || origin.role !== 'treeitem') return;

					if (event.key === 'Enter') openPath(path);
					else if (event.key === 'Delete') requestDelete(path);
				}}
				renderContextMenu={(item, context) => (
					<FileContextMenu
						item={item}
						context={context}
						rootPath={rootPath ?? ''}
						onOpen={() => openPath(item.path)}
						onNew={(isFolder) =>
							startCreate(
								isFolder,
								item.kind === 'directory' ? item.path : parentDirectory(item.path)
							)
						}
						onRename={() => model.startRenaming(item.path)}
						onDelete={() => requestDelete(item.path)}
					/>
				)}
			/>
			{pendingDelete ? (
				<ConfirmDialog
					title={`Delete ${leafName(pendingDelete)}?`}
					description={
						pendingDelete.endsWith('/')
							? 'This deletes the folder and everything in it. You can’t undo this.'
							: 'You can’t undo this.'
					}
					confirmLabel="Delete"
					destructive
					onCancel={() => setDeleteRequest(null)}
					onConfirm={() => confirmDelete(pendingDelete)}
				/>
			) : null}
		</div>
	);
}

const MENU_MARGIN = 8;

/** Keeps the menu inside the viewport, flipping above the anchor when it would overflow below. */
function placeMenu(menu: HTMLDivElement, anchor: ContextMenuOpenContext['anchorRect']) {
	const { width, height } = menu.getBoundingClientRect();
	const below = anchor.bottom + height + MENU_MARGIN <= window.innerHeight;
	const top = below ? anchor.bottom : anchor.top - height;

	menu.style.left = `${Math.max(MENU_MARGIN, Math.min(anchor.left, window.innerWidth - width - MENU_MARGIN))}px`;
	menu.style.top = `${Math.max(MENU_MARGIN, top)}px`;
	menu.querySelector<HTMLButtonElement>('button')?.focus();
}

function FileContextMenu({
	item,
	context,
	rootPath,
	onOpen,
	onNew,
	onRename,
	onDelete
}: {
	item: ContextMenuItem;
	context: ContextMenuOpenContext;
	rootPath: string;
	onOpen: () => void;
	onNew: (isFolder: boolean) => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const relativePath = trimSlash(item.path);
	const menuRef = useRef<HTMLDivElement>(null);
	const anchorRect = context.anchorRect;

	useLayoutEffect(() => {
		if (menuRef.current) placeMenu(menuRef.current, anchorRect);
	}, [anchorRect]);

	const groups: { label: string; run: () => void; ownsFocus?: boolean; destructive?: boolean }[][] =
		[
			[
				...(item.kind === 'file' ? [{ label: 'Open', run: onOpen }] : []),
				{ label: 'New file…', run: () => onNew(false), ownsFocus: true },
				{ label: 'New folder…', run: () => onNew(true), ownsFocus: true }
			],
			[
				{ label: 'Rename…', run: onRename, ownsFocus: true },
				{ label: 'Delete…', run: onDelete, ownsFocus: true, destructive: true }
			],
			[
				{
					label: 'Copy path',
					run: () => void navigator.clipboard?.writeText(`${rootPath}/${relativePath}`)
				},
				{
					label: 'Copy relative path',
					run: () => void navigator.clipboard?.writeText(relativePath)
				}
			]
		];

	return createPortal(
		<div
			role="menu"
			aria-label={`${item.name} actions`}
			data-file-tree-context-menu-root="true"
			ref={menuRef}
			className="bg-popover text-popover-foreground fixed z-250 w-48 rounded-md border p-1 shadow-md"
			onKeyDown={(event) => {
				const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
				const index = buttons.findIndex((button) => button === document.activeElement);
				const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;

				if (event.key === 'Escape') {
					event.preventDefault();
					context.close();
				} else if (delta !== 0) {
					event.preventDefault();
					buttons[(index + delta + buttons.length) % buttons.length]?.focus();
				}
			}}
		>
			{groups.map((group, groupIndex) => (
				<div
					key={groupIndex}
					role="group"
					className={groupIndex > 0 ? 'border-hairline mt-1 border-t pt-1' : undefined}
				>
					{group.map((action) => (
						<button
							key={action.label}
							type="button"
							role="menuitem"
							onClick={() => {
								context.close({ restoreFocus: !action.ownsFocus });
								action.run();
							}}
							className={`hover:bg-muted focus:bg-muted flex w-full rounded-sm px-2 py-1 text-left text-xs outline-none ${
								action.destructive ? 'text-destructive' : ''
							}`}
						>
							{action.label}
						</button>
					))}
				</div>
			))}
		</div>,
		document.body
	);
}
