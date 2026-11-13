import { Check } from 'lucide-react';
import { useState, type RefObject } from 'react';
import {
	type CatalogModel,
	reasoningEffortLabel,
	showsReasoningControl
} from '$lib/chat/model-catalog';
import ProviderLogo from './provider-logo';
import { normalizeServiceTier, speedTiers, type ServiceTier } from '$lib/chat/service-tier';
import ServiceTierOptions from './service-tier-options';
import MobileSelectorSheet from './ui/mobile-selector-sheet';
import { cn } from '$lib/utils';

export default function MobileModelSelector({
	models,
	modelId,
	reasoningEffort,
	serviceTier,
	onApply,
	onDismiss,
	returnFocusRef
}: {
	models: readonly CatalogModel[];
	modelId: string;
	reasoningEffort: string;
	serviceTier: ServiceTier;
	onApply: (model: CatalogModel, effort: string, tier: ServiceTier) => void;
	onDismiss: () => void;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const [draftId, setDraftId] = useState(modelId);
	const [draftEffort, setDraftEffort] = useState(reasoningEffort);
	const [draftTier, setDraftTier] = useState(serviceTier);
	const model = models.find((candidate) => candidate.id === draftId) ?? models[0];
	const tiers = model ? speedTiers(model) : [];
	const resolvedTier = normalizeServiceTier(draftTier, model);

	return (
		<MobileSelectorSheet
			title="Model settings"
			onDismiss={onDismiss}
			returnFocusRef={returnFocusRef}
			footer={
				<button
					type="button"
					className="bg-primary text-primary-foreground focus-visible:ring-ring h-12 w-full rounded-2xl text-base font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
					data-ph-capture-attribute-action="select_model"
					data-ph-capture-attribute-model={model?.id}
					data-ph-capture-attribute-reasoning_effort={draftEffort}
					disabled={!model}
					onClick={() => {
						if (model) onApply(model, draftEffort, resolvedTier);
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

							setDraftTier(normalizeServiceTier(draftTier, candidate));
						}}
					>
						<ProviderLogo provider={candidate.provider} className="size-5 shrink-0" />
						<span className="min-w-0 flex-1 text-[15px] leading-5">{candidate.label}</span>
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
			{tiers.length > 0 ? (
				<ServiceTierOptions tiers={tiers} value={resolvedTier} onChange={setDraftTier} />
			) : null}
		</MobileSelectorSheet>
	);
}
