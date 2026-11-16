import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { ReasoningLabel } from '$lib/components/home/reasoning-disclosure';

type Props = {
	inProgress: boolean;
	expanded: boolean;
	onToggle: () => void;
	summary: string | undefined;
	children: ReactNode;
};

export default function WorkDisclosure({
	inProgress,
	expanded,
	onToggle,
	summary,
	children
}: Props) {
	return (
		<div className="text-muted-foreground text-sm">
			<button
				type="button"
				className={`text-muted-foreground hover:text-muted-foreground inline-flex items-center transition ${summary === undefined ? 'gap-1.5' : 'gap-1'}`}
				onClick={onToggle}
				aria-expanded={expanded}
			>
				{summary === undefined ? (
					<ReasoningLabel label={inProgress ? 'Reasoning' : 'Reasoned'} />
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
