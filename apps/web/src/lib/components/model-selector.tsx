import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import ModelReasoningOptions from './model-reasoning-options';
import {
	availableServiceTiers,
	normalizeServiceTier,
	serviceTierLabel,
	type ServiceTier
} from '$lib/chat/service-tier';
import ServiceTierOptions from './service-tier-options';
import MobileModelSelector from './mobile-model-selector';
import { useMobileSelector } from './ui/use-mobile-selector';
import ProviderLogo from './provider-logo';
import { listenOpenMenuDismiss } from './ui/menu-dismiss';
import { cn } from '$lib/utils';

export default function ModelSelector({
	models,
	modelId,
	reasoningEffort,
	serviceTier,
	isDirectOpenAIByok,
	disabled,
	onSelect,
	onServiceTierChange
}: {
	models: readonly CatalogModel[];
	modelId: string;
	reasoningEffort: string;
	serviceTier: ServiceTier;
	isDirectOpenAIByok: (model: CatalogModel) => boolean;
	disabled: boolean;
	onSelect: (modelId: string, effort: string) => void;
	onServiceTierChange?: (tier: ServiceTier) => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const mobile = useMobileSelector();
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 0 });
	const [settingsTop, setSettingsTop] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const modelButtons = useRef(new Map<string, HTMLButtonElement>());
	const settingsRef = useRef<HTMLDivElement>(null);
	const touchPreviewRef = useRef(false);
	const focusOnOpenRef = useRef(false);
	const selectedModel = models.find((model) => model.id === modelId);
	const previewModel = models.find((model) => model.id === previewId);

	const previewTiers = previewModel
		? availableServiceTiers(previewModel, isDirectOpenAIByok(previewModel))
		: [];

	const summary = [
		selectedModel && showsReasoningControl(selectedModel)
			? reasoningEffortLabel(reasoningEffort)
			: null,
		serviceTier !== 'standard' ? serviceTierLabel(serviceTier) : null
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

	function hasSettings(model: CatalogModel) {
		return (
			showsReasoningControl(model) ||
			availableServiceTiers(model, isDirectOpenAIByok(model)).length > 1
		);
	}

	function settingsAnchor() {
		const settings = settingsRef.current;

		return (
			settings?.querySelector<HTMLButtonElement>('[data-default-reasoning]') ??
			settings?.querySelector<HTMLButtonElement>('button')
		);
	}

	function focusModel(index: number) {
		const model = models[(index + models.length) % models.length];

		if (model) modelButtons.current.get(model.id)?.focus();
	}

	useLayoutEffect(() => {
		if (!isOpen || mobile) return;

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
			const options = settingsRef.current;
			const anchor = settingsAnchor();

			if (!row || !options || !anchor) return;
			const menuTop = trigger.top - 12 - menu.height;

			const alignedTop =
				row.top - menu.top + row.height / 2 - anchor.offsetTop - anchor.offsetHeight / 2;

			setSettingsTop(
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
	}, [isOpen, mobile, previewId, previewTiers.length, position.maxHeight]);

	useEffect(() => {
		if (!isOpen || mobile || !focusOnOpenRef.current) return;
		focusOnOpenRef.current = false;
		(modelButtons.current.get(modelId) ?? modelButtons.current.values().next().value)?.focus();
	}, [isOpen, mobile, modelId]);

	useEffect(() => {
		if (!isOpen || mobile) return;

		return listenOpenMenuDismiss({
			getRoot: () => rootRef.current,
			onOutside: closeMenu,
			onEscape: () => {
				closeMenu();
				triggerRef.current?.focus();
			}
		});
	}, [isOpen, mobile]);

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
				data-ph-capture-attribute-action="open_model_selector"
				title={[selectedModel?.label ?? modelId, summary].filter(Boolean).join(' · ')}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				disabled={disabled}
				onClick={() => {
					if (isOpen) {
						closeMenu();
					} else {
						focusOnOpenRef.current = true;
						setIsOpen(true);
					}
				}}
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
			{isOpen && mobile ? (
				<MobileModelSelector
					models={models}
					modelId={modelId}
					reasoningEffort={reasoningEffort}
					serviceTier={serviceTier}
					isDirectOpenAIByok={isDirectOpenAIByok}
					onDismiss={closeMenu}
					returnFocusRef={triggerRef}
					onApply={(model, effort, tier) => {
						selectModel(model, effort);
						onServiceTierChange?.(tier);
					}}
				/>
			) : isOpen ? (
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
									data-ph-capture-attribute-action="select_model"
									data-ph-capture-attribute-model={model.id}
									aria-pressed={model.id === modelId}
									aria-haspopup={hasSettings(model) ? 'true' : undefined}
									className={cn(
										'text-foreground focus-visible:ring-ring/60 hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2',
										model.id === previewId && 'bg-hover-fill'
									)}
									onMouseEnter={() => setPreviewId(model.id)}
									onFocus={() => setPreviewId(model.id)}
									onPointerDown={(event) => {
										touchPreviewRef.current =
											event.pointerType === 'touch' && hasSettings(model) && previewId !== model.id;
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
											settingsAnchor()?.focus();
										}
									}}
								>
									<ProviderLogo provider={model.provider} className="size-4 shrink-0" />
									<span className="min-w-0 flex-1 truncate">{model.label}</span>
									{model.id === modelId ? (
										<Check className="text-accent-strong size-3.5 shrink-0" />
									) : null}
									{hasSettings(model) ? (
										<ChevronRight className="text-muted-foreground size-3 shrink-0" />
									) : null}
								</button>
							))}
						</div>
					</div>
					{previewModel && hasSettings(previewModel) ? (
						<div
							ref={settingsRef}
							role="group"
							aria-label={`${showsReasoningControl(previewModel) ? 'Reasoning' : 'Speed'} for ${previewModel.label}`}
							className="bg-popover/96 max-h-[50dvh] shrink-0 overflow-y-auto rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl sm:absolute sm:right-0 sm:w-46"
							style={{ top: settingsTop }}
							onKeyDown={(event) => {
								if (event.key === 'ArrowLeft') {
									event.preventDefault();
									modelButtons.current.get(previewModel.id)?.focus();
								} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
									event.preventDefault();

									const buttons = Array.from(
										event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
									);

									const index = buttons.findIndex((button) => button === event.target);
									buttons[
										(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
									]?.focus();
								}
							}}
						>
							{showsReasoningControl(previewModel) ? (
								<ModelReasoningOptions
									model={previewModel}
									reasoningEffort={previewModel.id === modelId ? reasoningEffort : ''}
									onSelect={(effort) => selectModel(previewModel, effort)}
								/>
							) : null}
							{previewTiers.length > 1 ? (
								<ServiceTierOptions
									tiers={previewTiers}
									value={normalizeServiceTier(
										serviceTier,
										previewModel,
										isDirectOpenAIByok(previewModel)
									)}
									onChange={(tier) => {
										onSelect(
											previewModel.id,
											previewModel.id === modelId
												? reasoningEffort
												: previewModel.defaultReasoningEffort
										);
										onServiceTierChange?.(tier);
									}}
								/>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
