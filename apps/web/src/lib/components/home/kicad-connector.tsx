import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ConnectorStatus, LocalApi } from '$lib/types/sprocket';
import {
	ConnectorCardFrame,
	ConnectorDescription,
	primaryButtonClass,
	secondaryButtonClass,
	useOnConnected,
	VersionLine
} from './connector-card-parts';
import { caughtMessage, useConnectors } from './use-connectors';

export type KiCadApi = Pick<
	LocalApi,
	'fetchConnectors' | 'installOrUpdateConnector' | 'uninstallConnector'
>;

export default function KiCadConnector({
	userId,
	localApi,
	onConnected
}: {
	userId: string;
	localApi: KiCadApi;
	onConnected?: () => void;
}) {
	const { connectors, loadError, replace } = useConnectors(userId, localApi);
	const connector = connectors?.find((entry) => entry.id === 'kicad');

	useOnConnected(connector?.state === 'installed', onConnected);

	return (
		<>
			{connector && (
				<ConnectorCard
					connector={connector}
					onInstall={() => localApi.installOrUpdateConnector(userId, connector.id)}
					onUninstall={() => localApi.uninstallConnector(userId, connector.id)}
					onStatus={replace}
				/>
			)}
			{loadError && (
				<p role="alert" className="text-destructive text-sm">
					{loadError}
				</p>
			)}
		</>
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
		<ConnectorCardFrame
			logo={<img src={`${import.meta.env.BASE_URL}kicad.svg`} alt="" className="size-8 shrink-0" />}
			name={
				<>
					{connector.name}
					<span className="border-border text-muted-foreground rounded-full border px-1.5 text-[11px] leading-4 font-normal">
						Experimental
					</span>
				</>
			}
			summary={
				<>
					<ConnectorDescription>Lets the agent design PCBs</ConnectorDescription>
					{connector.kicadVersion && (
						<VersionLine name={connector.name} version={connector.kicadVersion} />
					)}
					{error && (
						<p className="text-destructive mt-0.5 truncate text-[12px]" title={error}>
							{error}
						</p>
					)}
				</>
			}
			actions={
				connector.state === 'installed' ? (
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
				)
			}
			error={null}
		/>
	);
}
