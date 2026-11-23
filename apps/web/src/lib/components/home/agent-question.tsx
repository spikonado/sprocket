import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import {
	AGENT_DECIDE_OPTION_ID,
	canSubmitQuestionAnswer,
	type AgentQuestionOption
} from '@convex/lib/agentQuestions';
import { shouldSubmitComposerFromKeydown } from '$lib/chat/composer';

export type QuestionAnswer = { optionId: string | null; text: string };

type Props = {
	question: string;
	options: AgentQuestionOption[];
	runEnded: boolean;
	canSend: boolean;
	submitting: boolean;
	onAnswer?: (answer: QuestionAnswer) => void;
	onSkip?: () => void;
};

export default function AgentQuestion({
	question,
	options,
	runEnded,
	canSend,
	submitting,
	onAnswer,
	onSkip
}: Props) {
	const [expanded, setExpanded] = useState(!runEnded);
	const [previousRunEnded, setPreviousRunEnded] = useState(runEnded);
	const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
	const [text, setText] = useState('');
	const hasAnswer = canSubmitQuestionAnswer({ selectedOptionId, text });
	const canAnswer = canSend && !submitting && hasAnswer;
	const sendAnswer = () => onAnswer?.({ optionId: selectedOptionId, text: text.trim() });

	if (runEnded !== previousRunEnded) {
		setPreviousRunEnded(runEnded);
		setExpanded(!runEnded);
	}

	return (
		<div className="mb-3 max-h-[40dvh] overflow-y-auto" role="group" aria-label="Agent question">
			<div className="text-foreground flex items-start gap-1.5 text-[14px] leading-6">
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
									disabled={submitting}
									onClick={() => setSelectedOptionId(isSelected ? null : option.id)}
								>
									{option.label}
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
			<div className="mt-2 flex items-end gap-2">
				<textarea
					aria-label="Answer to agent question"
					placeholder="Add detail, or type a custom answer"
					className="border-border text-foreground placeholder:text-muted-foreground focus-visible:border-ring field-sizing-content max-h-24 min-h-11 min-w-0 flex-1 resize-none rounded-lg border bg-transparent px-3 py-2.5 text-base outline-none sm:text-[13px]"
					rows={1}
					value={text}
					disabled={submitting}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (
							!canAnswer ||
							window.matchMedia?.('(pointer: coarse)').matches ||
							!shouldSubmitComposerFromKeydown(event.nativeEvent)
						) {
							return;
						}

						event.preventDefault();
						sendAnswer();
					}}
				/>
				{hasAnswer ? (
					<button
						type="button"
						className="bg-primary/90 text-primary-foreground hover:bg-primary h-11 shrink-0 rounded-full px-4 text-[13px] transition enabled:cursor-pointer disabled:opacity-30"
						onClick={sendAnswer}
						disabled={!canAnswer}
						data-ph-capture-attribute-action="submit_answer"
					>
						Send answer
					</button>
				) : (
					<button
						type="button"
						className="border-border text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-hover-fill h-11 shrink-0 rounded-full border px-4 text-[13px] transition enabled:cursor-pointer disabled:opacity-40"
						onClick={onSkip}
						disabled={submitting}
						data-ph-capture-attribute-action="skip_question"
					>
						Skip question
					</button>
				)}
			</div>
		</div>
	);
}
