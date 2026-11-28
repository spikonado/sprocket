import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { cn } from '$lib/utils';
import type { ToolInstall } from '$lib/types/sprocket';
import { SwitchTrack } from './preference-toggle';
import { caughtMessage } from './use-connectors';

export const primaryButtonClass =
	'bg-primary text-primary-foreground inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] transition hover:opacity-90 disabled:opacity-50';

export const secondaryButtonClass =
	'border-border text-foreground hover:bg-hover-fill inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] transition disabled:opacity-50';

export const rowPrimaryButtonClass =
	'bg-primary text-primary-foreground inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition hover:opacity-90 disabled:opacity-50';

export const rowSecondaryButtonClass =
	'border-border text-foreground hover:bg-hover-fill inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition disabled:opacity-50';

export const inputClass =
	'border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-ring h-9 w-full min-w-0 rounded-lg border px-3 text-[13px] outline-none disabled:opacity-50';

export type ConnectorState = { tone: 'ready' | 'attention' | 'working' | 'off'; label: string };

export const checkingState: ConnectorState = { tone: 'working', label: 'Checking…' };

export function unloadedState(loadError: string | null): ConnectorState {
	return loadError ? { tone: 'attention', label: 'Unavailable' } : checkingState;
}

export function cliState<Status extends { install: ToolInstall }>(
	status: Status | null,
	loadError: string | null,
	whenInstalled: (status: Status) => ConnectorState
): ConnectorState {
	if (!status) return unloadedState(loadError);

	if (status.install.state === 'installing') return { tone: 'working', label: 'Installing…' };

	if (status.install.state === 'failed') return { tone: 'attention', label: 'Install failed' };

	return whenInstalled(status);
}

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

/** Calls `onConnected` whenever `connected` turns true, including on mount. */
export function useOnConnected(connected: boolean, onConnected: (() => void) | undefined) {
	const notify = useEffectEvent(() => onConnected?.());

	useEffect(() => {
		if (connected) notify();
	}, [connected]);
}

export function StateBadge({ state }: { state: ConnectorState }) {
	return (
		<span
			role="status"
			className={cn(
				'inline-flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap',
				state.tone === 'attention' ? 'text-foreground' : 'text-muted-foreground'
			)}
		>
			{state.tone === 'working' ? (
				<LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
			) : (
				<span
					aria-hidden="true"
					className={cn(
						'size-1.5 rounded-full',
						state.tone === 'ready' && 'bg-emerald-500',
						state.tone === 'attention' && 'bg-amber-500',
						state.tone === 'off' && 'bg-muted-foreground/40'
					)}
				/>
			)}
			{state.label}
		</span>
	);
}

function LogoBox({ size, children }: { size: 'sm' | 'lg'; children: ReactNode }) {
	return (
		<span
			className={cn(
				'text-foreground flex shrink-0 items-center justify-center [&>*]:size-full',
				size === 'sm' ? 'size-6' : 'size-9'
			)}
		>
			{children}
		</span>
	);
}

export function ConnectorRow({
	logo,
	name,
	detail,
	state,
	onOpen
}: {
	logo: ReactNode;
	name: string;
	detail: ReactNode;
	state: ConnectorState;
	onOpen: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				className="hover:bg-hover-fill focus-visible:bg-hover-fill flex w-full items-center gap-3 px-4 py-3 text-left transition outline-none"
				onClick={onOpen}
			>
				<LogoBox size="sm">{logo}</LogoBox>
				<span className="min-w-0 flex-1">
					<span className="text-foreground block truncate text-[13px]">{name}</span>
					<span className="text-muted-foreground block truncate text-[12px]">{detail}</span>
				</span>
				<StateBadge state={state} />
				<ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
			</button>
		</li>
	);
}

export function ConnectorTile({
	logo,
	name,
	description,
	onOpen
}: {
	logo: ReactNode;
	name: string;
	description: string;
	onOpen: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				className="border-border hover:bg-hover-fill focus-visible:border-ring flex h-full w-full items-start gap-3 rounded-xl border p-3 text-left transition outline-none"
				onClick={onOpen}
			>
				<LogoBox size="sm">{logo}</LogoBox>
				<span className="min-w-0 flex-1">
					<span className="text-foreground block truncate text-[13px]">{name}</span>
					<span className="text-muted-foreground line-clamp-2 text-[12px] leading-5">
						{description}
					</span>
				</span>
			</button>
		</li>
	);
}

export type PanelFooter = { info: ReactNode; actions?: ReactNode };

export function ConnectorPanel({
	logo,
	name,
	tag,
	description,
	state,
	actions,
	error,
	footer,
	children
}: {
	logo: ReactNode;
	name: string;
	tag?: string;
	description: ReactNode;
	state?: ConnectorState;
	actions?: ReactNode;
	error: string | null;
	footer?: PanelFooter;
	children?: ReactNode;
}) {
	return (
		<div className="border-border overflow-hidden rounded-xl border">
			<div className="flex items-start gap-3 p-5">
				<LogoBox size="lg">{logo}</LogoBox>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<h2 className="text-foreground text-[15px]">{name}</h2>
						{tag && (
							<span className="border-border text-muted-foreground rounded-full border px-1.5 text-[11px] leading-4">
								{tag}
							</span>
						)}
						{state && <StateBadge state={state} />}
					</div>
					<div className="text-muted-foreground mt-0.5 text-[12px] leading-5">{description}</div>
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</div>

			{error && (
				<p role="alert" className="text-destructive border-border border-t px-5 py-3 text-[12px]">
					{error}
				</p>
			)}

			{children}

			{footer && (
				<div className="border-border bg-hover-fill/40 flex items-center gap-3 border-t px-5 py-2.5">
					<div className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
						{footer.info}
					</div>
					{footer.actions}
				</div>
			)}
		</div>
	);
}

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-border border-t" aria-label={title}>
			<h3 className="text-muted-foreground px-5 pt-3 pb-1 text-[11px] tracking-[0.06em] uppercase">
				{title}
			</h3>
			{children}
		</section>
	);
}

export function cliFooter({
	name,
	install,
	version,
	checking,
	busy,
	retrying,
	onRetry,
	onRefresh
}: {
	name: string;
	install: ToolInstall | undefined;
	version: string | null;
	checking: boolean;
	busy: boolean;
	retrying: boolean;
	onRetry: () => void;
	onRefresh: () => void;
}): PanelFooter {
	return {
		info:
			install?.state === 'failed' ? (
				<span className="text-destructive" title={install.error}>
					{install.error}
				</span>
			) : (
				<>
					{name} {version && <span className="font-mono">{version}</span>}
				</>
			),
		actions: (
			<>
				{install?.state === 'failed' && (
					<button
						type="button"
						className={rowPrimaryButtonClass}
						disabled={retrying}
						onClick={onRetry}
					>
						{retrying && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
						Retry install
					</button>
				)}
				<button
					type="button"
					className={rowSecondaryButtonClass}
					disabled={checking || busy}
					onClick={onRefresh}
				>
					<RefreshCw className={cn('size-3', checking && 'animate-spin')} aria-hidden="true" />
					Check again
				</button>
			</>
		)
	};
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
