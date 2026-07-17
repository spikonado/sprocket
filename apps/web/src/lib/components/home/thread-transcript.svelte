<script lang="ts">
	import { Check, Copy } from '@lucide/svelte';
	import { tick } from 'svelte';
	import { isJsonObject, type JsonValue } from '$convex/lib/json';
	import {
		assistantTimelineToolError,
		assistantTimelineToolFailureKind,
		buildAssistantTimeline,
		groupAssistantTimeline,
		groupAssistantTimelineSections,
		isAssistantTimelineToolRunning,
		partitionWorkSectionTools,
		workSectionTimingAnchor,
		workSectionTimingIndexes,
		type AssistantTimelineTool
	} from '$lib/chat/assistant-timeline';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import ImageViewer, { type ViewerImage } from '$lib/components/image-viewer.svelte';
	import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure.svelte';
	import ToolCallsDisclosure from '$lib/components/home/tool-calls-disclosure.svelte';
	import WorkDisclosure from '$lib/components/home/work-disclosure.svelte';
	import { formatElapsedDuration } from '$lib/format';
	import type { ExecutorJob, ThreadMessage, WorkspaceSession } from '$lib/types/sprocket';

	type Props = {
		currentError: string | null;
		runError: string | null;
		messages: ThreadMessage[];
		actions: ExecutorJob[];
		workspaceSession: WorkspaceSession | null;
		emptyStateMessage?: string;
		emptyStateHint?: string | null;
	};

	let {
		currentError,
		runError,
		messages,
		actions,
		workspaceSession,
		emptyStateMessage = workspaceSession
			? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands.'
			: 'Add a project to begin.',
		emptyStateHint = null
	}: Props = $props();
	let scrollViewport = $state<HTMLDivElement | null>(null);
	let stickToBottom = $state(true);

	const SCROLL_EPSILON_PX = 28;

	function updateStickToBottom() {
		const viewport = scrollViewport;
		if (!viewport) {
			return;
		}
		const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		stickToBottom = distanceToBottom <= SCROLL_EPSILON_PX;
	}

	function titleizeSnakeCase(value: string) {
		return value
			.split('_')
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(' ');
	}

	function toolGroupLabel(toolKey: string) {
		switch (toolKey) {
			case 'exec_command':
				return 'Ran Commands';
			case 'write_stdin':
				return 'Monitored Commands';
			case 'apply_patch':
				return 'Changed Files';
			case 'get_workspace_instructions':
				return 'Read Instructions';
			case 'check_docs':
				return 'Checked Docs';
			default:
				return titleizeSnakeCase(toolKey);
		}
	}

	function describeExecCommandOptions(input: JsonValue | undefined) {
		if (!isJsonObject(input)) {
			return '';
		}

		const details: string[] = [];
		if (
			typeof input.workdir === 'string' &&
			input.workdir.trim().length > 0 &&
			input.workdir !== '.'
		) {
			details.push(`cwd ${input.workdir}`);
		}

		return details.length > 0 ? ` (${details.join(', ')})` : '';
	}

	/** Detail line for a tool row — no type prefix (that lives on the dropdown label). */
	function summarizeTool(name: string, input: JsonValue | undefined) {
		const fields = isJsonObject(input) ? input : undefined;

		switch (name) {
			case 'exec_command':
				return typeof fields?.cmd === 'string'
					? `${fields.cmd}${describeExecCommandOptions(input)}`
					: 'Command';
			case 'write_stdin':
				return typeof fields?.sessionId === 'string'
					? `Session ${fields.sessionId}`
					: 'Command session';
			case 'apply_patch':
				return summarizePatchInput(input) ?? 'Patch';
			case 'get_workspace_instructions':
				return 'Workspace instructions';
			case 'check_docs':
				return typeof fields?.query === 'string'
					? fields.query
					: typeof fields?.path === 'string'
						? fields.path
						: 'Docs';
			default:
				return titleizeSnakeCase(name);
		}
	}

	function summarizePaths(paths: string[]) {
		return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`;
	}

	function summarizePatchInput(input: JsonValue | undefined) {
		if (!isJsonObject(input) || typeof input.patch !== 'string') {
			return null;
		}

		const paths = input.patch.split('\n').flatMap((line) => {
			if (!line.startsWith('diff --git ')) {
				return [];
			}
			const quotedMarker = ' "b/';
			const plainMarker = ' b/';
			const marker = line.lastIndexOf(quotedMarker);
			if (marker >= 0) {
				return [line.slice(marker + quotedMarker.length).replace(/"$/, '')];
			}
			const plainMarkerIndex = line.lastIndexOf(plainMarker);
			return plainMarkerIndex >= 0 ? [line.slice(plainMarkerIndex + plainMarker.length)] : [];
		});
		const uniquePaths = [...new Set(paths)];
		return uniquePaths.length > 0 ? summarizePaths(uniquePaths) : null;
	}

	function summarizePatchResult(result: JsonValue | undefined) {
		if (!isJsonObject(result) || !Array.isArray(result.changes)) {
			return null;
		}

		const paths = result.changes.flatMap((change) =>
			isJsonObject(change) && typeof change.path === 'string' ? [change.path] : []
		);
		if (paths.length === 0) {
			return null;
		}
		return summarizePaths(paths);
	}

	function toolItemSummary(toolLog: AssistantTimelineTool) {
		if (toolLog.job) {
			if (toolLog.job.kind === 'apply_patch') {
				const patchSummary = summarizePatchResult(toolLog.job.result);
				if (patchSummary) {
					return patchSummary;
				}
			}
			return summarizeTool(toolLog.job.kind, toolLog.job.payload);
		}
		return summarizeTool(toolLog.name, toolLog.input);
	}

	function fullToolSummary(toolLog: AssistantTimelineTool, isStreaming: boolean) {
		const summary = toolItemSummary(toolLog);
		if (isAssistantTimelineToolRunning(toolLog, isStreaming)) {
			return `${summary} (running)`;
		}
		const error = assistantTimelineToolError(toolLog);
		return error ? `${summary} (${error})` : summary;
	}

	const userMessageClass =
		'w-fit max-w-[33rem] rounded-xl border border-white/7 bg-[linear-gradient(180deg,rgba(39,39,42,0.96),rgba(28,28,30,0.96))] px-5 py-3.5 text-[15.5px] leading-7 text-slate-100';

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

	$effect(() => {
		void messages;
		void actions;
		if (!stickToBottom) {
			return;
		}

		void tick().then(scrollToBottom);
	});

	$effect(() => {
		const viewport = scrollViewport;
		if (!viewport || typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(() => {
			scrollToBottom();
		});
		observer.observe(viewport);
		return () => {
			observer.disconnect();
		};
	});
</script>

<div class="relative min-h-0 flex-1">
	<div
		class="hide-scrollbar h-full overflow-auto [overflow-anchor:none]"
		bind:this={scrollViewport}
		onscroll={updateStickToBottom}
	>
		<div class="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-8">
			{#if currentError}
				<div
					role="alert"
					class="mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
				>
					{currentError}
				</div>
			{/if}

			{#if runError}
				<div
					role="alert"
					class="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
				>
					{runError}
				</div>
			{/if}

			{#if messages.length === 0}
				<div class="flex flex-1 items-center justify-center">
					<div class="max-w-2xl text-center">
						<p class="text-sm leading-7 text-slate-500">{emptyStateMessage}</p>
						{#if emptyStateHint}
							<p class="mt-3 text-xs tracking-[0.16em] text-slate-600 uppercase">
								{emptyStateHint}
							</p>
						{/if}
					</div>
				</div>
			{:else}
				<div class="space-y-8 pb-14">
					{#each messages as message (message._id)}
						{#if message.type === 'prompt'}
							<div class="flex flex-col items-end gap-1.5">
								{#if message.attachments.length}
									<ul
										class="flex max-w-[33rem] flex-wrap justify-end gap-2"
										aria-label="Attached images"
									>
										{#each message.attachments as attachment (attachment.imageUploadId)}
											<li>
												{#if attachment.url}
													{@const url = attachment.url}
													<button
														type="button"
														class="block size-14 cursor-zoom-in overflow-hidden rounded-xl border border-white/10 transition hover:border-white/25 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
														aria-label="View {attachment.name}"
														title={attachment.name}
														onclick={() => {
															viewerImage = {
																url,
																name: attachment.name,
																mediaType: attachment.mediaType
															};
														}}
													>
														<img src={url} alt="" loading="lazy" class="size-full object-cover" />
													</button>
												{:else}
													<span
														class="inline-flex items-center rounded-xl border border-white/7 bg-white/4 px-3 py-2 text-xs text-slate-400"
													>
														{attachment.name} (unavailable)
													</span>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}
								{#if message.text || !message.attachments.length}
									<div class={userMessageClass}>
										<ChatMarkdown content={message.text || ' '} className="text-slate-100" />
									</div>
								{/if}
								{#if message.text}
									<button
										type="button"
										class="inline-flex size-6 items-center justify-center rounded-md text-slate-600 transition hover:text-slate-400"
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
							</div>
						{:else}
							{@const messageActions = actions.filter((job) => job.runId === message.runId)}
							{@const timeline = buildAssistantTimeline(message.parts ?? [], messageActions)}
							{@const blocks = groupAssistantTimeline(timeline)}
							{@const sections = groupAssistantTimelineSections(blocks)}
							{@const { workIndexBySectionIndex, priorCompletedAtByWorkIndex } =
								workSectionTimingIndexes(sections)}
							{@const isStreaming =
								message.runStatus !== 'completed' &&
								message.runStatus !== 'failed' &&
								message.runStatus !== 'cancelled'}
							{@const hasPersistedAssistantContent = timeline.some(
								(part) => part.type === 'text' || part.type === 'reasoning'
							)}
							<div
								class="w-full min-w-0"
								role={isStreaming ? 'log' : undefined}
								aria-live={isStreaming ? 'polite' : undefined}
								aria-atomic="false"
								aria-relevant="additions text"
							>
								<div class="space-y-3">
									{#if !hasPersistedAssistantContent && (message.text || (isStreaming && timeline.length === 0))}
										<ChatMarkdown content={message.text || '...'} className="text-slate-200" />
									{/if}
									{#each sections as section, sectionIndex (`${section.type}-${section.type === 'work' ? section.key : section.id}-${sectionIndex}`)}
										{#if section.type === 'text'}
											<ChatMarkdown content={section.text || ' '} className="text-slate-200" />
										{:else}
											{@const { settledBlocks, runningTools } = partitionWorkSectionTools(
												section.blocks,
												isStreaming
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
											{#if settledBlocks.length > 0 || workInProgress || runningTools.length > 0}
												<WorkDisclosure
													inProgress={workInProgress}
													startedAtMs={timing.startedAtMs}
													completedAtMs={timing.completedAtMs}
												>
													{#each settledBlocks as block, blockIndex (`${block.type}-${block.type === 'tool-group' ? block.tools.map((tool) => tool.callId).join(',') : block.id}-${blockIndex}`)}
														{#if block.type === 'reasoning'}
															{@const reasoningInProgress =
																workInProgress &&
																runningTools.length === 0 &&
																blockIndex === settledBlocks.length - 1}
															<ReasoningDisclosure
																text={block.text}
																inProgress={reasoningInProgress}
															/>
														{:else}
															<ToolCallsDisclosure
																label={toolGroupLabel(block.toolKey)}
																tools={block.tools}
															>
																{#snippet toolRow(tool)}
																	{@const toolError = assistantTimelineToolError(tool)}
																	{@const toolFailureKind = assistantTimelineToolFailureKind(tool)}
																	{@const toolSummary = toolItemSummary(tool)}
																	{#if toolError && toolFailureKind}
																		<details class="min-w-0">
																			<summary
																				class="min-w-0 cursor-pointer text-left"
																				title={fullToolSummary(tool, isStreaming)}
																			>
																				<span class="truncate">{toolSummary}</span>
																				<span
																					class={toolFailureKind === 'cancelled'
																						? 'text-amber-200'
																						: 'text-rose-200'}
																				>
																					({toolFailureKind})
																				</span>
																			</summary>
																			<p
																				class="mt-1.5 whitespace-pre-wrap wrap-break-word text-xs leading-5 {toolFailureKind ===
																				'cancelled'
																					? 'text-amber-200'
																					: 'text-rose-200'}"
																				role="status"
																			>
																				{toolError}
																			</p>
																		</details>
																	{:else}
																		<p
																			class="min-w-0 truncate"
																			title={fullToolSummary(tool, isStreaming)}
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
											{#if runningTools.length > 0}
												<ToolCallsDisclosure
													label="Running"
													tools={runningTools}
													defaultExpanded={true}
												>
													{#snippet toolRow(tool)}
														{@const toolSummary = toolItemSummary(tool)}
														<p class="min-w-0 truncate" title={fullToolSummary(tool, isStreaming)}>
															{toolSummary}
														</p>
													{/snippet}
												</ToolCallsDisclosure>
											{/if}
										{/if}
									{/each}
									{#if !isStreaming && message.runCompletedAt !== undefined}
										<p class="text-sm text-slate-500">
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

	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(180deg,rgba(15,15,17,0),rgba(15,15,17,0.68)_48%,rgba(15,15,17,0.92))]"
	></div>
</div>

<ImageViewer
	image={viewerImage}
	onClose={() => {
		viewerImage = null;
	}}
/>
