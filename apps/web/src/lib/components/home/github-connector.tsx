import { useCallback, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '$lib/utils';
import type { GitHubHostStatus, GitHubSettingsUpdate, LocalApi } from '$lib/types/sprocket';
import {
	CliConnectorCard,
	StatusLine,
	Switch,
	rowPrimaryButtonClass,
	rowSecondaryButtonClass,
	useConnectorAction
} from './connector-card-parts';
import { DeviceSignInPanel, useDeviceSignIn, type SignInApi } from './device-sign-in';
import { pollWhileInstalling, usePolledStatus } from './use-connectors';

export type GitHubApi = SignInApi &
	Pick<
		LocalApi,
		'fetchGitHubStatus' | 'updateGitHubSettings' | 'signOutGitHub' | 'installConnectorCli'
	>;

const sourceLabels: Record<NonNullable<GitHubHostStatus['source']>, string> = {
	environment: 'environment token',
	gitHubCli: 'gh login'
};

export default function GitHubConnector({
	userId,
	localApi
}: {
	userId: string;
	localApi: GitHubApi;
}) {
	const fetchStatus = useCallback(() => localApi.fetchGitHubStatus(userId), [localApi, userId]);

	const { status, setStatus, loadError, checking, reload } = usePolledStatus(
		fetchStatus,
		pollWhileInstalling,
		'Couldn’t check GitHub on this computer.'
	);

	const { pending, error, act } = useConnectorAction<string>('GitHub');

	const update = (key: string, settings: GitHubSettingsUpdate) =>
		act(key, async () => setStatus(await localApi.updateGitHubSettings(userId, settings)));

	const enabled = status?.enabled ?? true;
	const installed = status?.install.state === 'installed';
	const busy = pending !== null;

	return (
		<CliConnectorCard
			logo={<GitHubMark className="text-foreground size-8 shrink-0 p-1" />}
			name="GitHub"
			cliName="GitHub CLI"
			cli={status && { install: status.install, version: status.cliVersion }}
			checking={checking}
			busy={busy}
			retrying={pending === 'install'}
			onRetry={() =>
				void act('install', async () => {
					const install = await localApi.installConnectorCli(userId, 'github');
					setStatus((current) => current && { ...current, install });
				})
			}
			onRefresh={() => void reload()}
			action={
				<Switch
					label="Use GitHub"
					checked={enabled}
					disabled={status === null || busy}
					onChange={(next) => void update('github', { enabled: next })}
				/>
			}
			error={error ?? loadError}
		>
			{status && (
				<ul
					className={cn('border-border divide-border divide-y border-t', !enabled && 'opacity-50')}
				>
					{status.hosts.map((host) => (
						<HostRow
							key={host.host}
							userId={userId}
							signInApi={localApi}
							host={host}
							disabled={!enabled || busy}
							installed={installed}
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
						disabled={!enabled || !installed}
						onSignedIn={() => void reload()}
					/>
				</ul>
			)}

			{status && !enabled && (
				<p className="text-muted-foreground border-border border-t px-5 py-3 text-[12px]">
					GitHub is off. Agents can’t link pull requests and their status won’t refresh.
				</p>
			)}
		</CliConnectorCard>
	);
}

function HostRow({
	userId,
	signInApi,
	host,
	disabled,
	installed,
	onEnabledChange,
	onSignOut,
	onSignedIn
}: {
	userId: string;
	signInApi: SignInApi;
	host: GitHubHostStatus;
	disabled: boolean;
	installed: boolean;
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
		<li className="px-5 py-4">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-foreground truncate font-mono text-[13px]">{host.host}</p>
					<HostState host={host} />
				</div>
				{canSignIn && !signIn.running && (
					<button
						type="button"
						className={rowPrimaryButtonClass}
						disabled={disabled || !installed}
						onClick={() => void signIn.start()}
					>
						Sign in
					</button>
				)}
				{canSignOut && (
					<button
						type="button"
						className={rowSecondaryButtonClass}
						disabled={disabled || !installed || signIn.running}
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

function HostState({ host }: { host: GitHubHostStatus }) {
	if (!host.enabled) return <StatusLine tone="off">Off</StatusLine>;

	const tone = host.problem ? 'problem' : host.login ? 'ok' : 'off';
	const account = host.problem ?? (host.login ? `Signed in as ${host.login}` : 'Not signed in');

	return (
		<StatusLine tone={tone}>
			{host.source ? `${account} · ${sourceLabels[host.source]}` : account}
		</StatusLine>
	);
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
		<li className="px-5 py-4">
			<form className="bg-hover-fill/60 space-y-3 rounded-lg p-3" onSubmit={submit}>
				<div className="flex items-center justify-between">
					<p className="text-foreground text-[13px]">GitHub Enterprise host</p>
					{!signIn.running && (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground text-[12px] transition"
							onClick={() => setOpen(false)}
						>
							Cancel
						</button>
					)}
				</div>
				<div className="flex gap-2">
					<input
						value={host}
						onChange={(event) => setHost(event.currentTarget.value)}
						autoComplete="off"
						spellCheck={false}
						aria-label="Enterprise host"
						placeholder="github.example.com"
						disabled={disabled || signIn.running}
						className="border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-ring h-9 min-w-0 flex-1 rounded-lg border px-3 font-mono text-[13px] outline-none disabled:opacity-50"
					/>
					<button
						type="submit"
						className="bg-primary text-primary-foreground h-9 shrink-0 rounded-lg px-3.5 text-[13px] transition hover:opacity-90 disabled:opacity-50"
						disabled={disabled || signIn.running || !normalizedHost}
					>
						Sign in
					</button>
				</div>
			</form>
			<DeviceSignInPanel status={signIn.status} onCancel={() => void signIn.cancel()} />
		</li>
	);
}

function GitHubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
		</svg>
	);
}
