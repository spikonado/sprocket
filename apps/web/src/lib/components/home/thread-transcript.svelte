<script lang="ts">
	import { tick } from 'svelte';
	import { TerminalSquare } from 'lucide-svelte';
	import {
		buildPersistedToolLogs,
		type AssistantPart,
		type PersistedToolLogEntry
	} from '$lib/assistant-tool-parts';
	import ScrollArea from '$lib/components/ui/scroll-area/scroll-area.svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import type { ExecutorJob, ThreadMessage, WorkspaceSession } from '$lib/types/sprocket';
	type AssistantDisplayPart = Extract<AssistantPart, { type: 'text' | 'reasoning' }>;

	type Props = {
		currentError: string | null;
		runError: string | null;
		messages: ThreadMessage[];
		actions: ExecutorJob[];
		workspaceSession: WorkspaceSession | null;
		desktopAvailable: boolean;
		emptyStateMessage?: string;
		emptyStateHint?: string | null;
	};

	let {
		currentError,
		runError,
		messages,
		actions,
		workspaceSession,
		desktopAvailable,
		emptyStateMessage = workspaceSession
			? 'Start a thread and ask Sprocket to inspect code, edit files, or run project commands in this workspace.'
			: 'Attach a workspace from the desktop app to begin.',
		emptyStateHint = !desktopAvailable ? 'Desktop executor required for workspace access' : null
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

		return kind
			.split('_')
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(' ');
	}

	function parseAssistantParts(message: ThreadMessage): AssistantDisplayPart[] {
		if (!message.parts || message.parts.length === 0) {
			return [];
		}
		return (message.parts as AssistantPart[]).filter((part) => {
			if (part.type === 'text' || part.type === 'reasoning') {
				return part.text.trim().length > 0;
			}
			return false;
		}) as AssistantDisplayPart[];
	}

	function parseAssistantToolLogs(message: ThreadMessage): PersistedToolLogEntry[] {
		if (!message.parts || message.parts.length === 0) {
			return [];
		}
		return buildPersistedToolLogs(message.parts as AssistantPart[]);
	}

	function actionTitle(job: ExecutorJob) {
		return toolDisplayName(job.kind);
	}

	function actionSummary(job: ExecutorJob) {
		const payload = job.payload as Record<string, unknown> | undefined;
		const result = job.result as Record<string, unknown> | undefined;
		switch (job.kind) {
			case 'read_file':
				if (typeof payload?.path === 'string') {
					return result?.exists === false
						? `${actionTitle(job)} - ${payload.path} (not found)`
						: `${actionTitle(job)} - ${payload.path}`;
				}
				return actionTitle(job);
			case 'create_file':
			case 'replace_in_file':
				return typeof payload?.path === 'string'
					? `${actionTitle(job)} - ${payload.path}`
					: actionTitle(job);
			default:
				return actionTitle(job);
		}
	}

	function toolLogSummary(toolLog: PersistedToolLogEntry) {
		const input = toolLog.input as Record<string, unknown> | undefined;
		const output = toolLog.output as Record<string, unknown> | undefined;
		const title = toolDisplayName(toolLog.name);

		switch (toolLog.name) {
			case 'read_file':
				if (typeof input?.path === 'string') {
					return output?.exists === false
						? `${title} - ${input.path} (not found)`
						: `${title} - ${input.path}`;
				}
				return title;
			case 'create_file':
			case 'replace_in_file':
				return typeof input?.path === 'string' ? `${title} - ${input.path}` : title;
			default:
				return title;
		}
	}

	const latestAssistantMessageId = $derived.by(() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === 'assistant') {
				return message._id;
			}
		}
		return null;
	});

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
					class="mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
				>
					{currentError}
				</div>
			{/if}

			{#if runError}
				<div
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
						{#if message.role === 'user'}
							<div class="flex justify-end">
								<div class={userMessageClass}>
									<ChatMarkdown content={message.text || ' '} className="text-slate-100" />
								</div>
							</div>
						{:else}
							{@const assistantParts = parseAssistantParts(message)}
							{@const toolLogs = parseAssistantToolLogs(message)}
							{@const showLiveActionsFallback =
								message._id === latestAssistantMessageId &&
								toolLogs.length === 0 &&
								actions.length > 0}
							<div class="max-w-4xl px-1">
								{#if assistantParts.length > 0}
									<div class="space-y-3">
										{#each assistantParts as part, index (`${part.type}-${part.id}-${index}`)}
											{#if part.type === 'text'}
												<ChatMarkdown content={part.text || ' '} className="text-slate-200" />
											{:else if part.type === 'reasoning'}
												<div
													class="rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-xs text-slate-400"
												>
													<span class="mr-2 tracking-[0.12em] uppercase">Reasoning</span>{part.text}
												</div>
											{/if}
										{/each}
									</div>
								{:else}
									<ChatMarkdown
										content={message.text || (message.status === 'streaming' ? '...' : ' ')}
										className="text-slate-200"
									/>
								{/if}

								{#if toolLogs.length > 0}
									<div class="mt-4 max-w-4xl rounded-3xl border border-white/6 bg-black/15">
										<div class="px-5 py-3 text-[11px] tracking-[0.22em] text-slate-500 uppercase">
											Work Log ({toolLogs.length})
										</div>
										<div class="border-t border-white/6 px-5 py-3">
											<div class="max-h-48 space-y-3 overflow-y-auto pr-1">
												{#each toolLogs as toolLog (`persisted-tool-log-${toolLog.callId}`)}
													<div class="text-muted-foreground flex items-start gap-3 text-sm">
														<TerminalSquare class="mt-0.5 size-4 shrink-0" />
														<p class="min-w-0 truncate">{toolLogSummary(toolLog)}</p>
													</div>
												{/each}
											</div>
										</div>
									</div>
								{:else if showLiveActionsFallback}
									<div class="mt-4 max-w-4xl rounded-3xl border border-white/6 bg-black/15">
										<div class="px-5 py-3 text-[11px] tracking-[0.22em] text-slate-500 uppercase">
											Work Log ({actions.length})
										</div>
										<div class="border-t border-white/6 px-5 py-3">
											<div class="max-h-48 space-y-3 overflow-y-auto pr-1">
												{#each actions as job (job._id)}
													<div class="text-muted-foreground flex items-start gap-3 text-sm">
														<TerminalSquare class="mt-0.5 size-4 shrink-0" />
														<p class="min-w-0 truncate">
															{actionSummary(job)}
															{#if job.status === 'failed' && job.error}
																<span class="text-rose-200"> ({job.error})</span>
															{/if}
														</p>
													</div>
												{/each}
											</div>
										</div>
									</div>
								{/if}
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
