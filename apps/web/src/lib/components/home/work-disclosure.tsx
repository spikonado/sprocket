import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

type Props = {
	inProgress: boolean;
	summary: string;
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
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1 transition"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<span className="text-left">{summary}</span>
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{expanded ? <div className="mt-1.5 space-y-2">{children}</div> : null}
		</div>
	);
}
