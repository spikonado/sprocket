import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { AGENT_DECIDE_OPTION_ID, type AgentQuestionOption } from '@convex/lib/agentQuestions';

type Props = {
	question: string;
	options: AgentQuestionOption[];
	runEnded: boolean;
	selectedOptionId: string | null;
	onToggleOption: (optionId: string) => void;
};

export default function AgentQuestion({
	question,
	options,
	runEnded,
	selectedOptionId,
	onToggleOption
}: Props) {
	const [expanded, setExpanded] = useState(!runEnded);
	const [previousRunEnded, setPreviousRunEnded] = useState(runEnded);

	if (runEnded !== previousRunEnded) {
		setPreviousRunEnded(runEnded);
		setExpanded(!runEnded);
	}

	return (
		<div className="mb-3" role="group" aria-label="Agent question">
			<div className="text-foreground flex items-start gap-1.5 text-[14px] leading-6 font-medium">
				<span
					className={`min-w-0 flex-1 ${expanded ? '' : 'cursor-pointer truncate'}`}
					onClick={expanded ? undefined : () => setExpanded(true)}
				>
					{question}
				</span>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring mt-0.5 shrink-0 cursor-pointer rounded p-0.5 transition focus-visible:ring-2 focus-visible:outline-none"
					aria-label={expanded ? 'Collapse question' : 'Expand question'}
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronRight
						className={`size-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
						aria-hidden="true"
					/>
				</button>
			</div>
			{expanded ? (
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
			) : null}
		</div>
	);
}
