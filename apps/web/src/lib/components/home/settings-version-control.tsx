import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ExternalLink, Eye, EyeOff, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { useAction } from 'convex/react';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import { convexClientErrorMessage } from '$lib/convex-error';
import { cn } from '$lib/utils';
import type {
	LocalApi,
	GitHubHostStatus,
	GitHubSettingsUpdate,
	GitHubStatus
} from '$lib/types/sprocket';

const sourceLabels: Record<NonNullable<GitHubHostStatus['source']>, string> = {
	settings: 'saved token',
	environment: 'environment token',
	gitHubCli: 'gh login'
};

type GitHubApi = Pick<LocalApi, 'fetchGitHubStatus' | 'updateGitHubSettings'>;

const caughtError = z.instanceof(Error).catch(new Error());

const tokenInputClass =
	'border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-ring h-9 w-full min-w-0 rounded-lg border font-mono text-[13px] outline-none disabled:opacity-50';

export default function SettingsVersionControl({
	userId,
	localApi
}: {
	userId: string;
	localApi: GitHubApi | null;
}) {
	const saveToken = useAction(api.githubCredentials.saveToken);
	const removeToken = useAction(api.githubCredentials.removeToken);
	const [status, setStatus] = useState<GitHubStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const check = useCallback(async () => {
		if (!localApi) return;
		setChecking(true);
		setError(null);

		try {
			setStatus(await localApi.fetchGitHubStatus(userId));
		} catch (caught) {
			setError(
				convexClientErrorMessage(caughtError.parse(caught)) ??
					'Couldn’t check GitHub on this computer.'
			);
		} finally {
			setChecking(false);
		}
	}, [localApi, userId]);

	useEffect(() => {
		void check();
	}, [check]);

	/** Runs one change, then shows the status that results from it. */
	async function change(key: string, run: (api: GitHubApi) => Promise<GitHubStatus>) {
		if (!localApi || pendingKey) return false;
		setPendingKey(key);
		setError(null);

		try {
			setStatus(await run(localApi));

			return true;
		} catch (caught) {
			setError(
				convexClientErrorMessage(caughtError.parse(caught)) ?? 'Couldn’t save your GitHub settings.'
			);

			return false;
		} finally {
			setPendingKey(null);
		}
	}

	const setEnabled = (key: string, update: GitHubSettingsUpdate) =>
		change(key, (desktop) => desktop.updateGitHubSettings(userId, update));

	const setToken = (host: string, token: string, key = host) =>
		change(key, async (desktop) => {
			await (token ? saveToken({ host, token }) : removeToken({ host }));

			return await desktop.fetchGitHubStatus(userId);
		});

	const enabled = status?.enabled ?? true;
	const busy = checking || pendingKey !== null;

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">
					Version Control
				</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					{!localApi ? (
						<p className="text-muted-foreground text-sm leading-6">
							Version control settings belong to the computer running Sprocket. Open Sprocket there
							to change them.
						</p>
					) : (
						<div className="border-border overflow-hidden rounded-xl border">
							<div className="flex items-start gap-3 p-5">
								<GitHubMark className="text-foreground mt-0.5 size-5 shrink-0" />
								<div className="min-w-0 flex-1">
									<p className="text-foreground text-[15px] font-medium">GitHub</p>
									<p className="text-muted-foreground mt-0.5 text-[12px]">
										{status === null ? (
											checking ? (
												'Checking GitHub…'
											) : (
												'Status unavailable'
											)
										) : status.cliVersion ? (
											<>
												GitHub CLI <span className="font-mono">{status.cliVersion}</span>
											</>
										) : (
											<>
												GitHub CLI not installed.{' '}
												<a
													href="https://cli.github.com"
													target="_blank"
													rel="noreferrer"
													className="text-foreground inline-flex items-center gap-0.5 hover:underline"
												>
													Install it
													<ExternalLink className="size-3" aria-hidden="true" />
												</a>{' '}
												or save a token below.
											</>
										)}
									</p>
								</div>
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-7 items-center justify-center rounded-md transition disabled:opacity-50"
									aria-label="Check GitHub again"
									title="Check again"
									disabled={busy}
									onClick={() => void check()}
								>
									<RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
								</button>
								<Switch
									label="Use GitHub"
									checked={enabled}
									disabled={status === null || busy}
									onChange={(next) => void setEnabled('github', { enabled: next })}
								/>
							</div>

							{status && (
								<ul
									className={cn(
										'border-border divide-border divide-y border-t',
										!enabled && 'opacity-50'
									)}
								>
									{status.hosts.map((host) => (
										<HostRow
											key={host.host}
											host={host}
											disabled={!enabled || busy}
											saving={pendingKey === host.host}
											onEnabledChange={(next) =>
												void setEnabled(host.host, { host: { host: host.host, enabled: next } })
											}
											onSaveToken={(token) => setToken(host.host, token)}
										/>
									))}
									<AddHost
										disabled={!enabled || busy}
										saving={pendingKey === 'new-host'}
										onSave={(host, token) => setToken(host, token, 'new-host')}
									/>
								</ul>
							)}

							{status && !enabled && (
								<p className="text-muted-foreground border-border border-t px-5 py-3 text-[12px]">
									GitHub is off. Agents can’t link pull requests and their status won’t refresh.
								</p>
							)}

							{status?.savedTokensProblem && (
								<p className="text-foreground border-border border-t px-5 py-3 text-[12px]">
									Couldn’t load your saved tokens, so this computer uses its own credentials:{' '}
									{status.savedTokensProblem}
								</p>
							)}
						</div>
					)}

					{error && (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}

function HostRow({
	host,
	disabled,
	saving,
	onEnabledChange,
	onSaveToken
}: {
	host: GitHubHostStatus;
	disabled: boolean;
	saving: boolean;
	onEnabledChange: (enabled: boolean) => void;
	onSaveToken: (token: string) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
	const tokenEditorId = `github-token-${host.host}`;

	return (
		<li className="px-5 py-4">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-foreground truncate font-mono text-[13px]">{host.host}</p>
					<HostState host={host} />
				</div>
				<button
					type="button"
					className={cn(
						'hover:bg-hover-fill inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition disabled:opacity-50',
						host.hasSavedToken || editing
							? 'text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					aria-expanded={editing}
					aria-controls={tokenEditorId}
					disabled={disabled || !host.enabled}
					onClick={() => setEditing((open) => !open)}
				>
					<KeyRound className="size-3.5" aria-hidden="true" />
					{host.hasSavedToken ? 'Token saved' : 'Add token'}
				</button>
				<Switch
					label={`Use ${host.host}`}
					checked={host.enabled}
					disabled={disabled}
					onChange={(enabled) => {
						if (!enabled) setEditing(false);
						onEnabledChange(enabled);
					}}
				/>
			</div>
			{editing && host.enabled && (
				<TokenEditor
					id={tokenEditorId}
					host={host}
					disabled={disabled}
					saving={saving}
					onSave={async (token) => {
						if (await onSaveToken(token)) setEditing(false);
					}}
				/>
			)}
		</li>
	);
}

function HostState({ host }: { host: GitHubHostStatus }) {
	const [tone, text] = !host.enabled
		? (['off', 'Off'] as const)
		: host.problem
			? (['problem', host.problem] as const)
			: host.login && host.source
				? (['ok', `Signed in as ${host.login} · ${sourceLabels[host.source]}`] as const)
				: ([
						'off',
						`Not signed in. Run gh auth login --hostname ${host.host}, or add a token.`
					] as const);

	return (
		<p className="text-muted-foreground mt-1 flex items-start gap-1.5 text-[12px] leading-5">
			<span
				aria-hidden="true"
				className={cn(
					'mt-[7px] size-1.5 shrink-0 rounded-full',
					tone === 'ok' && 'bg-emerald-500',
					tone === 'problem' && 'bg-amber-500',
					tone === 'off' && 'bg-muted-foreground/40'
				)}
			/>
			<span className={cn(tone === 'problem' && 'text-foreground')}>{text}</span>
		</p>
	);
}

function AddHost({
	disabled,
	saving,
	onSave
}: {
	disabled: boolean;
	saving: boolean;
	onSave: (host: string, token: string) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const [host, setHost] = useState('');
	const [token, setToken] = useState('');
	const ready = host.trim() !== '' && token.trim() !== '';

	async function submit(event: FormEvent) {
		event.preventDefault();

		if (!ready || !(await onSave(host.trim(), token))) return;
		setOpen(false);
		setHost('');
		setToken('');
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

	const trimmedHost = host.trim().toLowerCase();

	return (
		<li className="px-5 py-4">
			<form
				className="bg-hover-fill/60 space-y-3 rounded-lg p-3"
				onSubmit={(event) => void submit(event)}
			>
				<div className="flex items-center justify-between">
					<p className="text-foreground text-[13px] font-medium">GitHub Enterprise host</p>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground text-[12px] transition"
						onClick={() => setOpen(false)}
					>
						Cancel
					</button>
				</div>
				<div className="flex gap-2">
					<input
						value={host}
						onChange={(event) => setHost(event.currentTarget.value)}
						autoComplete="off"
						spellCheck={false}
						aria-label="Enterprise host"
						placeholder="github.example.com"
						disabled={disabled}
						className={cn(tokenInputClass, 'basis-2/5 px-3')}
					/>
					<input
						type="password"
						value={token}
						onChange={(event) => setToken(event.currentTarget.value)}
						autoComplete="off"
						spellCheck={false}
						aria-label="Enterprise token"
						placeholder="ghp_… or github_pat_…"
						disabled={disabled}
						className={cn(tokenInputClass, 'flex-1 px-3')}
					/>
					<button
						type="submit"
						className="bg-primary text-primary-foreground h-9 shrink-0 rounded-lg px-3.5 text-[13px] font-medium transition hover:opacity-90 disabled:opacity-50"
						disabled={disabled || !ready}
					>
						{saving ? 'Checking…' : 'Add'}
					</button>
				</div>
				<TokenHelp host={trimmedHost.includes('.') ? trimmedHost : null}>
					Create a token on {trimmedHost}
				</TokenHelp>
			</form>
		</li>
	);
}

function TokenHelp({ host, children }: { host: string | null; children: ReactNode }) {
	return (
		<p className="text-muted-foreground text-[12px] leading-5">
			It needs read access to pull requests.
			{host && (
				<>
					{' '}
					<a
						href={`https://${host}/settings/tokens/new?description=Sprocket&scopes=repo`}
						target="_blank"
						rel="noreferrer"
						className="text-foreground inline-flex items-center gap-0.5 hover:underline"
					>
						{children}
						<ExternalLink className="size-3" aria-hidden="true" />
					</a>
				</>
			)}
		</p>
	);
}

function TokenEditor({
	id,
	host,
	disabled,
	saving,
	onSave
}: {
	id: string;
	host: GitHubHostStatus;
	disabled: boolean;
	saving: boolean;
	onSave: (token: string) => Promise<void>;
}) {
	const [token, setToken] = useState('');
	const [visible, setVisible] = useState(false);

	function submit(event: FormEvent) {
		event.preventDefault();

		if (token.trim()) void onSave(token);
	}

	return (
		<form id={id} className="bg-hover-fill/60 mt-3 space-y-3 rounded-lg p-3" onSubmit={submit}>
			<div className="flex gap-2">
				<div className="relative min-w-0 flex-1">
					<input
						type={visible ? 'text' : 'password'}
						value={token}
						onChange={(event) => setToken(event.currentTarget.value)}
						autoComplete="off"
						spellCheck={false}
						aria-label={`Token for ${host.host}`}
						placeholder={host.hasSavedToken ? 'Enter a replacement token' : 'ghp_… or github_pat_…'}
						disabled={disabled}
						className={cn(tokenInputClass, 'pr-9 pl-3')}
					/>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center"
						aria-label={visible ? 'Hide token' : 'Show token'}
						onClick={() => setVisible((shown) => !shown)}
					>
						{visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
					</button>
				</div>
				<button
					type="submit"
					className="bg-primary text-primary-foreground h-9 rounded-lg px-3.5 text-[13px] font-medium transition hover:opacity-90 disabled:opacity-50"
					disabled={disabled || !token.trim()}
				>
					{saving ? 'Checking…' : 'Save'}
				</button>
			</div>
			<TokenHelp host={host.host}>Create a token</TokenHelp>
			{host.hasSavedToken && (
				<button
					type="button"
					className="text-muted-foreground hover:text-destructive text-[12px] transition disabled:opacity-50"
					disabled={disabled}
					onClick={() => void onSave('')}
				>
					Remove saved token
				</button>
			)}
		</form>
	);
}

function Switch({
	label,
	checked,
	disabled,
	onChange
}: {
	label: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			className={cn(
				'focus-visible:ring-ring/60 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition outline-none focus-visible:ring-2 disabled:opacity-50',
				checked ? 'bg-foreground' : 'bg-hover-fill-strong'
			)}
			onClick={() => onChange(!checked)}
		>
			<span
				className={cn(
					'bg-background inline-block size-3.5 rounded-full transition',
					checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
				)}
			/>
		</button>
	);
}

function GitHubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
		</svg>
	);
}
