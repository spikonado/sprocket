import { Brain, ChevronRight } from 'lucide-react';
import { useInProgressDisclosure } from '$lib/components/home/in-progress-disclosure';

type Props = {
	text: string;
	inProgress: boolean;
};

export default function ReasoningDisclosure({ text, inProgress }: Props) {
	const disclosure = useInProgressDisclosure(inProgress);

	return (
		<div className="text-muted-foreground text-sm">
			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
				onClick={disclosure.toggle}
				aria-expanded={disclosure.expanded}
			>
				<ReasoningLabel inProgress={inProgress} />
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${disclosure.expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{disclosure.expanded ? (
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
