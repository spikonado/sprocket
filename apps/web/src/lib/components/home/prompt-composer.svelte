<script lang="ts">
	import { ArrowUp, ImagePlus, Square, X } from '@lucide/svelte';
	import { useAuth, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import type { Id } from '$convex/_generated/dataModel';
	import OptionSelector from '$lib/components/option-selector.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
	import ReasoningServiceSelector from '$lib/components/reasoning-service-selector.svelte';
	import { shouldSubmitComposerFromKeydown } from '$lib/chat/composer';
	import { applySkillSelection, filterSkills, getActiveDollarQuery } from '$lib/chat/dollar-skills';
	import type { SkillSummary } from '$lib/types/sprocket';
	import {
		AGENT_DECIDE_OPTION_ID,
		canSubmitQuestionAnswer,
		type AgentQuestionOption
	} from '$convex/lib/agentQuestions';
	import {
		defaultModelId,
		defaultReasoningEffort,
		defaultServiceTier,
		type SupportedReasoningEffort,
		type SupportedServiceTier
	} from '$convex/lib/models';
	import {
		getCatalogModel,
		isModelAllowedForTier,
		modelOptionsForTier,
		resolveModelForTier,
		type CatalogModelId,
		type ModelCatalog
	} from '$lib/chat/model-catalog';
	import {
		MAX_IMAGE_ATTACHMENTS,
		SUPPORTED_IMAGE_MEDIA_TYPES,
		type ComposerAttachment
	} from '$lib/chat/attachments';

	export type PendingAgentQuestion = {
		questionId: Id<'agentQuestions'>;
		question: string;
		options: AgentQuestionOption[];
	};

	type Props = {
		prompt?: string;
		attachments: ComposerAttachment[];
		onAttachFiles: (files: File[]) => void;
		onRemoveAttachment: (localId: string) => void;
		modelCatalog?: ModelCatalog;
		selectedModel?: CatalogModelId;
		selectedReasoningEffort?: SupportedReasoningEffort;
		selectedServiceTier?: SupportedServiceTier;
		pendingQuestion?: PendingAgentQuestion | null;
		selectedQuestionOptionId?: string | null;
		canSend: boolean;
		isSubmitting: boolean;
		isStarting: boolean;
		isRunning: boolean;
		elapsedLabel: string | null;
		contextUsage: {
			inputTokens: number;
			totalTokensProcessed: number;
			contextWindowTokens: number;
			autoCompactTokenLimit: number;
		};
		/** Project-path skill loader; cache invalidates when `workspacePath` changes. */
		projectSkills?: {
			workspacePath: string | null;
			load: () => Promise<SkillSummary[]>;
		} | null;
		onSubmit: () => void;
		onCancel: () => void;
	};

	let {
		prompt = $bindable(''),
		attachments,
		onAttachFiles,
		onRemoveAttachment,
		modelCatalog,
		selectedModel = $bindable(defaultModelId),
		selectedReasoningEffort = $bindable<SupportedReasoningEffort>(defaultReasoningEffort),
		selectedServiceTier = $bindable<SupportedServiceTier>(defaultServiceTier),
		pendingQuestion = null,
		selectedQuestionOptionId = $bindable<string | null>(null),
		canSend,
		isSubmitting,
		isStarting,
		isRunning,
		elapsedLabel,
		contextUsage,
		projectSkills = null,
		onSubmit,
		onCancel
	}: Props = $props();

	const convexAuth = useAuth();
	const subscriptionQuery = useQuery(api.billing.getMySubscription, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);
	const subscriptionTier = $derived(subscriptionQuery.data?.tier);
	const subscriptionFailed = $derived(Boolean(subscriptionQuery.error));
	// Until the tier is known, render the free allowlist so locked models are never selectable.
	const tierModelOptions = $derived(
		modelCatalog ? modelOptionsForTier(modelCatalog, subscriptionTier ?? 'free') : []
	);
	const selectedCatalogModel = $derived(
		modelCatalog ? getCatalogModel(modelCatalog, selectedModel) : undefined
	);
	// Block send until a catalog model is selected. If the subscription query fails, keep send
	// enabled for a known selection and let the backend enforce entitlements.
	const canSubmitWithModel = $derived(
		selectedCatalogModel !== undefined &&
			(subscriptionFailed ||
				(subscriptionTier !== undefined &&
					modelCatalog !== undefined &&
					isModelAllowedForTier(modelCatalog, subscriptionTier, selectedModel)))
	);

	let composerTextarea = $state<HTMLTextAreaElement | null>(null);
	let attachmentInput = $state<HTMLInputElement | null>(null);
	let attachTooltip = $state<{ top: number; left: number } | null>(null);
	let skills = $state<SkillSummary[]>([]);
	let skillsLoadState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let skillsDismissed = $state(false);
	let highlightedIndex = $state(0);
	let caretPosition = $state(0);
	let skillsRequestId = 0;
	let skillsCacheKey: string | null | undefined = undefined;
	let optionElements = $state<Array<HTMLElement | null>>([]);

	const answeringQuestion = $derived(pendingQuestion != null);
	const composerLocked = $derived((isRunning && !answeringQuestion) || isSubmitting);
	const hasMessageContent = $derived(Boolean(prompt.trim()) || attachments.length > 0);
	const canAnswerQuestion = $derived(
		canSubmitQuestionAnswer({
			selectedOptionId: selectedQuestionOptionId,
			text: prompt
		})
	);
	const canSubmitContent = $derived(answeringQuestion ? canAnswerQuestion : hasMessageContent);
	const attachmentsPending = $derived(
		attachments.some((attachment) => attachment.status !== 'ready')
	);
	const canAttachMore = $derived(
		attachments.length < MAX_IMAGE_ATTACHMENTS && !composerLocked && !answeringQuestion
	);

	let trackedPendingQuestionId = $state<string | null>(null);
	$effect(() => {
		const nextId = pendingQuestion?.questionId ?? null;
		if (nextId !== trackedPendingQuestionId) {
			trackedPendingQuestionId = nextId;
			selectedQuestionOptionId = null;
			// Drop answer draft when the pending question changes or clears so it
			// cannot leak into the next question or a later normal send.
			if (prompt.trim()) {
				prompt = '';
			}
		}
	});
	const attachTooltipLabel = `Attach images (up to ${MAX_IMAGE_ATTACHMENTS})`;
	const supportsFieldSizing = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
	const contextPercent = $derived(
		contextUsage.contextWindowTokens > 0
			? Math.min(
					100,
					Math.round((contextUsage.inputTokens / contextUsage.contextWindowTokens) * 100)
				)
			: 0
	);
	const contextCompactPercent = $derived(
		contextUsage.contextWindowTokens > 0
			? Math.round((contextUsage.autoCompactTokenLimit / contextUsage.contextWindowTokens) * 100)
			: 0
	);
	const dollarQuery = $derived(getActiveDollarQuery(prompt, caretPosition));
	const skillsPopupOpen = $derived(dollarQuery !== null && !skillsDismissed && !answeringQuestion);
	const filteredSkills = $derived(dollarQuery === null ? [] : filterSkills(skills, dollarQuery));
	const activeOptionId = $derived(
		skillsPopupOpen && filteredSkills.length > 0
			? `composer-skill-option-${highlightedIndex}`
			: undefined
	);

	const COMPOSER_MIN_HEIGHT_PX = 68;
	const COMPOSER_MAX_HEIGHT_PX = 160;

	function syncCaretFromTextarea() {
		caretPosition = composerTextarea?.selectionStart ?? prompt.length;
	}

	function invalidateSkillsCache() {
		skills = [];
		skillsLoadState = 'idle';
		skillsDismissed = false;
		highlightedIndex = 0;
		skillsRequestId += 1;
	}

	async function ensureSkillsLoaded(force = false) {
		if (
			skillsLoadState === 'loading' ||
			((skillsLoadState === 'ready' || skillsLoadState === 'error') && !force)
		) {
			return;
		}

		if (!projectSkills?.load) {
			skills = [];
			skillsLoadState = 'ready';
			return;
		}

		const requestId = ++skillsRequestId;
		skillsLoadState = 'loading';
		try {
			const nextSkills = await projectSkills.load();
			if (requestId !== skillsRequestId) {
				return;
			}
			skills = nextSkills;
			skillsLoadState = 'ready';
		} catch {
			if (requestId !== skillsRequestId) {
				return;
			}
			skills = [];
			skillsLoadState = 'error';
		}
	}

	function selectSkill(skill: SkillSummary) {
		const selection = applySkillSelection(prompt, caretPosition, skill.name);
		if (!selection) {
			return;
		}
		prompt = selection.text;
		caretPosition = selection.caret;
		skillsDismissed = true;
		queueMicrotask(() => {
			if (!composerTextarea) {
				return;
			}
			composerTextarea.focus();
			composerTextarea.setSelectionRange(selection.caret, selection.caret);
			syncComposerHeight();
		});
	}

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
		if (files.length === 0 || isRunning || isSubmitting || answeringQuestion) {
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
		if (skillsPopupOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (filteredSkills.length === 0) {
					return;
				}
				const delta = event.key === 'ArrowDown' ? 1 : -1;
				highlightedIndex =
					(highlightedIndex + delta + filteredSkills.length) % filteredSkills.length;
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				skillsDismissed = true;
				return;
			}
			if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
				event.preventDefault();
				const skill = filteredSkills[highlightedIndex];
				if (skill) {
					selectSkill(skill);
				}
				return;
			}
		}

		if (
			!canSend ||
			(!answeringQuestion && !canSubmitWithModel) ||
			isSubmitting ||
			composerLocked ||
			!canSubmitContent ||
			(!answeringQuestion && attachmentsPending)
		) {
			return;
		}

		if (!shouldSubmitComposerFromKeydown(event)) {
			return;
		}

		event.preventDefault();
		onSubmit();
	}

	function toggleQuestionOption(optionId: string) {
		selectedQuestionOptionId = selectedQuestionOptionId === optionId ? null : optionId;
	}

	function handleModelChange(modelId: CatalogModelId) {
		if (!modelCatalog) return;
		const model = getCatalogModel(modelCatalog, modelId);
		if (model) selectedReasoningEffort = model.defaultReasoningEffort;
	}

	function formatTokens(value: number): string {
		if (value >= 1_000_000) {
			return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
		}
		if (value >= 1_000) {
			return `${Math.round(value / 1_000)}k`;
		}
		return String(value);
	}

	$effect(() => {
		if (!modelCatalog) return;
		if (!selectedModel || !getCatalogModel(modelCatalog, selectedModel)) {
			selectedModel = modelCatalog.defaultModelId;
			selectedReasoningEffort = modelCatalog.defaultReasoningEffort;
			selectedServiceTier = modelCatalog.defaultServiceTier;
		}
	});

	$effect(() => {
		// Only coerce after a successful tier + catalog load so paid users are not snapped to
		// free defaults during loading or transient query failures.
		if (!modelCatalog || !subscriptionTier) return;
		const allowedModel = resolveModelForTier(modelCatalog, subscriptionTier, selectedModel);
		if (allowedModel === selectedModel) return;
		selectedModel = allowedModel;
		selectedReasoningEffort =
			getCatalogModel(modelCatalog, allowedModel)?.defaultReasoningEffort ??
			modelCatalog.defaultReasoningEffort;
	});

	$effect(() => {
		void prompt;
		syncComposerHeight();
	});

	$effect(() => {
		const path = projectSkills?.workspacePath ?? null;
		if (skillsCacheKey !== path) {
			skillsCacheKey = path;
			invalidateSkillsCache();
		}

		if (dollarQuery === null) {
			skillsDismissed = false;
			return;
		}
		if (skillsDismissed) {
			return;
		}
		void ensureSkillsLoaded();
	});

	$effect(() => {
		void filteredSkills;
		highlightedIndex = 0;
	});

	$effect(() => {
		if (!skillsPopupOpen || filteredSkills.length === 0) {
			return;
		}
		optionElements[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
	});

	const composerShellClass =
		'composer-shell mx-auto w-full max-w-[48rem] rounded-[28px] p-px transition-colors duration-200';
	const composerInnerClass =
		'composer-inner rounded-[27px] border border-[var(--hairline)] transition-colors duration-200';
</script>

<footer class="shrink-0 px-6 py-4">
	<div class="mx-auto max-w-336">
		{#if elapsedLabel}
			<div class="text-muted-foreground mb-3 flex items-center gap-2 px-4 text-[11px]">
				<span class="inline-flex items-center gap-0.75">
					<span class="bg-foreground/28 size-1 animate-pulse rounded-full"></span>
					<span class="bg-foreground/28 size-1 animate-pulse rounded-full [animation-delay:200ms]"
					></span>
					<span class="bg-foreground/28 size-1 animate-pulse rounded-full [animation-delay:400ms]"
					></span>
				</span>
				<span>Working for {elapsedLabel}</span>
			</div>
		{:else if isSubmitting}
			<div
				class="text-muted-foreground mb-3 flex items-center gap-2 px-4 text-[11px]"
				role="status"
				aria-live="polite"
			>
				<span class="bg-foreground/28 size-1.5 animate-pulse rounded-full"></span>
				<span>{isStarting ? 'Starting agent…' : 'Sending request…'}</span>
			</div>
		{/if}

		<div class={composerShellClass}>
			<div class={composerInnerClass}>
				<div class="relative flex min-h-33 flex-col px-4 pt-4 pb-2.5">
					{#if pendingQuestion}
						<div class="mb-3" role="group" aria-label="Agent question">
							<p class="text-foreground text-[14px] leading-6 font-medium">
								{pendingQuestion.question}
							</p>
							<ul class="mt-2 flex flex-col gap-1.5" aria-label="Answer options">
								{#each pendingQuestion.options as option (option.id)}
									{@const isAgentDecide = option.id === AGENT_DECIDE_OPTION_ID}
									{@const isSelected = selectedQuestionOptionId === option.id}
									<li>
										<button
											type="button"
											class={`w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-5 transition ${
												isSelected
													? 'border-foreground/40 bg-hover-fill-strong text-foreground'
													: isAgentDecide
														? 'border-border/70 text-muted-foreground/80 hover:text-muted-foreground hover:bg-hover-fill'
														: 'border-border text-muted-foreground hover:text-foreground hover:bg-hover-fill'
											}`}
											aria-pressed={isSelected}
											onclick={() => {
												toggleQuestionOption(option.id);
											}}
										>
											{option.label}
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if attachments.length > 0 && !answeringQuestion}
						<ul class="mb-3 flex flex-wrap items-center gap-2" aria-label="Attached images">
							{#each attachments as attachment (attachment.localId)}
								<li
									class="group relative size-14 overflow-hidden rounded-xl border {attachment.status ===
									'error'
										? 'border-rose-500/60'
										: 'border-border'}"
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
												class="border-border border-t-foreground/80 size-3.5 animate-spin rounded-full border-2"
											></span>
										</span>
									{:else if attachment.status === 'error'}
										<span
											class="text-destructive absolute inset-x-0 bottom-0 bg-rose-950/80 px-1 py-0.5 text-center text-[9px] leading-3"
											role="alert"
										>
											Failed
										</span>
									{/if}
									<button
										type="button"
										class="bg-foreground/70 text-background hover:bg-foreground/90 absolute top-1 right-1 flex size-4.5 cursor-pointer items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40"
										aria-label="Remove {attachment.name}"
										disabled={composerLocked}
										onclick={() => onRemoveAttachment(attachment.localId)}
									>
										<X class="size-3" aria-hidden="true" />
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="relative min-h-0 flex-1">
						{#if skillsPopupOpen}
							<div
								class="border-border bg-popover absolute inset-x-0 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-xl border py-1 shadow-2xl"
								id="composer-skills-listbox"
								aria-label="Available skills"
								role={skillsLoadState === 'ready' && filteredSkills.length > 0
									? 'listbox'
									: 'status'}
							>
								{#if skillsLoadState === 'loading'}
									<p class="text-muted-foreground px-3 py-2 text-sm">Loading skills…</p>
								{:else if skillsLoadState === 'error'}
									<div class="flex items-center justify-between gap-3 px-3 py-2">
										<p class="text-muted-foreground text-sm">Couldn’t load skills</p>
										<button
											type="button"
											class="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline"
											onclick={() => {
												void ensureSkillsLoaded(true);
											}}
										>
											Retry
										</button>
									</div>
								{:else if filteredSkills.length === 0}
									<p class="text-muted-foreground px-3 py-2 text-sm">No matching skills</p>
								{:else}
									{#each filteredSkills as skill, index (skill.name)}
										<button
											type="button"
											bind:this={optionElements[index]}
											id="composer-skill-option-{index}"
											class={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition ${
												highlightedIndex === index
													? 'text-foreground bg-hover-fill-strong'
													: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
											}`}
											role="option"
											aria-selected={highlightedIndex === index}
											onpointerenter={() => {
												highlightedIndex = index;
											}}
											onclick={() => {
												selectSkill(skill);
											}}
										>
											<span class="text-sm font-medium">${skill.name}</span>
											<span class="text-muted-foreground line-clamp-2 text-[12px]"
												>{skill.description}</span
											>
										</button>
									{/each}
								{/if}
							</div>
						{/if}
						<textarea
							bind:this={composerTextarea}
							bind:value={prompt}
							rows="1"
							class="text-foreground placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-17 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-[14px] leading-6 outline-none"
							placeholder={answeringQuestion
								? 'Add detail, or type a custom answer'
								: 'Ask anything, @tag files/directories, or use $ to show available skills'}
							disabled={composerLocked}
							role="combobox"
							aria-autocomplete="list"
							aria-haspopup="listbox"
							aria-expanded={skillsPopupOpen}
							aria-controls={skillsPopupOpen ? 'composer-skills-listbox' : undefined}
							aria-activedescendant={activeOptionId}
							autocomplete="off"
							onkeydown={handleComposerKeydown}
							onpaste={handleComposerPaste}
							onfocus={syncCaretFromTextarea}
							oninput={() => {
								syncCaretFromTextarea();
								syncComposerHeight();
							}}
							onkeyup={syncCaretFromTextarea}
							onclick={syncCaretFromTextarea}
							onselect={syncCaretFromTextarea}></textarea>
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
								class="text-muted-foreground enabled:hover:text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition enabled:cursor-pointer disabled:opacity-40"
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

							<div class="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

							<OptionSelector
								bind:value={selectedModel}
								options={tierModelOptions}
								ariaLabel="Select model"
								menuTitle="Model"
								disabled={composerLocked || answeringQuestion || modelCatalog === undefined}
								searchable
								onValueChange={handleModelChange}
								className="z-20 shrink-0"
								triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-foreground shadow-none hover:bg-transparent focus-visible:ring-0"
							>
								{#snippet optionIcon(option)}
									<ProviderLogo provider={option.provider} className="size-4 shrink-0" />
								{/snippet}
							</OptionSelector>

							<div class="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

							{#if selectedCatalogModel}
								<ReasoningServiceSelector
									model={selectedCatalogModel}
									bind:reasoningEffort={selectedReasoningEffort}
									bind:serviceTier={selectedServiceTier}
									disabled={composerLocked || answeringQuestion}
									className="z-20 shrink-0"
								/>
							{/if}
						</div>

						<div class="flex shrink-0 flex-nowrap items-center justify-end gap-2.5">
							<div class="group/context relative">
								<button
									type="button"
									class="focus-visible:ring-ring/60 relative flex size-8 cursor-help items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
									aria-label={`Context window ${contextPercent}% full`}
									aria-describedby="context-window-details"
									style={`background: conic-gradient(var(--accent) ${contextPercent * 3.6}deg, var(--hover-fill-strong) 0deg);`}
									onkeydown={(event) => {
										if (event.key === 'Escape') event.currentTarget.blur();
									}}
								>
									<span class="bg-muted size-5.5 rounded-full"></span>
								</button>
								<div
									id="context-window-details"
									class="border-border bg-popover invisible absolute right-0 bottom-full z-50 mb-3 w-76 translate-y-1 rounded-xl border p-4 opacity-0 shadow-(--composer-shadow) transition duration-150 group-focus-within/context:visible group-focus-within/context:translate-y-0 group-focus-within/context:opacity-100 group-hover/context:visible group-hover/context:translate-y-0 group-hover/context:opacity-100"
									role="tooltip"
								>
									<div class="flex items-center justify-between gap-4 text-[13px]">
										<span class="text-foreground font-medium">Context window</span>
										<span class="text-muted-foreground"
											>{contextPercent}% · {formatTokens(contextUsage.inputTokens)}/{formatTokens(
												contextUsage.contextWindowTokens
											)}</span
										>
									</div>
									<div class="bg-hover-fill mt-3 h-1.5 overflow-hidden rounded-full">
										<div
											class="bg-accent h-full rounded-full transition-[width] duration-300"
											style={`width: ${contextPercent}%`}
										></div>
									</div>
									<div
										class="text-muted-foreground mt-3 flex items-center justify-between text-[12px]"
									>
										<span>Total processed</span>
										<span>{formatTokens(contextUsage.totalTokensProcessed)}</span>
									</div>
									<p class="text-muted-foreground mt-4 text-[12px] leading-5">
										Sprocket automatically compacts context at about {contextCompactPercent}% so
										long-running work can continue.
									</p>
								</div>
							</div>
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
							{/if}
							{#if answeringQuestion || !isRunning}
								<button
									type="button"
									class="bg-primary/90 text-primary-foreground hover:bg-primary flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 hover:scale-105 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100"
									onclick={onSubmit}
									disabled={!canSend ||
										(!answeringQuestion && !canSubmitWithModel) ||
										isSubmitting ||
										!canSubmitContent ||
										(!answeringQuestion && attachmentsPending)}
									aria-label={answeringQuestion ? 'Submit answer' : 'Send message'}
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
		class="bg-tooltip text-tooltip-foreground ring-border pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap shadow-lg ring-1"
		style={`top: ${attachTooltip.top}px; left: ${attachTooltip.left}px;`}
		role="tooltip"
	>
		{attachTooltipLabel}
	</div>
{/if}
