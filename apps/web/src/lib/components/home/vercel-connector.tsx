import { useCallback } from 'react';
import type { LocalApi, VercelStatus } from '$lib/types/sprocket';
import {
	ConnectorPanel,
	ConnectorRow,
	cliFooter,
	cliState,
	primaryButtonClass,
	secondaryButtonClass,
	useConnectorAction,
	useOnConnected,
	type ConnectorState
} from './connector-parts';
import { DeviceSignInPanel, useDeviceSignIn, type SignInApi } from './device-sign-in';
import { pollWhileInstalling, usePolledStatus } from './use-connectors';

export type VercelApi = SignInApi &
	Pick<LocalApi, 'fetchVercelStatus' | 'signOutVercel' | 'installConnectorCli'>;

const description = 'Lets the agent deploy your projects';

function vercelState(status: VercelStatus | null, loadError: string | null): ConnectorState {
	return cliState(status, loadError, ({ account }) => {
		if (account.state === 'signedIn') return { tone: 'ready', label: 'Ready' };

		if (account.state === 'problem') return { tone: 'attention', label: 'Needs attention' };

		return { tone: 'attention', label: 'Needs sign-in' };
	});
}

function useVercelStatus(userId: string, localApi: VercelApi) {
	const fetchStatus = useCallback(() => localApi.fetchVercelStatus(userId), [localApi, userId]);

	const polled = usePolledStatus(
		fetchStatus,
		pollWhileInstalling,
		'Couldn’t check Vercel on this computer.'
	);

	return { ...polled, state: vercelState(polled.status, polled.loadError) };
}

export function VercelRow({
	userId,
	localApi,
	onOpen
}: {
	userId: string;
	localApi: VercelApi;
	onOpen: () => void;
}) {
	const { status, state } = useVercelStatus(userId, localApi);
	const account = status?.install.state === 'installed' ? status.account : null;

	return (
		<ConnectorRow
			logo={<VercelMark />}
			name="Vercel"
			detail={account?.state === 'signedIn' ? accountDetail(account) : description}
			state={state}
			onOpen={onOpen}
		/>
	);
}

export default function VercelConnector({
	userId,
	localApi,
	onConnected
}: {
	userId: string;
	localApi: VercelApi;
	onConnected?: () => void;
}) {
	const { status, setStatus, loadError, checking, reload, state } = useVercelStatus(
		userId,
		localApi
	);

	const signIn = useDeviceSignIn(localApi, userId, { connector: 'vercel' }, () => void reload());
	const { pending, error, act } = useConnectorAction<'install' | 'signOut'>('Vercel');
	const installed = status?.install.state === 'installed';
	const account = installed ? status.account : null;
	const busy = pending !== null;

	useOnConnected(account?.state === 'signedIn', onConnected);

	let action = null;

	if (account?.state === 'signedIn' && account.source === 'cli') {
		action = (
			<button
				type="button"
				className={secondaryButtonClass}
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
				className={primaryButtonClass}
				disabled={busy}
				onClick={() => void signIn.start()}
			>
				Sign in
			</button>
		);
	}

	return (
		<ConnectorPanel
			logo={<VercelMark />}
			name="Vercel"
			description={account ? accountDetail(account) : description}
			state={state}
			actions={action}
			error={error ?? loadError}
			footer={cliFooter({
				name: 'Vercel CLI',
				install: status?.install,
				version: status?.version ?? null,
				checking,
				busy,
				retrying: pending === 'install',
				onRetry: () =>
					void act('install', async () => {
						const install = await localApi.installConnectorCli(userId, 'vercel');
						setStatus((current) => current && { ...current, install });
					}),
				onRefresh: () => void reload()
			})}
		>
			{signIn.status.state !== 'idle' && (
				<div className="-mt-3 px-5 pb-5">
					<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
				</div>
			)}
		</ConnectorPanel>
	);
}

function accountDetail(account: VercelStatus['account']) {
	if (account.state === 'problem') return account.error;

	if (account.state === 'signedOut') return 'Not signed in';

	return account.source === 'cli'
		? `Signed in as ${account.login}`
		: `Signed in as ${account.login} with VERCEL_TOKEN`;
}

function VercelMark() {
	return (
		<svg viewBox="0 0 76 65" fill="currentColor" aria-hidden="true" className="p-[14%]">
			<path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
		</svg>
	);
}
