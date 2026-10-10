import ComposerNotice from './composer-notice';
import Button from '$lib/components/ui/button/button';
import { CATALOG_UNAVAILABLE_MESSAGE } from '$lib/chat/model-catalog';

type Props = {
	error: string | null;
	runError: string | null;
	reconnecting: boolean;
	syncing: boolean;
	catalogError: boolean;
	catalogLoading: boolean;
	onRetryCatalog: () => void;
};

export default function ConversationNotices({
	error,
	runError,
	reconnecting,
	syncing,
	catalogError,
	catalogLoading,
	onRetryCatalog
}: Props) {
	return (
		<>
			{error ? (
				<ComposerNotice title="Something went wrong" tone="error">
					{error}
				</ComposerNotice>
			) : null}
			{runError && runError !== error ? (
				<ComposerNotice title="Run couldn't continue">{runError}</ComposerNotice>
			) : null}
			{reconnecting ? (
				<ComposerNotice title="Reconnecting" tone="status">
					Reconnecting to conversation history.
				</ComposerNotice>
			) : syncing ? (
				<ComposerNotice title="Loading history" tone="status">
					Conversation history is still loading. You can send a prompt while it loads.
				</ComposerNotice>
			) : null}
			{catalogError ? (
				<ComposerNotice
					title="Models unavailable"
					tone="error"
					action={
						<Button
							variant="outline"
							className="h-8 px-3"
							disabled={catalogLoading}
							onclick={onRetryCatalog}
						>
							{catalogLoading ? 'Retrying…' : 'Retry'}
						</Button>
					}
				>
					{CATALOG_UNAVAILABLE_MESSAGE}
				</ComposerNotice>
			) : null}
		</>
	);
}
