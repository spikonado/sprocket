import { useCallback } from 'react';
import type { LocalApi, VercelStatus } from '$lib/types/sprocket';
import {
	CliConnectorCard,
	rowPrimaryButtonClass,
	rowSecondaryButtonClass,
	useConnectorAction
} from './connector-card-parts';
import { DeviceSignInPanel, useDeviceSignIn, type SignInApi } from './device-sign-in';
import { pollWhileInstalling, usePolledStatus } from './use-connectors';

export type VercelApi = SignInApi &
	Pick<LocalApi, 'fetchVercelStatus' | 'signOutVercel' | 'installConnectorCli'>;

export default function VercelConnector({
	userId,
	localApi
}: {
	userId: string;
	localApi: VercelApi;
}) {
	const fetchStatus = useCallback(() => localApi.fetchVercelStatus(userId), [localApi, userId]);

	const { status, setStatus, loadError, checking, reload } = usePolledStatus(
		fetchStatus,
		pollWhileInstalling,
		'Couldn’t check Vercel on this computer.'
	);

	const signIn = useDeviceSignIn(localApi, userId, { connector: 'vercel' }, () => void reload());
	const { pending, error, act } = useConnectorAction<'install' | 'signOut'>('Vercel');
	const installed = status?.install.state === 'installed';
	const account = installed ? status.account : null;
	const busy = pending !== null;

	let action = null;

	if (account?.state === 'signedIn' && account.source === 'cli') {
		action = (
			<button
				type="button"
				className={rowSecondaryButtonClass}
				disabled={busy}
				onClick={() =>
					void act('signOut', async () => setStatus(await localApi.signOutVercel(userId)))
				}
			>
				Sign out
			</button>
		);
	} else if (account && account.state !== 'signedIn' && !signIn.running) {
		action = (
			<button
				type="button"
				className={rowPrimaryButtonClass}
				disabled={busy}
				onClick={() => void signIn.start()}
			>
				Sign in
			</button>
		);
	}

	return (
		<CliConnectorCard
			logo={<VercelMark className="text-foreground size-8 shrink-0 p-1.5" />}
			name="Vercel"
			description="Lets the agent deploy your projects and read their build logs."
			cliName="Vercel CLI"
			cli={status}
			detail={account && accountDetail(account)}
			checking={checking}
			busy={busy}
			retrying={pending === 'install'}
			onRetry={() =>
				void act('install', async () => {
					const install = await localApi.installConnectorCli(userId, 'vercel');
					setStatus((current) => current && { ...current, install });
				})
			}
			onRefresh={() => void reload()}
			action={action}
			error={error ?? loadError}
		>
			{signIn.status.state !== 'idle' && (
				<div className="-mt-5 px-5 pb-5">
					<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
				</div>
			)}
		</CliConnectorCard>
	);
}

function accountDetail(account: VercelStatus['account']) {
	if (account.state === 'problem') return account.error;

	if (account.state === 'signedOut') return 'Not signed in';

	return account.source === 'cli'
		? `Signed in as ${account.login}`
		: `Signed in as ${account.login} with VERCEL_TOKEN`;
}

function VercelMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 76 65" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
		</svg>
	);
}
