import { useCallback, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '$lib/utils';
import type {
	GitHubHostStatus,
	GitHubSettingsUpdate,
	GitHubStatus,
	LocalApi
} from '$lib/types/sprocket';
import {
	ConnectorPanel,
	ConnectorRow,
	PanelSection,
	Switch,
	cliFooter,
	cliState,
	inputClass,
	primaryButtonClass,
	rowPrimaryButtonClass,
	rowSecondaryButtonClass,
	useConnectorAction,
	useOnConnected,
	type ConnectorState
} from './connector-parts';
import { DeviceSignInPanel, useDeviceSignIn, type SignInApi } from './device-sign-in';
import { pollWhileInstalling, usePolledStatus } from './use-connectors';

export type GitHubApi = SignInApi &
	Pick<
		LocalApi,
		'fetchGitHubStatus' | 'updateGitHubSettings' | 'signOutGitHub' | 'installConnectorCli'
	>;

const description = 'Lets the agent link pull requests and follow their checks';

const sourceLabels: Record<NonNullable<GitHubHostStatus['source']>, string> = {
	environment: 'environment token',
	gitHubCli: 'gh login'
};

function gitHubState(status: GitHubStatus | null, loadError: string | null): ConnectorState {
	return cliState(status, loadError, ({ enabled, hosts }) => {
		if (!enabled) return { tone: 'off', label: 'Off' };
		const active = hosts.filter((host) => host.enabled);

		if (active.some((host) => host.problem)) return { tone: 'attention', label: 'Needs attention' };

		if (active.some((host) => host.login)) return { tone: 'ready', label: 'Ready' };

		return { tone: 'attention', label: 'Needs sign-in' };
	});
}

function signedInAccounts(status: GitHubStatus | null) {
	const accounts = (status?.hosts ?? [])
		.filter((host) => host.enabled && host.login)
		.map((host) => `${host.login} on ${host.host}`);

	return accounts.length > 0 ? accounts.join(', ') : description;
}

function useGitHubStatus(userId: string, localApi: GitHubApi) {
	const fetchStatus = useCallback(() => localApi.fetchGitHubStatus(userId), [localApi, userId]);

	const polled = usePolledStatus(
		fetchStatus,
		pollWhileInstalling,
		'Couldn’t check GitHub on this computer.'
	);

	return { ...polled, state: gitHubState(polled.status, polled.loadError) };
}

export function GitHubRow({
	userId,
	localApi,
	onOpen
}: {
	userId: string;
	localApi: GitHubApi;
	onOpen: () => void;
}) {
	const { status, state } = useGitHubStatus(userId, localApi);

	return (
		<ConnectorRow
			logo={<GitHubMark />}
			name="GitHub"
			detail={signedInAccounts(status)}
			state={state}
			onOpen={onOpen}
		/>
	);
}

export default function GitHubConnector({
	userId,
	localApi,
	onConnected
}: {
	userId: string;
	localApi: GitHubApi;
	onConnected?: () => void;
}) {
	const { status, setStatus, loadError, checking, reload, state } = useGitHubStatus(
		userId,
		localApi
	);

	const { pending, error, act } = useConnectorAction<string>('GitHub');

	const update = (key: string, settings: GitHubSettingsUpdate) =>
		act(key, async () => setStatus(await localApi.updateGitHubSettings(userId, settings)));

	const installed = status?.install.state === 'installed';
	const busy = pending !== null;

	useOnConnected(state.tone === 'ready', onConnected);

	return (
		<ConnectorPanel
			logo={<GitHubMark />}
			name="GitHub"
			description={description}
			state={state}
			actions={
				status &&
				!status.enabled && (
					<button
						type="button"
						className={primaryButtonClass}
						disabled={busy}
						onClick={() => void update('github', { enabled: true })}
					>
						Turn on
					</button>
				)
			}
			error={error ?? loadError}
			footer={cliFooter({
				name: 'GitHub CLI',
				install: status?.install,
				version: status?.cliVersion ?? null,
				checking,
				busy,
				retrying: pending === 'install',
				onRetry: () =>
					void act('install', async () => {
						const install = await localApi.installConnectorCli(userId, 'github');
						setStatus((current) => current && { ...current, install });
					}),
				onRefresh: () => void reload()
			})}
		>
			{status?.enabled && (
				<PanelSection title="Accounts">
					<ul className="divide-border divide-y">
						{status.hosts.map((host) => (
							<HostRow
								key={host.host}
								userId={userId}
								signInApi={localApi}
								host={host}
								disabled={busy || !installed}
								onEnabledChange={(next) =>
									void update(host.host, { host: { host: host.host, enabled: next } })
								}
								onSignOut={() =>
									void act(host.host, async () =>
										setStatus(await localApi.signOutGitHub(userId, host.host))
									)
								}
								onSignedIn={() => void reload()}
							/>
						))}
						<AddHost
							userId={userId}
							signInApi={localApi}
							disabled={!installed}
							onSignedIn={() => void reload()}
						/>
					</ul>
				</PanelSection>
			)}
		</ConnectorPanel>
	);
}

function HostRow({
	userId,
	signInApi,
	host,
	disabled,
	onEnabledChange,
	onSignOut,
	onSignedIn
}: {
	userId: string;
	signInApi: SignInApi;
	host: GitHubHostStatus;
	disabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
	onSignOut: () => void;
	onSignedIn: () => void;
}) {
	const signIn = useDeviceSignIn(
		signInApi,
		userId,
		{ connector: 'github', host: host.host },
		onSignedIn
	);

	const canSignIn = host.enabled && !host.login && host.source !== 'environment';
	const canSignOut = host.enabled && host.source === 'gitHubCli';

	return (
		<li className="px-5 py-3">
			<div className="flex items-center gap-3">
				<div className={cn('min-w-0 flex-1', !host.enabled && 'opacity-60')}>
					<p className="text-foreground truncate font-mono text-[13px]">{host.host}</p>
					<p
						className={cn(
							'truncate text-[12px] leading-5',
							host.problem ? 'text-foreground' : 'text-muted-foreground'
						)}
					>
						{hostAccount(host)}
					</p>
				</div>
				{canSignIn && !signIn.running && (
					<button
						type="button"
						className={rowPrimaryButtonClass}
						disabled={disabled}
						onClick={() => void signIn.start()}
					>
						Sign in
					</button>
				)}
				{canSignOut && (
					<button
						type="button"
						className={rowSecondaryButtonClass}
						disabled={disabled || signIn.running}
						onClick={onSignOut}
					>
						Sign out
					</button>
				)}
				<Switch
					label={`Use ${host.host}`}
					checked={host.enabled}
					disabled={disabled}
					onChange={onEnabledChange}
				/>
			</div>
			<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
		</li>
	);
}

function hostAccount(host: GitHubHostStatus) {
	if (!host.enabled) return 'Off';

	if (host.problem) return host.problem;

	if (!host.login) return 'Not signed in';

	const account = `Signed in as ${host.login}`;

	return host.source ? `${account} · ${sourceLabels[host.source]}` : account;
}

function AddHost({
	userId,
	signInApi,
	disabled,
	onSignedIn
}: {
	userId: string;
	signInApi: SignInApi;
	disabled: boolean;
	onSignedIn: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [host, setHost] = useState('');
	const normalizedHost = host.trim().toLowerCase();

	const signIn = useDeviceSignIn(
		signInApi,
		userId,
		{ connector: 'github', host: normalizedHost },
		() => {
			setOpen(false);
			setHost('');
			onSignedIn();
		}
	);

	function submit(event: FormEvent) {
		event.preventDefault();

		if (normalizedHost) void signIn.start();
	}

	if (!open) {
		return (
			<li className="px-5 py-3">
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[12px] transition disabled:opacity-50"
					disabled={disabled}
					onClick={() => setOpen(true)}
				>
					<Plus className="size-3.5" aria-hidden="true" />
					Add a GitHub Enterprise host
				</button>
			</li>
		);
	}

	return (
		<li className="px-5 py-3">
			<form className="flex gap-2" onSubmit={submit}>
				<input
					value={host}
					onChange={(event) => setHost(event.currentTarget.value)}
					autoComplete="off"
					spellCheck={false}
					aria-label="Enterprise host"
					placeholder="github.example.com"
					disabled={disabled || signIn.running}
					className={cn(inputClass, 'flex-1 font-mono')}
				/>
				<button
					type="submit"
					className={cn(primaryButtonClass, 'h-9')}
					disabled={disabled || signIn.running || !normalizedHost}
				>
					Sign in
				</button>
				{!signIn.running && (
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground px-1 text-[12px] transition"
						onClick={() => setOpen(false)}
					>
						Cancel
					</button>
				)}
			</form>
			<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
		</li>
	);
}

function GitHubMark() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="p-[8%]">
			<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
		</svg>
	);
}
