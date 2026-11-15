import { memo, useLayoutEffect } from 'react';
import {
	useTranscriptRow,
	useTranscriptWork,
	type TranscriptStore
} from '$lib/home/transcript-store';
import ReasoningDisclosure from '$lib/components/home/reasoning-disclosure';
import WorkTools from '$lib/components/home/work-tools';

type Props = {
	store: TranscriptStore;
	rowId: string;
};

export default function WorkSectionDetails({ store, rowId }: Props) {
	const itemIds = useTranscriptWork(store, rowId);
	useLayoutEffect(() => {
		store.setExpanded(rowId, true);

		return store.openWork(rowId);
	}, [store, rowId]);

	return (
		<div className="space-y-2">
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
