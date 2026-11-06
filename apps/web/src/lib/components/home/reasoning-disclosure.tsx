import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';

type Props = {
	text: string;
	inProgress: boolean;
};

export default function ReasoningDisclosure({ text, inProgress }: Props) {
	const [expanded, setExpanded] = useState(inProgress);
	const [previousInProgress, setPreviousInProgress] = useState(inProgress);

	if (inProgress !== previousInProgress) {
		setPreviousInProgress(inProgress);
		setExpanded(inProgress);
	}

	return (
		<div className="text-muted-foreground text-sm">
			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<ReasoningLabel inProgress={inProgress} />
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{expanded ? (
				<div className="mt-1.5">
					<ReasoningText text={text} />
				</div>
			) : null}
		</div>
	);
}

export function ReasoningLabel({ inProgress }: { inProgress: boolean }) {
	return (
		<>
			<Brain className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{inProgress ? 'Reasoning' : 'Reasoned'}</span>
		</>
	);
}

export function ReasoningText({ text }: { text: string }) {
	return (
		<div className="text-muted-foreground text-[13px] leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap">
			{text}
		</div>
	);
}
