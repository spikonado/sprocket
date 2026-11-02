import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { openCardLinkPopup } from '$lib/agentcard';
import Button from '$lib/components/ui/button/button';
import { convexClientErrorMessage } from '$lib/convex-error';

export default function SaveCardButton({ label = 'Save a card' }: { label?: string }) {
	const createCardLink = useAction(api.payments.createCardLink);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function open() {
		setOpening(true);
		setError(null);

		try {
			await openCardLinkPopup(() => createCardLink({}));
		} catch (caught) {
			setError(
				(caught instanceof Error && convexClientErrorMessage(caught)) || 'Couldn’t open Agentcard.'
			);
		} finally {
			setOpening(false);
		}
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
		</div>
	);
}
