<script lang="ts">
	import { Check, Copy, LoaderCircle } from '@lucide/svelte';
	import { tick, untrack } from 'svelte';
	import {
		assistantTimelineToolError,
		assistantTimelineToolFailureKind,
		buildAssistantTimeline,
		buildCommandSessionCommandMap,
		buildOpenExecCommandSessions,
		groupAssistantTimeline,
		groupAssistantTimelineSections,
		isAssistantResponseStreaming,
		partitionWorkSectionTools,
		workSectionTimingAnchor,
		workSectionTimingIndexes,
		type AssistantTimelineTool,
		type AssistantTimelineWorkBlock
	} from '$lib/chat/assistant-timeline';
	import { toolKindIcon, toolLogIcon } from '$lib/chat/tool-icons';
	import {
		changedFileCount,
		fullToolSummary,
		toolGroupLabel,
		toolItemSummary,
		toolSummaryClass
	} from '$lib/chat/tool-summaries';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer.svelte';
	import TranscriptAttachment from '$lib/components/home/transcript-attachment.svelte';
	import MandateApprovalForm from '$lib/components/home/mandate-approval-form.svelte';
	import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure.svelte';
	import ToolCallsDisclosure from '$lib/components/home/tool-calls-disclosure.svelte';
	import WorkDisclosure from '$lib/components/home/work-disclosure.svelte';
	import { mandateApprovals } from '$lib/chat/mandate';
	import { formatElapsedDuration } from '$lib/format';
	import type { ExecutorJob, ThreadMessage, Project, MessageAttachment } from '$lib/types/sprocket';

	type Props = {
		currentError: string | null;
		runError: string | null;
		messages: ThreadMessage[];
		actions: ExecutorJob[];
		activeRunId: ThreadMessage['runId'] | null;
		project: Project | null;
		remoteChangeNotice?: string | null;
		onDismissRemoteChangeNotice?: () => void;
		emptyStateMessage?: string;
		stale?: boolean;
		loadingOlder?: boolean;
		hasOlder?: boolean;
		onLoadOlder?: () => void;
		loadAttachment?: (imageUploadId: MessageAttachment['imageUploadId']) => Promise<string | null>;
		onLoadDetails?: (message: ThreadMessage) => Promise<void>;
	};

	let {
		currentError,
		runError,
		messages,
		actions,
		activeRunId,
		project,
		remoteChangeNotice = null,
		onDismissRemoteChangeNotice,
		emptyStateMessage = project
			? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
			: 'Add a project to begin.',
		stale = false,
		loadingOlder = false,
		hasOlder = false,
		onLoadOlder,
		loadAttachment,
		onLoadDetails
	}: Props = $props();
	const firstPromptMessageId = $derived(messages.find((message) => message.type === 'prompt')?._id);
	let scrollViewport = $state<HTMLDivElement | null>(null);
	let scrollContent = $state<HTMLDivElement | null>(null);
	let stickToBottom = $state(true);
	let adjustingScroll = false;

	const SCROLL_EPSILON_PX = 28;
	const LOAD_OLDER_THRESHOLD_PX = 2_000;

	function updateStickToBottom() {
		const viewport = scrollViewport;
		if (!viewport) {
			return;
		}
		if (adjustingScroll) {
			return;
		}
		const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		stickToBottom = distanceToBottom <= SCROLL_EPSILON_PX;
		if (hasOlder && !loadingOlder && onLoadOlder && viewport.scrollTop <= LOAD_OLDER_THRESHOLD_PX) {
			onLoadOlder();
		}
	}

	function isArtifactToolGroup(
		block: AssistantTimelineWorkBlock
	): block is Extract<AssistantTimelineWorkBlock, { type: 'tool-group' }> {
		return (
			block.type === 'tool-group' &&
			(block.toolKey === 'create_artifact' || block.toolKey === 'update_artifact')
		);
	}

	function isVisibleWorkBlock(block: AssistantTimelineWorkBlock): boolean {
		return !isArtifactToolGroup(block);
	}

	const userMessageClass =
		'user-bubble w-fit max-w-[33rem] rounded-xl border px-5 py-3.5 text-[15.5px] leading-7 text-foreground';

	let viewerImage = $state<ViewerImage | null>(null);

	let copiedMessageId = $state<string | null>(null);
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null;

	async function copyUserMessage(messageId: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedMessageId = messageId;
			if (copiedTimeout !== null) {
				clearTimeout(copiedTimeout);
			}
			copiedTimeout = setTimeout(() => {
				if (copiedMessageId === messageId) {
					copiedMessageId = null;
				}
				copiedTimeout = null;
			}, 1_500);
		} catch {
			copiedMessageId = null;
		}
	}

	$effect(() => {
		return () => {
			if (copiedTimeout !== null) {
				clearTimeout(copiedTimeout);
			}
		};
	});

	function scrollToBottom() {
		const viewport = scrollViewport;
		if (!viewport || !stickToBottom) {
			return;
		}
		viewport.scrollTop = viewport.scrollHeight;
	}

	function firstVisibleMessage(viewport: HTMLDivElement) {
		const elements = viewport.querySelectorAll<HTMLElement>('[data-message-id]');
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

	$effect.pre(() => {
		void messages;
		void actions;
		untrack(() => {
			const viewport = scrollViewport;
			if (!viewport) return;
			const anchor = stickToBottom ? undefined : firstVisibleMessage(viewport);
			const offset = anchor?.getBoundingClientRect().top;
			const scrollTop = viewport.scrollTop;
			void tick().then(() => {
				if (viewport !== scrollViewport) return;
				adjustingScroll = true;
				if (stickToBottom) {
					scrollToBottom();
				} else if (
					anchor?.isConnected &&
					offset !== undefined &&
					viewport.scrollTop === scrollTop
				) {
					viewport.scrollTop += anchor.getBoundingClientRect().top - offset;
				}
				requestAnimationFrame(() => {
					adjustingScroll = false;
				});
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
			adjustingScroll = true;
			scrollToBottom();
			requestAnimationFrame(() => {
				adjustingScroll = false;
			});
		});
		observer.observe(viewport);
		observer.observe(content);
		return () => {
			observer.disconnect();
		};
	});
</script>

<div class="relative min-h-0 flex-1">
	<div
		class="hide-scrollbar h-full overflow-auto"
		bind:this={scrollViewport}
		onscroll={updateStickToBottom}
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
					Showing a local copy while Sprocket reconnects to history.
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
				<div class="space-y-8 pb-14">
					{#each messages as message (message._id)}
						{#if message.type === 'prompt'}
							<div data-message-id={message._id} class="flex flex-col items-end gap-1.5">
								{#if message.attachments.length}
									<ul
										class="flex max-w-132 flex-wrap justify-end gap-2"
										aria-label="Attached images"
									>
										{#each message.attachments as attachment (attachment.imageUploadId)}
											<li>
												<TranscriptAttachment
													{attachment}
													{loadAttachment}
													onOpen={(image) => {
														viewerImage = image;
													}}
												/>
											</li>
										{/each}
									</ul>
								{/if}
								{#if message.text || !message.attachments.length}
									<div class={userMessageClass}>
										<ChatMarkdown content={message.text || ' '} className="text-foreground" />
									</div>
								{/if}
								{#if message.text}
									<button
										type="button"
										class="text-muted-foreground hover:text-muted-foreground inline-flex size-6 items-center justify-center rounded-md transition"
										aria-label={copiedMessageId === message._id ? 'Copied' : 'Copy message'}
										onclick={() => {
											void copyUserMessage(message._id, message.text);
										}}
									>
										{#if copiedMessageId === message._id}
											<Check class="size-3.5" aria-hidden="true" />
										{:else}
											<Copy class="size-3.5" aria-hidden="true" />
										{/if}
									</button>
								{/if}
								{#if remoteChangeNotice && message._id === firstPromptMessageId}
									<div
										role="status"
										class="w-full max-w-132 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-800 dark:text-amber-200"
									>
										<div class="flex items-start justify-between gap-3">
											<p class="min-w-0 flex-1 leading-6">{remoteChangeNotice}</p>
											{#if onDismissRemoteChangeNotice}
												<button
													type="button"
													class="shrink-0 text-xs font-medium tracking-[-0.01em] text-amber-800/80 underline-offset-2 hover:text-amber-900 hover:underline dark:text-amber-200/80 dark:hover:text-amber-100"
													onclick={onDismissRemoteChangeNotice}
												>
													Dismiss
												</button>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{:else}
							{@const messageActions = actions.filter((job) => job.runId === message.runId)}
							{@const timeline = buildAssistantTimeline(message.parts, messageActions)}
							{@const timelineTools = timeline.filter(
								(item): item is AssistantTimelineTool => item.type === 'tool'
							)}
							{@const sessionCommands = buildCommandSessionCommandMap(timelineTools)}
							{@const blocks = groupAssistantTimeline(timeline)}
							{@const sections = groupAssistantTimelineSections(blocks)}
							{@const { workIndexBySectionIndex, priorCompletedAtByWorkIndex } =
								workSectionTimingIndexes(sections)}
							{@const isStreaming = isAssistantResponseStreaming(message, activeRunId)}
							{@const openSessions = buildOpenExecCommandSessions(timelineTools, isStreaming)}
							{@const hasPersistedAssistantContent = timeline.some(
								(part) => part.type === 'text' || part.type === 'reasoning'
							)}
							<div
								data-message-id={message._id}
								class="w-full min-w-0"
								role={isStreaming ? 'log' : undefined}
								aria-live={isStreaming ? 'polite' : undefined}
								aria-atomic="false"
								aria-relevant="additions text"
							>
								<div class="space-y-3">
									{#if !hasPersistedAssistantContent && (message.text || (isStreaming && timeline.length === 0))}
										<ChatMarkdown content={message.text || '...'} className="text-foreground" />
									{/if}
									{#each sections as section, sectionIndex (`${section.type}-${section.type === 'work' ? section.key : section.id}-${sectionIndex}`)}
										{#if section.type === 'text'}
											<ChatMarkdown content={section.text || ' '} className="text-foreground" />
										{:else}
											{@const { settledBlocks, runningTools } = partitionWorkSectionTools(
												section.blocks,
												isStreaming,
												openSessions
											)}
											{@const visibleBlocks = settledBlocks.filter(isVisibleWorkBlock)}
											{@const sectionMandateApprovals = visibleBlocks.flatMap((block) =>
												block.type === 'tool-group' ? mandateApprovals(block.tools) : []
											)}
											{@const workInProgress =
												isStreaming &&
												(sectionIndex === sections.length - 1 || runningTools.length > 0)}
											{@const workSectionOrder = workIndexBySectionIndex[sectionIndex] ?? 0}
											{@const timing = workSectionTimingAnchor(section, {
												inProgress: workInProgress,
												workSectionIndex: workSectionOrder,
												runStartedAt: message.runStartedAt,
												runCompletedAt: message.runCompletedAt,
												priorWorkCompletedAtMs: priorCompletedAtByWorkIndex[workSectionOrder]
											})}
											{#if visibleBlocks.length > 0 || workInProgress || runningTools.length > 0}
												<WorkDisclosure
													inProgress={workInProgress}
													startedAtMs={timing.startedAtMs}
													completedAtMs={timing.completedAtMs}
													detailsKey={`${message.sourceNumbers?.join(',')}:${message.detailsLoaded}`}
													onExpand={() => onLoadDetails?.(message)}
												>
													{#each visibleBlocks as block, blockIndex (`${block.type}-${block.type === 'tool-group' ? block.tools.map((tool) => tool.callId).join(',') : block.id}-${blockIndex}`)}
														{#if block.type === 'reasoning'}
															{@const reasoningInProgress =
																workInProgress &&
																runningTools.length === 0 &&
																blockIndex === visibleBlocks.length - 1}
															<ReasoningDisclosure
																text={block.text}
																inProgress={reasoningInProgress}
															/>
														{:else}
															<ToolCallsDisclosure
																label={toolGroupLabel(block.toolKey)}
																icon={toolKindIcon(block.toolKey)}
																tools={block.tools}
																defaultExpanded={block.toolKey === 'apply_patch'
																	? changedFileCount(block.tools) <= 2
																	: undefined}
															>
																{#snippet toolRow(tool)}
																	{@const toolError = assistantTimelineToolError(tool, isStreaming)}
																	{@const toolFailureKind = assistantTimelineToolFailureKind(
																		tool,
																		isStreaming
																	)}
																	{@const toolSummary = toolItemSummary(tool, sessionCommands)}
																	{#if toolError && toolFailureKind}
																		<details class="min-w-0">
																			<summary
																				class="min-w-0 cursor-pointer text-left"
																				title={fullToolSummary(tool, isStreaming, sessionCommands)}
																			>
																				<span class={toolSummaryClass(tool)}>{toolSummary}</span>
																				<span
																					class={toolFailureKind === 'failed'
																						? 'text-destructive'
																						: 'text-amber-800 dark:text-amber-200'}
																				>
																					({toolFailureKind})
																				</span>
																			</summary>
																			<p
																				class="mt-1.5 text-xs leading-5 wrap-break-word whitespace-pre-wrap {toolFailureKind ===
																				'failed'
																					? 'text-destructive'
																					: 'text-amber-800 dark:text-amber-200'}"
																				role="status"
																			>
																				{toolError}
																			</p>
																		</details>
																	{:else}
																		<p
																			class={`min-w-0 ${toolSummaryClass(tool)}`}
																			title={fullToolSummary(tool, isStreaming, sessionCommands)}
																		>
																			{toolSummary}
																		</p>
																	{/if}
																{/snippet}
															</ToolCallsDisclosure>
														{/if}
													{/each}
												</WorkDisclosure>
											{/if}
											{#each sectionMandateApprovals as approval (approval.mandateId)}
												<MandateApprovalForm {approval} />
											{/each}
											{#if runningTools.length > 0}
												<ToolCallsDisclosure
													label="Running"
													icon={LoaderCircle}
													iconClass="animate-spin"
													tools={runningTools}
													defaultExpanded={true}
												>
													{#snippet toolRow(tool)}
														{@const ToolIcon = toolLogIcon(tool)}
														{@const toolSummary = toolItemSummary(tool, sessionCommands)}
														<p
															class="flex min-w-0 items-start gap-1.5"
															title={`${toolSummary} (running)`}
														>
															<ToolIcon
																class="text-muted-foreground mt-1.5 size-3 shrink-0"
																aria-hidden="true"
															/>
															<span class={toolSummaryClass(tool)}>{toolSummary}</span>
														</p>
													{/snippet}
												</ToolCallsDisclosure>
											{/if}
										{/if}
									{/each}
									{#if !isStreaming && message.runCompletedAt !== undefined}
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
	[data-message-id] {
		content-visibility: auto;
		contain-intrinsic-size: auto 300px;
	}
</style>
