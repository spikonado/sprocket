import { serviceTierLabel, type ServiceTier } from '$lib/chat/service-tier';
import { cn } from '$lib/utils';

export default function ServiceTierOptions({
	tiers,
	value,
	onChange
}: {
	tiers: readonly ServiceTier[];
	value: ServiceTier;
	onChange: (tier: ServiceTier) => void;
}) {
	return (
		<div role="group" aria-label="Speed" className="border-t border-[var(--hairline)] pt-2">
			<div className="text-muted-foreground px-3 pb-2 text-xs">Speed</div>
			<div className="flex gap-1">
				{tiers.map((tier) => (
					<button
						key={tier}
						type="button"
						aria-pressed={value === tier}
						className={cn(
							'focus-visible:ring-ring/60 hover:bg-hover-fill min-h-11 flex-1 rounded-xl px-2 py-2 text-sm outline-none focus-visible:ring-2 sm:min-h-9',
							value === tier && 'bg-hover-fill font-medium'
						)}
						onClick={() => onChange(tier)}
					>
						{serviceTierLabel(tier)}
					</button>
				))}
			</div>
		</div>
	);
}
