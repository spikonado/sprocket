<script lang="ts">
	import { tick, untrack } from 'svelte';
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
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer.svelte';
	import TranscriptPromptMessage from '$lib/components/home/transcript-prompt-message.svelte';
	import MandateApprovalForm from '$lib/components/home/mandate-approval-form.svelte';
	import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure.svelte';
	import WorkTools from '$lib/components/home/work-tools.svelte';
	import WorkDisclosure from '$lib/components/home/work-disclosure.svelte';
	import WorkSectionDetails from '$lib/components/home/work-section-details.svelte';
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

	let {
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
	}: Props = $props();
	let scrollViewport = $state<HTMLDivElement | null>(null);
	let scrollContent = $state<HTMLDivElement | null>(null);
	let stickToBottom = $state(true);
	let lastScrollTop = 0;
	let touchY: number | undefined;
	let requestedBefore: number | undefined;
	let historyPrefetchPagesRemaining = 3;

	const SCROLL_EPSILON_PX = 28;
	const HISTORY_PREFETCH_VIEWPORTS = 3;

	function updateStickToBottom() {
		const viewport = scrollViewport;
		if (!viewport) return;
		if (viewport.scrollTop === lastScrollTop) {
			prefetchOlderHistory();
			return;
		}
		const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
		const movingUp = viewport.scrollTop < lastScrollTop;
		const clampedToBottom = lastScrollTop > bottom && Math.abs(viewport.scrollTop - bottom) < 1;
		lastScrollTop = viewport.scrollTop;
		historyPrefetchPagesRemaining = 3;
		// A shorter scroll range must preserve the reader's existing follow state.
		if (!clampedToBottom) {
			const distanceToBottom = bottom - viewport.scrollTop;
			stickToBottom = !movingUp && distanceToBottom <= SCROLL_EPSILON_PX;
			if (movingUp) stopFollowing();
		}
		prefetchOlderHistory();
	}

	function stopFollowing() {
		stickToBottom = false;
		historyPrefetchPagesRemaining = 3;
		prefetchOlderHistory();
	}

	function prefetchOlderHistory() {
		const viewport = scrollViewport;
		if (
			viewport &&
			nextBefore !== undefined &&
			nextBefore !== requestedBefore &&
			!loadingOlder &&
			onLoadOlder &&
			historyPrefetchPagesRemaining > 0 &&
			viewport.clientHeight > 0 &&
			viewport.scrollTop <= viewport.clientHeight * HISTORY_PREFETCH_VIEWPORTS
		) {
			historyPrefetchPagesRemaining -= 1;
			requestedBefore = nextBefore;
			onLoadOlder();
		}
	}

	$effect(() => {
		void messages;
		void nextBefore;
		void loadingOlder;
		void scrollViewport;
		let active = true;
		untrack(
			() =>
				void tick().then(() => {
					if (active) prefetchOlderHistory();
				})
		);
		return () => {
			active = false;
		};
	});

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

	function isArtifactToolGroup(
		block: AssistantTimelineWorkBlock
	): block is Extract<AssistantTimelineWorkBlock, { type: 'tool-group' }> {
		return (
			block.type === 'tool-group' &&
			(block.toolKey === 'add_artifact' ||
				block.toolKey === 'list_artifacts' ||
				block.toolKey === 'edit_artifact' ||
				block.toolKey === 'create_artifact' ||
				block.toolKey === 'update_artifact')
		);
	}

	function isVisibleWorkBlock(block: AssistantTimelineWorkBlock): boolean {
		return !isArtifactToolGroup(block);
	}

	const sectionKeys = new TranscriptSectionKeys();
	type LiveSection = ReturnType<TranscriptSectionKeys['reconcile']>[number];
	type LiveWorkSection = Extract<LiveSection, { type: 'work' }>;
	type LiveRenderState = ReturnType<typeof liveRenderState>;
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

	function liveWorkState(state: LiveRenderState, section: LiveWorkSection, sectionIndex: number) {
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

	$effect.pre(() =>
		sectionKeys.retain(
			messages.filter((message) => message.kind === 'live').map((message) => message.id)
		)
	);

	let viewerImage = $state<ViewerImage | null>(null);
	let copiedMessageId = $state<string | null>(null);
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null;

	async function copyUserMessage(messageId: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedMessageId = messageId;
			if (copiedTimeout !== null) clearTimeout(copiedTimeout);
			copiedTimeout = setTimeout(() => {
				if (copiedMessageId === messageId) copiedMessageId = null;
				copiedTimeout = null;
			}, 1_500);
		} catch {
			copiedMessageId = null;
		}
	}

	$effect(() => () => {
		if (copiedTimeout !== null) clearTimeout(copiedTimeout);
	});

	function scrollToBottom() {
		const viewport = scrollViewport;
		if (!viewport || !stickToBottom) {
			return;
		}
		const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
		// A scrollbar drag can reach layout before its scroll event. Shrinking content also clamps scrollTop.
		if (viewport.scrollTop + 1 < Math.min(lastScrollTop, bottom)) {
			stickToBottom = false;
			return;
		}
		setScrollTop(viewport, bottom);
	}

	function setScrollTop(viewport: HTMLDivElement, top: number) {
		if (viewport.scrollTop !== top) viewport.scrollTop = top;
		lastScrollTop = viewport.scrollTop;
	}

	function firstVisibleAnchor(viewport: HTMLDivElement) {
		const elements = [
			...viewport.querySelectorAll<HTMLElement>('[data-transcript-anchor], [data-work-detail]')
		].filter((element) => !element.querySelector('[data-work-detail]'));
		const top = viewport.getBoundingClientRect().top;
		let low = 0;
		let high = elements.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (elements[mid].getBoundingClientRect().bottom <= top) low = mid + 1;
			else high = mid;
		}
		return elements[low];
	}

	function beforeDetailChange(follow: boolean) {
		if (!follow) stickToBottom = false;
		const viewport = scrollViewport;
		const anchor = viewport && !stickToBottom ? firstVisibleAnchor(viewport) : undefined;
		const offset = anchor?.getBoundingClientRect().top;
		const top = viewport?.scrollTop;
		return () => {
			if (!viewport || viewport !== scrollViewport) return;
			if (stickToBottom) scrollToBottom();
			else if (anchor?.isConnected && offset !== undefined && viewport.scrollTop === top) {
				setScrollTop(viewport, viewport.scrollTop + anchor.getBoundingClientRect().top - offset);
			}
		};
	}

	$effect.pre(() => {
		void messages;
		void actions;
		void scrollViewport;
		untrack(() => {
			const viewport = scrollViewport;
			if (!viewport) return;
			const anchor = stickToBottom ? undefined : firstVisibleAnchor(viewport);
			const offset = anchor?.getBoundingClientRect().top;
			const scrollTop = viewport.scrollTop;
			const scrollHeight = viewport.scrollHeight;
			void tick().then(() => {
				if (viewport !== scrollViewport) return;
				if (stickToBottom) {
					scrollToBottom();
				} else if (
					anchor?.isConnected &&
					offset !== undefined &&
					viewport.scrollTop === scrollTop
				) {
					setScrollTop(viewport, scrollTop + anchor.getBoundingClientRect().top - offset);
				} else if (anchor && !anchor.isConnected && viewport.scrollTop === scrollTop) {
					setScrollTop(viewport, scrollTop + viewport.scrollHeight - scrollHeight);
				}
			});
		});
	});

	$effect(() => {
		const viewport = scrollViewport;
		const content = scrollContent;
		if (!viewport || !content || !globalThis.ResizeObserver) {
			return;
		}

		const observer = new ResizeObserver(() => {
			scrollToBottom();
			prefetchOlderHistory();
		});
		observer.observe(viewport);
		observer.observe(content);
		return () => {
			observer.disconnect();
		};
	});
</script>

{#snippet liveWorkBlocks(work: LiveWorkState, state: LiveRenderState)}
	{#each work.visibleBlocks as block, blockIndex (`${block.type}-${block.type === 'tool-group' ? block.tools.map((tool) => tool.callId).join(',') : block.id}-${blockIndex}`)}
		{#if block.type === 'reasoning'}
			{@const reasoningInProgress =
				work.workInProgress &&
				work.runningTools.length === 0 &&
				blockIndex === work.visibleBlocks.length - 1}
			<ReasoningDisclosure text={block.text} inProgress={reasoningInProgress} />
		{:else}
			<WorkTools
				tools={block.tools}
				toolKey={block.toolKey}
				inProgress={state.isStreaming}
				commands={state.commands}
			/>
		{/if}
	{/each}
{/snippet}

<div class="relative min-h-0 flex-1">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Keyboard users must be able to page history even when it does not overflow.) -->
	<div
		class="hide-scrollbar h-full overflow-x-hidden overflow-y-auto"
		role="region"
		aria-label="Conversation history"
		tabindex="0"
		bind:this={scrollViewport}
		onscroll={updateStickToBottom}
		onwheel={(event) => {
			if (event.deltaY < 0) stopFollowing();
		}}
		onkeydown={handleHistoryKey}
		ontouchstart={(event) => {
			touchY = event.touches[0]?.clientY;
		}}
		ontouchmove={(event) => {
			const nextY = event.touches[0]?.clientY;
			if (nextY !== undefined && touchY !== undefined && nextY > touchY) {
				stopFollowing();
			}
			touchY = nextY;
		}}
	>
		<div
			bind:this={scrollContent}
			class="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-8"
		>
			{#if currentError}
				<div
					role="alert"
					class="text-destructive mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm"
				>
					{currentError}
				</div>
			{/if}

			{#if runError}
				<div
					role="alert"
					class="mb-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
				>
					{runError}
				</div>
			{/if}

			{#if stale}
				<div
					role="status"
					class="mb-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
				>
					Reconnecting to conversation history.
				</div>
			{/if}

			{#if messages.length === 0}
				{#if emptyStateMessage}
					<div class="flex flex-1 items-center justify-center">
						<div class="max-w-2xl text-center">
							<p class="text-muted-foreground text-sm leading-7">{emptyStateMessage}</p>
						</div>
					</div>
				{/if}
			{:else}
				<div class="transcript-messages space-y-8 pb-14">
					{#each messages as message, messageIndex (message.id)}
						{#if message.kind === 'prompt'}
							<TranscriptPromptMessage
								{message}
								copied={copiedMessageId === message.id}
								{loadAttachment}
								onCopy={() => void copyUserMessage(message.id, message.text ?? '')}
								onOpenImage={(image) => {
									viewerImage = image;
								}}
							/>
						{:else if message.kind === 'work'}
							{@const row = message}
							{@const followingLive = !row.closed
								? followingLiveState(messageIndex, row.runId)
								: undefined}
							{@const firstLiveSection = followingLive?.sections[0]}
							{@const continuation =
								followingLive && firstLiveSection?.type === 'work'
									? liveWorkState(followingLive, firstLiveSection, 0)
									: undefined}
							{@const inProgress = continuation
								? continuation.workInProgress
								: firstLiveSection?.type === 'text'
									? false
									: row.runId === activeRunId && (!row.closed || row.pendingTools > 0)}
							{@const startedAt = earlierTimestamp(row.startedAt, continuation?.timing.startedAtMs)}
							{@const completedAt = laterTimestamp(
								row.completedAt,
								continuation?.timing.completedAtMs ??
									(firstLiveSection?.type === 'text'
										? (firstLiveSection.startedAt ?? undefined)
										: undefined)
							)}
							<div
								data-message-id={message.id}
								data-transcript-anchor={message.id}
								data-message-kind="work"
							>
								<WorkDisclosure {inProgress} startedAtMs={startedAt} completedAtMs={completedAt}>
									{#if loadSectionDetails}
										<WorkSectionDetails
											{row}
											load={loadSectionDetails}
											{inProgress}
											viewport={scrollViewport}
											beforeChange={beforeDetailChange}
										/>
									{/if}
									{#if continuation && followingLive}
										{@render liveWorkBlocks(continuation, followingLive)}
									{/if}
								</WorkDisclosure>
							</div>
						{:else if message.kind === 'approval'}
							{@const row = message}
							{#if row.mandateId && row.approvalUrl}
								<div data-transcript-anchor={message.id}>
									<MandateApprovalForm
										approval={{ mandateId: row.mandateId, approvalUrl: row.approvalUrl }}
									/>
								</div>
							{/if}
						{:else if message.kind === 'text'}
							<div
								data-message-id={message.id}
								data-transcript-anchor={message.id}
								data-message-kind="text"
							>
								<ChatMarkdown
									content={message.text || ' '}
									className="text-foreground"
									{artifacts}
									{onOpenArtifact}
								/>
							</div>
						{:else if message.kind === 'live'}
							{@const live = liveRenderState(message)}
							{@const continuesPreviousWork = followsOpenPersistedWork(messageIndex, message.runId)}
							{@const hasPersistedAssistantContent = live.timeline.some(
								(part) => part.type === 'text' || part.type === 'reasoning'
							)}
							<div
								data-message-id={message.id}
								class="w-full min-w-0"
								role={live.isStreaming ? 'log' : undefined}
								aria-live={live.isStreaming ? 'polite' : undefined}
								aria-atomic="false"
								aria-relevant="additions text"
							>
								<div class="space-y-3">
									{#if !hasPersistedAssistantContent && (message.text || (live.isStreaming && live.timeline.length === 0))}
										<ChatMarkdown
											content={message.text || '...'}
											className="text-foreground"
											{artifacts}
											{onOpenArtifact}
										/>
									{/if}
									{#each live.sections as section, sectionIndex (section.renderKey)}
										{#if section.type === 'text'}
											<div
												data-transcript-anchor={`${message.id}:${assistantTimelinePartKey(section)}`}
											>
												<ChatMarkdown
													content={section.text || ' '}
													className="text-foreground"
													{artifacts}
													{onOpenArtifact}
												/>
											</div>
										{:else}
											{@const work = liveWorkState(live, section, sectionIndex)}
											{#if work.visibleBlocks.length > 0 || work.workInProgress || work.runningTools.length > 0}
												<div
													class="space-y-3"
													data-transcript-anchor={`${message.id}:${section.renderKey}`}
												>
													{#if !(continuesPreviousWork && sectionIndex === 0)}
														<WorkDisclosure
															inProgress={work.workInProgress}
															startedAtMs={work.timing.startedAtMs}
															completedAtMs={work.timing.completedAtMs}
														>
															{@render liveWorkBlocks(work, live)}
														</WorkDisclosure>
													{/if}
													{#each work.approvals as approval (approval.mandateId)}
														<MandateApprovalForm {approval} />
													{/each}
													{#if work.runningTools.length > 0}
														<WorkTools
															tools={work.runningTools}
															running={true}
															inProgress={live.isStreaming}
															commands={live.commands}
														/>
													{/if}
												</div>
											{/if}
										{/if}
									{/each}
									{#if !live.isStreaming && message.runStartedAt > 0 && message.runCompletedAt !== undefined}
										<p class="text-muted-foreground text-sm">
											Worked for {formatElapsedDuration(
												Math.max(
													0,
													Math.floor((message.runCompletedAt - message.runStartedAt) / 1000)
												)
											)}
										</p>
									{/if}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="transcript-fade pointer-events-none absolute inset-x-0 bottom-0 h-16"></div>
</div>

<ImageViewer
	image={viewerImage}
	onClose={() => {
		viewerImage = null;
	}}
/>

<style>
	.transcript-messages > [data-message-kind='text']:has(+ [data-message-kind='work']),
	.transcript-messages > [data-message-kind='work']:has(+ [data-message-kind='text']) {
		margin-block-end: 0.5rem;
	}
</style>
