import { Check } from 'lucide-react';
import { type CatalogModel, reasoningEffortLabel } from '$lib/chat/model-catalog';

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
			className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2"
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
			{effort === model.defaultReasoningEffort ? (
				<span className="text-muted-foreground shrink-0 text-xs">Default</span>
			) : null}
			{effort === reasoningEffort ? <Check className="text-accent-strong size-3 shrink-0" /> : null}
		</button>
	));
}
