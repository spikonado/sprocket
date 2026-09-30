import { Brain, ChevronRight } from 'lucide-react';
import { useInProgressDisclosure } from '$lib/components/home/in-progress-disclosure';

type Props = {
	text: string;
	inProgress: boolean;
};

export default function ReasoningDisclosure({ text, inProgress }: Props) {
	const disclosure = useInProgressDisclosure(inProgress);
	const label = inProgress ? 'Reasoning' : 'Reasoned';

	return (
		<div className="text-muted-foreground text-sm">
			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
				onClick={disclosure.toggle}
				aria-expanded={disclosure.expanded}
			>
				<Brain className="size-3.5 shrink-0" aria-hidden="true" />
				<span>{label}</span>
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${disclosure.expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{disclosure.expanded ? (
				<div className="text-muted-foreground mt-1.5 text-[13px] leading-6 whitespace-pre-wrap">
					{text}
				</div>
			) : null}
		</div>
	);
}
