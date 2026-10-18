import ArtifactMenu from '$lib/components/artifact-menu';
import {
	FileCode,
	Files,
	FileText,
	Fullscreen,
	Globe,
	Maximize2,
	Minimize2,
	PanelRight,
	Plus,
	type LucideIcon
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import ArtifactDisplay from '$lib/components/home/artifact-display';
import BrowserView, { type BrowserApi } from '$lib/components/home/browser-view';
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

const VIEWS: { tab: Exclude<SidePanelTab, 'launcher'>; label: string; icon: LucideIcon }[] = [
	{ tab: 'artifacts', label: 'Artifacts', icon: Files },
	{ tab: 'browser', label: 'Browser', icon: Globe }
];

const ICON_BUTTON =
	'text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring rounded-md p-1.5 transition focus-visible:ring-2 focus-visible:outline-none';

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
	const current = VIEWS.find((view) => view.tab === tab) ?? null;
	const viewRef = useRef<HTMLElement>(null);

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
			id="side-panel"
			className={`bg-background flex h-full min-h-0 w-full flex-col ${expanded ? '' : 'border-hairline border-l'}`}
		>
			<div
				className={`flex h-10 shrink-0 items-center gap-1 px-2 ${current ? 'border-hairline border-b' : ''}`}
			>
				{current ? (
					<span className="bg-muted text-foreground inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium">
						<current.icon className="size-3.5" aria-hidden="true" />
						{current.label}
					</span>
				) : null}
				<button
					type="button"
					className={ICON_BUTTON}
					onClick={() => onTabChange('launcher')}
					aria-label="New tab"
					title="New tab"
				>
					<Plus className="size-4" aria-hidden="true" />
				</button>
				<div className="flex-1"></div>
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
				<button
					type="button"
					className={ICON_BUTTON}
					onClick={onClose}
					aria-label="Close panel"
					title="Close panel"
				>
					<PanelRight className="size-4" aria-hidden="true" />
				</button>
			</div>
			<section
				ref={viewRef}
				tabIndex={-1}
				aria-label={current?.label ?? 'Side panel'}
				className="flex min-h-0 flex-1 flex-col focus:outline-none"
			>
				{tab === 'launcher' ? (
					<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
						<ul aria-label="Open a view" className="grid w-full max-w-84 grid-cols-2 gap-4">
							{VIEWS.map((view) => (
								<li key={view.tab}>
									<button
										type="button"
										onClick={() => {
											onTabChange(view.tab);
											viewRef.current?.focus();
										}}
										className="border-hairline text-muted-foreground hover:bg-hover-fill hover:text-foreground focus-visible:ring-ring flex h-32 w-full flex-col items-center justify-center gap-3 rounded-xl border transition focus-visible:ring-2 focus-visible:outline-none"
									>
										<view.icon className="size-5" strokeWidth={1.5} aria-hidden="true" />
										<span className="text-sm">{view.label}</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				) : tab === 'browser' ? (
					<BrowserView browserApi={browserApi} />
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
			</section>
		</aside>
	);
}
