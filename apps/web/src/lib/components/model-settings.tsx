import { Check, Zap } from 'lucide-react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import { cn } from '$lib/utils';

export default function ModelSettings({
	model,
	reasoningEffort,
	fastMode = false,
	fastModeAvailable = false,
	onReasoningEffortChange,
	onFastModeChange
}: {
	model: CatalogModel;
	reasoningEffort: string;
	fastMode?: boolean;
	fastModeAvailable?: boolean;
	onReasoningEffortChange?: (effort: string) => void;
	onFastModeChange?: (fastMode: boolean) => void;
}) {
	const showsReasoning = showsReasoningControl(model);

	if (!showsReasoning && !fastModeAvailable) return null;

	return (
		<div className="mt-2 border-t border-[var(--hairline)] pt-2">
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
								onClick={() => onReasoningEffortChange?.(effort)}
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

			{fastModeAvailable ? (
				<>
					{showsReasoning ? <div className="mx-2 my-2 h-px bg-[var(--hairline)]"></div> : null}
					<p className="text-muted-foreground px-3 pb-1.5 text-[11px] font-medium">Speed</p>
					<div className="space-y-0.5">
						<button
							type="button"
							role="switch"
							className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
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
								></span>
							</span>
						</button>
					</div>
				</>
			) : null}
		</div>
	);
}
