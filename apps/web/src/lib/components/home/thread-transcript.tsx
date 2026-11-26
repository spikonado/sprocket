import {
	Fragment,
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import type { MarkdownImageScope } from '$lib/chat/markdown-images';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { workSummary } from '$lib/chat/work-summary';
import ChatMarkdown from '$lib/components/chat-markdown';
import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer';
import { useCopyFeedback } from '$lib/components/use-copy-feedback';
import TranscriptPromptMessage from '$lib/components/home/transcript-prompt-message';
import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure';
import WorkTools from '$lib/components/home/work-tools';
import WorkDisclosure from '$lib/components/home/work-disclosure';
import WorkSectionDetails from '$lib/components/home/work-section-details';
import {
	useTranscriptRows,
	useTranscriptExpanded,
	type TranscriptStore
} from '$lib/home/transcript-store';
import { TranscriptActiveRunContext, useTranscriptRunRow } from '$lib/home/transcript-run';
import type { Id } from '@convex/_generated/dataModel';
import type { Project } from '$lib/types/sprocket';
import '$lib/components/home/thread-transcript.css';

type Props = {
	store: TranscriptStore;
	activeRunId: string | null | undefined;
	project: Project | null;
	cwd?: string;
	emptyStateMessage?: string;
	loadingOlder?: boolean;
	nextBefore?: number;
	onLoadOlder?: () => void;
	loadAttachment?: (fileId: Id<'files'>) => Promise<string | null>;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
	renderRunFooter?: (runId: string) => ReactNode;
};

const NO_ARTIFACTS: ArtifactEntry[] = [];
const SCROLL_EPSILON_PX = 28;
const HISTORY_PREFETCH_VIEWPORTS = 3;
const HISTORY_PREFETCH_PAGES = 3;

type ScrollAnchor = {
	anchor: HTMLElement;
	offset: number;
	scrollTop: number;
	scrollHeight: number;
};

type RowProps = Pick<Props, 'store' | 'loadAttachment' | 'onOpenArtifact'> & {
	rowId: string;
	imageScope: MarkdownImageScope;
	artifacts: ArtifactEntry[];
	onOpenImage: (image: ViewerImage) => void;
};

const TranscriptRow = memo(function TranscriptRow({
	store,
	rowId,
	imageScope,
	loadAttachment,
	artifacts,
	onOpenArtifact,
	onOpenImage
}: RowProps) {
	const row = useTranscriptRunRow(store, rowId);
	const summary = row?.kind === 'work' ? workSummary(row.toolCounts) : undefined;

	const [expanded, setExpanded] = useTranscriptExpanded(
		store,
		rowId,
		row?.kind === 'work' && row.running && summary !== undefined
	);

	const { copied, markCopied, resetCopied } = useCopyFeedback<string>();

	if (!row) return null;

	async function copyPrompt(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			markCopied(rowId);
		} catch {
			resetCopied();
		}
	}

	if (row.kind === 'prompt') {
		return (
			<TranscriptPromptMessage
				message={row}
				imageScope={imageScope}
				copied={copied === rowId}
				loadAttachment={loadAttachment}
				onCopy={() => void copyPrompt(row.text)}
				onOpenImage={onOpenImage}
			/>
		);
	}

	return (
		<div data-message-id={row.id} data-transcript-anchor={row.id} data-message-kind={row.kind}>
			{row.kind === 'text' ? (
				<div
					role={row.running ? 'log' : undefined}
					aria-live={row.running ? 'polite' : undefined}
					aria-atomic="false"
					aria-relevant="additions text"
				>
					<ChatMarkdown
						imageScope={imageScope}
						content={row.text || ' '}
						className="text-foreground"
						artifacts={artifacts}
						onOpenArtifact={onOpenArtifact}
						openLinksInNewTab
					/>
				</div>
			) : row.kind === 'work' ? (
				<WorkDisclosure
					inProgress={row.running}
					summary={summary}
					expanded={expanded}
					onToggle={() => setExpanded(!expanded)}
				>
					<WorkSectionDetails store={store} rowId={rowId} />
				</WorkDisclosure>
			) : row.kind === 'reasoning' ? (
				<ReasoningDisclosure store={store} rowId={rowId} />
			) : (
				<WorkTools store={store} rowId={rowId} />
			)}
		</div>
	);
});

export default function ThreadTranscript({
	store,
	activeRunId,
	project,
	cwd,
	emptyStateMessage = project
		? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
		: 'Add a project to begin.',
	loadingOlder = false,
	nextBefore,
	onLoadOlder,
	loadAttachment,
	artifacts = NO_ARTIFACTS,
	onOpenArtifact,
	renderRunFooter
}: Props) {
	const rowIds = useTranscriptRows(store);

	const imageScope = useMemo(
		() => ({ workspacePath: cwd ?? project?.workspacePath }),
		[cwd, project?.workspacePath]
	);

	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const lastScrollTopRef = useRef(0);
	const touchYRef = useRef<number | undefined>(undefined);
	const requestedBeforeRef = useRef<number | undefined>(undefined);
	const historyPrefetchPagesRef = useRef(HISTORY_PREFETCH_PAGES);
	const [viewerImage, setViewerImage] = useState<ViewerImage | null>(null);

	function firstVisibleAnchor(root: HTMLDivElement) {
		const elements = [
			...root.querySelectorAll<HTMLElement>('[data-transcript-anchor], [data-work-detail]')
		].filter((element) => !element.querySelector('[data-work-detail]'));

		const top = root.getBoundingClientRect().top;
		let low = 0;
		let high = elements.length;

		while (low < high) {
			const mid = Math.floor((low + high) / 2);

			if (elements[mid].getBoundingClientRect().bottom <= top) low = mid + 1;
			else high = mid;
		}

		return elements[low];
	}

	function setScrollTop(root: HTMLDivElement, top: number) {
		if (root.scrollTop !== top) root.scrollTop = top;
		lastScrollTopRef.current = root.scrollTop;
	}

	function scrollToBottom() {
		const root = viewportRef.current;

		if (!root || !stickToBottomRef.current) return;
		const bottom = Math.max(0, root.scrollHeight - root.clientHeight);

		// A scrollbar drag can reach layout before its scroll event. Shrinking content also clamps scrollTop.
		if (root.scrollTop + 1 < Math.min(lastScrollTopRef.current, bottom)) {
			stickToBottomRef.current = false;

			return;
		}

		setScrollTop(root, bottom);
	}

	function prefetchOlderHistory() {
		const root = viewportRef.current;

		if (
			root &&
			nextBefore !== undefined &&
			nextBefore !== requestedBeforeRef.current &&
			!loadingOlder &&
			onLoadOlder &&
			historyPrefetchPagesRef.current > 0 &&
			root.clientHeight > 0 &&
			root.scrollTop <= root.clientHeight * HISTORY_PREFETCH_VIEWPORTS
		) {
			historyPrefetchPagesRef.current -= 1;
			requestedBeforeRef.current = nextBefore;
			onLoadOlder();
		}
	}

	function stopFollowing() {
		stickToBottomRef.current = false;
		historyPrefetchPagesRef.current = HISTORY_PREFETCH_PAGES;
		prefetchOlderHistory();
	}

	function updateStickToBottom() {
		const root = viewportRef.current;

		if (!root) return;

		if (root.scrollTop === lastScrollTopRef.current) {
			prefetchOlderHistory();

			return;
		}

		const bottom = Math.max(0, root.scrollHeight - root.clientHeight);
		const movingUp = root.scrollTop < lastScrollTopRef.current;

		const clampedToBottom =
			lastScrollTopRef.current > bottom && Math.abs(root.scrollTop - bottom) < 1;

		lastScrollTopRef.current = root.scrollTop;
		historyPrefetchPagesRef.current = HISTORY_PREFETCH_PAGES;

		if (!clampedToBottom) {
			stickToBottomRef.current = !movingUp && bottom - root.scrollTop <= SCROLL_EPSILON_PX;

			if (movingUp) stopFollowing();
		}

		prefetchOlderHistory();
	}

	function handleHistoryKey(event: KeyboardEvent) {
		if (
			event.target instanceof Element &&
			event.target.closest('input, textarea, button, [contenteditable="true"]')
		)
			return;

		if (
			event.key === 'ArrowUp' ||
			event.key === 'PageUp' ||
			event.key === 'Home' ||
			(event.key === ' ' && event.shiftKey)
		)
			stopFollowing();
	}

	const scrollToBottomRef = useRef(scrollToBottom);
	const prefetchOlderHistoryRef = useRef(prefetchOlderHistory);
	useLayoutEffect(() => {
		scrollToBottomRef.current = scrollToBottom;
		prefetchOlderHistoryRef.current = prefetchOlderHistory;
	});

	useLayoutEffect(() => {
		if (!loadingOlder) requestedBeforeRef.current = undefined;
	}, [loadingOlder]);

	useLayoutEffect(() => {
		if (rowIds.length === 0) {
			if (nextBefore === undefined) {
				requestedBeforeRef.current = undefined;
				historyPrefetchPagesRef.current = HISTORY_PREFETCH_PAGES;
			}

			stickToBottomRef.current = true;
		}

		prefetchOlderHistoryRef.current();
	}, [rowIds, nextBefore, loadingOlder, viewport]);

	useLayoutEffect(() => {
		const content = contentRef.current;

		if (!viewport || !content || !globalThis.ResizeObserver) return;

		const observer = new ResizeObserver(() => {
			scrollToBottomRef.current();
			prefetchOlderHistoryRef.current();
		});

		observer.observe(viewport);
		observer.observe(content);

		return () => observer.disconnect();
	}, [viewport]);

	// Read the existing DOM before prepending older rows.
	const renderedRowsRef = useRef(rowIds);
	const anchorRef = useRef<ScrollAnchor | null>(null);

	if (renderedRowsRef.current !== rowIds) {
		renderedRowsRef.current = rowIds;
		const root = viewportRef.current;
		const anchor = root && !stickToBottomRef.current ? firstVisibleAnchor(root) : undefined;
		anchorRef.current =
			root && anchor
				? {
						anchor,
						offset: anchor.getBoundingClientRect().top,
						scrollTop: root.scrollTop,
						scrollHeight: root.scrollHeight
					}
				: null;
	}

	useLayoutEffect(() => {
		const root = viewportRef.current;

		if (!root) return;

		if (stickToBottomRef.current) {
			scrollToBottomRef.current();

			return;
		}

		const snapshot = anchorRef.current;
		anchorRef.current = null;

		if (!snapshot) return;
		const { anchor, offset, scrollTop, scrollHeight } = snapshot;

		if (anchor.isConnected && root.scrollTop === scrollTop) {
			setScrollTop(root, scrollTop + anchor.getBoundingClientRect().top - offset);
		} else if (!anchor.isConnected && root.scrollTop === scrollTop) {
			setScrollTop(root, scrollTop + root.scrollHeight - scrollHeight);
		}
	}, [rowIds]);

	const setViewportNode = useCallback((node: HTMLDivElement | null) => {
		viewportRef.current = node;
		setViewport(node);
	}, []);

	return (
		<TranscriptActiveRunContext value={activeRunId}>
			<div className="relative min-h-0 flex-1">
				<div
					className="hide-scrollbar h-full overflow-x-hidden overflow-y-auto"
					role="region"
					aria-label="Conversation history"
					tabIndex={0}
					ref={setViewportNode}
					onScroll={updateStickToBottom}
					onWheel={(event) => {
						if (event.deltaY < 0) stopFollowing();
					}}
					onKeyDown={handleHistoryKey}
					onTouchStart={(event) => {
						touchYRef.current = event.touches[0]?.clientY;
					}}
					onTouchMove={(event) => {
						const nextY = event.touches[0]?.clientY;

						if (nextY !== undefined && touchYRef.current !== undefined && nextY > touchYRef.current)
							stopFollowing();
						touchYRef.current = nextY;
					}}
				>
					<div
						ref={contentRef}
						className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col px-4 pt-12 pb-8"
					>
						{rowIds.length === 0 ? (
							emptyStateMessage ? (
								<div className="flex flex-1 items-center justify-center">
									<div className="max-w-2xl text-center">
										<p className="text-muted-foreground text-sm leading-7">{emptyStateMessage}</p>
									</div>
								</div>
							) : null
						) : (
							<div className="transcript-messages space-y-8 pb-14">
								{rowIds.map((rowId, index) => {
									const row = store.getRow(rowId);
									const next = store.getRow(rowIds[index + 1]);

									const endsSettledRun =
										row &&
										activeRunId !== undefined &&
										row.kind !== 'prompt' &&
										row.runId !== activeRunId &&
										next?.runId !== row.runId;

									return (
										<Fragment key={rowId}>
											<TranscriptRow
												store={store}
												rowId={rowId}
												imageScope={imageScope}
												loadAttachment={loadAttachment}
												artifacts={artifacts}
												onOpenArtifact={onOpenArtifact}
												onOpenImage={setViewerImage}
											/>
											{endsSettledRun ? renderRunFooter?.(row.runId) : null}
										</Fragment>
									);
								})}
							</div>
						)}
					</div>
				</div>
				<div className="transcript-fade pointer-events-none absolute inset-x-0 bottom-0 h-16"></div>
				<ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
			</div>
		</TranscriptActiveRunContext>
	);
}
