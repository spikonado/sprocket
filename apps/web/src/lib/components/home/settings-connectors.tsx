import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { z } from 'zod';
import type { ConnectorStatus, LocalApi } from '$lib/types/sprocket';

type ConnectorsApi = Pick<LocalApi, 'fetchConnectors' | 'installConnector' | 'uninstallConnector'>;

const INSTALL_POLL_MS = 2000;

const logos: Record<ConnectorStatus['id'], string> = { kicad: '/kicad.svg' };

const caughtMessage = z
	.instanceof(Error)
	.transform((error) => error.message)
	.catch('');

const primaryButtonClass =
	'bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition hover:opacity-90 disabled:opacity-50';

const secondaryButtonClass =
	'border-border text-foreground hover:bg-hover-fill inline-flex h-8 items-center rounded-lg border px-3 text-[13px] transition disabled:opacity-50';

export default function SettingsConnectors({
	userId,
	localApi
}: {
	userId: string;
	localApi: ConnectorsApi | null;
}) {
	const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!localApi) return;

		try {
			setConnectors(await localApi.fetchConnectors(userId));
			setLoadError(null);
		} catch (caught) {
			setLoadError(caughtMessage.parse(caught) || 'Couldn’t check connectors on this computer.');
		}
	}, [localApi, userId]);

	useEffect(() => {
		void load();
	}, [load]);

	const installing = connectors?.some((connector) => connector.state === 'installing') ?? false;

	useEffect(() => {
		if (!installing) return;
		const timer = setInterval(() => void load(), INSTALL_POLL_MS);

		return () => clearInterval(timer);
	}, [installing, load]);

	function replace(status: ConnectorStatus) {
		setConnectors(
			(current) =>
				current && current.map((connector) => (connector.id === status.id ? status : connector))
		);
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Connectors</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					{!localApi ? (
						<p className="text-muted-foreground text-sm leading-6">
							Connectors are installed on the computer running Sprocket. Open Sprocket there to
							change them.
						</p>
					) : (
						connectors?.map((connector) => (
							<ConnectorCard
								key={connector.id}
								connector={connector}
								onInstall={() => localApi.installConnector(userId, connector.id)}
								onUninstall={() => localApi.uninstallConnector(userId, connector.id)}
								onStatus={replace}
							/>
						))
					)}

					{loadError && (
						<p role="alert" className="text-destructive text-sm">
							{loadError}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}

function ConnectorCard({
	connector,
	onInstall,
	onUninstall,
	onStatus
}: {
	connector: ConnectorStatus;
	onInstall: () => Promise<ConnectorStatus>;
	onUninstall: () => Promise<ConnectorStatus>;
	onStatus: (status: ConnectorStatus) => void;
}) {
	const [pending, setPending] = useState(false);
	const [requestError, setRequestError] = useState<string | null>(null);
	const installing = connector.state === 'installing';
	const busy = pending || installing;
	const error = requestError ?? connector.error;

	async function run(action: () => Promise<ConnectorStatus>) {
		setPending(true);
		setRequestError(null);

		try {
			onStatus(await action());
		} catch (caught) {
			setRequestError(caughtMessage.parse(caught) || 'Something went wrong.');
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="border-border flex items-center gap-3 rounded-xl border p-5">
			<img src={logos[connector.id]} alt="" className="size-8 shrink-0" />
			<div className="min-w-0 flex-1">
				<p className="text-foreground flex items-center gap-2 text-[15px] font-medium">
					{connector.name}
					<span className="border-border text-muted-foreground rounded-full border px-1.5 text-[11px] leading-4 font-normal">
						Experimental
					</span>
				</p>
				{error && (
					<p className="text-destructive mt-0.5 truncate text-[12px]" title={error}>
						{error}
					</p>
				)}
			</div>
			{connector.state === 'installed' ? (
				<>
					{connector.updateAvailable && (
						<button
							type="button"
							className={primaryButtonClass}
							disabled={busy}
							onClick={() => void run(onInstall)}
						>
							Update
						</button>
					)}
					<button
						type="button"
						className={secondaryButtonClass}
						disabled={busy}
						onClick={() => void run(onUninstall)}
					>
						Uninstall
					</button>
				</>
			) : (
				<button
					type="button"
					className={primaryButtonClass}
					disabled={busy}
					onClick={() => void run(onInstall)}
				>
					{installing && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
					{installing ? 'Installing…' : connector.state === 'failed' ? 'Retry' : 'Install'}
				</button>
			)}
		</div>
	);
}
