<script lang="ts">
	import { LoaderCircle } from '@lucide/svelte';
	import {
		assistantTimelineToolError,
		assistantTimelineToolFailureKind,
		type AssistantTimelineTool
	} from '$lib/chat/assistant-timeline';
	import {
		changedFileCount,
		fullToolSummary,
		toolGroupLabel,
		toolItemSummary,
		toolSummaryClass
	} from '$lib/chat/tool-summaries';
	import { toolKindIcon, toolLogIcon } from '$lib/chat/tool-icons';
	import ToolCallsDisclosure from './tool-calls-disclosure.svelte';

	let {
		tools,
		toolKey = '',
		running = false,
		inProgress,
		commands
	}: {
		tools: AssistantTimelineTool[];
		toolKey?: string;
		running?: boolean;
		inProgress: boolean;
		commands: ReadonlyMap<string, string>;
	} = $props();
</script>

<ToolCallsDisclosure
	label={running ? 'Running' : toolGroupLabel(toolKey)}
	icon={running ? LoaderCircle : toolKindIcon(toolKey)}
	iconClass={running ? 'animate-spin' : undefined}
	{tools}
	defaultExpanded={running
		? true
		: toolKey === 'apply_patch'
			? changedFileCount(tools) <= 2
			: undefined}
>
	{#snippet toolRow(tool)}
		{@const summary = toolItemSummary(tool, commands)}
		{#if running}
			{@const ToolIcon = toolLogIcon(tool)}
			<p class="flex min-w-0 items-start gap-1.5" title={`${summary} (running)`}>
				<ToolIcon class="text-muted-foreground mt-1.5 size-3 shrink-0" aria-hidden="true" />
				<span class={toolSummaryClass(tool)}>{summary}</span>
			</p>
		{:else}
			{@const error = assistantTimelineToolError(tool, inProgress)}
			{@const failure = assistantTimelineToolFailureKind(tool, inProgress)}
			{#if error && failure}
				{@const errorClass =
					failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200'}
				<details class="min-w-0">
					<summary
						class="min-w-0 cursor-pointer text-left"
						title={fullToolSummary(tool, inProgress, commands)}
					>
						<span class={toolSummaryClass(tool)}>{summary}</span>
						<span class={errorClass}>({failure})</span>
					</summary>
					<p
						class="mt-1.5 text-xs leading-5 wrap-break-word whitespace-pre-wrap {errorClass}"
						role="status"
					>
						{error}
					</p>
				</details>
			{:else}
				<p
					class={`min-w-0 ${toolSummaryClass(tool)}`}
					title={fullToolSummary(tool, inProgress, commands)}
				>
					{summary}
				</p>
			{/if}
		{/if}
	{/snippet}
</ToolCallsDisclosure>
