import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type {
	DragEvent as ReactDragEvent,
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent
} from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { CatalogModel } from '@convex/lib/uiModelCatalog';
import { inboxState, type InboxState } from '@convex/lib/inboxState';
import type { Project } from '$lib/types/sprocket';
import type { SprocketTheme } from '$lib/theme';
import type { InboxSectionData } from '$lib/project/inbox';
import { cn } from '$lib/utils';
import BrandMark from '$lib/components/brand-mark';
import ProviderLogo from '$lib/components/provider-logo';
import AppUpdate from './app-update';
import InboxLoadMore from './inbox-load-more';
import SidebarTopActions from './sidebar-top-actions';

const SETTLED_INBOX_OPEN_KEY = 'sprocket.inbox.settled-open';

type Thread = Doc<'threadRecords'>;

const labels = {
	unsettled: 'Unsettled',
	settled: 'Settled Threads'
} satisfies Record<InboxState, string>;

export default function InboxSidebar({
	sections,
	projects,
	models,
	selectedProjects,
	currentThreadId,
	settledOpen = false,
	onSettledOpenChange,
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
}: {
	sections: InboxSectionData[];
	projects: Project[];
	models: readonly Pick<CatalogModel, 'id' | 'label' | 'provider'>[];
	selectedProjects: string[];
	currentThreadId: Id<'threadRecords'> | null;
	settledOpen?: boolean;
	onSettledOpenChange: (open: boolean) => void;
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
}) {
	const [dragging, setDragging] = useState<Thread | null>(null);
	const [menu, setMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [renameThread, setRenameThread] = useState<Thread | null>(null);
	const [renameTitle, setRenameTitle] = useState('');
	const [now, setNow] = useState(() => Date.now());
	const [projectSearch, setProjectSearch] = useState('');
	const busyRef = useRef(false);
	const menuTriggerRef = useRef<HTMLElement | null>(null);
	const renameInputRef = useRef<HTMLInputElement | null>(null);
	const projectMenuRef = useRef<HTMLDetailsElement | null>(null);
	const onSettledOpenChangeRef = useRef(onSettledOpenChange);

	const closeMenu = useCallback(() => {
		const trigger = menuTriggerRef.current;
		menuTriggerRef.current = null;
		setMenu(null);
		trigger?.focus();
	}, []);

	const rows = sections.flatMap((section) => section.rows);

	const filteredProjects = projects.filter((project) =>
		project.displayName.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())
	);

	const visibleSections = sections.filter(
		(section) =>
			section.rows.length ||
			section.loading ||
			section.error ||
			section.canLoadMore ||
			(section.state === 'settled' && !settledOpen)
	);

	const projectFilterLabel =
		selectedProjects.length === 0
			? 'All projects'
			: selectedProjects.length === 1
				? (projects.find((project) => project.repositoryKey === selectedProjects[0])?.displayName ??
					'All projects')
				: `${selectedProjects.length} projects`;

	const menuThread = menu?.thread ?? null;

	useEffect(() => {
		onSettledOpenChangeRef.current = onSettledOpenChange;
	});

	useEffect(() => {
		try {
			const savedSettledOpen = localStorage.getItem(SETTLED_INBOX_OPEN_KEY);

			if (savedSettledOpen !== null) {
				onSettledOpenChangeRef.current(savedSettledOpen === 'true');
			}
		} catch {
			// Browsers can deny storage access while still allowing the app to run.
		}

		const timer = setInterval(() => {
			setNow(Date.now());
		}, 30_000);

		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (!renameThread || !renameInputRef.current) return;
		renameInputRef.current.focus();
		renameInputRef.current.select();
	}, [renameThread]);

	useEffect(() => {
		if (!menu) return;
		document.querySelector<HTMLButtonElement>('.inbox-context-menu button:not(:disabled)')?.focus();
	}, [menu]);

	function projectName(thread: Thread) {
		return (
			projects.find((project) => project.repositoryKey === thread.repositoryKey)?.displayName ??
			thread.repositoryKey
		);
	}

	function threadModel(thread: Thread) {
		return models.find((model) => model.id === thread.selectedModel);
	}

	function closeProjectMenu() {
		if (projectMenuRef.current) {
			projectMenuRef.current.open = false;
		}

		setProjectSearch('');
	}

	function filterProjects(keys: string[]) {
		onFilter(keys);
		closeProjectMenu();
	}

	function addProject() {
		closeProjectMenu();
		onAddProject();
	}

	function toggleSettled() {
		const next = !settledOpen;
		onSettledOpenChange(next);

		try {
			localStorage.setItem(SETTLED_INBOX_OPEN_KEY, String(next));
		} catch {
			// The collapsed state still works for this session without storage.
		}
	}

	function age(at: number) {
		const minutes = Math.max(0, Math.floor((now - at) / 60_000));

		if (minutes < 1) return 'now';

		if (minutes < 60) return `${minutes}m`;

		if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;

		return `${Math.floor(minutes / 1440)}d`;
	}

	function runStatus(thread: Thread): { label: string; className: string } | null {
		if (thread.status === 'queued') return { label: 'Starting', className: 'inbox-working' };

		if (thread.status === 'running') return { label: 'Working', className: 'inbox-working' };

		return thread.status === 'failed' ? { label: 'Failed', className: 'inbox-attention' } : null;
	}

	function choose(thread: Thread) {
		onSelect(thread);
	}

	function beginRename(thread: Thread) {
		setMenu(null);
		setRenameThread(thread);
		setRenameTitle(thread.title ?? '');
	}

	function cancelRename() {
		setRenameThread(null);
		setRenameTitle('');
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
			setNotice(error instanceof Error ? error.message : 'Could not rename thread.');
		}
	}

	function canChange(thread: Thread, state: InboxState) {
		return inboxState(thread) !== state && (state !== 'settled' || thread.status !== 'running');
	}

	async function change(thread: Thread, state: InboxState) {
		if (!mutationsEnabled || busyRef.current) return;
		closeMenu();
		busyRef.current = true;
		setBusy(true);
		setNotice(null);

		if (!canChange(thread, state)) {
			busyRef.current = false;
			setBusy(false);

			return;
		}

		try {
			await onChange(thread, state);
		} catch (error) {
			setNotice(error instanceof Error ? error.message : 'Could not update thread.');
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	function canDrop(state: InboxState) {
		return mutationsEnabled && !busy && dragging !== null && canChange(dragging, state);
	}

	function dropThreads(event: ReactDragEvent, state: InboxState) {
		event.preventDefault();

		if (dragging && canDrop(state)) void change(dragging, state);
		setDragging(null);
	}

	function openMenu(event: ReactMouseEvent, thread: Thread) {
		event.preventDefault();
		const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		menuTriggerRef.current = trigger;
		const rect = trigger?.getBoundingClientRect();
		const pointerX = event.clientX;
		const pointerY = event.clientY;
		setMenu({
			thread,
			x: Math.min(pointerX || rect?.left || 8, window.innerWidth - 230),
			y: Math.min(pointerY || rect?.bottom || 8, window.innerHeight - 260)
		});
	}

	function navigateMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Tab' || event.key === 'Escape') {
			event.preventDefault();
			closeMenu();

			return;
		}

		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();

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

	const handleWindowKeydown = useCallback(
		(event: KeyboardEvent) => {
			if (event.defaultPrevented) return;

			if (event.key === 'Escape') {
				if (menu) closeMenu();

				return;
			}

			if (event.altKey && event.key.toLowerCase() === 'n') {
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
		},
		[menu, closeMenu, onNew, rows, currentThreadId, onSelect]
	);

	useEffect(() => {
		window.addEventListener('keydown', handleWindowKeydown);

		return () => window.removeEventListener('keydown', handleWindowKeydown);
	}, [handleWindowKeydown]);

	return (
		<aside className="inbox-sidebar" aria-label="Thread inbox">
			<header className="flex items-center gap-2 px-4 pt-4 pb-3">
				<BrandMark size="sm" class="mr-auto" label="Close sidebar" onclick={() => onClose()} />
				<SidebarTopActions theme={theme} onThemeChange={onThemeChange} onClose={onClose} />
			</header>

			<div className="px-3 pb-3">
				<button className="inbox-menu-item inbox-primary-navigation" type="button" onClick={onNew}>
					<SquarePen size={15} />
					New thread
				</button>
				<div className="inbox-project-controls">
					<details ref={projectMenuRef}>
						<summary className="inbox-filter inbox-primary-navigation">
							<span className="truncate">{projectFilterLabel}</span>
							<ChevronDown size={14} />
						</summary>
						<div className="inbox-project-menu">
							<label className="inbox-project-search">
								<Search size={14} />
								<input
									value={projectSearch}
									onChange={(event) => setProjectSearch(event.currentTarget.value)}
									aria-label="Search projects"
									placeholder="Search projects"
								/>
							</label>
							<div className="inbox-project-list">
								<button
									className={cn('inbox-project-option', {
										'inbox-project-selected': selectedProjects.length === 0
									})}
									type="button"
									aria-pressed={selectedProjects.length === 0}
									onClick={() => filterProjects([])}
								>
									All projects
								</button>
								{filteredProjects.map((project) => {
									const selected =
										selectedProjects.length === 1 && selectedProjects[0] === project.repositoryKey;

									return (
										<button
											key={project.repositoryKey}
											className={cn('inbox-project-option', {
												'inbox-project-selected': selected
											})}
											type="button"
											aria-pressed={selected}
											onClick={() => filterProjects([project.repositoryKey])}
										>
											{project.displayName}
										</button>
									);
								})}
							</div>
						</div>
					</details>
					<button
						className="inbox-icon inbox-add-project-button"
						type="button"
						aria-label="Create or add project"
						onClick={addProject}
					>
						<FolderPlus size={17} />
					</button>
				</div>
			</div>

			<div className="inbox-scroll">
				{visibleSections.map((section) => (
					<section
						key={section.state}
						id={`inbox-${section.state}`}
						onDragOver={(event) => {
							if (canDrop(section.state)) event.preventDefault();
						}}
						onDrop={(event) => dropThreads(event, section.state)}
						aria-label={labels[section.state]}
					>
						{section.state === 'settled' && (
							<button
								className="inbox-section-heading inbox-primary-navigation"
								type="button"
								aria-expanded={settledOpen}
								aria-controls="inbox-settled-threads"
								onClick={toggleSettled}
							>
								<span>Settled Threads</span>
								<ChevronDown
									className={settledOpen ? 'inbox-section-chevron-open' : undefined}
									size={14}
								/>
							</button>
						)}
						<div id={section.state === 'settled' ? 'inbox-settled-threads' : undefined}>
							{(section.state !== 'settled' || settledOpen) && (
								<>
									{section.rows.map((thread) => {
										const status = runStatus(thread);
										const model = threadModel(thread);
										const isRenaming = renameThread?._id === thread._id;

										return (
											<div
												key={thread._id}
												className={cn('inbox-row', {
													'inbox-row-selected': thread._id === currentThreadId
												})}
												draggable={mutationsEnabled && !busy && !isRenaming}
												onDragStart={(event) => {
													setDragging(thread);
													event.dataTransfer?.setData('text/plain', thread._id);
												}}
												onDragEnd={() => setDragging(null)}
												onContextMenu={(event) => openMenu(event, thread)}
												role="group"
												aria-label={thread.title ?? 'New thread'}
											>
												{isRenaming ? (
													<form
														className="inbox-row-main"
														onSubmit={(event) => {
															event.preventDefault();
															void commitRename();
														}}
													>
														<span className="inbox-row-meta">
															<span className="truncate">{projectName(thread)}</span>
															<span className="inbox-row-age shrink-0">
																{age(thread.lastMessageAt)}
															</span>
														</span>
														<input
															ref={renameInputRef}
															value={renameTitle}
															onChange={(event) => setRenameTitle(event.currentTarget.value)}
															className="inbox-row-rename-input"
															aria-label="Rename thread"
															maxLength={300}
															onKeyDown={(event) => {
																if (event.key !== 'Escape') return;
																event.preventDefault();
																cancelRename();
															}}
															onBlur={() => void commitRename()}
														/>
														<span className="inbox-row-model">
															{model ? (
																<>
																	<ProviderLogo
																		provider={model.provider}
																		className="size-3.5 shrink-0"
																	/>
																	<span className="truncate">{model.label}</span>
																</>
															) : (
																<span className="truncate">Unknown model</span>
															)}
														</span>
													</form>
												) : (
													<button
														className="inbox-row-main"
														type="button"
														title={`${thread.title ?? 'New thread'}\n${projectName(thread)}\n${new Date(thread.lastMessageAt).toLocaleString()}`}
														onClick={() => choose(thread)}
														onDoubleClick={() => {
															if (!mutationsEnabled || busy) return;
															beginRename(thread);
														}}
														aria-current={thread._id === currentThreadId ? 'page' : undefined}
													>
														<span className="inbox-row-meta">
															<span className="truncate">{projectName(thread)}</span>
															<span className="inbox-row-age shrink-0">
																{age(thread.lastMessageAt)}
															</span>
														</span>
														<span className="inbox-row-title truncate">
															{thread.title ?? 'New thread'}
														</span>
														<span className="inbox-row-model">
															{model ? (
																<>
																	<ProviderLogo
																		provider={model.provider}
																		className="size-3.5 shrink-0"
																	/>
																	<span className="truncate">{model.label}</span>
																</>
															) : (
																<span className="truncate">Unknown model</span>
															)}
															{status && (
																<span className={cn('inbox-status', status.className)}>
																	{status.label}
																</span>
															)}
														</span>
													</button>
												)}
												{!isRenaming && (
													<div className="inbox-row-actions">
														{section.state === 'unsettled' ? (
															<button
																className="inbox-icon inbox-row-state-action"
																type="button"
																disabled={
																	!mutationsEnabled || busy || !canChange(thread, 'settled')
																}
																aria-label={`Settle ${thread.title ?? 'thread'}`}
																data-tooltip="Settle"
																onClick={() => void change(thread, 'settled')}
															>
																<Check size={14} />
															</button>
														) : (
															<button
																className="inbox-icon inbox-row-state-action"
																type="button"
																disabled={!mutationsEnabled || busy}
																aria-label={`Unsettle ${thread.title ?? 'thread'}`}
																data-tooltip="Unsettle"
																onClick={() => void change(thread, 'unsettled')}
															>
																<RotateCcw size={14} />
															</button>
														)}
													</div>
												)}
											</div>
										);
									})}
									<InboxLoadMore section={section} />
								</>
							)}
						</div>
					</section>
				))}
			</div>

			{notice && (
				<div className="inbox-notice" role="status">
					<span>{notice}</span>
					<button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
						<X size={13} />
					</button>
				</div>
			)}

			<footer className="inbox-footer">
				<button
					className="inbox-menu-item inbox-primary-navigation"
					type="button"
					onClick={onSettings}
				>
					<Settings size={15} />
					Settings
				</button>
				<AppUpdate />
			</footer>

			{menu && menuThread && (
				<>
					<button
						className="fixed inset-0 z-[200] cursor-default"
						type="button"
						aria-label="Close thread actions"
						onClick={closeMenu}
					></button>
					<div
						className="inbox-context-menu"
						style={{ left: `${Math.max(8, menu.x)}px`, top: `${Math.max(8, menu.y)}px` }}
						role="menu"
						tabIndex={-1}
						onKeyDown={navigateMenu}
					>
						{inboxState(menuThread) === 'unsettled' ? (
							<button
								type="button"
								role="menuitem"
								disabled={!mutationsEnabled || busy || !canChange(menuThread, 'settled')}
								onClick={() => void change(menuThread, 'settled')}
							>
								<Check size={14} />
								Settle
							</button>
						) : (
							<button
								type="button"
								role="menuitem"
								disabled={!mutationsEnabled || busy}
								onClick={() => void change(menuThread, 'unsettled')}
							>
								<RotateCcw size={14} />
								Unsettle
							</button>
						)}
						<button
							type="button"
							role="menuitem"
							disabled={!mutationsEnabled}
							onClick={() => beginRename(menuThread)}
						>
							<SquarePen size={14} />
							Rename
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								void navigator.clipboard.writeText(menuThread._id).catch(() => {
									setNotice('Could not copy thread ID.');
								});
								setMenu(null);
							}}
						>
							<Copy size={14} />
							Copy thread ID
						</button>
					</div>
				</>
			)}
		</aside>
	);
}
