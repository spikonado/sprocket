import { Brain, ChevronRight } from 'lucide-react';
import { memo, useEffect } from 'react';
import { workRowClass } from '$lib/components/home/work-tools';
import {
	useTranscriptExpanded,
	useTranscriptRow,
	type TranscriptStore
} from '$lib/home/transcript-store';

type Props = {
	store: TranscriptStore;
	rowId: string;
};

export default memo(function ReasoningDisclosure({ store, rowId }: Props) {
	const row = useTranscriptRow(store, rowId);
	const [expanded, setExpanded] = useTranscriptExpanded(store, rowId);

	if (row?.kind !== 'reasoning') return null;

	return (
		<div className="text-muted-foreground min-w-0 text-[13px] leading-6" data-work-detail>
			<button
				type="button"
				className={`${workRowClass} max-w-full`}
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
			>
				<Brain className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{row.label}</span>
				<ChevronRight
					className={`mt-1 size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
					aria-hidden="true"
				/>
			</button>
			{expanded ? <ReasoningDetails store={store} rowId={rowId} /> : null}
		</div>
	);
});

function ReasoningDetails({ store, rowId }: Props) {
	const row = useTranscriptRow(store, rowId, true);
	useEffect(() => store.openItem(rowId), [store, rowId]);

	return (
		<div className="mt-1.5 ml-5">
			{row?.kind === 'reasoning' && row.text !== undefined ? (
				<div className="[overflow-wrap:anywhere] whitespace-pre-wrap">{row.text}</div>
			) : (
				<p role="status">Loading reasoning...</p>
			)}
		</div>
	);
}

export function ReasoningLabel({ label }: { label: string }) {
	return (
		<>
			<Brain className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{label}</span>
		</>
	);
}
