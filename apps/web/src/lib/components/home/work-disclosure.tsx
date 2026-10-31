import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ReasoningLabel } from '$lib/components/home/reasoning-disclosure';

type Props = {
	inProgress: boolean;
	summary: string | undefined;
	children: ReactNode;
};

export default function WorkDisclosure({ inProgress, summary, children }: Props) {
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
				className={`text-muted-foreground hover:text-muted-foreground inline-flex items-center transition ${summary === undefined ? 'gap-1.5' : 'gap-1'}`}
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				{summary === undefined ? (
					<ReasoningLabel inProgress={inProgress} />
				) : (
					<span className="text-left">{summary}</span>
				)}
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{expanded ? <div className="mt-1.5 space-y-2">{children}</div> : null}
		</div>
	);
}
