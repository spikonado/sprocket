import { Brain, ChevronRight } from 'lucide-react';
import { memo, useEffect } from 'react';
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
		<div className="text-muted-foreground text-sm" data-work-detail>
			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
			>
				<ReasoningLabel label={row.label} />
				<ChevronRight
					className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
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
		<div className="mt-1.5">
			{row?.kind === 'reasoning' && row.text !== undefined ? (
				<div className="text-muted-foreground text-[13px] leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap">
					{row.text}
				</div>
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
