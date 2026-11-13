import { Zap } from 'lucide-react';
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
		<div
			role="group"
			aria-label="Speed"
			className="border-t border-[var(--hairline)] py-2 first:border-t-0 first:pt-0 sm:py-0 sm:pt-1"
		>
			{tiers.map((tier) => {
				const checked = value === tier;

				return (
					<button
						key={tier}
						type="button"
						role="switch"
						aria-checked={checked}
						aria-label={`${serviceTierLabel(tier)} mode`}
						data-ph-capture-attribute-action={`toggle_${tier}_mode`}
						className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] outline-none focus-visible:ring-2 sm:min-h-0 sm:text-sm"
						onClick={() => onChange(checked ? 'standard' : tier)}
					>
						<Zap className="size-5 shrink-0 text-amber-400 sm:size-3.5" />
						<span className="min-w-0 flex-1">{serviceTierLabel(tier)}</span>
						<span
							className={cn(
								'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition sm:h-5 sm:w-9',
								checked ? 'bg-foreground' : 'bg-hover-fill-strong'
							)}
							aria-hidden="true"
						>
							<span
								className={cn(
									'bg-background inline-block size-4.5 rounded-full transition sm:size-3.5',
									checked ? 'translate-x-[23px] sm:translate-x-[18px]' : 'translate-x-[3px]'
								)}
							/>
						</span>
					</button>
				);
			})}
		</div>
	);
}
