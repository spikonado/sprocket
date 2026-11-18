import type { CatalogModel } from '$lib/chat/model-catalog';
import ProviderLogo, { providerLabel } from './provider-logo';
import { cn } from '$lib/utils';

export type ProviderGroup = { provider: string; models: CatalogModel[] };

const labelCollator = new Intl.Collator('en', { sensitivity: 'base' });

export function groupModelsByProvider(models: readonly CatalogModel[]): ProviderGroup[] {
	const groups = new Map<string, CatalogModel[]>();

	for (const model of models) {
		const group = groups.get(model.provider);

		if (group) group.push(model);
		else groups.set(model.provider, [model]);
	}

	return [...groups]
		.map(([provider, models]) => ({ provider, models }))
		.sort((a, b) => labelCollator.compare(providerLabel(a.provider), providerLabel(b.provider)));
}

export default function ProviderTabs({
	groups,
	provider,
	orientation,
	onChange,
	className
}: {
	groups: readonly ProviderGroup[];
	provider: string;
	orientation: 'horizontal' | 'vertical';
	onChange: (provider: string) => void;
	className?: string;
}) {
	const [previous, next] =
		orientation === 'vertical' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];

	return (
		<div
			role="tablist"
			aria-label="Providers"
			aria-orientation={orientation}
			className={cn('flex gap-1', orientation === 'vertical' && 'flex-col', className)}
			onKeyDown={(event) => {
				if (event.key !== previous && event.key !== next) return;
				event.preventDefault();
				const index = groups.findIndex((group) => group.provider === provider);
				const targetIndex = (index + (event.key === next ? 1 : -1) + groups.length) % groups.length;
				const target = groups[targetIndex];

				if (!target) return;
				onChange(target.provider);
				const tab = event.currentTarget.children[targetIndex];

				if (tab instanceof HTMLElement) tab.focus();
			}}
		>
			{groups.map((group) => (
				<button
					key={group.provider}
					type="button"
					role="tab"
					aria-label={providerLabel(group.provider)}
					title={providerLabel(group.provider)}
					aria-selected={group.provider === provider}
					tabIndex={group.provider === provider ? 0 : -1}
					className={cn(
						'focus-visible:ring-ring/60 flex shrink-0 items-center justify-center rounded-xl outline-none focus-visible:ring-2',
						orientation === 'vertical' ? 'size-9' : 'size-11',
						group.provider === provider ? 'bg-hover-fill-strong' : 'hover:bg-hover-fill'
					)}
					onClick={() => onChange(group.provider)}
				>
					<ProviderLogo
						provider={group.provider}
						className={orientation === 'vertical' ? 'size-4' : 'size-5'}
					/>
				</button>
			))}
		</div>
	);
}
