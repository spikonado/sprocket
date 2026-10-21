import ArtifactMenu from '$lib/components/artifact-menu';
import {
	Columns2,
	FileCode,
	Files,
	FileText,
	FolderTree,
	Fullscreen,
	Globe,
	Maximize2,
	Minimize2,
	PanelRight,
	Plus,
	Rows2,
	SquarePlus,
	X,
	type LucideIcon
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import ArtifactDisplay from '$lib/components/home/artifact-display';
import BrowserView, { type BrowserApi } from '$lib/components/home/browser-view';
import ConfirmDialog from '$lib/components/home/confirm-dialog';
import FileEditor, { type FileEditorApi } from '$lib/components/home/file-editor';
import FilesView, { type FilesApi } from '$lib/components/home/files-view';
import SidePanelSplitDivider from '$lib/components/home/side-panel-split-divider';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import {
	layoutRects,
	leafName,
	MIN_PANE_SIZE,
	topRightPane,
	type FileDraft,
	type LayoutRect,
	type SidePanelLayout,
	type SidePanelPane,
	type SidePanelTab,
	type SidePanelView,
	type SplitDirection
} from '$lib/chat/side-panel';
import type { WorkspaceFileTarget } from '$lib/types/sprocket';
import type { ArtifactType } from '@convex/lib/validators';

type TabPatch = Partial<Omit<SidePanelTab, 'id'>>;

type Props = {
	artifacts: ArtifactEntry[];
	workspacePath?: string;
	threadCwd?: string;
	onDeleteArtifact?: (artifactId: string) => Promise<void>;
	layout: SidePanelLayout;
	activePaneId: string;
	browserApi: BrowserApi | null;
	filesApi: (FilesApi & FileEditorApi) | null;
	/** When true, the panel covers the full Sprocket workspace UI (not browser fullscreen). */
	expanded: boolean;
	stale?: boolean;
	error?: string | null;
	onNewTab: (paneId: string) => void;
	onActivateTab: (id: string) => void;
	onCloseTab: (id: string) => void;
	onUpdateTab: (id: string, patch: TabPatch) => void;
	onDraftChange: (id: string, draft: FileDraft | undefined) => void;
	onFocusPane: (id: string) => void;
	onSplitPane: (id: string, direction: SplitDirection) => void;
	onResizeSplit: (id: string, ratio: number) => void;
	onOpenFile: (file: WorkspaceFileTarget) => void;
	onFileRenamed: (workspacePath: string, from: string, to: string) => void;
	onFileDeleted: (workspacePath: string, path: string) => void;
	/** Enter true browser fullscreen for a single artifact (content only). */
	onOpenFullscreen: (key: string) => void;
	/** Omitted when the panel can only be fullscreen. */
	onToggleExpanded?: () => void;
	onClose: () => void;
};

const TYPE_ICONS = {
	markdown: FileText,
	html: Globe,
	react: FileCode
} as const satisfies Record<ArtifactType, typeof FileCode>;

const VIEWS: { id: Exclude<SidePanelView, 'file'>; label: string; icon: LucideIcon }[] = [
	{ id: 'artifacts', label: 'Artifacts', icon: Files },
	{ id: 'files', label: 'Files', icon: FolderTree },
	{ id: 'browser', label: 'Browser', icon: Globe }
];

const ICON_BUTTON =
	'touch-target relative text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring rounded-md p-1 transition focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40';

function tabIndexForKey(key: string, index: number, count: number) {
	switch (key) {
		case 'ArrowLeft':
			return (index - 1 + count) % count;
		case 'ArrowRight':
			return (index + 1) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

function tabHeading(tab: SidePanelTab, artifacts: ArtifactEntry[]) {
	const artifact =
		tab.view === 'artifacts' ? artifacts.find((item) => item.key === tab.selectedKey) : undefined;

	if (artifact) return { label: artifact.title, icon: TYPE_ICONS[artifact.artifactType] };

	if (tab.view === 'file' && tab.file) {
		return { label: leafName(tab.file.path), title: tab.file.path, icon: FileCode };
	}

	return VIEWS.find((item) => item.id === tab.view) ?? { label: 'New tab', icon: SquarePlus };
}

export default function SidePanel(props: Props) {
	const {
		layout,
		activePaneId,
		expanded,
		onCloseTab,
		onFocusPane,
		onResizeSplit,
		onToggleExpanded
	} = props;

	const container = useRef<HTMLElement>(null);
	const focusNewPane = useRef(false);
	const [size, setSize] = useState<{ width: number; height: number } | null>(null);
	const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
	const { panes, splits } = layoutRects(layout);
	const cornerPaneId = topRightPane(layout).id;
	const activeTabId = panes.find(({ pane }) => pane.id === activePaneId)?.pane.activeTabId;
	const previousPaneCount = useRef(panes.length);

	const takeNewPaneFocus = useCallback(() => {
		const take = focusNewPane.current;
		focusNewPane.current = false;

		return take;
	}, []);

	useEffect(() => {
		const element = container.current;

		if (!element || !globalThis.ResizeObserver) return;

		const observer = new ResizeObserver(() =>
			setSize({ width: element.clientWidth, height: element.clientHeight })
		);

		observer.observe(element);

		return () => observer.disconnect();
	}, []);

	// Iframe clicks never reach the panes' capture handlers; the window blurs instead.
	useEffect(() => {
		const onBlur = () =>
			setTimeout(() => {
				const frame = document.activeElement;

				if (!(frame instanceof HTMLIFrameElement)) return;

				const paneId = frame.closest<HTMLElement>('[data-side-panel-pane]')?.dataset.sidePanelPane;

				if (paneId) onFocusPane(paneId);
			});

		window.addEventListener('blur', onBlur);

		return () => window.removeEventListener('blur', onBlur);
	}, [onFocusPane]);

	useEffect(() => {
		const paneClosed = panes.length < previousPaneCount.current;
		previousPaneCount.current = panes.length;

		if (paneClosed && document.activeElement === document.body) {
			document.getElementById(`side-panel-tab-${activeTabId}`)?.focus();
		}
	}, [panes.length, activeTabId]);

	function requestCloseTab(id: string) {
		const tab = panes.flatMap(({ pane }) => pane.tabs).find((candidate) => candidate.id === id);

		if (tab?.draft) setConfirmCloseId(id);
		else onCloseTab(id);
	}

	useEffect(() => {
		if (!expanded || !onToggleExpanded) return;

		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key !== 'Escape') return;

			// Artifact screen-fullscreen (browser FS or CSS fallback) owns Escape.
			if (
				document.fullscreenElement ||
				document.querySelector('[data-artifact-screen-fullscreen]') ||
				document.querySelector('[data-image-viewer]')
			) {
				return;
			}

			event.preventDefault();
			onToggleExpanded();
		};

		window.addEventListener('keydown', onKeyDown);

		return () => window.removeEventListener('keydown', onKeyDown);
	}, [expanded, onToggleExpanded]);

	return (
		<aside
			ref={container}
			id="side-panel"
			className={`bg-background relative h-full min-h-0 w-full overflow-hidden ${expanded ? '' : 'border-hairline border-l'}`}
		>
			{/* Panes render flat, keyed by id, so splitting never remounts a pane's browser or editor. */}
			{panes.map(({ pane, rect }) => (
				<Pane
					key={pane.id}
					{...props}
					pane={pane}
					rect={rect}
					focused={panes.length === 1 || pane.id === activePaneId}
					showsPanelButtons={pane.id === cornerPaneId}
					canSplitRight={!size || rect.width * size.width >= 2 * MIN_PANE_SIZE.row}
					canSplitDown={!size || rect.height * size.height >= 2 * MIN_PANE_SIZE.column}
					onSplit={(direction) => {
						focusNewPane.current = true;
						props.onSplitPane(pane.id, direction);
					}}
					takeNewPaneFocus={takeNewPaneFocus}
					onRequestCloseTab={requestCloseTab}
				/>
			))}
			{splits.map(({ split, rect }) => (
				<SidePanelSplitDivider
					key={split.id}
					split={split}
					rect={rect}
					container={container}
					onResize={(ratio) => onResizeSplit(split.id, ratio)}
				/>
			))}
			{confirmCloseId ? (
				<ConfirmDialog
					title="Discard unsaved changes?"
					description="This file has edits that haven’t been saved. Closing the tab discards them."
					confirmLabel="Discard and close"
					destructive
					onCancel={() => setConfirmCloseId(null)}
					onConfirm={() => {
						setConfirmCloseId(null);
						onCloseTab(confirmCloseId);
					}}
				/>
			) : null}
		</aside>
	);
}

function Pane({
	pane,
	rect,
	focused,
	showsPanelButtons,
	canSplitRight,
	canSplitDown,
	onSplit,
	takeNewPaneFocus,
	onRequestCloseTab,
	artifacts,
	workspacePath,
	threadCwd,
	onDeleteArtifact,
	browserApi,
	filesApi,
	expanded,
	stale = false,
	error = null,
	onNewTab,
	onActivateTab,
	onUpdateTab,
	onDraftChange,
	onFocusPane,
	onOpenFile,
	onFileRenamed,
	onFileDeleted,
	onOpenFullscreen,
	onToggleExpanded,
	onClose
}: Props & {
	pane: SidePanelPane;
	rect: LayoutRect;
	/** Whether chat links open here; only shown when the panel is split. */
	focused: boolean;
	showsPanelButtons: boolean;
	/** True until the panel is measured. */
	canSplitRight: boolean;
	canSplitDown: boolean;
	onSplit: (direction: SplitDirection) => void;
	/** True once, for the pane a split just created. */
	takeNewPaneFocus: () => boolean;
	onRequestCloseTab: (id: string) => void;
}) {
	const focusActiveTab = useRef(false);
	const { tabs, activeTabId } = pane;

	useEffect(() => {
		const tab = document.getElementById(`side-panel-tab-${activeTabId}`);
		tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

		if (focusActiveTab.current || takeNewPaneFocus()) {
			focusActiveTab.current = false;
			tab?.focus();
		}
	}, [activeTabId, tabs.length, takeNewPaneFocus]);

	return (
		<div
			style={{
				left: `${rect.left * 100}%`,
				top: `${rect.top * 100}%`,
				width: `${rect.width * 100}%`,
				height: `${rect.height * 100}%`
			}}
			className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden"
			data-side-panel-pane={pane.id}
			onPointerDownCapture={() => onFocusPane(pane.id)}
			onFocusCapture={() => onFocusPane(pane.id)}
		>
			<div className="border-hairline flex min-h-10 shrink-0 items-center gap-1 border-b px-2">
				<div
					role="tablist"
					aria-label="Side panel tabs"
					className="flex min-w-0 items-center gap-1 overflow-x-auto"
					onKeyDown={(event) => {
						const index = tabIndexForKey(
							event.key,
							tabs.findIndex((tab) => tab.id === activeTabId),
							tabs.length
						);

						if (index === null) return;
						event.preventDefault();

						const next = tabs[index]!;

						if (next.id === activeTabId) return;
						focusActiveTab.current = true;
						onActivateTab(next.id);
					}}
				>
					{tabs.map((tab) => {
						const heading = tabHeading(tab, artifacts);
						const active = tab.id === activeTabId;

						return (
							<div
								key={tab.id}
								className={`group flex max-w-40 min-w-20 shrink items-center rounded-md text-xs font-medium transition ${
									active
										? `text-foreground ${focused ? 'bg-muted' : 'bg-muted/50'}`
										: 'text-muted-foreground hover:bg-hover-fill hover:text-foreground'
								}`}
							>
								<button
									type="button"
									role="tab"
									id={`side-panel-tab-${tab.id}`}
									aria-selected={active}
									aria-controls={`side-panel-tabpanel-${tab.id}`}
									tabIndex={active ? 0 : -1}
									title={'title' in heading ? heading.title : heading.label}
									onClick={() => onActivateTab(tab.id)}
									onAuxClick={(event) => {
										if (event.button === 1) onRequestCloseTab(tab.id);
									}}
									className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2.5 focus-visible:ring-2 focus-visible:outline-none"
								>
									<heading.icon className="size-3.5 shrink-0" aria-hidden="true" />
									<span className="truncate">{heading.label}</span>
									{tab.draft ? (
										<span
											className="bg-foreground/70 size-1.5 shrink-0 rounded-full"
											aria-label="Unsaved changes"
										/>
									) : null}
								</button>
								<button
									type="button"
									tabIndex={active ? 0 : -1}
									onClick={() => {
										focusActiveTab.current = true;
										onRequestCloseTab(tab.id);
									}}
									aria-label={`Close ${heading.label} tab`}
									title="Close tab"
									className={`hover:bg-hover-fill focus-visible:ring-ring touch:opacity-100 mx-0.5 shrink-0 rounded p-0.5 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none ${active ? '' : 'opacity-0'}`}
								>
									<X className="size-3" aria-hidden="true" />
								</button>
							</div>
						);
					})}
				</div>
				<button
					type="button"
					className={ICON_BUTTON}
					data-ph-capture-attribute-action="new_side_panel_tab"
					onClick={() => onNewTab(pane.id)}
					aria-label="New tab"
					title="New tab"
				>
					<Plus className="size-4" aria-hidden="true" />
				</button>
				<div className="flex-1"></div>
				<button
					type="button"
					className={ICON_BUTTON}
					data-ph-capture-attribute-action="split_side_panel"
					data-ph-capture-attribute-split_direction="row"
					onClick={() => onSplit('row')}
					disabled={!canSplitRight}
					aria-label="Split right"
					title={canSplitRight ? 'Split right' : 'Widen the panel to split right'}
				>
					<Columns2 className="size-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					className={ICON_BUTTON}
					data-ph-capture-attribute-action="split_side_panel"
					data-ph-capture-attribute-split_direction="column"
					onClick={() => onSplit('column')}
					disabled={!canSplitDown}
					aria-label="Split down"
					title={canSplitDown ? 'Split down' : 'Make the panel taller to split down'}
				>
					<Rows2 className="size-4" aria-hidden="true" />
				</button>
				{showsPanelButtons ? (
					<>
						{onToggleExpanded && (
							<button
								type="button"
								className={ICON_BUTTON}
								onClick={onToggleExpanded}
								aria-label={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
								title={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
								aria-pressed={expanded}
							>
								{expanded ? (
									<Minimize2 className="size-4" aria-hidden="true" />
								) : (
									<Maximize2 className="size-4" aria-hidden="true" />
								)}
							</button>
						)}
						<button
							type="button"
							className={ICON_BUTTON}
							onClick={onClose}
							aria-label="Close panel"
							title="Close panel"
						>
							<PanelRight className="size-4" aria-hidden="true" />
						</button>
					</>
				) : null}
			</div>
			{tabs.map((tab) => (
				// Inactive tabs stay mounted so their browser session, scroll, and artifact state survive.
				<section
					key={tab.id}
					id={`side-panel-tabpanel-${tab.id}`}
					role="tabpanel"
					aria-labelledby={`side-panel-tab-${tab.id}`}
					hidden={tab.id !== activeTabId}
					tabIndex={-1}
					className="flex min-h-0 flex-1 flex-col focus:outline-none"
				>
					{tab.view === null ? (
						<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
							<ul aria-label="Open a view" className="grid w-full max-w-84 grid-cols-2 gap-4">
								{VIEWS.map((item) => (
									<li key={item.id}>
										<button
											type="button"
											data-ph-capture-attribute-action="choose_side_panel_view"
											data-ph-capture-attribute-side_panel_view={item.id}
											onClick={(event) => {
												onUpdateTab(tab.id, { view: item.id });
												event.currentTarget.closest<HTMLElement>('[role="tabpanel"]')?.focus();
											}}
											className="border-hairline text-muted-foreground hover:bg-hover-fill hover:text-foreground focus-visible:ring-ring flex h-32 w-full flex-col items-center justify-center gap-3 rounded-xl border transition focus-visible:ring-2 focus-visible:outline-none"
										>
											<item.icon className="size-5" strokeWidth={1.5} aria-hidden="true" />
											<span className="text-sm">{item.label}</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					) : tab.view === 'browser' ? (
						<BrowserView browserApi={browserApi} />
					) : tab.view === 'files' ? (
						<FilesView
							api={filesApi}
							projectPath={workspacePath}
							threadCwd={threadCwd}
							location={tab.directory}
							onLocationChange={(directory) => onUpdateTab(tab.id, { directory })}
							active={tab.id === activeTabId}
							onOpenFile={onOpenFile}
							onRenamed={onFileRenamed}
							onDeleted={onFileDeleted}
						/>
					) : tab.view === 'file' && tab.file ? (
						<FileEditor
							api={filesApi}
							file={tab.file}
							draft={tab.draft}
							active={tab.id === activeTabId}
							onDraftChange={(draft) => onDraftChange(tab.id, draft)}
						/>
					) : (
						<ArtifactsView
							artifacts={artifacts}
							selectedKey={tab.selectedKey}
							workspacePath={workspacePath}
							stale={stale}
							error={error}
							onSelect={(key) => onUpdateTab(tab.id, { selectedKey: key })}
							onBack={() => onUpdateTab(tab.id, { selectedKey: null })}
							onOpenFullscreen={onOpenFullscreen}
							onDeleteArtifact={onDeleteArtifact}
						/>
					)}
				</section>
			))}
		</div>
	);
}

function ArtifactsView({
	artifacts,
	selectedKey,
	workspacePath,
	stale,
	error,
	onSelect,
	onBack,
	onOpenFullscreen,
	onDeleteArtifact
}: {
	artifacts: ArtifactEntry[];
	selectedKey: string | null;
	workspacePath?: string;
	stale: boolean;
	error: string | null;
	onSelect: (key: string) => void;
	onBack: () => void;
	onOpenFullscreen: (key: string) => void;
	onDeleteArtifact?: (artifactId: string) => Promise<void>;
}) {
	const selected = artifacts.find((artifact) => artifact.key === selectedKey) ?? null;

	return (
		<>
			{error || stale ? (
				<div className="space-y-1 border-b px-3 py-2">
					{error ? (
						<p role="alert" className="text-xs text-amber-800 dark:text-amber-200">
							{error}
						</p>
					) : null}
					{stale ? (
						<p role="status" className="text-muted-foreground text-xs">
							Showing last known artifacts while Sprocket reconnects.
						</p>
					) : null}
				</div>
			) : null}
			{selected ? (
				<div className="flex min-h-0 flex-1 flex-col p-3">
					<ArtifactDisplay
						title={selected.title}
						artifactType={selected.artifactType}
						content={selected.content}
						localPath={selected.localPath}
						workspacePath={workspacePath}
						localError={selected.localError}
						variant="full"
						onOpenFullscreen={() => onOpenFullscreen(selected.key)}
						onBack={onBack}
						onDelete={onDeleteArtifact ? () => onDeleteArtifact(selected.key) : undefined}
					/>
				</div>
			) : (
				<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
					{artifacts.length === 0 ? (
						<p className="text-muted-foreground p-3 text-sm">No artifacts yet.</p>
					) : (
						artifacts.map((artifact) => {
							const TypeIcon = TYPE_ICONS[artifact.artifactType];

							return (
								<div
									key={artifact.key}
									className="group hover:bg-muted focus-within:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5"
								>
									<ArtifactMenu
										trigger="context"
										title={artifact.title}
										onDelete={onDeleteArtifact ? () => onDeleteArtifact(artifact.key) : undefined}
									>
										<button
											type="button"
											className="flex min-w-0 flex-1 items-center gap-2 text-left"
											onClick={() => onSelect(artifact.key)}
										>
											<TypeIcon
												className="text-muted-foreground size-3.5 shrink-0"
												aria-hidden="true"
											/>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="flex min-w-0 items-center gap-2">
													<span className="text-foreground min-w-0 truncate text-sm">
														{artifact.title}
													</span>
													<span className="text-muted-foreground shrink-0 text-[11px]">
														{artifact.artifactType}
													</span>
												</span>
												<span className="text-muted-foreground min-w-0 truncate text-[11px]">
													{artifact.localPath ?? 'Stored in cloud'}
												</span>
												{artifact.localError ? (
													<span className="text-[11px] text-amber-800 dark:text-amber-200">
														{artifact.localError}
													</span>
												) : null}
											</span>
										</button>
									</ArtifactMenu>
									<button
										type="button"
										className="touch-target text-muted-foreground hover:text-foreground touch:opacity-100 relative shrink-0 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
										onClick={() => onOpenFullscreen(artifact.key)}
										aria-label={`Open ${artifact.title} fullscreen`}
										title="Open fullscreen"
									>
										<Fullscreen className="size-3.5" aria-hidden="true" />
									</button>
								</div>
							);
						})
					)}
				</div>
			)}
		</>
	);
}
