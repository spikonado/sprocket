import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatElapsedDuration } from '$lib/format';
import { elapsedSeconds, useTickingNow } from '$lib/chat/elapsed-time';

type Props = {
	inProgress: boolean;
	startedAtMs?: number;
	/** Durable end when the section is finished; omit while in progress. */
	completedAtMs?: number;
	children: ReactNode;
};

export default function WorkDisclosure({
	inProgress,
	startedAtMs,
	completedAtMs,
	children
}: Props) {
	const [expanded, setExpanded] = useState(false);
	const now = useTickingNow(inProgress);

	const duration = elapsedSeconds(startedAtMs, inProgress ? now : completedAtMs);

	const label = `${inProgress ? 'Working' : 'Worked'}${
		duration === undefined ? '' : ` for ${formatElapsedDuration(duration)}`
	}`;

	return (
		<div className="text-muted-foreground text-sm">
			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1 transition"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<span>{label}</span>
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{expanded ? <div className="mt-1.5 space-y-2">{children}</div> : null}
		</div>
	);
}
