import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type { ConnectorStatus, LocalApi } from '$lib/types/sprocket';

const INSTALL_POLL_MS = 2000;
const UPDATE_POLL_MS = 10 * 60_000;

export const caughtMessage = z
	.instanceof(Error)
	.transform((error) => error.message)
	.catch('');

export function useConnectors(
	userId: string | null,
	localApi: Pick<LocalApi, 'fetchConnectors'> | null
) {
	const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!localApi || !userId) return;

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
		const timer = setInterval(() => void load(), installing ? INSTALL_POLL_MS : UPDATE_POLL_MS);

		return () => clearInterval(timer);
	}, [installing, load]);

	const replace = useCallback((status: ConnectorStatus) => {
		setConnectors(
			(current) =>
				current && current.map((connector) => (connector.id === status.id ? status : connector))
		);
	}, []);

	return { connectors, loadError, replace };
}
