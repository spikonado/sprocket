import { Check, Zap } from 'lucide-react';
import { useState, type RefObject } from 'react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import ProviderLogo from './provider-logo';
import MobileSelectorSheet from './ui/mobile-selector-sheet';
import { cn } from '$lib/utils';

export default function MobileModelSelector({
	models,
	modelId,
	reasoningEffort,
	fastMode,
	allowsFastMode,
	onApply,
	onDismiss,
	returnFocusRef
}: {
	models: CatalogModel[];
	modelId: string;
	reasoningEffort: string;
	fastMode: boolean;
	allowsFastMode: boolean;
	onApply: (model: CatalogModel, effort: string, fast: boolean) => void;
	onDismiss: () => void;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const [draftId, setDraftId] = useState(modelId);
	const [draftEffort, setDraftEffort] = useState(reasoningEffort);
	const [draftFast, setDraftFast] = useState(fastMode);
	const model = models.find((candidate) => candidate.id === draftId) ?? models[0];
	const fastAvailable = allowsFastMode && model?.supportsFastMode;

	return (
		<MobileSelectorSheet
			title="Model settings"
			onDismiss={onDismiss}
			returnFocusRef={returnFocusRef}
			footer={
				<button
					type="button"
					className="bg-primary text-primary-foreground focus-visible:ring-ring h-12 w-full rounded-2xl text-base font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
					disabled={!model}
					onClick={() => {
						if (model) onApply(model, draftEffort, Boolean(fastAvailable && draftFast));
					}}
				>
					Done
				</button>
			}
		>
			<div role="group" aria-label="Models" className="space-y-1 pb-4">
				{models.map((candidate) => (
					<button
						key={candidate.id}
						type="button"
						aria-pressed={candidate.id === model?.id}
						className={cn(
							'focus-visible:ring-ring flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2',
							candidate.id === model?.id ? 'bg-hover-fill' : 'hover:bg-hover-fill'
						)}
						onClick={() => {
							if (candidate.id === model?.id) return;
							setDraftId(candidate.id);
							setDraftEffort(candidate.defaultReasoningEffort);

							if (!candidate.supportsFastMode) setDraftFast(false);
						}}
					>
						<ProviderLogo provider={candidate.provider} className="size-5 shrink-0" />
						<span className="min-w-0 flex-1 text-[15px] leading-5 font-medium">
							{candidate.label}
						</span>
						{candidate.id === model?.id ? (
							<Check className="text-accent-strong size-5 shrink-0" />
						) : null}
					</button>
				))}
			</div>
			{model && showsReasoningControl(model) ? (
				<div
					role="group"
					aria-label={`Reasoning for ${model.label}`}
					className="border-t border-[var(--hairline)] px-1 py-4"
				>
					<div className="mb-3 flex items-center justify-between gap-3">
						<h3 className="text-sm font-semibold">Reasoning</h3>
						<span className="text-muted-foreground text-xs">
							Default: {reasoningEffortLabel(model.defaultReasoningEffort)}
						</span>
					</div>
					<div className="grid grid-cols-3 gap-2">
						{model.reasoningEfforts.map((effort) => (
							<button
								key={effort}
								type="button"
								aria-label={reasoningEffortLabel(effort)}
								aria-pressed={effort === draftEffort}
								className={cn(
									'focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-xl border px-2 py-2 text-sm outline-none focus-visible:ring-2',
									effort === draftEffort
										? 'border-accent-strong bg-accent/15'
										: 'hover:bg-hover-fill border-[var(--hairline)]'
								)}
								onClick={() => setDraftEffort(effort)}
							>
								<span>{reasoningEffortLabel(effort)}</span>
							</button>
						))}
					</div>
				</div>
			) : null}
			{fastAvailable ? (
				<button
					type="button"
					role="switch"
					aria-checked={draftFast}
					aria-label="Fast mode"
					className="focus-visible:ring-ring flex min-h-14 w-full items-center gap-3 border-t border-[var(--hairline)] px-1 py-4 text-left outline-none focus-visible:ring-2"
					onClick={() => setDraftFast(!draftFast)}
				>
					<Zap className="size-5 shrink-0 text-amber-500" />
					<span className="flex-1 text-sm font-semibold">Fast mode</span>
					<span
						className={cn(
							'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5',
							draftFast ? 'bg-accent-strong' : 'bg-hover-fill-strong'
						)}
						aria-hidden="true"
					>
						<span
							className={cn(
								'bg-background size-5 rounded-full transition-transform',
								draftFast && 'translate-x-5'
							)}
						/>
					</span>
				</button>
			) : null}
		</MobileSelectorSheet>
	);
}
