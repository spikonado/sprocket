import { Brain } from 'lucide-react';

type Props = {
	text: string;
	inProgress: boolean;
};

export default function WorkReasoning({ text, inProgress }: Props) {
	const label = inProgress ? 'Reasoning' : 'Reasoned';

	return (
		<div className="text-muted-foreground flex items-start gap-1.5 text-[13px] leading-6">
			<Brain className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
			<div className="min-w-0">
				<p>{label}</p>
				<p className="[overflow-wrap:anywhere] whitespace-pre-wrap">{text}</p>
			</div>
		</div>
	);
}
