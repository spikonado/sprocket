import { memo, useEffect } from 'react';
import {
	useTranscriptRow,
	useTranscriptWork,
	useTranscriptWorkHasEarlier,
	type TranscriptStore
} from '$lib/home/transcript-store';
import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure';
import WorkTools, { workRowClass } from '$lib/components/home/work-tools';

type Props = {
	store: TranscriptStore;
	rowId: string;
};

export default function WorkSectionDetails({ store, rowId }: Props) {
	const itemIds = useTranscriptWork(store, rowId);
	const hasEarlier = useTranscriptWorkHasEarlier(store, rowId);
	useEffect(() => store.openWork(rowId), [store, rowId]);

	return (
		<div className="space-y-2">
			{hasEarlier && (
				<button
					type="button"
					className={`${workRowClass} text-muted-foreground text-[13px] leading-6`}
					onClick={() => store.loadEarlierWork(rowId)}
				>
					Show earlier
				</button>
			)}
			{itemIds.map((itemId) => (
				<WorkItem key={itemId} store={store} rowId={itemId} />
			))}
		</div>
	);
}

const WorkItem = memo(function WorkItem({ store, rowId }: Props) {
	const row = useTranscriptRow(store, rowId);

	if (row?.kind === 'reasoning') return <ReasoningDisclosure store={store} rowId={rowId} />;

	if (row?.kind === 'tool') return <WorkTools store={store} rowId={rowId} />;

	return null;
});
