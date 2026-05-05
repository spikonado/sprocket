<script lang="ts">
	import { ArrowUp, ChevronDown, Cpu, Folder, LockOpen, Square } from 'lucide-svelte';
	import ModelSelector from '$lib/components/model-selector.svelte';
	import ReasoningSelector from '$lib/components/reasoning-selector.svelte';
	import { shouldSubmitComposerFromKeydown } from '$lib/composer';
	import {
		defaultModelId,
		defaultReasoningEffort,
		modelOptions,
		type SupportedModelId,
		type SupportedReasoningEffort
	} from '$lib/models';
	import type { WorkspaceSession } from '$lib/types/sprocket';

	type Props = {
		prompt?: string;
		selectedModel?: SupportedModelId;
		selectedReasoningEffort?: SupportedReasoningEffort;
		workspaceSession: WorkspaceSession | null;
		canSend: boolean;
		isRunning: boolean;
		elapsedLabel: string | null;
		onSubmit: () => void;
		onCancel: () => void;
	};

	let {
		prompt = $bindable(''),
		selectedModel = $bindable(defaultModelId),
		selectedReasoningEffort = $bindable(defaultReasoningEffort),
		workspaceSession,
		canSend,
		isRunning,
		elapsedLabel,
		onSubmit,
		onCancel
	}: Props = $props();

	let composerTextarea = $state<HTMLTextAreaElement | null>(null);

	function syncComposerHeight() {
		if (!composerTextarea) {
			return;
		}

		composerTextarea.style.height = '0px';

		const minHeight = 68;
		const maxHeight = 160;
		const nextHeight = Math.min(Math.max(composerTextarea.scrollHeight, minHeight), maxHeight);

		composerTextarea.style.height = `${nextHeight}px`;
		composerTextarea.style.overflowY =
			composerTextarea.scrollHeight > nextHeight ? 'auto' : 'hidden';
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (!shouldSubmitComposerFromKeydown(event)) {
			return;
		}

		event.preventDefault();
		onSubmit();
	}

	$effect(() => {
		const textarea = composerTextarea;
		const promptValue = prompt;

		queueMicrotask(() => {
			if (!textarea && promptValue.length === 0) {
				return;
			}

			syncComposerHeight();
		});
	});

	const composerShellClass =
		'mx-auto w-full max-w-[48rem] rounded-[28px] bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-px transition-colors duration-200';
	const composerInnerClass =
		'rounded-[27px] border border-white/6 bg-[linear-gradient(180deg,rgba(35,35,38,0.98),rgba(28,28,30,0.98))] shadow-[0_24px_64px_rgba(0,0,0,0.28)] transition-colors duration-200';
</script>

<footer class="shrink-0 px-6 py-4">
	<div class="mx-auto max-w-336">
		{#if elapsedLabel}
			<div class="mb-3 flex items-center gap-2 px-4 text-[11px] text-slate-400">
				<span class="inline-flex items-center gap-0.75">
					<span class="size-1 animate-pulse rounded-full bg-white/28"></span>
					<span class="size-1 animate-pulse rounded-full bg-white/28 [animation-delay:200ms]"
					></span>
					<span class="size-1 animate-pulse rounded-full bg-white/28 [animation-delay:400ms]"
					></span>
				</span>
				<span>Working for {elapsedLabel}</span>
			</div>
		{/if}

		<div class={composerShellClass}>
			<div class={composerInnerClass}>
				<div class="relative flex min-h-33 flex-col px-4 pt-4 pb-2.5">
					<div class="min-h-0 flex-1">
						<textarea
							bind:this={composerTextarea}
							bind:value={prompt}
							rows="1"
							class="min-h-0 w-full resize-none border-0 bg-transparent px-0 py-0 text-[14px] leading-6 text-slate-100 outline-none placeholder:text-slate-500"
							placeholder="Ask anything, @tag files/folders, or use / to show available commands"
							disabled={isRunning}
							onkeydown={handleComposerKeydown}
						></textarea>
					</div>

					<div
						class="flex min-w-0 flex-nowrap items-center justify-between gap-3 overflow-visible px-0 pt-2.5 pb-0"
					>
						<div class="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-visible p-1">
							<ModelSelector
								bind:value={selectedModel}
								options={modelOptions}
								disabled={isRunning}
								className="z-20 shrink-0"
								triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-slate-200 shadow-none hover:bg-transparent focus-visible:ring-0"
							/>

							<div class="mx-1 hidden h-4 w-px shrink-0 bg-white/8 sm:block"></div>

							<ReasoningSelector
								bind:value={selectedReasoningEffort}
								disabled={isRunning}
								className="z-20 shrink-0"
								triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-slate-300 shadow-none hover:bg-transparent focus-visible:ring-0"
							/>

							<div class="mx-1 hidden h-4 w-px shrink-0 bg-white/8 sm:block"></div>

							<button
								type="button"
								class="flex h-9 shrink-0 items-center gap-1.5 px-2 text-[15px] whitespace-nowrap text-slate-300 transition hover:text-slate-200"
							>
								<Cpu class="size-4 text-slate-400" />
								<span>Build</span>
							</button>

							<div class="mx-1 hidden h-4 w-px shrink-0 bg-white/8 sm:block"></div>

							<button
								type="button"
								class="flex h-9 shrink-0 items-center gap-1.5 px-2 text-[15px] whitespace-nowrap text-slate-300 transition hover:text-slate-200"
							>
								<LockOpen class="size-4 text-slate-400" />
								<span>Full access</span>
								<ChevronDown class="size-3 text-slate-500" />
							</button>
						</div>

						<div class="flex shrink-0 flex-nowrap items-center justify-end gap-2.5">
							{#if isRunning}
								<button
									type="button"
									class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:scale-105 hover:bg-rose-500 disabled:pointer-events-none disabled:opacity-60 disabled:hover:scale-100"
									aria-label="Stop generation"
									title="Stop"
									onclick={onCancel}
								>
									<Square class="size-3.5 fill-current" />
								</button>
							{:else}
								<button
									type="button"
									class="bg-primary/90 text-primary-foreground hover:bg-primary flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 hover:scale-105 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100"
									onclick={onSubmit}
									disabled={!canSend || !prompt.trim()}
									aria-label="Send message"
								>
									<ArrowUp class="size-4" />
								</button>
							{/if}
						</div>
					</div>
				</div>
			</div>
		</div>

		{#if workspaceSession}
			<div
				class="mx-auto mt-2.5 flex w-full max-w-3xl items-center justify-between px-1 text-xs text-slate-500"
			>
				<div class="flex min-w-0 items-center gap-2" title={workspaceSession.workspacePath}>
					<Folder class="size-3.5 shrink-0" />
					<span class="truncate">Local checkout</span>
				</div>
				{#if workspaceSession.gitBranch}
					<div class="ml-4 flex shrink-0 items-center gap-1.5">
						<span>{workspaceSession.gitBranch}</span>
						<ChevronDown class="size-3.5 text-slate-500" />
					</div>
				{/if}
			</div>
		{/if}
	</div>
</footer>
