import { useCallback } from 'react';
import type { LocalApi, VercelStatus } from '$lib/types/sprocket';
import {
	CliConnectorCard,
	StatusLine,
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
	const account = status?.account;

	return (
		<CliConnectorCard
			logo={<VercelMark className="text-foreground size-8 shrink-0 p-1.5" />}
			name="Vercel"
			cliName="Vercel CLI"
			cli={status}
			checking={checking}
			busy={pending !== null}
			retrying={pending === 'install'}
			onRetry={() =>
				void act('install', async () => {
					const install = await localApi.installConnectorCli(userId, 'vercel');
					setStatus((current) => current && { ...current, install });
				})
			}
			onRefresh={() => void reload()}
			error={error ?? loadError}
		>
			{account && (
				<div className="border-border border-t px-5 py-4">
					<div className="flex items-center gap-3">
						<div className="min-w-0 flex-1">
							<p className="text-foreground text-[13px]">Account</p>
							<AccountState account={account} />
						</div>
						{account.state !== 'signedIn' && !signIn.running && (
							<button
								type="button"
								className={rowPrimaryButtonClass}
								disabled={!installed || pending !== null}
								onClick={() => void signIn.start()}
							>
								Sign in
							</button>
						)}
						{account.state === 'signedIn' && account.source === 'cli' && (
							<button
								type="button"
								className={rowSecondaryButtonClass}
								disabled={!installed || pending !== null}
								onClick={() =>
									void act('signOut', async () => setStatus(await localApi.signOutVercel(userId)))
								}
							>
								Sign out
							</button>
						)}
					</div>
					<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
				</div>
			)}
		</CliConnectorCard>
	);
}

function AccountState({ account }: { account: VercelStatus['account'] }) {
	if (account.state === 'problem') return <StatusLine tone="problem">{account.error}</StatusLine>;

	if (account.state === 'signedOut') return <StatusLine tone="off">Not signed in</StatusLine>;

	return (
		<StatusLine tone="ok">
			{`Signed in as ${account.login} · ${account.source === 'cli' ? 'Vercel CLI login' : 'environment token'}`}
		</StatusLine>
	);
}

function VercelMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 76 65" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
		</svg>
	);
}
