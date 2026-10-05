import { Check } from 'lucide-react';
import { type CatalogModel, reasoningEffortLabel } from '$lib/chat/model-catalog';
import { cn } from '$lib/utils';

export default function ModelReasoningOptions({
	model,
	reasoningEffort,
	onSelect
}: {
	model: CatalogModel;
	reasoningEffort: string;
	onSelect: (effort: string) => void;
}) {
	return model.reasoningEfforts.map((effort) => (
		<button
			key={effort}
			type="button"
			className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex h-9 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm outline-none focus-visible:ring-2"
			aria-label={`${reasoningEffortLabel(effort)}${effort === model.defaultReasoningEffort ? ' (default)' : ''}`}
			aria-pressed={effort === reasoningEffort}
			data-default-reasoning={effort === model.defaultReasoningEffort ? '' : undefined}
			title={effort === model.defaultReasoningEffort ? 'Default reasoning' : undefined}
			onClick={() => onSelect(effort)}
			onKeyDown={(event) => {
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					const buttons = Array.from(
						event.currentTarget.parentElement?.querySelectorAll('button') ?? []
					);
					const index = buttons.indexOf(event.currentTarget);
					buttons[
						(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
					]?.focus();
				}
			}}
		>
			<span className="min-w-0 flex-1">{reasoningEffortLabel(effort)}</span>
			<Check
				className={cn(
					'text-accent-strong size-3 shrink-0',
					effort === reasoningEffort ? 'opacity-100' : 'opacity-0'
				)}
			/>
		</button>
	));
}
