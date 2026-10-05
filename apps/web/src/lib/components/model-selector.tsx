import { Check, ChevronDown, ChevronRight, Search, Zap } from 'lucide-react';
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
	const [searchQuery, setSearchQuery] = useState('');
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 0 });
	const [reasoningTop, setReasoningTop] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const modelButtons = useRef(new Map<string, HTMLButtonElement>());
	const reasoningRef = useRef<HTMLDivElement>(null);
	const touchPreviewRef = useRef(false);
	const selectedModel = models.find((model) => model.id === modelId);
	const fastModeAvailable = allowsFastMode && selectedModel?.supportsFastMode;

	const filteredModels = models.filter((model) =>
		model.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
	);

	const previewModel = filteredModels.find((model) => model.id === previewId);

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
		setSearchQuery('');
		setPreviewId(null);
	}

	function selectModel(model: CatalogModel, effort = model.defaultReasoningEffort) {
		onSelect(model.id, effort);
		closeMenu();
		triggerRef.current?.focus();
	}

	function focusModel(index: number) {
		const model = filteredModels[(index + filteredModels.length) % filteredModels.length];

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
				maxHeight: Math.max(120, trigger.top - 20)
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
		const menu = menuRef.current;
		menu?.addEventListener('scroll', updatePosition, true);

		return () => {
			window.removeEventListener('resize', updatePosition);
			menu?.removeEventListener('scroll', updatePosition, true);
		};
	}, [isOpen, previewId, searchQuery, fastModeAvailable, position.maxHeight]);

	useEffect(() => {
		if (!isOpen) return;
		searchRef.current?.focus();

		return listenOpenMenuDismiss({
			getRoot: () => rootRef.current,
			onOutside: closeMenu,
			onEscape: () => {
				closeMenu();
				triggerRef.current?.focus();
			}
		});
	}, [isOpen]);

	useEffect(() => {
		if (disabled) closeMenu();
	}, [disabled]);

	return (
		<div
			ref={rootRef}
			className={cn('relative min-w-32 flex-1 sm:min-w-0 sm:flex-none', isOpen ? 'z-30' : 'z-20')}
		>
			<button
				ref={triggerRef}
				type="button"
				className="text-foreground focus-visible:ring-ring/60 inline-flex h-9 max-w-full items-center gap-2 rounded-lg px-2 text-[15px] outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
				aria-label="Select model"
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
					{summary ? ` · ${summary}` : ''}
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
					className="fixed z-50 w-[min(23.75rem,calc(100vw-1rem))]"
					style={position}
				>
					<div
						className="bg-popover/96 flex w-[calc(100%-9.75rem)] flex-col overflow-hidden rounded-xl border border-[var(--hairline)] p-1 shadow-[var(--composer-shadow)] backdrop-blur-xl"
						style={{ maxHeight: position.maxHeight }}
					>
						<label className="text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-2">
							<Search className="size-3.5 shrink-0" />
							<span className="sr-only">Search model</span>
							<input
								ref={searchRef}
								value={searchQuery}
								onChange={(event) => {
									setSearchQuery(event.target.value);
									setPreviewId(null);
								}}
								className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
								placeholder="Search model…"
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing || filteredModels.length === 0) return;

									if (event.key === 'ArrowDown') {
										event.preventDefault();
										focusModel(0);
									} else if (event.key === 'Enter' && searchQuery.trim()) {
										event.preventDefault();
										selectModel(filteredModels[0]);
									}
								}}
							/>
						</label>
						<div role="group" aria-label="Models" className="min-h-0 overflow-y-auto py-1">
							{filteredModels.map((model, index) => (
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
										'text-foreground focus-visible:ring-ring/60 hover:bg-hover-fill flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-2',
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
									<ProviderLogo
										provider={model.provider}
										className="hidden size-4 shrink-0 sm:block"
									/>
									<span className="min-w-0 flex-1 truncate font-medium">{model.label}</span>
									{model.id === modelId ? (
										<Check className="text-accent-strong size-3.5 shrink-0" />
									) : null}
									{showsReasoningControl(model) ? (
										<ChevronRight className="text-muted-foreground size-3 shrink-0" />
									) : null}
								</button>
							))}
							{filteredModels.length === 0 ? (
								<p className="text-muted-foreground px-2 py-3 text-center text-sm">
									No matches found
								</p>
							) : null}
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
									className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-2"
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
							className="bg-popover/96 absolute right-0 w-38 rounded-xl border border-[var(--hairline)] p-1 shadow-[var(--composer-shadow)] backdrop-blur-xl"
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
