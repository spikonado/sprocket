import {
	Fragment,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import {
	assistantTimelinePartKey,
	buildAssistantTimeline,
	buildCommandSessionCommandMap,
	groupAssistantTimeline,
	groupAssistantTimelineSections,
	isAssistantResponseStreaming,
	partitionWorkSectionTools,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import { TranscriptSectionKeys } from '$lib/chat/transcript-section-keys';
import ChatMarkdown from '$lib/components/chat-markdown';
import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer';
import TranscriptPromptMessage from '$lib/components/home/transcript-prompt-message';
import ReasoningDisclosure, { ReasoningText } from '$lib/components/home/reasoning-disclosure';
import SaveCardButton from '$lib/components/home/save-card-button';
import WorkTools from '$lib/components/home/work-tools';
import WorkDisclosure from '$lib/components/home/work-disclosure';
import WorkSectionDetails from '$lib/components/home/work-section-details';
import type {
	TranscriptDisplayRow,
	TranscriptDisplayDetails,
	TranscriptDetailCursor,
	LiveTranscriptMessage
} from '$lib/types/sprocket';
import { jsonObjectString } from '$lib/chat/json-fields';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { mergeWorkToolCounts, workSummary, workToolCounts } from '$lib/chat/work-summary';
import type {
	ExecutorJob,
	TranscriptMessage,
	Project,
	MessageAttachment
} from '$lib/types/sprocket';
import '$lib/components/home/thread-transcript.css';

type Props = {
	messages: TranscriptMessage[];
	actions: ExecutorJob[];
	activeRunId: TranscriptMessage['runId'] | null;
	project: Project | null;
	cwd?: string;
	emptyStateMessage?: string;
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
	renderRunFooter?: (runId: TranscriptMessage['runId']) => ReactNode;
};

const SCROLL_EPSILON_PX = 28;

function needsSavedCard(tool: AssistantTimelineTool) {
	return (
		(tool.job?.kind ?? tool.name) === 'card_checkout' &&
		jsonObjectString(tool.output, 'status') === 'card_required'
	);
}

const HISTORY_PREFETCH_VIEWPORTS = 3;

const HISTORY_PREFETCH_PAGES = 3;

type ScrollAnchor = {
	anchor: HTMLElement;
	offset: number;
	scrollTop: number;
	scrollHeight: number;
};

export default function ThreadTranscript({
	messages,
	actions,
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
	loadSectionDetails,
	artifacts = [],
	onOpenArtifact,
	renderRunFooter
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

	const [rememberedCommands, setRememberedCommands] = useState<ReadonlyMap<string, string>>(
		() => new Map()
	);

	const rememberCommands = useCallback((added: ReadonlyMap<string, string>) => {
		if (added.size === 0) return;
		setRememberedCommands((previous) => {
			if ([...added].every(([session, command]) => previous.get(session) === command)) {
				return previous;
			}

			return new Map([...previous, ...added]);
		});
	}, []);

	const liveCommands = useMemo(() => {
		const tools = [
			...buildAssistantTimeline([], actions),
			...messages.flatMap((message) =>
				message.kind === 'live' ? buildAssistantTimeline(message.parts, []) : []
			)
		].filter((item) => item.type === 'tool');

		return buildCommandSessionCommandMap(tools);
	}, [messages, actions]);

	useLayoutEffect(() => rememberCommands(liveCommands), [liveCommands, rememberCommands]);

	const commands = useMemo(
		() => new Map([...rememberedCommands, ...liveCommands]),
		[rememberedCommands, liveCommands]
	);

	const loadWorkDetails = useMemo<Props['loadSectionDetails']>(
		() =>
			loadSectionDetails
				? async (row, cursor, signal) => {
						const details = await loadSectionDetails(row, cursor, signal);

						if (!signal.aborted) {
							const tools = buildAssistantTimeline(details.parts, []).filter(
								(item) => item.type === 'tool'
							);

							rememberCommands(buildCommandSessionCommandMap(tools));
						}

						return details;
					}
				: undefined,
		[loadSectionDetails, rememberCommands]
	);

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

		const sections = sectionKeys.reconcile(
			message.id,
			groupAssistantTimelineSections(groupAssistantTimeline(timeline))
		);

		const isStreaming = isAssistantResponseStreaming(message, activeRunId);

		return {
			timeline,
			sections,
			isStreaming
		};
	}

	function liveWorkState(
		state: LiveRenderState,
		section: Extract<LiveSection, { type: 'work' }>,
		sectionIndex: number,
		excludedCallIds?: ReadonlySet<string>
	) {
		const { settledBlocks, runningTools } = partitionWorkSectionTools(
			section.blocks,
			state.isStreaming
		);

		const workInProgress = state.isStreaming && sectionIndex === state.sections.length - 1;

		return {
			settledBlocks,
			lastBlock: section.blocks.at(-1),
			runningTools,
			workInProgress,
			needsSavedCard: settledBlocks.some(
				(block) => block.type === 'tool-group' && block.tools.some(needsSavedCard)
			),
			toolCounts: workToolCounts(section.blocks, excludedCallIds)
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

	function beforeDetailChange() {
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

	function renderWorkBlocks(work: LiveWorkState, state: LiveRenderState, reasoningOnly: boolean) {
		return (
			<>
				{work.settledBlocks.map((block, blockIndex) => {
					const renderKey = `${block.type}-${
						block.type === 'tool-group'
							? block.tools.map((tool) => tool.callId).join(',')
							: block.id
					}-${blockIndex}`;

					if (block.type === 'reasoning') {
						if (reasoningOnly) return <ReasoningText key={renderKey} text={block.text} />;

						const reasoningInProgress =
							work.workInProgress && work.runningTools.length === 0 && block === work.lastBlock;

						return (
							<ReasoningDisclosure
								key={renderKey}
								text={block.text}
								inProgress={reasoningInProgress}
							/>
						);
					}

					return (
						<WorkTools
							key={renderKey}
							tools={block.tools}
							inProgress={state.isStreaming}
							commands={commands}
						/>
					);
				})}
				{work.runningTools.length > 0 ? (
					<WorkTools tools={work.runningTools} inProgress={state.isStreaming} commands={commands} />
				) : null}
			</>
		);
	}

	function renderMessage(message: TranscriptMessage, messageIndex: number): ReactNode {
		const imageScope = { workspacePath: cwd ?? project?.workspacePath };

		if (message.kind === 'prompt') {
			return (
				<TranscriptPromptMessage
					key={message.id}
					message={message}
					imageScope={imageScope}
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
					? liveWorkState(followingLive, firstLiveSection, 0, new Set(row.unpersistedToolCallIds))
					: undefined;

			const inProgress = continuation
				? continuation.workInProgress
				: firstLiveSection?.type === 'text'
					? false
					: row.runId === activeRunId && !row.closed;

			const summary = workSummary(mergeWorkToolCounts(row.toolCounts, continuation?.toolCounts));

			return (
				<div
					key={message.id}
					data-message-id={message.id}
					data-transcript-anchor={message.id}
					data-message-kind="work"
				>
					<WorkDisclosure inProgress={inProgress} summary={summary}>
						{loadWorkDetails ? (
							<WorkSectionDetails
								row={row}
								load={loadWorkDetails}
								commands={commands}
								inProgress={!row.closed && row.runId === activeRunId}
								reasoningOnly={summary === undefined}
								viewport={viewport}
								beforeChange={beforeDetailChange}
							/>
						) : null}
						{continuation && followingLive
							? renderWorkBlocks(continuation, followingLive, summary === undefined)
							: null}
					</WorkDisclosure>
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
						imageScope={imageScope}
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
							imageScope={imageScope}
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
										imageScope={imageScope}
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
							work.settledBlocks.length === 0 &&
							!work.workInProgress &&
							work.runningTools.length === 0
						) {
							return null;
						}

						const summary = workSummary(work.toolCounts);

						return (
							<div
								key={section.renderKey}
								className="space-y-3"
								data-transcript-anchor={`${message.id}:${section.renderKey}`}
							>
								{!(continuesPreviousWork && sectionIndex === 0) ? (
									<WorkDisclosure inProgress={work.workInProgress} summary={summary}>
										{renderWorkBlocks(work, live, summary === undefined)}
									</WorkDisclosure>
								) : null}
								{work.needsSavedCard ? <SaveCardButton /> : null}
							</div>
						);
					})}
				</div>
			</div>
		);
	}

	function endsSettledRun(messageIndex: number) {
		const message = messages[messageIndex];

		return (
			renderRunFooter !== undefined &&
			message.kind !== 'prompt' &&
			message.runId !== activeRunId &&
			messages[messageIndex + 1]?.runId !== message.runId
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
					className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col px-4 py-8"
				>
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
							{messages.flatMap((message, messageIndex) => [
								renderMessage(message, messageIndex),
								endsSettledRun(messageIndex) ? (
									<Fragment key={`${message.runId}:footer`}>
										{renderRunFooter?.(message.runId)}
									</Fragment>
								) : null
							])}
						</div>
					)}
				</div>
			</div>

			<div className="transcript-fade pointer-events-none absolute inset-x-0 bottom-0 h-16"></div>
			<ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
		</div>
	);
}
