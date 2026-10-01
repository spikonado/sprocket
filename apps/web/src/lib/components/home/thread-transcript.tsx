import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import {
	assistantTimelinePartKey,
	buildAssistantTimeline,
	buildCommandSessionCommandMap,
	buildOpenExecCommandSessions,
	groupAssistantTimeline,
	groupAssistantTimelineSections,
	isAssistantResponseStreaming,
	partitionWorkSectionTools,
	workSectionTimingAnchor,
	type AssistantTimelineTool,
	type AssistantTimelineWorkBlock
} from '$lib/chat/assistant-timeline';
import { TranscriptSectionKeys } from '$lib/chat/transcript-section-keys';
import ChatMarkdown from '$lib/components/chat-markdown';
import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer';
import TranscriptPromptMessage from '$lib/components/home/transcript-prompt-message';
import MandateApprovalForm from '$lib/components/home/mandate-approval-form';
import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure';
import WorkTools from '$lib/components/home/work-tools';
import WorkDisclosure from '$lib/components/home/work-disclosure';
import WorkSectionDetails from '$lib/components/home/work-section-details';
import type {
	TranscriptDisplayRow,
	TranscriptDisplayDetails,
	TranscriptDetailCursor,
	LiveTranscriptMessage
} from '$lib/types/sprocket';
import { mandateApprovals } from '$lib/chat/mandate';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { formatElapsedDuration } from '$lib/format';
import type {
	ExecutorJob,
	TranscriptMessage,
	Project,
	MessageAttachment
} from '$lib/types/sprocket';
import '$lib/components/home/thread-transcript.css';

type Props = {
	currentError: string | null;
	runError: string | null;
	messages: TranscriptMessage[];
	actions: ExecutorJob[];
	activeRunId: TranscriptMessage['runId'] | null;
	project: Project | null;
	emptyStateMessage?: string;
	stale?: boolean;
	loadingOlder?: boolean;
	nextBefore?: number;
	onLoadOlder?: () => void;
	loadAttachment?: (storageId: MessageAttachment['storageId']) => Promise<string | null>;
	loadSectionDetails?: (
		row: TranscriptDisplayRow,
		cursor: TranscriptDetailCursor,
		signal: AbortSignal
	) => Promise<TranscriptDisplayDetails>;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
};

const SCROLL_EPSILON_PX = 28;

const HISTORY_PREFETCH_VIEWPORTS = 3;

const HISTORY_PREFETCH_PAGES = 3;

type ScrollAnchor = {
	anchor: HTMLElement;
	offset: number;
	scrollTop: number;
	scrollHeight: number;
};

function isArtifactToolGroup(block: AssistantTimelineWorkBlock) {
	return (
		block.type === 'tool-group' &&
		(block.toolKey === 'add_artifact' ||
			block.toolKey === 'list_artifacts' ||
			block.toolKey === 'edit_artifact' ||
			block.toolKey === 'create_artifact' ||
			block.toolKey === 'update_artifact')
	);
}

function isVisibleWorkBlock(block: AssistantTimelineWorkBlock) {
	return !isArtifactToolGroup(block);
}

function earlierTimestamp(left: number | undefined, right: number | undefined) {
	if (left === undefined) return right;

	if (right === undefined) return left;

	return Math.min(left, right);
}

function laterTimestamp(left: number | undefined, right: number | undefined) {
	if (left === undefined) return right;

	if (right === undefined) return left;

	return Math.max(left, right);
}

export default function ThreadTranscript({
	currentError,
	runError,
	messages,
	actions,
	activeRunId,
	project,
	emptyStateMessage = project
		? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
		: 'Add a project to begin.',
	stale = false,
	loadingOlder = false,
	nextBefore,
	onLoadOlder,
	loadAttachment,
	loadSectionDetails,
	artifacts = [],
	onOpenArtifact
}: Props) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const lastScrollTopRef = useRef(0);
	const touchYRef = useRef<number | undefined>(undefined);
	const requestedBeforeRef = useRef<number | undefined>(undefined);
	const historyPrefetchPagesRef = useRef(HISTORY_PREFETCH_PAGES);
	const [viewerImage, setViewerImage] = useState<ViewerImage | null>(null);
	const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const sectionKeysRef = useRef<TranscriptSectionKeys | null>(null);

	if (!sectionKeysRef.current) sectionKeysRef.current = new TranscriptSectionKeys();
	const sectionKeys = sectionKeysRef.current;

	type LiveRenderState = ReturnType<typeof liveRenderState>;

	type LiveSection = ReturnType<TranscriptSectionKeys['reconcile']>[number];

	type LiveWorkState = ReturnType<typeof liveWorkState>;

	function liveRenderState(message: LiveTranscriptMessage) {
		const messageActions = actions.filter(
			(job) =>
				job.runId === message.runId &&
				message.parts.some((part) => part.type === 'tool-call' && part.callId === job.callId)
		);

		const timeline = buildAssistantTimeline(message.parts, messageActions);
		const tools = timeline.filter((item): item is AssistantTimelineTool => item.type === 'tool');

		const sections = sectionKeys.reconcile(
			message.id,
			groupAssistantTimelineSections(groupAssistantTimeline(timeline))
		);

		const isStreaming = isAssistantResponseStreaming(message, activeRunId);

		return {
			timeline,
			sections,
			isStreaming,
			commands: buildCommandSessionCommandMap(tools),
			openSessions: buildOpenExecCommandSessions(tools, isStreaming)
		};
	}

	function liveWorkState(
		state: LiveRenderState,
		section: Extract<LiveSection, { type: 'work' }>,
		sectionIndex: number
	) {
		const { settledBlocks, runningTools } = partitionWorkSectionTools(
			section.blocks,
			state.isStreaming,
			state.openSessions
		);

		const visibleBlocks = settledBlocks.filter(isVisibleWorkBlock);

		const workInProgress =
			state.isStreaming && (sectionIndex === state.sections.length - 1 || runningTools.length > 0);

		const nextSection = state.sections[sectionIndex + 1];

		return {
			visibleBlocks,
			runningTools,
			workInProgress,
			approvals: visibleBlocks.flatMap((block) =>
				block.type === 'tool-group' ? mandateApprovals(block.tools) : []
			),
			timing: workSectionTimingAnchor(section, {
				inProgress: workInProgress,
				endedAt: nextSection?.type === 'text' ? (nextSection.startedAt ?? undefined) : undefined
			})
		};
	}

	function followingLiveState(messageIndex: number, runId: TranscriptDisplayRow['runId']) {
		for (const message of messages.slice(messageIndex + 1)) {
			if (message.kind === 'approval' && message.runId === runId) continue;

			return message.kind === 'live' && message.runId === runId
				? liveRenderState(message)
				: undefined;
		}

		return undefined;
	}

	function followsOpenPersistedWork(messageIndex: number, runId: LiveTranscriptMessage['runId']) {
		for (let index = messageIndex - 1; index >= 0; index -= 1) {
			const message = messages[index];

			if (message.kind === 'approval' && message.runId === runId) continue;

			return message.kind === 'work' && message.runId === runId && !message.closed;
		}

		return false;
	}

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

		if (!root || !stickToBottomRef.current) {
			return;
		}

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

		// A shorter scroll range must preserve the reader's existing follow state.
		if (!clampedToBottom) {
			const distanceToBottom = bottom - root.scrollTop;
			stickToBottomRef.current = !movingUp && distanceToBottom <= SCROLL_EPSILON_PX;

			if (movingUp) stopFollowing();
		}

		prefetchOlderHistory();
	}

	function handleHistoryKey(event: KeyboardEvent) {
		if (
			event.target instanceof Element &&
			event.target.closest('input, textarea, button, [contenteditable="true"]')
		) {
			return;
		}

		if (
			event.key === 'ArrowUp' ||
			event.key === 'PageUp' ||
			event.key === 'Home' ||
			(event.key === ' ' && event.shiftKey)
		) {
			stopFollowing();
		}
	}

	function beforeDetailChange(follow: boolean) {
		if (!follow) stickToBottomRef.current = false;
		const root = viewportRef.current;
		const anchor = root && !stickToBottomRef.current ? firstVisibleAnchor(root) : undefined;
		const offset = anchor?.getBoundingClientRect().top;
		const top = root?.scrollTop;

		return () => {
			if (!root || root !== viewportRef.current) return;

			if (stickToBottomRef.current) scrollToBottom();
			else if (anchor?.isConnected && offset !== undefined && root.scrollTop === top) {
				setScrollTop(root, root.scrollTop + anchor.getBoundingClientRect().top - offset);
			}
		};
	}

	const scrollToBottomRef = useRef(scrollToBottom);
	const prefetchOlderHistoryRef = useRef(prefetchOlderHistory);
	useLayoutEffect(() => {
		scrollToBottomRef.current = scrollToBottom;
		prefetchOlderHistoryRef.current = prefetchOlderHistory;
	});

	useLayoutEffect(() => {
		prefetchOlderHistoryRef.current();
	}, [messages, nextBefore, loadingOlder, viewport]);

	useLayoutEffect(() => {
		const root = viewport;
		const content = contentRef.current;

		if (!root || !content || !globalThis.ResizeObserver) {
			return;
		}

		const observer = new ResizeObserver(() => {
			scrollToBottomRef.current();
			prefetchOlderHistoryRef.current();
		});

		observer.observe(root);
		observer.observe(content);

		return () => {
			observer.disconnect();
		};
	}, [viewport]);

	// Anchor capture must read the DOM before this render commits, matching `$effect.pre`.
	const renderedMessagesRef = useRef(messages);
	const renderedActionsRef = useRef(actions);
	const anchorRef = useRef<ScrollAnchor | null>(null);

	if (renderedMessagesRef.current !== messages || renderedActionsRef.current !== actions) {
		renderedMessagesRef.current = messages;
		renderedActionsRef.current = actions;
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
	}, [messages, actions]);

	async function copyUserMessage(messageId: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedMessageId(messageId);

			if (copiedTimeoutRef.current !== null) clearTimeout(copiedTimeoutRef.current);
			copiedTimeoutRef.current = setTimeout(() => {
				setCopiedMessageId((current) => (current === messageId ? null : current));
				copiedTimeoutRef.current = null;
			}, 1_500);
		} catch {
			setCopiedMessageId(null);
		}
	}

	useLayoutEffect(() => {
		return () => {
			if (copiedTimeoutRef.current !== null) clearTimeout(copiedTimeoutRef.current);
		};
	}, []);

	useLayoutEffect(() => {
		sectionKeys.retain(
			messages.filter((message) => message.kind === 'live').map((message) => message.id)
		);
	}, [messages, sectionKeys]);

	const setViewportNode = useCallback((node: HTMLDivElement | null) => {
		viewportRef.current = node;
		setViewport(node);
	}, []);

	function renderWorkBlocks(work: LiveWorkState, state: LiveRenderState) {
		return work.visibleBlocks.map((block, blockIndex) => {
			const renderKey = `${block.type}-${
				block.type === 'tool-group' ? block.tools.map((tool) => tool.callId).join(',') : block.id
			}-${blockIndex}`;

			if (block.type === 'reasoning') {
				const reasoningInProgress =
					work.workInProgress &&
					work.runningTools.length === 0 &&
					blockIndex === work.visibleBlocks.length - 1;

				return (
					<ReasoningDisclosure key={renderKey} text={block.text} inProgress={reasoningInProgress} />
				);
			}

			return (
				<WorkTools
					key={renderKey}
					tools={block.tools}
					toolKey={block.toolKey}
					inProgress={state.isStreaming}
					commands={state.commands}
				/>
			);
		});
	}

	function renderMessage(message: TranscriptMessage, messageIndex: number): ReactNode {
		if (message.kind === 'prompt') {
			return (
				<TranscriptPromptMessage
					key={message.id}
					message={message}
					copied={copiedMessageId === message.id}
					loadAttachment={loadAttachment}
					onCopy={() => void copyUserMessage(message.id, message.text ?? '')}
					onOpenImage={setViewerImage}
				/>
			);
		}

		if (message.kind === 'work') {
			const row = message;
			const followingLive = !row.closed ? followingLiveState(messageIndex, row.runId) : undefined;
			const firstLiveSection = followingLive?.sections[0];

			const continuation =
				followingLive && firstLiveSection?.type === 'work'
					? liveWorkState(followingLive, firstLiveSection, 0)
					: undefined;

			const inProgress = continuation
				? continuation.workInProgress
				: firstLiveSection?.type === 'text'
					? false
					: row.runId === activeRunId && (!row.closed || row.pendingTools > 0);

			const startedAt = earlierTimestamp(row.startedAt, continuation?.timing.startedAtMs);

			const completedAt = laterTimestamp(
				row.completedAt,
				continuation?.timing.completedAtMs ??
					(firstLiveSection?.type === 'text'
						? (firstLiveSection.startedAt ?? undefined)
						: undefined)
			);

			return (
				<div
					key={message.id}
					data-message-id={message.id}
					data-transcript-anchor={message.id}
					data-message-kind="work"
				>
					<WorkDisclosure
						inProgress={inProgress}
						startedAtMs={startedAt}
						completedAtMs={completedAt}
					>
						{loadSectionDetails ? (
							<WorkSectionDetails
								row={row}
								load={loadSectionDetails}
								inProgress={inProgress}
								viewport={viewport}
								beforeChange={beforeDetailChange}
							/>
						) : null}
						{continuation && followingLive ? renderWorkBlocks(continuation, followingLive) : null}
					</WorkDisclosure>
				</div>
			);
		}

		if (message.kind === 'approval') {
			if (!message.mandateId || !message.approvalUrl) return null;

			return (
				<div key={message.id} data-transcript-anchor={message.id}>
					<MandateApprovalForm
						approval={{ mandateId: message.mandateId, approvalUrl: message.approvalUrl }}
					/>
				</div>
			);
		}

		if (message.kind === 'text') {
			return (
				<div
					key={message.id}
					data-message-id={message.id}
					data-transcript-anchor={message.id}
					data-message-kind="text"
				>
					<ChatMarkdown
						content={message.text || ' '}
						className="text-foreground"
						artifacts={artifacts}
						onOpenArtifact={onOpenArtifact}
						openLinksInNewTab
					/>
				</div>
			);
		}

		if (message.kind !== 'live') return null;

		const live = liveRenderState(message);
		const continuesPreviousWork = followsOpenPersistedWork(messageIndex, message.runId);

		const hasPersistedAssistantContent = live.timeline.some(
			(part) => part.type === 'text' || part.type === 'reasoning'
		);

		return (
			<div
				key={message.id}
				data-message-id={message.id}
				className="w-full min-w-0"
				role={live.isStreaming ? 'log' : undefined}
				aria-live={live.isStreaming ? 'polite' : undefined}
				aria-atomic="false"
				aria-relevant="additions text"
			>
				<div className="space-y-3">
					{!hasPersistedAssistantContent &&
					(message.text || (live.isStreaming && live.timeline.length === 0)) ? (
						<ChatMarkdown
							content={message.text || '...'}
							className="text-foreground"
							artifacts={artifacts}
							onOpenArtifact={onOpenArtifact}
							openLinksInNewTab
						/>
					) : null}
					{live.sections.map((section, sectionIndex) => {
						if (section.type === 'text') {
							return (
								<div
									key={section.renderKey}
									data-transcript-anchor={`${message.id}:${assistantTimelinePartKey(section)}`}
								>
									<ChatMarkdown
										content={section.text || ' '}
										className="text-foreground"
										artifacts={artifacts}
										onOpenArtifact={onOpenArtifact}
										openLinksInNewTab
									/>
								</div>
							);
						}

						const work = liveWorkState(live, section, sectionIndex);

						if (
							work.visibleBlocks.length === 0 &&
							!work.workInProgress &&
							work.runningTools.length === 0
						) {
							return null;
						}

						return (
							<div
								key={section.renderKey}
								className="space-y-3"
								data-transcript-anchor={`${message.id}:${section.renderKey}`}
							>
								{!(continuesPreviousWork && sectionIndex === 0) ? (
									<WorkDisclosure
										inProgress={work.workInProgress}
										startedAtMs={work.timing.startedAtMs}
										completedAtMs={work.timing.completedAtMs}
									>
										{renderWorkBlocks(work, live)}
									</WorkDisclosure>
								) : null}
								{work.approvals.map((approval) => (
									<MandateApprovalForm key={approval.mandateId} approval={approval} />
								))}
								{work.runningTools.length > 0 ? (
									<WorkTools
										tools={work.runningTools}
										running
										inProgress={live.isStreaming}
										commands={live.commands}
									/>
								) : null}
							</div>
						);
					})}
					{!live.isStreaming && message.runStartedAt > 0 && message.runCompletedAt !== undefined ? (
						<p className="text-muted-foreground text-sm">
							{`Worked for ${formatElapsedDuration(
								Math.max(0, Math.floor((message.runCompletedAt - message.runStartedAt) / 1000))
							)}`}
						</p>
					) : null}
				</div>
			</div>
		);
	}

	return (
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

					if (nextY !== undefined && touchYRef.current !== undefined && nextY > touchYRef.current) {
						stopFollowing();
					}

					touchYRef.current = nextY;
				}}
			>
				<div
					ref={contentRef}
					className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-8"
				>
					{currentError ? (
						<div
							role="alert"
							className="text-destructive mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm"
						>
							{currentError}
						</div>
					) : null}

					{runError ? (
						<div
							role="alert"
							className="mb-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
						>
							{runError}
						</div>
					) : null}

					{stale ? (
						<div
							role="status"
							className="mb-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
						>
							Reconnecting to conversation history.
						</div>
					) : null}

					{messages.length === 0 ? (
						emptyStateMessage ? (
							<div className="flex flex-1 items-center justify-center">
								<div className="max-w-2xl text-center">
									<p className="text-muted-foreground text-sm leading-7">{emptyStateMessage}</p>
								</div>
							</div>
						) : null
					) : (
						<div className="transcript-messages space-y-8 pb-14">
							{messages.map((message, messageIndex) => renderMessage(message, messageIndex))}
						</div>
					)}
				</div>
			</div>

			<div className="transcript-fade pointer-events-none absolute inset-x-0 bottom-0 h-16"></div>
			<ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
		</div>
	);
}
