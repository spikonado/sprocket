import { Check, ChevronDown, Lock, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { defaultReasoningEffort } from '@convex/lib/models';
import {
	type CatalogModel,
	type FastModeAccess,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import { useLockTooltip } from '$lib/components/ui/lock-tooltip';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';
import Tooltip from '$lib/components/ui/tooltip';
import { cn } from '$lib/utils';

export default function ReasoningSelector({
	model,
	reasoningEffort = defaultReasoningEffort,
	fastMode = false,
	fastModeAccess,
	fastModeLockTooltip,
	disabled = false,
	className = '',
	onReasoningEffortChange,
	onFastModeChange
}: {
	model: CatalogModel;
	reasoningEffort?: string;
	fastMode?: boolean;
	fastModeAccess?: FastModeAccess;
	fastModeLockTooltip?: string;
	disabled?: boolean;
	className?: string;
	onReasoningEffortChange?: (effort: string) => void;
	onFastModeChange?: (fastMode: boolean) => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const lockTooltipState = useLockTooltip();

	const showsReasoning = showsReasoningControl(model);
	const showsFastModeControl = fastModeAccess === 'available' || fastModeAccess === 'locked';

	const triggerText = showsReasoning
		? `${reasoningEffortLabel(reasoningEffort)}${fastMode && model.supportsFastMode ? ' · Fast' : ''}`
		: fastMode
			? 'Fast'
			: 'Speed';

	const triggerLabel =
		showsReasoning && showsFastModeControl
			? 'Select reasoning effort and Fast mode'
			: showsReasoning
				? 'Select reasoning effort'
				: 'Select Fast mode';

	const dialogLabel =
		showsReasoning && showsFastModeControl
			? 'Reasoning and Fast mode'
			: showsReasoning
				? 'Reasoning'
				: 'Fast mode';

	useEffect(() => {
		if (!model.reasoningEfforts.includes(reasoningEffort)) {
			onReasoningEffortChange?.(model.defaultReasoningEffort);
		}

		if ((fastModeAccess === 'unsupported' || fastModeAccess === 'locked') && fastMode) {
			onFastModeChange?.(false);
		}
	}, [model, reasoningEffort, fastMode, fastModeAccess, onReasoningEffortChange, onFastModeChange]);

	function selectReasoning(next: string) {
		onReasoningEffortChange?.(next);
	}

	function toggleFastMode(event: React.MouseEvent) {
		if (fastModeAccess === 'locked') {
			if (fastModeLockTooltip) lockTooltipState.showLockTooltip(event, fastModeLockTooltip, true);

			return;
		}

		if (fastModeAccess === 'available') onFastModeChange?.(!fastMode);
	}

	const { hideLockTooltip } = lockTooltipState;
	useEffect(() => {
		if (!isOpen) {
			hideLockTooltip();

			return;
		}

		return listenOpenMenuDismiss({
			getRoot: () => rootRef.current,
			onOutside: () => {
				setIsOpen(false);
			},
			onEscape: () => {
				setIsOpen(false);
				triggerRef.current?.focus();
			}
		});
	}, [isOpen, hideLockTooltip]);

	useEffect(() => {
		if (disabled || (!showsReasoning && !showsFastModeControl)) setIsOpen(false);
	}, [disabled, showsReasoning, showsFastModeControl]);

	if (!showsReasoning && !showsFastModeControl) return null;

	return (
		<div ref={rootRef} className={cn('relative', className)}>
			<button
				ref={triggerRef}
				type="button"
				className="focus-visible:ring-ring/60 text-muted-foreground hover:bg-hover-fill inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[15px] transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				aria-label={triggerLabel}
				disabled={disabled}
				onClick={() => {
					setIsOpen(!isOpen);
				}}
			>
				<span>{triggerText}</span>
				<ChevronDown
					className={cn(
						'text-muted-foreground size-3 shrink-0 transition-transform',
						isOpen && 'rotate-180'
					)}
				/>
			</button>

			{isOpen ? (
				<div
					className="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 min-w-[15rem] rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl"
					role="dialog"
					aria-label={dialogLabel}
				>
					{showsReasoning ? (
						<>
							<p className="text-muted-foreground px-3 pt-1 pb-1.5 text-[11px] font-medium">
								Reasoning
							</p>
							<div className="space-y-0.5">
								{model.reasoningEfforts.map((effort) => (
									<button
										key={effort}
										type="button"
										className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
										aria-pressed={effort === reasoningEffort}
										onClick={() => selectReasoning(effort)}
									>
										<Check
											className={cn(
												'size-4 shrink-0 transition-opacity',
												effort === reasoningEffort ? 'opacity-100' : 'opacity-0'
											)}
										/>
										<span>{reasoningEffortLabel(effort)}</span>
										{effort === model.defaultReasoningEffort ? (
											<span className="text-muted-foreground ml-auto text-xs">Default</span>
										) : null}
									</button>
								))}
							</div>
						</>
					) : null}

					{showsFastModeControl ? (
						<>
							{showsReasoning ? <div className="mx-2 my-2 h-px bg-[var(--hairline)]"></div> : null}
							<p className="text-muted-foreground px-3 pb-1.5 text-[11px] font-medium">Speed</p>
							<div className="space-y-0.5">
								<button
									type="button"
									role="switch"
									className={cn(
										'focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2',
										fastModeAccess === 'locked'
											? 'cursor-not-allowed opacity-45'
											: 'text-foreground hover:bg-hover-fill'
									)}
									aria-checked={fastModeAccess !== 'locked' && fastMode}
									aria-disabled={fastModeAccess === 'locked'}
									aria-label={
										fastModeAccess === 'locked' && fastModeLockTooltip
											? `Fast mode. ${fastModeLockTooltip}`
											: undefined
									}
									onMouseEnter={(event) => {
										if (fastModeAccess === 'locked' && fastModeLockTooltip)
											lockTooltipState.showLockTooltip(event, fastModeLockTooltip);
									}}
									onMouseLeave={() => lockTooltipState.hideLockTooltip()}
									onFocus={(event) => {
										if (fastModeAccess === 'locked' && fastModeLockTooltip)
											lockTooltipState.showLockTooltip(event, fastModeLockTooltip);
									}}
									onBlur={() => lockTooltipState.hideLockTooltip()}
									onClick={toggleFastMode}
								>
									{fastModeAccess === 'locked' ? (
										<span className="text-muted-foreground shrink-0" aria-hidden="true">
											<Lock className="size-3.5" />
										</span>
									) : (
										<span className="size-3.5 shrink-0" aria-hidden="true"></span>
									)}
									<Zap className="size-3.5 shrink-0 text-amber-400" />
									<span className={cn(fastModeAccess === 'locked' && 'text-muted-foreground')}>
										Fast
									</span>
									<span
										className={cn(
											'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
											fastMode && fastModeAccess !== 'locked'
												? 'bg-foreground'
												: 'bg-hover-fill-strong'
										)}
										aria-hidden="true"
									>
										<span
											className={cn(
												'bg-background inline-block size-3.5 rounded-full transition',
												fastMode && fastModeAccess !== 'locked'
													? 'translate-x-[18px]'
													: 'translate-x-[3px]'
											)}
										></span>
									</span>
								</button>
							</div>
						</>
					) : null}
				</div>
			) : null}

			<Tooltip tooltip={lockTooltipState.lockTooltip} />
		</div>
	);
}
