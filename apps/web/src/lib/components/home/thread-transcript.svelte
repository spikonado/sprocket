<script lang="ts">
	import { tick } from 'svelte';
	import { TerminalSquare } from '@lucide/svelte';
	import { isJsonObject, type JsonValue } from '$convex/lib/json';
	import {
		assistantTimelineToolError,
		assistantTimelineToolFailureKind,
		buildAssistantTimeline,
		type AssistantTimelineItem
	} from '$lib/chat/assistant-timeline';
	import ScrollArea from '$lib/components/ui/scroll-area/scroll-area.svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import type { ExecutorJob, ThreadMessage, WorkspaceSession } from '$lib/types/sprocket';
	type AssistantTimelineTool = Extract<AssistantTimelineItem, { type: 'tool' }>;

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
			? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands in this workspace.'
			: 'Attach a workspace to begin.',
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

	function toolDisplayName(kind: string) {
		if (kind === 'check_docs') {
			return 'Check Docs';
		}
		if (kind === 'exec_command') {
			return 'Run Command';
		}

		return kind
			.split('_')
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(' ');
	}

	function describeExecCommandOptions(input: JsonValue | undefined) {
		if (!isJsonObject(input)) {
			return '';
		}

		const details: string[] = [];
		if (typeof input.workdir === 'string' && input.workdir.trim().length > 0) {
			details.push(`cwd ${input.workdir}`);
		}
		if (input.login === true) {
			details.push('login shell');
		}
		if (typeof input.shell === 'string' && input.shell.trim().length > 0) {
			details.push(input.shell);
		}

		return details.length > 0 ? ` (${details.join(', ')})` : '';
	}

	function actionTitle(job: ExecutorJob) {
		return toolDisplayName(job.kind);
	}

	function actionSummary(job: ExecutorJob) {
		const pathPayload = 'path' in job.payload ? job.payload : undefined;
		const commandPayload = 'cmd' in job.payload ? job.payload : undefined;
		switch (job.kind) {
			case 'exec_command':
				return commandPayload?.cmd
					? `${actionTitle(job)} - ${commandPayload.cmd}${describeExecCommandOptions(job.payload)}`
					: actionTitle(job);
			case 'create_file':
			case 'replace_in_file':
				return pathPayload?.path ? `${actionTitle(job)} - ${pathPayload.path}` : actionTitle(job);
			default:
				return actionTitle(job);
		}
	}

	function toolLogSummary(toolLog: AssistantTimelineTool) {
		const input = isJsonObject(toolLog.input) ? toolLog.input : undefined;
		const title = toolDisplayName(toolLog.name);

		switch (toolLog.name) {
			case 'exec_command':
				return typeof input?.cmd === 'string'
					? `${title} - ${input.cmd}${describeExecCommandOptions(input)}`
					: title;
			case 'create_file':
			case 'replace_in_file':
				return typeof input?.path === 'string' ? `${title} - ${input.path}` : title;
			default:
				return title;
		}
	}

	function fullToolSummary(toolLog: AssistantTimelineTool) {
		const summary = toolLog.job ? actionSummary(toolLog.job) : toolLogSummary(toolLog);
		if (toolLog.job?.status === 'pending' || toolLog.job?.status === 'claimed') {
			return `${summary} (running)`;
		}
		const error = assistantTimelineToolError(toolLog);
		return error ? `${summary} (${error})` : summary;
	}

	const userMessageClass =
		'w-full max-w-[56rem] rounded-[28px] border border-white/7 bg-[linear-gradient(180deg,rgba(39,39,42,0.96),rgba(28,28,30,0.96))] px-5 py-4 text-[15px] leading-8 text-slate-100 shadow-[0_16px_40px_rgba(0,0,0,0.22)]';

	$effect(() => {
		void messages;
		void actions;
		if (!stickToBottom) {
			return;
		}

		void tick().then(() => {
			const viewport = scrollViewport;
			if (!viewport) {
				return;
			}
			viewport.scrollTop = viewport.scrollHeight;
		});
	});
</script>

<div class="relative min-h-0 flex-1">
	<ScrollArea
		className="h-full [overflow-anchor:none]"
		bind:viewport={scrollViewport}
		onViewportScroll={updateStickToBottom}
	>
		<div class="mx-auto flex min-h-full w-full max-w-336 flex-col px-8 py-8">
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
							<div class="flex justify-end">
								<div class={userMessageClass}>
									<ChatMarkdown content={message.text || ' '} className="text-slate-100" />
								</div>
							</div>
						{:else}
							{@const messageActions = actions.filter((job) => job.runId === message.runId)}
							{@const timeline = buildAssistantTimeline(message.parts ?? [], messageActions)}
							{@const isStreaming =
								message.runStatus !== 'completed' &&
								message.runStatus !== 'failed' &&
								message.runStatus !== 'cancelled'}
							{@const hasPersistedAssistantContent = timeline.some(
								(part) => part.type === 'text' || part.type === 'reasoning'
							)}
							<div
								class="max-w-4xl px-1"
								role={isStreaming ? 'log' : undefined}
								aria-live={isStreaming ? 'polite' : undefined}
								aria-atomic="false"
								aria-relevant="additions text"
							>
								<div class="space-y-3">
									{#if !hasPersistedAssistantContent && (message.text || (isStreaming && timeline.length === 0))}
										<ChatMarkdown content={message.text || '...'} className="text-slate-200" />
									{/if}
									{#each timeline as part, index (`${part.type}-${part.type === 'tool' ? part.callId : part.id}-${index}`)}
										{#if part.type === 'text'}
											<ChatMarkdown content={part.text || ' '} className="text-slate-200" />
										{:else if part.type === 'reasoning'}
											<div
												class="rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-xs text-slate-400"
											>
												<span class="mr-2 tracking-[0.12em] uppercase">Reasoning</span>{part.text}
											</div>
										{:else}
											{@const toolError = assistantTimelineToolError(part)}
											{@const toolFailureKind = assistantTimelineToolFailureKind(part)}
											{@const toolSummary = part.job
												? actionSummary(part.job)
												: toolLogSummary(part)}
											{@const isToolRunning =
												part.job?.status === 'pending' || part.job?.status === 'claimed'}
											<div
												class="text-muted-foreground flex max-w-4xl items-start gap-3 rounded-xl border border-white/6 bg-black/15 px-3 py-2 text-sm"
											>
												<TerminalSquare class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
												{#if toolError && toolFailureKind}
													<details class="min-w-0 flex-1">
														<summary
															class="min-w-0 cursor-pointer text-left"
															title={fullToolSummary(part)}
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
															class="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 {toolFailureKind ===
															'cancelled'
																? 'text-amber-200'
																: 'text-rose-200'}"
															role="status"
														>
															{toolError}
														</p>
													</details>
												{:else}
													<p class="min-w-0 truncate" title={fullToolSummary(part)}>
														{toolSummary}
														{#if isToolRunning}
															<span> (running)</span>
														{/if}
													</p>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</ScrollArea>

	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(180deg,rgba(15,15,17,0),rgba(15,15,17,0.68)_48%,rgba(15,15,17,0.92))]"
	></div>
</div>
