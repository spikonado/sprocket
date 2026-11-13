import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import type { ConnectorStatus, LocalApi, ToolInstall } from '$lib/types/sprocket';

const INSTALL_POLL_MS = 2000;
const UPDATE_POLL_MS = 10 * 60_000;

export const caughtMessage = z
	.instanceof(Error)
	.transform((error) => error.message)
	.catch('');

export function usePolledStatus<T>(
	fetchStatus: (() => Promise<T>) | null,
	pollMs: (status: T | null) => number | null,
	failureMessage: string
) {
	const [status, setCurrentStatus] = useState<T | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	// Bumped by every write so a fetch that started before it can't restore older state.
	const generation = useRef(0);

	const setStatus = useCallback((next: T | null | ((current: T | null) => T | null)) => {
		generation.current += 1;
		setCurrentStatus(next);
	}, []);

	const reload = useCallback(async () => {
		if (!fetchStatus) return;
		const started = generation.current;
		setChecking(true);

		try {
			const fetched = await fetchStatus();

			if (generation.current === started) setCurrentStatus(fetched);
			setLoadError(null);
		} catch (caught) {
			setLoadError(caughtMessage.parse(caught) || failureMessage);
		} finally {
			setChecking(false);
		}
	}, [fetchStatus, failureMessage]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const interval = pollMs(status);

	useEffect(() => {
		if (interval === null) return;
		const timer = setInterval(() => void reload(), interval);

		return () => clearInterval(timer);
	}, [interval, reload]);

	return { status, setStatus, loadError, checking, reload };
}

export function pollWhileInstalling(status: { install: ToolInstall } | null) {
	return status?.install.state === 'installing' ? INSTALL_POLL_MS : null;
}

export function useConnectors(
	userId: string | null,
	localApi: Pick<LocalApi, 'fetchConnectors'> | null
) {
	const fetchConnectors = useMemo(
		() => (localApi && userId ? () => localApi.fetchConnectors(userId) : null),
		[localApi, userId]
	);

	const {
		status: connectors,
		setStatus: setConnectors,
		loadError
	} = usePolledStatus(
		fetchConnectors,
		(current) =>
			current?.some((connector) => connector.state === 'installing')
				? INSTALL_POLL_MS
				: UPDATE_POLL_MS,
		'Couldn’t check connectors on this computer.'
	);

	const replace = useCallback(
		(status: ConnectorStatus) => {
			setConnectors(
				(current) =>
					current && current.map((connector) => (connector.id === status.id ? status : connector))
			);
		},
		[setConnectors]
	);

	return { connectors, loadError, replace };
}
