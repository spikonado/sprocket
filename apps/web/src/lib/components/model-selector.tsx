import { Check, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import ModelReasoningOptions from './model-reasoning-options';
import ProviderLogo from './provider-logo';
import { listenOpenMenuDismiss } from './ui/menu-dismiss';
import { cn } from '$lib/utils';

export default function ModelSelector({
	models,
	modelId,
	reasoningEffort,
	fastMode,
	allowsFastMode,
	disabled,
	onSelect,
	onFastModeChange
}: {
	models: CatalogModel[];
	modelId: string;
	reasoningEffort: string;
	fastMode: boolean;
	allowsFastMode: boolean;
	disabled: boolean;
	onSelect: (modelId: string, effort: string) => void;
	onFastModeChange?: (fastMode: boolean) => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 0 });
	const [reasoningTop, setReasoningTop] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const modelButtons = useRef(new Map<string, HTMLButtonElement>());
	const reasoningRef = useRef<HTMLDivElement>(null);
	const touchPreviewRef = useRef(false);
	const selectedModel = models.find((model) => model.id === modelId);
	const fastModeAvailable = allowsFastMode && selectedModel?.supportsFastMode;

	const previewModel = models.find((model) => model.id === previewId);

	const summary = [
		selectedModel && showsReasoningControl(selectedModel)
			? reasoningEffortLabel(reasoningEffort)
			: null,
		fastModeAvailable && fastMode ? 'Fast' : null
	]
		.filter(Boolean)
		.join(' · ');

	function closeMenu() {
		setIsOpen(false);
		setPreviewId(null);
	}

	function selectModel(model: CatalogModel, effort = model.defaultReasoningEffort) {
		onSelect(model.id, effort);
		closeMenu();
		triggerRef.current?.focus();
	}

	function focusModel(index: number) {
		const model = models[(index + models.length) % models.length];

		if (model) modelButtons.current.get(model.id)?.focus();
	}

	useLayoutEffect(() => {
		if (!isOpen) return;

		function updatePosition() {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const menu = menuRef.current?.getBoundingClientRect();

			if (!trigger || !menu) return;
			setPosition({
				left: Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8)),
				bottom: window.innerHeight - trigger.top + 12,
				maxHeight: Math.max(0, trigger.top - 20)
			});
			const row = previewId ? modelButtons.current.get(previewId)?.getBoundingClientRect() : null;
			const options = reasoningRef.current;
			const defaultOption = options?.querySelector<HTMLButtonElement>('[data-default-reasoning]');

			if (!row || !options || !defaultOption) return;
			const menuTop = trigger.top - 12 - menu.height;

			const alignedTop =
				row.top -
				menu.top +
				row.height / 2 -
				defaultOption.offsetTop -
				defaultOption.offsetHeight / 2;

			setReasoningTop(
				Math.max(
					8 - menuTop,
					Math.min(alignedTop, window.innerHeight - menuTop - options.offsetHeight - 8)
				)
			);
		}

		updatePosition();
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);

		return () => {
			window.removeEventListener('resize', updatePosition);
			window.removeEventListener('scroll', updatePosition, true);
		};
	}, [isOpen, previewId, fastModeAvailable, position.maxHeight]);

	useEffect(() => {
		if (!isOpen) return;
		(modelButtons.current.get(modelId) ?? modelButtons.current.values().next().value)?.focus();

		return listenOpenMenuDismiss({
			getRoot: () => rootRef.current,
			onOutside: closeMenu,
			onEscape: () => {
				closeMenu();
				triggerRef.current?.focus();
			}
		});
	}, [isOpen, modelId]);

	useEffect(() => {
		if (disabled) closeMenu();
	}, [disabled]);

	return (
		<div
			ref={rootRef}
			className={cn('relative min-w-0 flex-1 sm:flex-none', isOpen ? 'z-30' : 'z-20')}
		>
			<button
				ref={triggerRef}
				type="button"
				className="text-foreground focus-visible:ring-ring/60 inline-flex h-11 max-w-full items-center gap-2 rounded-lg px-2 text-[15px] outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 sm:h-9"
				aria-label="Select model"
				title={[selectedModel?.label ?? modelId, summary].filter(Boolean).join(' · ')}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				disabled={disabled}
				onClick={() => (isOpen ? closeMenu() : setIsOpen(true))}
			>
				{selectedModel ? (
					<ProviderLogo provider={selectedModel.provider} className="size-4 shrink-0" />
				) : null}
				<span className="truncate">
					{selectedModel?.label ?? modelId}
					{summary ? <span className="hidden sm:inline"> · {summary}</span> : null}
				</span>
				<ChevronDown
					className={cn('text-muted-foreground size-3 shrink-0', isOpen && 'rotate-180')}
				/>
			</button>
			{isOpen ? (
				<div
					ref={menuRef}
					role="dialog"
					aria-label="Model"
					className="fixed z-50 flex w-[min(19rem,calc(100vw-1rem))] flex-col gap-1 overflow-y-auto sm:block sm:w-[30.75rem] sm:overflow-visible"
					style={position}
				>
					<div
						className="bg-popover/96 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl sm:w-[19rem]"
						style={{ maxHeight: position.maxHeight }}
					>
						<div role="group" aria-label="Models" className="min-h-0 space-y-0.5 overflow-y-auto">
							{models.map((model, index) => (
								<button
									key={model.id}
									ref={(button) => {
										if (button) modelButtons.current.set(model.id, button);
										else modelButtons.current.delete(model.id);
									}}
									type="button"
									aria-label={model.label}
									aria-pressed={model.id === modelId}
									aria-haspopup={showsReasoningControl(model) ? 'true' : undefined}
									className={cn(
										'text-foreground focus-visible:ring-ring/60 hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2',
										model.id === previewId && 'bg-hover-fill'
									)}
									onMouseEnter={() => setPreviewId(model.id)}
									onFocus={() => setPreviewId(model.id)}
									onPointerDown={(event) => {
										touchPreviewRef.current =
											event.pointerType === 'touch' &&
											showsReasoningControl(model) &&
											previewId !== model.id;
									}}
									onClick={() => {
										if (touchPreviewRef.current) {
											touchPreviewRef.current = false;
											setPreviewId(model.id);

											return;
										}

										selectModel(model);
									}}
									onKeyDown={(event) => {
										if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
											event.preventDefault();
											focusModel(index + (event.key === 'ArrowDown' ? 1 : -1));
										} else if (event.key === 'ArrowRight' && showsReasoningControl(model)) {
											event.preventDefault();
											reasoningRef.current
												?.querySelector<HTMLButtonElement>('[data-default-reasoning]')
												?.focus();
										}
									}}
								>
									<ProviderLogo provider={model.provider} className="size-4 shrink-0" />
									<span className="min-w-0 flex-1 truncate font-medium">{model.label}</span>
									{model.id === modelId ? (
										<Check className="text-accent-strong size-3.5 shrink-0" />
									) : null}
									{showsReasoningControl(model) ? (
										<ChevronRight className="text-muted-foreground size-3 shrink-0" />
									) : null}
								</button>
							))}
						</div>
						{fastModeAvailable ? (
							<div
								role="group"
								aria-label="Speed"
								className="shrink-0 border-t border-[var(--hairline)] pt-1"
							>
								<button
									type="button"
									role="switch"
									className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2"
									aria-checked={fastMode}
									onClick={() => onFastModeChange?.(!fastMode)}
								>
									<Zap className="size-3.5 shrink-0 text-amber-400" />
									<span>Fast</span>
									<span
										className={cn(
											'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
											fastMode ? 'bg-foreground' : 'bg-hover-fill-strong'
										)}
										aria-hidden="true"
									>
										<span
											className={cn(
												'bg-background inline-block size-3.5 rounded-full transition',
												fastMode ? 'translate-x-[18px]' : 'translate-x-[3px]'
											)}
										/>
									</span>
								</button>
							</div>
						) : null}
					</div>
					{previewModel && showsReasoningControl(previewModel) ? (
						<div
							ref={reasoningRef}
							role="group"
							aria-label={`Reasoning for ${previewModel.label}`}
							className="bg-popover/96 max-h-[50vh] shrink-0 overflow-y-auto rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl sm:absolute sm:right-0 sm:w-46"
							style={{ top: reasoningTop }}
							onKeyDown={(event) => {
								if (event.key === 'ArrowLeft') {
									event.preventDefault();
									modelButtons.current.get(previewModel.id)?.focus();
								}
							}}
						>
							<ModelReasoningOptions
								model={previewModel}
								reasoningEffort={previewModel.id === modelId ? reasoningEffort : ''}
								onSelect={(effort) => selectModel(previewModel, effort)}
							/>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
