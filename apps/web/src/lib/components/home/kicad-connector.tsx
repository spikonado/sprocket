import { LoaderCircle } from 'lucide-react';
import type { ConnectorStatus, LocalApi } from '$lib/types/sprocket';
import {
	ConnectorPanel,
	primaryButtonClass,
	rowSecondaryButtonClass,
	unloadedState,
	useConnectorAction,
	useOnConnected,
	type ConnectorState
} from './connector-parts';
import { useConnectors } from './use-connectors';

export type KiCadApi = Pick<
	LocalApi,
	'fetchConnectors' | 'installOrUpdateConnector' | 'uninstallConnector'
>;

export const kicadDescription = 'Lets the agent design PCBs';

export function kicadState(connector: ConnectorStatus): ConnectorState {
	if (connector.state === 'installing') return { tone: 'working', label: 'Installing…' };

	if (connector.state === 'failed') return { tone: 'attention', label: 'Install failed' };

	if (connector.state === 'notInstalled') return { tone: 'off', label: 'Not installed' };

	if (connector.updateAvailable) return { tone: 'attention', label: 'Update available' };

	return { tone: 'ready', label: 'Ready' };
}

export function KiCadLogo() {
	return <img src={`${import.meta.env.BASE_URL}kicad.svg`} alt="" />;
}

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
	const { pending, error, act } = useConnectorAction<'change'>('KiCad');
	const installing = connector?.state === 'installing';
	const busy = pending !== null || installing;

	useOnConnected(connector?.state === 'installed', onConnected);

	const run = (action: (id: ConnectorStatus['id']) => Promise<ConnectorStatus>) =>
		void act('change', async () => replace(await action('kicad')));

	const install = () => run((id) => localApi.installOrUpdateConnector(userId, id));

	return (
		<ConnectorPanel
			logo={<KiCadLogo />}
			name="KiCad"
			tag="Experimental"
			description={kicadDescription}
			state={connector ? kicadState(connector) : unloadedState(loadError)}
			actions={
				connector &&
				(connector.state !== 'installed' || connector.updateAvailable) && (
					<button type="button" className={primaryButtonClass} disabled={busy} onClick={install}>
						{installing && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
						{installing
							? 'Installing…'
							: connector.state === 'failed'
								? 'Retry'
								: connector.state === 'installed'
									? 'Update'
									: 'Install'}
					</button>
				)
			}
			error={error ?? connector?.error ?? loadError}
			footer={
				connector?.state === 'installed'
					? {
							info: connector.kicadVersion ? (
								<>
									KiCad <span className="font-mono">{connector.kicadVersion}</span>
								</>
							) : (
								'Installed'
							),
							actions: (
								<button
									type="button"
									className={rowSecondaryButtonClass}
									disabled={busy}
									onClick={() => run((id) => localApi.uninstallConnector(userId, id))}
								>
									Uninstall
								</button>
							)
						}
					: undefined
			}
		/>
	);
}
