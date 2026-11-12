import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import AgentcardLinkDialog from '$lib/components/home/agentcard-link-dialog';
import Button from '$lib/components/ui/button/button';
import { convexClientErrorMessage } from '$lib/convex-error';

export default function SaveCardButton({
	label = 'Save a card',
	onDone
}: {
	label?: string;
	onDone?: () => void;
}) {
	const createCardLink = useAction(api.payments.createCardLink);
	const [opening, setOpening] = useState(false);
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function open() {
		setOpening(true);
		setError(null);

		try {
			setUrl((await createCardLink({})).url);
		} catch (caught) {
			setError(
				(caught instanceof Error && convexClientErrorMessage(caught)) || 'Couldn’t open Agentcard.'
			);
		} finally {
			setOpening(false);
		}
	}

	function close() {
		setUrl(null);
		onDone?.();
	}

	return (
		<div>
			<Button
				variant="outline"
				className="h-9 px-4 text-xs"
				disabled={opening}
				onclick={() => void open()}
			>
				{label}
			</Button>
			{error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
			{url ? (
				<AgentcardLinkDialog title="Add a card" action="save your card" url={url} onClose={close} />
			) : null}
		</div>
	);
}
