<script lang="ts">
	import { ArrowUp, CircleAlert, Paperclip, Square } from '@lucide/svelte';
	import { useAuth, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import type { Id } from '$convex/_generated/dataModel';
	import OptionSelector from '$lib/components/option-selector.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
	import ReasoningSelector from '$lib/components/reasoning-selector.svelte';
	import AgentQuestion from '$lib/components/home/agent-question.svelte';
	import ComposerAttachments from '$lib/components/home/composer-attachments.svelte';
	import ComposerSkillMenu from '$lib/components/home/composer-skill-menu.svelte';
	import { containsDraggedFiles, shouldSubmitComposerFromKeydown } from '$lib/chat/composer';
	import { applySkillSelection, filterSkills, getActiveDollarQuery } from '$lib/chat/dollar-skills';
	import type { SkillSummary } from '$lib/types/sprocket';
	import { formatCountdownDuration } from '$lib/format';
	import { canSubmitQuestionAnswer, type AgentQuestionOption } from '$convex/lib/agentQuestions';
	import { defaultModelId, defaultReasoningEffort } from '$convex/lib/models';
	import type { CompletionProvider } from '$convex/lib/validators';
	import {
		fastModeAccessForModelAndTier,
		getCatalogModel,
		isModelAllowedForTier,
		modelOptionsForCompletionProvider,
		resolveModelForCompletionProvider,
		showsReasoningControl,
		type CatalogModelId,
		type ModelCatalog
	} from '$lib/chat/model-catalog';
	import type { ComposerAttachment } from '$lib/chat/attachments';
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
		configuredProviders?: CompletionProvider[];
		chatGptModelIds?: readonly string[] | null;
		providersReady?: boolean;
		selectedCompletionProvider?: CompletionProvider;
		selectedReasoningEffort?: string;
		fastMode?: boolean;
		pendingQuestion?: PendingAgentQuestion | null;
		showContinueWorking?: boolean;
		onContinueWorking?: () => void;
		selectedQuestionOptionId?: string | null;
		canSend: boolean;
		isSubmitting: boolean;
		isStarting: boolean;
		isRunning: boolean;
		elapsedLabel: string | null;
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
		configuredProviders = ['spikonado'],
		chatGptModelIds = null,
		providersReady = true,
		selectedCompletionProvider = $bindable<CompletionProvider>('spikonado'),
		selectedReasoningEffort = $bindable<string>(defaultReasoningEffort),
		fastMode = $bindable(false),
		pendingQuestion = null,
		showContinueWorking = false,
		onContinueWorking,
		selectedQuestionOptionId = $bindable<string | null>(null),
		canSend,
		isSubmitting,
		isStarting,
		isRunning,
		elapsedLabel,
		projectSkills = null,
		onSubmit,
		onCancel
	}: Props = $props();

	const convexAuth = useAuth();
	const usageQuery = useQuery(api.usage.getMyUsage, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);
	const subscriptionTier = $derived(usageQuery.data?.tier);
	const subscriptionFailed = $derived(Boolean(usageQuery.error));
	// Until the tier is known, render the free allowlist so locked models are never selectable.
	const providerOptions = $derived(
		configuredProviders.map((provider) => ({
			id: provider,
			label:
				provider === 'spikonado'
					? 'Spikonado'
					: provider === 'chatgpt'
						? 'ChatGPT Subscription'
						: 'OpenAI API'
		}))
	);
	const modelOptions = $derived(
		modelCatalog
			? modelOptionsForCompletionProvider(
					modelCatalog,
					subscriptionTier ?? 'free',
					selectedCompletionProvider,
					chatGptModelIds
				)
			: []
	);
	const selectedCatalogModel = $derived(
		modelCatalog ? getCatalogModel(modelCatalog, selectedModel) : undefined
	);
	const selectedFastModeAccess = $derived.by(() => {
		if (!modelCatalog || !selectedCatalogModel) return undefined;
		if (selectedCompletionProvider !== 'spikonado') return 'unsupported';
		if (!selectedCatalogModel.supportsFastMode) return 'unsupported';
		if (!subscriptionTier) return undefined;
		return fastModeAccessForModelAndTier(modelCatalog, subscriptionTier, selectedCatalogModel);
	});
	// Block send until a catalog model is selected. If the usage query fails, keep send
	// enabled for a known selection and let the backend enforce entitlements.
	const canSubmitWithModel = $derived(
		(selectedCompletionProvider === 'spikonado' ||
			(providersReady && configuredProviders.includes(selectedCompletionProvider))) &&
			selectedCatalogModel !== undefined &&
			(selectedCompletionProvider !== 'spikonado'
				? selectedCatalogModel.provider === 'openai' &&
					(selectedCompletionProvider !== 'chatgpt' ||
						chatGptModelIds?.includes(selectedModel) === true)
				: subscriptionFailed ||
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
	let draggingFiles = $state(false);

	const answeringQuestion = $derived(pendingQuestion != null);
	const composerLocked = $derived((isRunning && !answeringQuestion) || isSubmitting);
	let now = $state(Date.now());

	$effect(() => {
		const interval = setInterval(() => {
			now = Date.now();
		}, 1_000);
		return () => {
			clearInterval(interval);
		};
	});

	// Unknown policies count as metered, matching backend enforcement.
	const selectedModelUnmetered = $derived(selectedCatalogModel?.usagePolicy === 'unlimited');
	// The cached result can outlive its own reset time because the query only
	// re-runs when the limiter document changes, so expire it on the local clock.
	const usageBlocked = $derived(
		usageQuery.data?.exhausted === true &&
			(usageQuery.data.resetsAt === null || usageQuery.data.resetsAt > now) &&
			!selectedModelUnmetered &&
			selectedCompletionProvider === 'spikonado'
	);
	const unlimitedAlternativeLabel = $derived.by(() => {
		if (!modelCatalog) return null;
		const option = modelOptions.find(
			(candidate) =>
				!candidate.locked &&
				getCatalogModel(modelCatalog, candidate.id)?.usagePolicy === 'unlimited'
		);
		return option?.label ?? null;
	});
	const composerNotice = $derived.by(() => {
		if (!usageBlocked || usageQuery.data === undefined) return null;
		const keepGoing =
			unlimitedAlternativeLabel !== null
				? `Switch to ${unlimitedAlternativeLabel} or upgrade your subscription to keep going.`
				: 'Upgrade your subscription to keep going.';
		if (usageQuery.data.resetsAt === null) return keepGoing;
		return `Your limit resets in ${formatCountdownDuration(usageQuery.data.resetsAt - now)}. ${keepGoing}`;
	});
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
	const canAttachMore = $derived(!composerLocked && !answeringQuestion);
	$effect(() => {
		if (!canAttachMore) draggingFiles = false;
	});

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
	const attachTooltipLabel = 'Attach files';
	const supportsFieldSizing = Boolean(globalThis.CSS?.supports('field-sizing', 'content'));
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
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) {
			return;
		}
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length > 0) {
			onAttachFiles(files);
		}
	}

	function handleComposerPaste(event: ClipboardEvent) {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0 || !canAttachMore) {
			return;
		}
		if (!event.clipboardData?.getData('text/plain')) {
			event.preventDefault();
		}
		onAttachFiles(files);
	}

	function handleFileDragEnter(event: DragEvent) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();
		if (canAttachMore) draggingFiles = true;
	}

	function handleFileDragOver(event: DragEvent) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = canAttachMore ? 'copy' : 'none';
	}

	function handleFileDragLeave(event: DragEvent) {
		const composer = event.currentTarget;
		if (
			composer instanceof HTMLElement &&
			event.relatedTarget instanceof Node &&
			composer.contains(event.relatedTarget)
		) {
			return;
		}
		draggingFiles = false;
	}

	function handleFileDrop(event: DragEvent) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();
		draggingFiles = false;
		if (!canAttachMore) return;
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) onAttachFiles(files);
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
			(!answeringQuestion && usageBlocked) ||
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
		selectedModel = modelId;
		const model = getCatalogModel(modelCatalog, modelId);
		if (model) selectedReasoningEffort = model.defaultReasoningEffort;
	}

	function handleProviderChange(provider: CompletionProvider) {
		if (!modelCatalog) return;
		selectedCompletionProvider = provider;
		const modelId = resolveModelForCompletionProvider(
			modelCatalog,
			subscriptionTier ?? 'free',
			provider,
			selectedModel,
			chatGptModelIds
		);
		if (!modelId) return;
		selectedModel = modelId;
		selectedReasoningEffort =
			getCatalogModel(modelCatalog, modelId)?.defaultReasoningEffort ??
			modelCatalog.defaultReasoningEffort;
		fastMode = false;
	}

	$effect(() => {
		if (!modelCatalog) return;
		if (providersReady && !configuredProviders.includes(selectedCompletionProvider)) {
			selectedCompletionProvider = 'spikonado';
		}
		const resolvedModel =
			selectedCompletionProvider !== 'spikonado'
				? resolveModelForCompletionProvider(
						modelCatalog,
						subscriptionTier ?? 'free',
						selectedCompletionProvider,
						selectedModel,
						chatGptModelIds
					)
				: getCatalogModel(modelCatalog, selectedModel)
					? selectedModel
					: modelCatalog.defaultModelId;
		if (resolvedModel && resolvedModel !== selectedModel) {
			selectedModel = resolvedModel;
			selectedReasoningEffort =
				getCatalogModel(modelCatalog, resolvedModel)?.defaultReasoningEffort ??
				modelCatalog.defaultReasoningEffort;
			fastMode = false;
		}
	});

	$effect(() => {
		if (selectedCompletionProvider !== 'spikonado') {
			fastMode = false;
		}
	});

	$effect(() => {
		// Only coerce after a successful tier + catalog load so paid users are not snapped to
		// free defaults during loading or transient query failures.
		if (!modelCatalog || !subscriptionTier) return;
		const allowedModel = resolveModelForCompletionProvider(
			modelCatalog,
			subscriptionTier,
			selectedCompletionProvider,
			selectedModel,
			chatGptModelIds
		);
		if (!allowedModel) return;
		if (allowedModel !== selectedModel) {
			selectedModel = allowedModel;
			selectedReasoningEffort =
				getCatalogModel(modelCatalog, allowedModel)?.defaultReasoningEffort ??
				modelCatalog.defaultReasoningEffort;
		}
		const catalogModel = getCatalogModel(modelCatalog, allowedModel);
		if (!catalogModel) return;
		if (fastModeAccessForModelAndTier(modelCatalog, subscriptionTier, catalogModel) !== 'available')
			fastMode = false;
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

		{#if showContinueWorking && onContinueWorking}
			<div class="mx-auto mb-3 w-full max-w-[48rem] px-4">
				<button
					type="button"
					class="border-border bg-surface/80 text-foreground hover:bg-hover-fill rounded-full border px-3 py-1.5 text-[13px] font-medium transition"
					onclick={onContinueWorking}
					disabled={isSubmitting}
				>
					Continue working
				</button>
			</div>
		{/if}

		<div
			class={composerShellClass}
			role="group"
			aria-label="Message composer"
			ondragenter={handleFileDragEnter}
			ondragover={handleFileDragOver}
			ondragleave={handleFileDragLeave}
			ondrop={handleFileDrop}
		>
			<div class={`${composerInnerClass} relative`}>
				{#if draggingFiles}
					<div
						class="bg-surface/90 border-primary/70 pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-[27px] border-2 border-dashed backdrop-blur-sm"
						role="status"
						aria-live="polite"
					>
						<Paperclip class="text-primary size-5" aria-hidden="true" />
						<span class="text-foreground text-sm font-medium">Drop files to attach</span>
					</div>
				{/if}
				<div class="relative flex min-h-33 flex-col px-4 pt-4 pb-2.5">
					{#if composerNotice}
						<div
							class="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-3"
							role="alert"
						>
							<CircleAlert
								class="mt-0.5 size-4 shrink-0 text-amber-800 dark:text-amber-200"
								aria-hidden="true"
							/>
							<div class="min-w-0">
								<p class="text-[13px] leading-5 font-medium text-amber-800 dark:text-amber-200">
									You're out of usage
								</p>
								<p class="text-[12.5px] leading-5 text-amber-800/90 dark:text-amber-200/90">
									{composerNotice}
								</p>
							</div>
						</div>
					{/if}
					{#if pendingQuestion}
						<AgentQuestion
							question={pendingQuestion.question}
							options={pendingQuestion.options}
							selectedOptionId={selectedQuestionOptionId}
							onToggleOption={toggleQuestionOption}
						/>
					{/if}
					{#if attachments.length > 0 && !answeringQuestion}
						<ComposerAttachments
							{attachments}
							disabled={composerLocked}
							onRemove={onRemoveAttachment}
						/>
					{/if}
					<div class="relative min-h-0 flex-1">
						{#if skillsPopupOpen}
							<ComposerSkillMenu
								loadState={skillsLoadState}
								skills={filteredSkills}
								{highlightedIndex}
								onRetry={() => void ensureSkillsLoaded(true)}
								onHighlight={(index) => {
									highlightedIndex = index;
								}}
								onSelect={selectSkill}
							/>
						{/if}
						<textarea
							bind:this={composerTextarea}
							bind:value={prompt}
							rows="1"
							class="text-foreground placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-17 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-[14px] leading-6 outline-none"
							placeholder={answeringQuestion
								? 'Add detail, or type a custom answer'
								: 'Ask anything, @tag files/directories, or use $ to show available skills'}
							disabled={isSubmitting}
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
								<Paperclip class="size-4" aria-hidden="true" />
							</button>

							<div class="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

							<OptionSelector
								value={selectedModel}
								options={modelOptions}
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

							{#if selectedCatalogModel}
								{#if showsReasoningControl(selectedCatalogModel) || selectedFastModeAccess === 'available' || selectedFastModeAccess === 'locked'}
									<div class="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>
								{/if}
								<ReasoningSelector
									model={selectedCatalogModel}
									bind:reasoningEffort={selectedReasoningEffort}
									bind:fastMode
									fastModeAccess={selectedFastModeAccess}
									fastModeLockTooltip={modelCatalog?.fastModeLockUpgradeMessage}
									disabled={composerLocked || answeringQuestion}
									className="z-20 shrink-0"
								/>
							{/if}

							<div class="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

							<OptionSelector
								value={selectedCompletionProvider}
								options={providerOptions}
								ariaLabel="Select provider"
								menuTitle="Provider"
								disabled={composerLocked || answeringQuestion || !providersReady}
								onValueChange={handleProviderChange}
								className="z-20 shrink-0"
								triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-foreground shadow-none hover:bg-transparent focus-visible:ring-0"
							>
								{#snippet optionIcon(option)}
									<ProviderLogo provider={option.id} className="size-4 shrink-0" />
								{/snippet}
							</OptionSelector>
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
							{/if}
							{#if answeringQuestion || !isRunning}
								<button
									type="button"
									class="bg-primary/90 text-primary-foreground hover:bg-primary flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 hover:scale-105 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100"
									onclick={onSubmit}
									disabled={!canSend ||
										(!answeringQuestion && !canSubmitWithModel) ||
										(!answeringQuestion && usageBlocked) ||
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
