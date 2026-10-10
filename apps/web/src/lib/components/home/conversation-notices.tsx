import ComposerNotice from './composer-notice';
import Button from '$lib/components/ui/button/button';
import { CATALOG_UNAVAILABLE_MESSAGE } from '$lib/chat/model-catalog';

type Props = {
	error: string | null;
	runError: string | null;
	usageLimitRetryAt?: number;
	cancellingAutoResume?: boolean;
	onCancelAutoResume: () => void;
	reconnecting: boolean;
	syncing: boolean;
	catalogError: boolean;
	catalogLoading: boolean;
	onRetryCatalog: () => void;
};

export default function ConversationNotices({
	error,
	runError,
	usageLimitRetryAt,
	cancellingAutoResume = false,
	onCancelAutoResume,
	reconnecting,
	syncing,
	catalogError,
	catalogLoading,
	onRetryCatalog
}: Props) {
	const retryAt = usageLimitRetryAt === undefined ? null : new Date(usageLimitRetryAt);

	return (
		<>
			{retryAt ? (
				<ComposerNotice
					title="Waiting for usage limit reset"
					tone="status"
					action={
						<Button
							variant="outline"
							className="h-8 px-3"
							disabled={cancellingAutoResume}
							onclick={onCancelAutoResume}
						>
							{cancellingAutoResume ? 'Cancelling…' : 'Cancel auto-resume'}
						</Button>
					}
				>
					Next retry: <time dateTime={retryAt.toISOString()}>{retryAt.toLocaleString()}</time>. You
					can retry manually, send a new message, or switch providers.
				</ComposerNotice>
			) : null}
			{error && (!retryAt || error !== runError) ? (
				<ComposerNotice title="Something went wrong" tone="error">
					{error}
				</ComposerNotice>
			) : null}
			{runError && !retryAt && runError !== error ? (
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
