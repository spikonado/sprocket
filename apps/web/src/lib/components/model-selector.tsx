import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import ModelSettings from './model-settings';
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
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const modelButtons = useRef(new Map<string, HTMLButtonElement>());
	const settingsRef = useRef<HTMLDivElement>(null);
	const touchPreviewRef = useRef(false);
	const selectedModel = models.find((model) => model.id === modelId);

	const filteredModels = models.filter((model) =>
		model.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
	);

	const previewModel = filteredModels.find((model) => model.id === previewId);
	const previewHasSettings = previewModel && hasSettings(previewModel);

	const summary = [
		selectedModel && showsReasoningControl(selectedModel)
			? reasoningEffortLabel(reasoningEffort)
			: null,
		allowsFastMode && selectedModel?.supportsFastMode && fastMode ? 'Fast' : null
	]
		.filter(Boolean)
		.join(' · ');

	function hasSettings(model: CatalogModel) {
		return showsReasoningControl(model) || (allowsFastMode && model.supportsFastMode);
	}

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
		}

		updatePosition();
		window.addEventListener('resize', updatePosition);

		return () => window.removeEventListener('resize', updatePosition);
	}, [isOpen, previewHasSettings]);

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
		<div ref={rootRef} className="relative z-20 min-w-0">
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
					className={cn(
						'bg-popover/96 fixed z-50 h-80 overflow-hidden rounded-[18px] border border-[var(--hairline)] shadow-[var(--composer-shadow)] backdrop-blur-xl',
						previewHasSettings
							? 'w-[min(35rem,calc(100vw-1rem))]'
							: 'w-[min(20rem,calc(100vw-1rem))]'
					)}
					style={position}
				>
					<div
						className={cn(
							'grid h-full',
							previewHasSettings && 'grid-cols-[minmax(0,1fr)_minmax(9rem,0.65fr)]'
						)}
					>
						<div className="flex min-h-0 min-w-0 flex-col p-2">
							<label className="text-muted-foreground flex h-10 items-center gap-2 border-b border-[var(--hairline)] px-2">
								<Search className="size-4 shrink-0" />
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
							<div className="min-h-0 space-y-0.5 overflow-y-auto pt-1.5">
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
										className={cn(
											'text-foreground focus-visible:ring-ring/60 hover:bg-hover-fill flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2',
											model.id === previewId && 'bg-hover-fill'
										)}
										onMouseEnter={() => setPreviewId(model.id)}
										onFocus={() => setPreviewId(model.id)}
										onPointerDown={(event) => {
											touchPreviewRef.current =
												event.pointerType === 'touch' &&
												hasSettings(model) &&
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
											} else if (event.key === 'ArrowRight' && hasSettings(model)) {
												event.preventDefault();
												settingsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
											}
										}}
									>
										<ProviderLogo provider={model.provider} className="size-4 shrink-0" />
										<span className="min-w-0 flex-1 truncate font-medium">{model.label}</span>
										{model.id === previewId && showsReasoningControl(model) ? (
											<span
												className="text-muted-foreground shrink-0 text-xs"
												title="Default reasoning"
											>
												{reasoningEffortLabel(model.defaultReasoningEffort)}
											</span>
										) : null}
										{model.id === modelId ? (
											<Check className="text-accent-strong size-3.5 shrink-0" />
										) : null}
										{hasSettings(model) ? (
											<ChevronRight className="text-muted-foreground size-3 shrink-0" />
										) : null}
									</button>
								))}
								{filteredModels.length === 0 ? (
									<p className="text-muted-foreground px-3 py-5 text-center text-sm">
										No matches found
									</p>
								) : null}
							</div>
						</div>
						{previewModel && previewHasSettings ? (
							<div
								ref={settingsRef}
								role="group"
								aria-label={`Settings for ${previewModel.label}`}
								className="min-h-0 min-w-0 overflow-y-auto border-l border-[var(--hairline)] p-2"
								onKeyDown={(event) => {
									if (event.key === 'ArrowLeft') {
										event.preventDefault();
										modelButtons.current.get(previewModel.id)?.focus();
									}
								}}
							>
								<ModelSettings
									model={previewModel}
									reasoningEffort={
										previewModel.id === modelId
											? reasoningEffort
											: previewModel.defaultReasoningEffort
									}
									fastMode={fastMode}
									fastModeAvailable={allowsFastMode && previewModel.supportsFastMode}
									onReasoningEffortChange={(effort) => selectModel(previewModel, effort)}
									onFastModeChange={(next) => {
										onSelect(
											previewModel.id,
											previewModel.id === modelId
												? reasoningEffort
												: previewModel.defaultReasoningEffort
										);
										onFastModeChange?.(next);
									}}
								/>
							</div>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
