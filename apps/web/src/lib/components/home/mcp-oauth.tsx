import { useState, type FormEvent } from 'react';
import { useAction } from 'convex/react';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import { inputClass, primaryButtonClass } from './connector-card-parts';
import { caughtMessage } from './use-connectors';

const clientRequiredError = z.object({ code: z.literal('client_required') });

type OAuthStatus = 'ready' | 'starting' | 'client_required' | 'authorizing';

export default function McpOAuth({ connectorId }: { connectorId: string }) {
	const startOAuth = useAction(api.mcpServers.startOAuth);

	const [status, setStatus] = useState<OAuthStatus>('ready');

	const [clientId, setClientId] = useState('');
	const [clientSecret, setClientSecret] = useState('');
	const [error, setError] = useState<string | null>(null);

	async function connect(event: FormEvent) {
		event.preventDefault();
		const needsClient = status === 'client_required';
		const bridge = window.sprocketDesktopBridge;
		const loginWindow = bridge ? null : window.open('about:blank', '_blank');
		setStatus('starting');
		setError(null);

		try {
			if (!bridge && !loginWindow) throw new Error('Allow popups to connect this server.');

			if (loginWindow) loginWindow.opener = null;

			const { authorizationUrl } = await startOAuth({
				connectorId,
				...(needsClient && {
					client: { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined }
				})
			});

			if (bridge) await bridge.openExternal(authorizationUrl);
			else loginWindow?.location.replace(authorizationUrl);
			setClientSecret('');
			setStatus('authorizing');
		} catch (caught) {
			loginWindow?.close();

			const requiresClient =
				caught instanceof ConvexError && clientRequiredError.safeParse(caught.data).success;

			setStatus(requiresClient || needsClient ? 'client_required' : 'ready');
			setError(caughtMessage.parse(caught) || 'Couldn’t start sign-in.');
		}
	}

	return (
		<form className="space-y-3 px-5 pb-5" onSubmit={(event) => void connect(event)}>
			{status === 'client_required' && (
				<>
					<label className="block space-y-1.5 text-[12px]">
						<span>Client ID</span>
						<input
							className={inputClass}
							value={clientId}
							onChange={(event) => setClientId(event.currentTarget.value)}
							required
							autoComplete="off"
						/>
					</label>
					<label className="block space-y-1.5 text-[12px]">
						<span>Client secret (optional)</span>
						<input
							className={inputClass}
							type="password"
							value={clientSecret}
							onChange={(event) => setClientSecret(event.currentTarget.value)}
							autoComplete="off"
						/>
					</label>
				</>
			)}
			{status === 'authorizing' && (
				<p role="status" className="text-muted-foreground text-[12px]">
					Finish connecting in your browser. This card updates when sign-in completes.
				</p>
			)}
			{error && (
				<p role="alert" className="text-destructive text-[12px]">
					{error}
				</p>
			)}
			<div className="flex justify-end">
				<button type="submit" className={primaryButtonClass} disabled={status === 'starting'}>
					{status === 'starting' ? 'Connecting…' : 'Connect'}
				</button>
			</div>
		</form>
	);
}
