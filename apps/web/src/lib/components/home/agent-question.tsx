import { AGENT_DECIDE_OPTION_ID, type AgentQuestionOption } from '@convex/lib/agentQuestions';

type Props = {
	question: string;
	options: AgentQuestionOption[];
	selectedOptionId: string | null;
	onToggleOption: (optionId: string) => void;
};

export default function AgentQuestion({
	question,
	options,
	selectedOptionId,
	onToggleOption
}: Props) {
	return (
		<div className="mb-3" role="group" aria-label="Agent question">
			<p className="text-foreground text-[14px] leading-6 font-medium">{question}</p>
			<ul className="mt-2 flex flex-col gap-1.5" aria-label="Answer options">
				{options.map((option) => {
					const isAgentDecide = option.id === AGENT_DECIDE_OPTION_ID;
					const isSelected = selectedOptionId === option.id;

					return (
						<li key={option.id}>
							<button
								type="button"
								className={`w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-5 transition ${
									isSelected
										? 'border-foreground/40 bg-hover-fill-strong text-foreground'
										: isAgentDecide
											? 'border-border/70 text-muted-foreground/80 hover:text-muted-foreground hover:bg-hover-fill'
											: 'border-border text-muted-foreground hover:text-foreground hover:bg-hover-fill'
								}`}
								aria-pressed={isSelected}
								onClick={() => onToggleOption(option.id)}
							>
								{option.label}
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
