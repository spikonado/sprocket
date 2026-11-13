import { useState, type ReactNode } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { cn } from '$lib/utils';
import type { ToolInstall } from '$lib/types/sprocket';
import { SwitchTrack } from './preference-toggle';
import { caughtMessage } from './use-connectors';

export const primaryButtonClass =
	'bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] transition hover:opacity-90 disabled:opacity-50';

export const secondaryButtonClass =
	'border-border text-foreground hover:bg-hover-fill inline-flex h-8 items-center rounded-lg border px-3 text-[13px] transition disabled:opacity-50';

export const rowPrimaryButtonClass =
	'bg-primary text-primary-foreground inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-[12px] transition hover:opacity-90 disabled:opacity-50';

export const rowSecondaryButtonClass =
	'border-border text-foreground hover:bg-hover-fill inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[12px] transition disabled:opacity-50';

export function useConnectorAction<Key extends string>(name: string) {
	const [pending, setPending] = useState<Key | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function act(key: Key, run: () => Promise<void>) {
		if (pending) return;
		setPending(key);
		setError(null);

		try {
			await run();
		} catch (caught) {
			setError(caughtMessage.parse(caught) || `Couldn’t update ${name} on this computer.`);
		} finally {
			setPending(null);
		}
	}

	return { pending, error, act };
}

export function CliConnectorCard({
	logo,
	name,
	cliName,
	cli,
	checking,
	busy,
	retrying,
	onRetry,
	onRefresh,
	action,
	error,
	children
}: {
	logo: ReactNode;
	name: string;
	cliName: string;
	cli: { install: ToolInstall; version: string | null } | null;
	checking: boolean;
	busy: boolean;
	retrying: boolean;
	onRetry: () => void;
	onRefresh: () => void;
	action?: ReactNode;
	error: string | null;
	children: ReactNode;
}) {
	return (
		<div className="border-border overflow-hidden rounded-xl border">
			<div className="flex items-center gap-3 p-5">
				{logo}
				<div className="min-w-0 flex-1">
					<p className="text-foreground text-[15px]">{name}</p>
					{cli ? (
						<CliInstallLine name={cliName} install={cli.install} version={cli.version} />
					) : (
						<p className="text-muted-foreground mt-0.5 text-[12px]">
							{checking ? `Checking ${name}…` : 'Status unavailable'}
						</p>
					)}
				</div>
				{cli?.install.state === 'failed' && (
					<button
						type="button"
						className={primaryButtonClass}
						disabled={retrying}
						onClick={onRetry}
					>
						{retrying && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
						Retry
					</button>
				)}
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-7 shrink-0 items-center justify-center rounded-md transition disabled:opacity-50"
					aria-label={`Check ${name} again`}
					title="Check again"
					disabled={checking || busy}
					onClick={onRefresh}
				>
					<RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
				</button>
				{action}
			</div>

			{children}

			{error && (
				<p role="alert" className="text-destructive border-border border-t px-5 py-3 text-[12px]">
					{error}
				</p>
			)}
		</div>
	);
}

function CliInstallLine({
	name,
	install,
	version
}: {
	name: string;
	install: ToolInstall;
	version: string | null;
}) {
	if (install.state === 'installing') {
		return (
			<p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[12px]">
				<LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
				Installing {name}…
			</p>
		);
	}

	if (install.state === 'failed') {
		return (
			<p className="text-destructive mt-0.5 truncate text-[12px]" title={install.error}>
				{install.error}
			</p>
		);
	}

	return (
		<p className="text-muted-foreground mt-0.5 text-[12px]">
			{name} {version && <span className="font-mono">{version}</span>}
		</p>
	);
}

export function StatusLine({
	tone,
	children
}: {
	tone: 'ok' | 'problem' | 'off';
	children: ReactNode;
}) {
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
			<span className={cn(tone === 'problem' && 'text-foreground')}>{children}</span>
		</p>
	);
}

export function Switch({
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
			className="focus-visible:ring-ring/60 flex shrink-0 rounded-full outline-none focus-visible:ring-2 disabled:opacity-50"
			onClick={() => onChange(!checked)}
		>
			<SwitchTrack enabled={checked} />
		</button>
	);
}
