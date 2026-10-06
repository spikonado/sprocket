import ArtifactMenu from '$lib/components/artifact-menu';
import { Expand, FileCode, FileText, Fullscreen, Globe, Shrink, X } from 'lucide-react';
import { useEffect, type KeyboardEvent } from 'react';
import ArtifactDisplay from '$lib/components/home/artifact-display';
import BrowserLiveView, { type BrowserApi } from '$lib/components/home/browser-live-view';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import type { SidePanelTab } from '$lib/chat/side-panel';
import type { ArtifactType } from '@convex/lib/validators';

type Props = {
	artifacts: ArtifactEntry[];
	workspacePath?: string;
	onDeleteArtifact?: (artifactId: string) => Promise<void>;
	selectedKey: string | null;
	tab: SidePanelTab;
	browserApi: BrowserApi | null;
	/** When true, the panel covers the full Sprocket workspace UI (not browser fullscreen). */
	expanded: boolean;
	stale?: boolean;
	error?: string | null;
	onSelect: (key: string) => void;
	onBack: () => void;
	onTabChange: (tab: SidePanelTab) => void;
	/** Enter true browser fullscreen for a single artifact (content only). */
	onOpenFullscreen: (key: string) => void;
	onToggleExpanded: () => void;
	onClose: () => void;
};

const TYPE_ICONS = {
	markdown: FileText,
	html: Globe,
	react: FileCode
} as const satisfies Record<ArtifactType, typeof FileCode>;

const TABS: { id: SidePanelTab; label: string }[] = [
	{ id: 'artifacts', label: 'Artifacts' },
	{ id: 'live', label: 'Live view' }
];

export default function SidePanel({
	artifacts,
	workspacePath,
	onDeleteArtifact,
	selectedKey,
	tab,
	browserApi,
	expanded,
	stale = false,
	error = null,
	onSelect,
	onBack,
	onTabChange,
	onOpenFullscreen,
	onToggleExpanded,
	onClose
}: Props) {
	const selected = artifacts.find((artifact) => artifact.key === selectedKey) ?? null;

	// Roving tabindex for the WAI-ARIA tabs keyboard pattern.
	function focusTab(tabId: SidePanelTab) {
		document.getElementById(`side-panel-tab-${tabId}`)?.focus();
	}

	function onTabKeydown(event: KeyboardEvent) {
		const current = TABS.findIndex((item) => item.id === tab);
		let next = -1;

		if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
		else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = TABS.length - 1;

		if (next === -1) return;
		event.preventDefault();
		onTabChange(TABS[next].id);
		// Focus moves with selection (automatic activation).
		focusTab(TABS[next].id);
	}

	useEffect(() => {
		if (!expanded) return;

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
			className={`bg-background flex h-full min-h-0 w-full flex-col ${expanded ? '' : 'border-l'}`}
		>
			<div className="flex items-center gap-1 border-b px-2 py-1.5">
				<div role="tablist" aria-label="Side panel views" className="flex items-center gap-1">
					{TABS.map((item) => (
						<button
							key={item.id}
							type="button"
							role="tab"
							id={`side-panel-tab-${item.id}`}
							aria-controls="side-panel-tabpanel"
							aria-selected={tab === item.id}
							tabIndex={tab === item.id ? 0 : -1}
							className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
								tab === item.id
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:text-foreground'
							}`}
							onClick={() => onTabChange(item.id)}
							onKeyDown={onTabKeydown}
						>
							{item.label}
						</button>
					))}
				</div>
				<div className="flex-1"></div>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
					onClick={onToggleExpanded}
					aria-label={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
					title={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
					aria-pressed={expanded}
				>
					{expanded ? (
						<Shrink className="size-4" aria-hidden="true" />
					) : (
						<Expand className="size-4" aria-hidden="true" />
					)}
				</button>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
					onClick={onClose}
					aria-label="Close panel"
				>
					<X className="size-4" aria-hidden="true" />
				</button>
			</div>
			<div
				role="tabpanel"
				id="side-panel-tabpanel"
				aria-labelledby={`side-panel-tab-${tab}`}
				className="flex min-h-0 flex-1 flex-col"
			>
				{tab === 'live' ? (
					<BrowserLiveView browserApi={browserApi} />
				) : (
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
													onDelete={
														onDeleteArtifact ? () => onDeleteArtifact(artifact.key) : undefined
													}
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
													className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
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
				)}
			</div>
		</aside>
	);
}
