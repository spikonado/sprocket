<script lang="ts">
	import { ArrowUp, ImagePlus, Square, X } from '@lucide/svelte';
	import OptionSelector from '$lib/components/option-selector.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
	import ReasoningServiceSelector from '$lib/components/reasoning-service-selector.svelte';
	import { shouldSubmitComposerFromKeydown } from '$lib/chat/composer';
	import {
		defaultModelId,
		defaultReasoningEffort,
		defaultServiceTier,
		getModelDefinition
	} from '$convex/lib/models';
	import type {
		SupportedModelId,
		SupportedReasoningEffort,
		SupportedServiceTier
	} from '$convex/lib/models';
	import { modelOptions } from '$lib/chat/model-options';
	import {
		MAX_IMAGE_ATTACHMENTS,
		SUPPORTED_IMAGE_MEDIA_TYPES,
		type ComposerAttachment
	} from '$lib/chat/attachments';

	type Props = {
		prompt?: string;
		attachments: ComposerAttachment[];
		onAttachFiles: (files: File[]) => void;
		onRemoveAttachment: (localId: string) => void;
		selectedModel?: SupportedModelId;
		selectedReasoningEffort?: SupportedReasoningEffort;
		selectedServiceTier?: SupportedServiceTier;
		canSend: boolean;
		isSubmitting: boolean;
		isStarting: boolean;
		isRunning: boolean;
		elapsedLabel: string | null;
		onSubmit: () => void;
		onCancel: () => void;
	};

	let {
		prompt = $bindable(''),
		attachments,
		onAttachFiles,
		onRemoveAttachment,
		selectedModel = $bindable(defaultModelId),
		selectedReasoningEffort = $bindable(defaultReasoningEffort),
		selectedServiceTier = $bindable(defaultServiceTier),
		canSend,
		isSubmitting,
		isStarting,
		isRunning,
		elapsedLabel,
		onSubmit,
		onCancel
	}: Props = $props();

	let composerTextarea = $state<HTMLTextAreaElement | null>(null);
	let attachmentInput = $state<HTMLInputElement | null>(null);
	let attachTooltip = $state<{ top: number; left: number } | null>(null);

	const hasMessageContent = $derived(Boolean(prompt.trim()) || attachments.length > 0);
	const attachmentsPending = $derived(
		attachments.some((attachment) => attachment.status !== 'ready')
	);
	const canAttachMore = $derived(
		attachments.length < MAX_IMAGE_ATTACHMENTS && !isRunning && !isSubmitting
	);
	const attachTooltipLabel = `Attach images (up to ${MAX_IMAGE_ATTACHMENTS})`;
	const supportsFieldSizing = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

	const COMPOSER_MIN_HEIGHT_PX = 68;
	const COMPOSER_MAX_HEIGHT_PX = 160;

	function handleAttachmentInputChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length > 0) {
			onAttachFiles(files);
		}
	}

	function handleComposerPaste(event: ClipboardEvent) {
		const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
			file.type.startsWith('image/')
		);
		if (files.length === 0 || isRunning || isSubmitting) {
			return;
		}
		event.preventDefault();
		onAttachFiles(files);
	}

	function showAttachTooltip(event: MouseEvent | FocusEvent) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLButtonElement) || target.disabled) {
			return;
		}
		const rect = target.getBoundingClientRect();
		attachTooltip = {
			top: rect.top - 8,
			left: rect.left + rect.width / 2
		};
	}

	function hideAttachTooltip() {
		attachTooltip = null;
	}

	/** Fallback only when field-sizing is unavailable; CSS handles modern browsers. */
	function syncComposerHeight() {
		if (!composerTextarea || supportsFieldSizing) {
			return;
		}
		const el = composerTextarea;
		el.style.height = `${COMPOSER_MIN_HEIGHT_PX}px`;
		const nextHeight = Math.min(
			Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT_PX),
			COMPOSER_MAX_HEIGHT_PX
		);
		el.style.height = `${nextHeight}px`;
		el.style.overflowY = el.scrollHeight > nextHeight ? 'auto' : 'hidden';
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (!canSend || isSubmitting || isRunning || !hasMessageContent || attachmentsPending) {
			return;
		}

		if (!shouldSubmitComposerFromKeydown(event)) {
			return;
		}

		event.preventDefault();
		onSubmit();
	}

	function handleModelChange(modelId: SupportedModelId) {
		selectedReasoningEffort = getModelDefinition(modelId).defaultReasoningEffort;
	}

	$effect(() => {
		void prompt;
		syncComposerHeight();
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
		{:else if isSubmitting}
			<div
				class="mb-3 flex items-center gap-2 px-4 text-[11px] text-slate-400"
				role="status"
				aria-live="polite"
			>
				<span class="size-1.5 animate-pulse rounded-full bg-white/28"></span>
				<span>{isStarting ? 'Starting agent…' : 'Sending request…'}</span>
			</div>
		{/if}

		<div class={composerShellClass}>
			<div class={composerInnerClass}>
				<div class="relative flex min-h-33 flex-col px-4 pt-4 pb-2.5">
					{#if attachments.length > 0}
						<ul class="mb-3 flex flex-wrap items-center gap-2" aria-label="Attached images">
							{#each attachments as attachment (attachment.localId)}
								<li
									class="group relative size-14 overflow-hidden rounded-xl border {attachment.status ===
									'error'
										? 'border-rose-500/60'
										: 'border-white/10'}"
									title={attachment.error ?? attachment.name}
								>
									<img
										src={attachment.previewUrl}
										alt={attachment.name}
										class="size-full object-cover {attachment.status === 'uploading'
											? 'opacity-50'
											: ''}"
									/>
									{#if attachment.status === 'uploading'}
										<span
											class="absolute inset-0 flex items-center justify-center"
											role="status"
											aria-label="Uploading {attachment.name}"
										>
											<span
												class="size-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white/80"
											></span>
										</span>
									{:else if attachment.status === 'error'}
										<span
											class="absolute inset-x-0 bottom-0 bg-rose-950/80 px-1 py-0.5 text-center text-[9px] leading-3 text-rose-200"
											role="alert"
										>
											Failed
										</span>
									{/if}
									<button
										type="button"
										class="absolute top-1 right-1 flex size-4.5 cursor-pointer items-center justify-center rounded-full bg-black/70 text-slate-200 transition hover:bg-black/90 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
										aria-label="Remove {attachment.name}"
										disabled={isRunning || isSubmitting}
										onclick={() => onRemoveAttachment(attachment.localId)}
									>
										<X class="size-3" aria-hidden="true" />
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="min-h-0 flex-1">
						<textarea
							bind:this={composerTextarea}
							bind:value={prompt}
							rows="1"
							class="field-sizing-content max-h-40 min-h-17 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-[14px] leading-6 text-slate-100 outline-none placeholder:text-slate-500"
							placeholder="Ask anything, @tag files/directories, or use / to show available commands"
							disabled={isRunning || isSubmitting}
							onkeydown={handleComposerKeydown}
							onpaste={handleComposerPaste}
							oninput={syncComposerHeight}></textarea>
					</div>

					<div
						class="flex min-w-0 flex-nowrap items-center justify-between gap-3 overflow-visible px-0 pt-2.5 pb-0"
					>
						<div class="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-visible p-1">
							<input
								bind:this={attachmentInput}
								type="file"
								class="hidden"
								accept={SUPPORTED_IMAGE_MEDIA_TYPES.join(',')}
								multiple
								onchange={handleAttachmentInputChange}
							/>
							<button
								type="button"
								class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition enabled:cursor-pointer enabled:hover:text-slate-200 disabled:opacity-40"
								aria-label={attachTooltipLabel}
								disabled={!canAttachMore}
								onmouseenter={showAttachTooltip}
								onmouseleave={hideAttachTooltip}
								onfocus={showAttachTooltip}
								onblur={hideAttachTooltip}
								onclick={() => {
									hideAttachTooltip();
									attachmentInput?.click();
								}}
							>
								<ImagePlus class="size-4" aria-hidden="true" />
							</button>

							<div class="mx-1 hidden h-4 w-px shrink-0 bg-white/8 sm:block"></div>

							<OptionSelector
								bind:value={selectedModel}
								options={modelOptions}
								ariaLabel="Select model"
								menuTitle="Model"
								disabled={isRunning}
								searchable
								onValueChange={handleModelChange}
								className="z-20 shrink-0"
								triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-slate-200 shadow-none hover:bg-transparent focus-visible:ring-0"
							>
								{#snippet optionIcon(option)}
									<ProviderLogo provider={option.provider} className="size-4 shrink-0" />
								{/snippet}
							</OptionSelector>

							<div class="mx-1 hidden h-4 w-px shrink-0 bg-white/8 sm:block"></div>

							<ReasoningServiceSelector
								modelId={selectedModel}
								bind:reasoningEffort={selectedReasoningEffort}
								bind:serviceTier={selectedServiceTier}
								disabled={isRunning}
								className="z-20 shrink-0"
							/>
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
									disabled={!canSend || isSubmitting || !hasMessageContent || attachmentsPending}
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
	</div>
</footer>

{#if attachTooltip}
	<div
		class="pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md bg-[#1a1d27] px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap text-slate-100 shadow-lg ring-1 ring-white/10"
		style={`top: ${attachTooltip.top}px; left: ${attachTooltip.left}px;`}
		role="tooltip"
	>
		{attachTooltipLabel}
	</div>
{/if}
