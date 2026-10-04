import { ArrowUp, CircleAlert, Paperclip, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvexAuth, useQuery_experimental } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { canSubmitQuestionAnswer, type AgentQuestionOption } from '@convex/lib/agentQuestions';
import { defaultModelId, defaultReasoningEffort } from '@convex/lib/models';
import type { CompletionProvider } from '@convex/lib/validators';
import type { ComposerAttachment } from '$lib/chat/attachments';
import { containsDraggedFiles, shouldSubmitComposerFromKeydown } from '$lib/chat/composer';
import { applyPathSelection, getActiveAtMention } from '$lib/chat/at-paths';
import { applySkillSelection, filterSkills, getActiveDollarQuery } from '$lib/chat/dollar-skills';
import {
	getCatalogModel,
	modelOptionsForCompletionProvider,
	resolveModelForCompletionProvider,
	showsReasoningControl,
	type CatalogModelId,
	type ModelCatalog
} from '$lib/chat/model-catalog';
import { formatCountdownDuration } from '$lib/format';
import AgentQuestion from '$lib/components/home/agent-question';
import RunElapsed from '$lib/components/home/run-elapsed';
import RunningCommands from '$lib/components/home/running-commands';
import ComposerAttachments from '$lib/components/home/composer-attachments';
import ComposerSkillMenu from '$lib/components/home/composer-skill-menu';
import ComposerPathMenu from '$lib/components/home/composer-path-menu';
import { useComposerPaths, type ComposerPathSource } from '$lib/home/composer-paths';
import type { CommandApi } from '$lib/home/running-commands';
import OptionSelector from '$lib/components/option-selector';
import ProviderLogo from '$lib/components/provider-logo';
import ReasoningSelector from '$lib/components/reasoning-selector';
import type {
	SkillSummary,
	TranscriptScopeRequest,
	WorkspaceSearchEntry
} from '$lib/types/sprocket';

export type PendingAgentQuestion = {
	questionId: string;
	question: string;
	options: AgentQuestionOption[];
};

export type PromptComposerProps = {
	prompt?: string;
	onPromptChange?: (prompt: string) => void;
	attachments: ComposerAttachment[];
	onAttachFiles: (files: File[]) => void;
	onRemoveAttachment: (localId: string) => void;
	modelCatalog?: ModelCatalog;
	selectedModel?: CatalogModelId;
	onSelectedModelChange?: (modelId: CatalogModelId) => void;
	configuredProviders?: CompletionProvider[];
	providersReady?: boolean;
	selectedCompletionProvider?: CompletionProvider;
	onSelectedCompletionProviderChange?: (provider: CompletionProvider) => void;
	selectedReasoningEffort?: string;
	onSelectedReasoningEffortChange?: (effort: string) => void;
	fastMode?: boolean;
	onFastModeChange?: (fastMode: boolean) => void;
	pendingQuestion?: PendingAgentQuestion | null;
	showContinueWorking?: boolean;
	onContinueWorking?: () => void;
	runningCommands?: { api: CommandApi; scope: TranscriptScopeRequest } | null;
	selectedQuestionOptionId?: string | null;
	onSelectedQuestionOptionIdChange?: (optionId: string | null) => void;
	canSend: boolean;
	isSubmitting: boolean;
	isStarting: boolean;
	isRunning: boolean;
	runStartedAt: number | null;
	/** Project-path skill loader; cache invalidates when `workspacePath` changes. */
	projectSkills?: {
		workspacePath: string | null;
		load: () => Promise<SkillSummary[]>;
	} | null;
	projectPaths?: ComposerPathSource | null;
	onSubmit: () => void;
	onCancel: () => void;
};

export type ComposerUsage = Pick<
	FunctionReturnType<typeof api.usage.getMyUsage>,
	'tier' | 'exhausted' | 'resetsAt'
>;

export type PromptComposerViewProps = PromptComposerProps & {
	usage: ComposerUsage | undefined;
	usageFailed: boolean;
};

const COMPOSER_MIN_HEIGHT_PX = 68;

const COMPOSER_MAX_HEIGHT_PX = 160;

const SUPPORTS_FIELD_SIZING = Boolean(globalThis.CSS?.supports('field-sizing', 'content'));

const ATTACH_TOOLTIP_LABEL = 'Attach files';

const COMPOSER_SHELL_CLASS =
	'composer-shell mx-auto w-full max-w-[48rem] rounded-[28px] p-px transition-colors duration-200';

const COMPOSER_INNER_CLASS =
	'composer-inner rounded-[27px] border border-[var(--hairline)] transition-colors duration-200';

export function PromptComposerView({
	prompt = '',
	onPromptChange,
	attachments,
	onAttachFiles,
	onRemoveAttachment,
	modelCatalog,
	selectedModel = defaultModelId,
	onSelectedModelChange,
	configuredProviders = ['spikonado'],
	providersReady = true,
	selectedCompletionProvider = 'spikonado',
	onSelectedCompletionProviderChange,
	selectedReasoningEffort = defaultReasoningEffort,
	onSelectedReasoningEffortChange,
	fastMode = false,
	onFastModeChange,
	pendingQuestion = null,
	showContinueWorking = false,
	onContinueWorking,
	runningCommands = null,
	selectedQuestionOptionId = null,
	onSelectedQuestionOptionIdChange,
	canSend,
	isSubmitting,
	isStarting,
	isRunning,
	runStartedAt,
	projectSkills = null,
	projectPaths = null,
	onSubmit,
	onCancel,
	usage,
	usageFailed
}: PromptComposerViewProps) {
	const [now, setNow] = useState(() => Date.now());
	const continueWorkingVisible = showContinueWorking && Boolean(onContinueWorking);

	useEffect(() => {
		const interval = setInterval(() => {
			setNow(Date.now());
		}, 1_000);

		return () => {
			clearInterval(interval);
		};
	}, []);

	const providerOptions = configuredProviders.map((provider) => ({
		id: provider,
		label:
			provider === 'spikonado'
				? 'Spikonado'
				: provider === 'chatgpt'
					? 'ChatGPT Subscription'
					: 'OpenAI API'
	}));

	const modelOptions = modelCatalog
		? modelOptionsForCompletionProvider(modelCatalog, selectedCompletionProvider)
		: [];

	const selectedCatalogModel = modelCatalog
		? getCatalogModel(modelCatalog, selectedModel)
		: undefined;

	// Fast mode only runs through Spikonado's gateway; other providers never offer it.
	const selectedFastModeAvailable =
		selectedCompletionProvider === 'spikonado' && selectedCatalogModel?.supportsFastMode === true;

	const canSubmitWithModel =
		(selectedCompletionProvider === 'spikonado' ||
			(providersReady && configuredProviders.includes(selectedCompletionProvider))) &&
		selectedCatalogModel !== undefined &&
		(selectedCompletionProvider !== 'spikonado'
			? selectedCatalogModel.provider === 'openai'
			: usageFailed || usage !== undefined);

	const composerTextarea = useRef<HTMLTextAreaElement | null>(null);
	const attachmentInput = useRef<HTMLInputElement | null>(null);
	const [attachTooltip, setAttachTooltip] = useState<{ top: number; left: number } | null>(null);
	const [skills, setSkills] = useState<SkillSummary[]>([]);

	const [skillsLoadState, setSkillsLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
		'idle'
	);

	const [skillsDismissed, setSkillsDismissed] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [caretPosition, setCaretPosition] = useState(0);
	const [pathsDismissed, setPathsDismissed] = useState(false);
	const [pathHighlightedIndex, setPathHighlightedIndex] = useState(0);
	const skillsRequestId = useRef(0);
	const skillsCacheKey = useRef<string | null | undefined>(undefined);
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [trackedPendingQuestionId, setTrackedPendingQuestionId] = useState<string | null>(null);

	const answeringQuestion = pendingQuestion != null;
	const composerLocked = (isRunning && !answeringQuestion) || isSubmitting;

	// Unknown policies count as metered, matching backend enforcement.
	const selectedModelUnmetered = selectedCatalogModel?.usagePolicy === 'unlimited';

	// The cached result can outlive its own reset time because the query only
	// re-runs when the limiter document changes, so expire it on the local clock.
	const usageBlocked =
		usage?.exhausted === true &&
		(usage.resetsAt === null || usage.resetsAt > now) &&
		!selectedModelUnmetered &&
		selectedCompletionProvider === 'spikonado';

	const unlimitedAlternativeLabel = (() => {
		if (!modelCatalog) return null;

		const option = modelOptions.find(
			(candidate) => getCatalogModel(modelCatalog, candidate.id)?.usagePolicy === 'unlimited'
		);

		return option?.label ?? null;
	})();

	const composerNotice = (() => {
		if (!usageBlocked || usage === undefined) return null;

		const keepGoing =
			unlimitedAlternativeLabel !== null
				? `Switch to ${unlimitedAlternativeLabel} or upgrade your subscription to keep going.`
				: 'Upgrade your subscription to keep going.';

		if (usage.resetsAt === null) return keepGoing;

		return `Your limit resets in ${formatCountdownDuration(usage.resetsAt - now)}. ${keepGoing}`;
	})();

	const hasMessageContent = Boolean(prompt.trim()) || attachments.length > 0;

	const canAnswerQuestion = canSubmitQuestionAnswer({
		selectedOptionId: selectedQuestionOptionId,
		text: prompt
	});

	const canSubmitContent = answeringQuestion ? canAnswerQuestion : hasMessageContent;
	const attachmentsPending = attachments.some((attachment) => attachment.status !== 'ready');
	const canAttachMore = !composerLocked && !answeringQuestion;
	const dollarQuery = getActiveDollarQuery(prompt, caretPosition);
	const atMention = getActiveAtMention(prompt, caretPosition);
	const atQuery = atMention?.query ?? null;

	const skillsPopupOpen =
		dollarQuery !== null && atQuery === null && !skillsDismissed && !answeringQuestion;

	const pathsPopupOpen = atQuery !== null && !pathsDismissed && !answeringQuestion && !isSubmitting;
	const paths = useComposerPaths(projectPaths, pathsPopupOpen ? atQuery : null);
	const activePathIndex = Math.min(pathHighlightedIndex, Math.max(0, paths.entries.length - 1));
	const popupOpen = skillsPopupOpen || pathsPopupOpen;

	const filteredSkills = useMemo(
		() => (dollarQuery === null ? [] : filterSkills(skills, dollarQuery)),
		[dollarQuery, skills]
	);

	const activeOptionId =
		pathsPopupOpen && paths.entries[activePathIndex]
			? `composer-path-option-${activePathIndex}`
			: skillsPopupOpen && filteredSkills.length > 0
				? `composer-skill-option-${highlightedIndex}`
				: undefined;

	const syncCaretFromTextarea = useCallback(() => {
		setCaretPosition(composerTextarea.current?.selectionStart ?? prompt.length);
	}, [prompt.length]);

	/** Fallback only when field-sizing is unavailable; CSS handles modern browsers. */
	const syncComposerHeight = useCallback(() => {
		const textarea = composerTextarea.current;

		if (!textarea || SUPPORTS_FIELD_SIZING) {
			return;
		}

		textarea.style.height = `${COMPOSER_MIN_HEIGHT_PX}px`;

		const nextHeight = Math.min(
			Math.max(textarea.scrollHeight, COMPOSER_MIN_HEIGHT_PX),
			COMPOSER_MAX_HEIGHT_PX
		);

		textarea.style.height = `${nextHeight}px`;
		textarea.style.overflowY = textarea.scrollHeight > nextHeight ? 'auto' : 'hidden';
	}, []);

	const invalidateSkillsCache = useCallback(() => {
		setSkills([]);
		setSkillsLoadState('idle');
		setSkillsDismissed(false);
		setHighlightedIndex(0);
		skillsRequestId.current += 1;
	}, []);

	const ensureSkillsLoaded = useCallback(
		async (force = false) => {
			if (
				skillsLoadState === 'loading' ||
				((skillsLoadState === 'ready' || skillsLoadState === 'error') && !force)
			) {
				return;
			}

			if (!projectSkills?.load) {
				setSkills([]);
				setSkillsLoadState('ready');

				return;
			}

			const requestId = ++skillsRequestId.current;
			setSkillsLoadState('loading');

			try {
				const nextSkills = await projectSkills.load();

				if (requestId !== skillsRequestId.current) {
					return;
				}

				setSkills(nextSkills);
				setSkillsLoadState('ready');
			} catch {
				if (requestId !== skillsRequestId.current) {
					return;
				}

				setSkills([]);
				setSkillsLoadState('error');
			}
		},
		[projectSkills, skillsLoadState]
	);

	function selectSkill(skill: SkillSummary) {
		const selection = applySkillSelection(prompt, caretPosition, skill.name);

		if (!selection) {
			return;
		}

		onPromptChange?.(selection.text);
		setCaretPosition(selection.caret);
		setSkillsDismissed(true);
		queueMicrotask(() => {
			const textarea = composerTextarea.current;

			if (!textarea) {
				return;
			}

			textarea.focus();
			textarea.setSelectionRange(selection.caret, selection.caret);
			syncComposerHeight();
		});
	}

	function selectPath(entry: WorkspaceSearchEntry) {
		const selection = applyPathSelection(prompt, caretPosition, entry);

		if (!selection) return;
		onPromptChange?.(selection.text);
		setCaretPosition(selection.caret);
		setPathsDismissed(true);
		queueMicrotask(() => {
			const textarea = composerTextarea.current;

			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(selection.caret, selection.caret);
			syncComposerHeight();
		});
	}

	function handleAttachmentInputChange(event: React.ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const files = Array.from(input.files ?? []);
		input.value = '';

		if (files.length > 0) {
			onAttachFiles(files);
		}
	}

	function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
		const files = Array.from(event.clipboardData.files);

		if (files.length === 0 || !canAttachMore) {
			return;
		}

		if (!event.clipboardData.getData('text/plain')) {
			event.preventDefault();
		}

		onAttachFiles(files);
	}

	function handleFileDragEnter(event: React.DragEvent<HTMLDivElement>) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();

		if (canAttachMore) setDraggingFiles(true);
	}

	function handleFileDragOver(event: React.DragEvent<HTMLDivElement>) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = canAttachMore ? 'copy' : 'none';
	}

	function handleFileDragLeave(event: React.DragEvent<HTMLDivElement>) {
		const composer = event.currentTarget;
		const related = event.relatedTarget;

		if (related instanceof Node && composer.contains(related)) {
			return;
		}

		setDraggingFiles(false);
	}

	function handleFileDrop(event: React.DragEvent<HTMLDivElement>) {
		if (!containsDraggedFiles(event.dataTransfer)) return;
		event.preventDefault();
		setDraggingFiles(false);

		if (!canAttachMore) return;
		const files = Array.from(event.dataTransfer.files);

		if (files.length > 0) {
			onAttachFiles(files);
		}
	}

	function showAttachTooltip(
		event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>
	) {
		const target = event.currentTarget;

		if (target.disabled) {
			return;
		}

		const rect = target.getBoundingClientRect();
		setAttachTooltip({
			top: rect.top - 8,
			left: rect.left + rect.width / 2
		});
	}

	function hideAttachTooltip() {
		setAttachTooltip(null);
	}

	function handleComposerKeydown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (event.nativeEvent.isComposing) return;

		if (pathsPopupOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const count = paths.entries.length;

				if (count > 0) {
					const delta = event.key === 'ArrowDown' ? 1 : -1;
					setPathHighlightedIndex((activePathIndex + delta + count) % count);
				}

				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				setPathsDismissed(true);

				return;
			}

			if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
				const entry = paths.entries[activePathIndex];

				if (entry) {
					event.preventDefault();
					selectPath(entry);

					return;
				}
			}
		}

		if (skillsPopupOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();

				if (filteredSkills.length === 0) {
					return;
				}

				const delta = event.key === 'ArrowDown' ? 1 : -1;
				setHighlightedIndex(
					(current) => (current + delta + filteredSkills.length) % filteredSkills.length
				);

				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				setSkillsDismissed(true);

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

		if (
			!shouldSubmitComposerFromKeydown({
				key: event.key,
				shiftKey: event.shiftKey,
				isComposing: event.nativeEvent.isComposing
			})
		) {
			return;
		}

		event.preventDefault();
		onSubmit();
	}

	function toggleQuestionOption(optionId: string) {
		onSelectedQuestionOptionIdChange?.(selectedQuestionOptionId === optionId ? null : optionId);
	}

	function handleModelChange(modelId: CatalogModelId) {
		if (!modelCatalog) return;
		onSelectedModelChange?.(modelId);
		const model = getCatalogModel(modelCatalog, modelId);

		if (model) onSelectedReasoningEffortChange?.(model.defaultReasoningEffort);
	}

	function handleProviderChange(provider: CompletionProvider) {
		if (!modelCatalog) return;
		onSelectedCompletionProviderChange?.(provider);

		const modelId = resolveModelForCompletionProvider(modelCatalog, provider, selectedModel);

		if (!modelId) return;
		onSelectedModelChange?.(modelId);
		onSelectedReasoningEffortChange?.(
			getCatalogModel(modelCatalog, modelId)?.defaultReasoningEffort ??
				modelCatalog.defaultReasoningEffort
		);
		onFastModeChange?.(false);
	}

	useEffect(() => {
		if (!modelCatalog) return;

		const nextProvider =
			providersReady && !configuredProviders.includes(selectedCompletionProvider)
				? 'spikonado'
				: selectedCompletionProvider;

		if (nextProvider !== selectedCompletionProvider) {
			onSelectedCompletionProviderChange?.(nextProvider);
		}

		const resolvedModel = resolveModelForCompletionProvider(
			modelCatalog,
			nextProvider,
			selectedModel
		);

		if (resolvedModel && resolvedModel !== selectedModel) {
			onSelectedModelChange?.(resolvedModel);
			onSelectedReasoningEffortChange?.(
				getCatalogModel(modelCatalog, resolvedModel)?.defaultReasoningEffort ??
					modelCatalog.defaultReasoningEffort
			);
			onFastModeChange?.(false);
		}
	}, [
		modelCatalog,
		providersReady,
		configuredProviders,
		selectedCompletionProvider,
		selectedModel,
		onSelectedCompletionProviderChange,
		onSelectedModelChange,
		onSelectedReasoningEffortChange,
		onFastModeChange
	]);

	useEffect(() => {
		if (selectedCompletionProvider !== 'spikonado' && fastMode) {
			onFastModeChange?.(false);
		}
	}, [selectedCompletionProvider, fastMode, onFastModeChange]);

	useEffect(() => {
		if (!selectedCatalogModel) return;

		if (fastMode && !selectedCatalogModel.supportsFastMode) {
			onFastModeChange?.(false);
		}
	}, [selectedCatalogModel, fastMode, onFastModeChange]);

	useEffect(() => {
		syncComposerHeight();
	}, [prompt, syncComposerHeight]);

	useEffect(() => {
		if (!canAttachMore) setDraggingFiles(false);
	}, [canAttachMore]);

	useEffect(() => {
		const nextId = pendingQuestion?.questionId ?? null;

		if (nextId === trackedPendingQuestionId) return;
		setTrackedPendingQuestionId(nextId);

		if (selectedQuestionOptionId !== null) {
			onSelectedQuestionOptionIdChange?.(null);
		}

		// Drop answer draft when the pending question changes or clears so it
		// cannot leak into the next question or a later normal send.
		if (prompt.trim()) {
			onPromptChange?.('');
		}
	}, [
		pendingQuestion,
		trackedPendingQuestionId,
		selectedQuestionOptionId,
		prompt,
		onSelectedQuestionOptionIdChange,
		onPromptChange
	]);

	useEffect(() => {
		const path = projectSkills?.workspacePath ?? null;

		if (skillsCacheKey.current !== path) {
			skillsCacheKey.current = path;
			invalidateSkillsCache();
		}

		if (dollarQuery === null) {
			setSkillsDismissed(false);

			return;
		}

		if (skillsDismissed) {
			return;
		}

		void ensureSkillsLoaded();
	}, [projectSkills, dollarQuery, skillsDismissed, ensureSkillsLoaded, invalidateSkillsCache]);

	useEffect(() => {
		setHighlightedIndex(0);
	}, [filteredSkills]);

	useEffect(() => {
		setPathsDismissed(false);
		setPathHighlightedIndex(0);
	}, [atQuery, atMention?.start, projectPaths]);

	return (
		<>
			<footer className="shrink-0 px-6 py-4">
				<div className="mx-auto max-w-336">
					{runStartedAt !== null && runStartedAt > 0 && Number.isFinite(runStartedAt) ? (
						<div className="text-muted-foreground mb-3 flex items-center gap-2 px-4 text-[11px]">
							<span className="inline-flex items-center gap-0.75">
								<span className="bg-foreground/28 size-1 animate-pulse rounded-full"></span>
								<span className="bg-foreground/28 size-1 animate-pulse rounded-full [animation-delay:200ms]"></span>
								<span className="bg-foreground/28 size-1 animate-pulse rounded-full [animation-delay:400ms]"></span>
							</span>
							<span>
								Working for <RunElapsed startedAt={runStartedAt} />
							</span>
						</div>
					) : isSubmitting ? (
						<div
							className="text-muted-foreground mb-3 flex items-center gap-2 px-4 text-[11px]"
							role="status"
							aria-live="polite"
						>
							<span className="bg-foreground/28 size-1.5 animate-pulse rounded-full"></span>
							<span>{isStarting ? 'Starting agent…' : 'Sending request…'}</span>
						</div>
					) : null}

					{runningCommands && (
						<RunningCommands {...runningCommands} collapseWhen={continueWorkingVisible} />
					)}

					{continueWorkingVisible ? (
						<div className="mx-auto mb-3 w-full max-w-[48rem] px-4">
							<button
								type="button"
								className="border-border bg-surface/80 text-foreground hover:bg-hover-fill rounded-full border px-3 py-1.5 text-[13px] font-medium transition"
								onClick={onContinueWorking}
								disabled={isSubmitting}
							>
								Continue working
							</button>
						</div>
					) : null}

					<div
						className={COMPOSER_SHELL_CLASS}
						role="group"
						aria-label="Message composer"
						onDragEnter={handleFileDragEnter}
						onDragOver={handleFileDragOver}
						onDragLeave={handleFileDragLeave}
						onDrop={handleFileDrop}
					>
						<div className={`${COMPOSER_INNER_CLASS} relative`}>
							{draggingFiles ? (
								<div
									className="bg-surface/90 border-primary/70 pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-[27px] border-2 border-dashed backdrop-blur-sm"
									role="status"
									aria-live="polite"
								>
									<Paperclip className="text-primary size-5" aria-hidden="true" />
									<span className="text-foreground text-sm font-medium">Drop files to attach</span>
								</div>
							) : null}
							<div className="relative flex min-h-33 flex-col px-4 pt-4 pb-2.5">
								{composerNotice ? (
									<div
										className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-3"
										role="alert"
									>
										<CircleAlert
											className="mt-0.5 size-4 shrink-0 text-amber-800 dark:text-amber-200"
											aria-hidden="true"
										/>
										<div className="min-w-0">
											<p className="text-[13px] leading-5 font-medium text-amber-800 dark:text-amber-200">
												You're out of usage
											</p>
											<p className="text-[12.5px] leading-5 text-amber-800/90 dark:text-amber-200/90">
												{composerNotice}
											</p>
										</div>
									</div>
								) : null}
								{pendingQuestion ? (
									<AgentQuestion
										question={pendingQuestion.question}
										options={pendingQuestion.options}
										selectedOptionId={selectedQuestionOptionId}
										onToggleOption={toggleQuestionOption}
									/>
								) : null}
								{attachments.length > 0 && !answeringQuestion ? (
									<ComposerAttachments
										attachments={attachments}
										disabled={composerLocked}
										onRemove={onRemoveAttachment}
									/>
								) : null}
								<div className="relative min-h-0 flex-1">
									{pathsPopupOpen ? (
										<ComposerPathMenu
											loadState={paths.loadState}
											entries={paths.entries}
											scanning={paths.scanning}
											highlightedIndex={activePathIndex}
											onRetry={() => {
												paths.retry();
												composerTextarea.current?.focus();
											}}
											onHighlight={setPathHighlightedIndex}
											onSelect={selectPath}
										/>
									) : null}
									{skillsPopupOpen ? (
										<ComposerSkillMenu
											loadState={skillsLoadState}
											skills={filteredSkills}
											highlightedIndex={highlightedIndex}
											onRetry={() => void ensureSkillsLoaded(true)}
											onHighlight={(index) => {
												setHighlightedIndex(index);
											}}
											onSelect={selectSkill}
										/>
									) : null}
									<textarea
										ref={composerTextarea}
										value={prompt}
										rows={1}
										className="text-foreground placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-17 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-[14px] leading-6 outline-none"
										placeholder={
											answeringQuestion
												? 'Add detail, or type a custom answer'
												: 'Ask anything, @tag files/directories, or use $ to show available skills'
										}
										disabled={isSubmitting}
										role="combobox"
										aria-autocomplete="list"
										aria-haspopup="listbox"
										aria-expanded={popupOpen}
										aria-controls={
											pathsPopupOpen
												? 'composer-paths-listbox'
												: skillsPopupOpen
													? 'composer-skills-listbox'
													: undefined
										}
										aria-activedescendant={activeOptionId}
										autoComplete="off"
										onKeyDown={handleComposerKeydown}
										onPaste={handleComposerPaste}
										onFocus={syncCaretFromTextarea}
										onChange={(event) => {
											onPromptChange?.(event.target.value);
											syncCaretFromTextarea();
											syncComposerHeight();
										}}
										onKeyUp={syncCaretFromTextarea}
										onClick={syncCaretFromTextarea}
										onSelect={syncCaretFromTextarea}
									/>
								</div>

								<div className="flex min-w-0 flex-nowrap items-center justify-between gap-3 overflow-visible px-0 pt-2.5 pb-0">
									<div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-visible p-1">
										<input
											ref={attachmentInput}
											type="file"
											className="hidden"
											multiple
											onChange={handleAttachmentInputChange}
										/>
										<button
											type="button"
											className="text-muted-foreground enabled:hover:text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition enabled:cursor-pointer disabled:opacity-40"
											aria-label={ATTACH_TOOLTIP_LABEL}
											disabled={!canAttachMore}
											onMouseEnter={showAttachTooltip}
											onMouseLeave={hideAttachTooltip}
											onFocus={showAttachTooltip}
											onBlur={hideAttachTooltip}
											onClick={() => {
												hideAttachTooltip();
												attachmentInput.current?.click();
											}}
										>
											<Paperclip className="size-4" aria-hidden="true" />
										</button>

										<div className="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

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
											optionIcon={(option) => (
												<ProviderLogo provider={option.provider} className="size-4 shrink-0" />
											)}
										/>

										{selectedCatalogModel ? (
											<>
												{showsReasoningControl(selectedCatalogModel) ||
												selectedFastModeAvailable ? (
													<div className="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>
												) : null}
												<ReasoningSelector
													model={selectedCatalogModel}
													reasoningEffort={selectedReasoningEffort}
													fastMode={fastMode}
													fastModeAvailable={selectedFastModeAvailable}
													disabled={composerLocked || answeringQuestion}
													className="z-20 shrink-0"
													onReasoningEffortChange={onSelectedReasoningEffortChange}
													onFastModeChange={onFastModeChange}
												/>
											</>
										) : null}

										<div className="bg-hover-fill-strong mx-1 hidden h-4 w-px shrink-0 sm:block"></div>

										<OptionSelector
											value={selectedCompletionProvider}
											options={providerOptions}
											ariaLabel="Select provider"
											menuTitle="Provider"
											disabled={composerLocked || answeringQuestion || !providersReady}
											onValueChange={handleProviderChange}
											className="z-20 shrink-0"
											triggerClassName="h-9 border-0 bg-transparent px-2 text-[15px] text-foreground shadow-none hover:bg-transparent focus-visible:ring-0"
											optionIcon={(option) => (
												<ProviderLogo provider={option.id} className="size-4 shrink-0" />
											)}
										/>
									</div>

									<div className="flex shrink-0 flex-nowrap items-center justify-end gap-2.5">
										{isRunning ? (
											<button
												type="button"
												className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:scale-105 hover:bg-rose-500 disabled:pointer-events-none disabled:opacity-60 disabled:hover:scale-100"
												aria-label="Stop generation"
												title="Stop"
												onClick={onCancel}
											>
												<Square className="size-3.5 fill-current" />
											</button>
										) : null}
										{answeringQuestion || !isRunning ? (
											<button
												type="button"
												className="bg-primary/90 text-primary-foreground hover:bg-primary flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 hover:scale-105 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100"
												onClick={onSubmit}
												disabled={
													!canSend ||
													(!answeringQuestion && !canSubmitWithModel) ||
													(!answeringQuestion && usageBlocked) ||
													isSubmitting ||
													!canSubmitContent ||
													(!answeringQuestion && attachmentsPending)
												}
												aria-label={answeringQuestion ? 'Submit answer' : 'Send message'}
											>
												<ArrowUp className="size-4" />
											</button>
										) : null}
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</footer>

			{attachTooltip ? (
				<div
					className="bg-tooltip text-tooltip-foreground ring-border pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap shadow-lg ring-1"
					style={{ top: attachTooltip.top, left: attachTooltip.left }}
					role="tooltip"
				>
					{ATTACH_TOOLTIP_LABEL}
				</div>
			) : null}
		</>
	);
}

export default function PromptComposer(props: PromptComposerProps) {
	const convexAuth = useConvexAuth();

	const usageQuery = useQuery_experimental({
		query: api.usage.getMyUsage,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	});

	return (
		<PromptComposerView
			{...props}
			usage={usageQuery.status === 'success' ? usageQuery.data : undefined}
			usageFailed={usageQuery.status === 'error'}
		/>
	);
}
