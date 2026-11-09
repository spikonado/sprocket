import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useConvexAuth, useQuery_experimental as useConvexQueryResult } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { LocalApi } from '$lib/types/sprocket';
import {
	installPackageUpdate,
	restartPackageUpdate,
	updateLabel,
	watchPackageUpdate,
	type UpdateState
} from '$lib/updates';
import ConfirmDialog from './confirm-dialog';
import { caughtMessage, useConnectors } from './use-connectors';

export type ConnectorUpdatesApi = Pick<LocalApi, 'fetchConnectors' | 'installOrUpdateConnector'>;

type FailedRequest = { error: string; status: UpdateState['status'] | null };

type TrackedUpdate = { state: UpdateState; restartWhenReady: boolean };

function withState(state: UpdateState | null) {
	return (current: TrackedUpdate | null): TrackedUpdate | null =>
		state && {
			state,
			restartWhenReady: current?.restartWhenReady === true && state.status !== 'error'
		};
}

function withRestartWhenReady(restartWhenReady: boolean) {
	return (current: TrackedUpdate | null) => current && { ...current, restartWhenReady };
}

/** One button updates Sprocket and every connector, and restarts once both finish. */
export default function AppUpdate({
	userId,
	localApi
}: {
	userId: string | null;
	localApi: ConnectorUpdatesApi | null;
}) {
	const auth = useConvexAuth();

	const preferences = useConvexQueryResult({
		query: api.uiPreferences.getMine,
		args: auth.isAuthenticated ? {} : 'skip'
	});

	const [tracked, setTracked] = useState<TrackedUpdate | null>(null);
	const [confirmRestart, setConfirmRestart] = useState(false);
	const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null);
	const [busy, setBusy] = useState(false);
	const revisionRef = useRef(0);
	const { connectors, replace } = useConnectors(userId, localApi);
	const updateState = tracked?.state ?? null;
	const sprocketLabel = updateState ? updateLabel(updateState) : null;
	const outdated = connectors?.filter((connector) => connector.updateAvailable) ?? [];
	const connectorsInstalling = outdated.some((connector) => connector.state === 'installing');
	const connectorError = outdated.find((connector) => connector.error)?.error ?? null;

	const sprocketWorking =
		updateState?.status === 'downloading' || updateState?.status === 'installing';

	const working = busy || sprocketWorking || connectorsInstalling;
	const restartReady = updateState?.status === 'installed' || updateState?.status === 'downloaded';

	const requestError =
		failedRequest && failedRequest.status === (updateState?.status ?? null)
			? failedRequest.error
			: null;

	const continuesAgents =
		preferences.status === 'success' && preferences.data?.automaticAgentContinuation !== false;

	const connectorLabel = outdated.length
		? connectorError
			? 'Retry update'
			: 'Update available'
		: null;

	const label =
		busy && restartReady
			? 'Restarting Sprocket...'
			: connectorsInstalling && !sprocketWorking
				? 'Installing update…'
				: (sprocketLabel ?? connectorLabel);

	const title = [
		sprocketLabel && updateState?.version ? `Sprocket ${updateState.version}` : null,
		...outdated.map((connector) => `${connector.name} connector`)
	]
		.filter(Boolean)
		.join(', ');

	useEffect(() => {
		const watch = new AbortController();
		const updates = window.sprocketDesktopBridge?.updates;

		const onState = (next: UpdateState) => {
			revisionRef.current += 1;
			setTracked(withState(next));
		};

		if (updates) {
			const unsubscribe = updates.onState(onState);
			const startedRevision = revisionRef.current;

			void updates.getState().then(
				(next) => {
					if (!watch.signal.aborted && revisionRef.current === startedRevision) {
						setTracked(withState(next));
					}
				},
				() => undefined
			);

			return () => {
				watch.abort();
				unsubscribe();
			};
		}

		void (async () => {
			while (!watch.signal.aborted) {
				await watchPackageUpdate({ signal: watch.signal, onEvent: onState }).catch(() => undefined);

				if (!watch.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		})();

		return () => watch.abort();
	}, []);

	useEffect(() => {
		if (!restartReady || working || !continuesAgents || !tracked?.restartWhenReady) return;
		void update();
	});

	async function updateSprocket(startedRevision: number) {
		const updates = window.sprocketDesktopBridge?.updates;

		if (!updateState || !sprocketLabel) return;

		if (updateState.method === 'desktop' && updates) {
			const next = await (updateState.status === 'downloaded'
				? updates.install()
				: updates.download());

			if (revisionRef.current === startedRevision) setTracked(withState(next));
		} else if (updateState.method === 'package') {
			if (updateState.status === 'installed' && updateState.version) {
				await restartPackageUpdate(updateState.version);
			} else {
				const next = await installPackageUpdate();

				if (revisionRef.current === startedRevision) setTracked(withState(next));
			}
		}
	}

	async function updateConnectors() {
		if (!userId || !localApi) return;

		await Promise.all(
			outdated.map(async (connector) =>
				replace(await localApi.installOrUpdateConnector(userId, connector.id))
			)
		);
	}

	async function update(confirmed = false) {
		if (!label || working) return;

		if (restartReady && !confirmed && !continuesAgents) {
			setConfirmRestart(true);

			return;
		}

		setConfirmRestart(false);
		setTracked(withRestartWhenReady(!restartReady && continuesAgents));

		const startedRevision = ++revisionRef.current;
		setBusy(true);
		setFailedRequest(null);

		try {
			await Promise.all([
				updateSprocket(startedRevision),
				restartReady ? undefined : updateConnectors()
			]);
		} catch (error) {
			setTracked(withRestartWhenReady(false));
			setFailedRequest({
				error: caughtMessage.parse(error) || String(error),
				status: updateState?.status ?? null
			});
		} finally {
			setBusy(false);
		}
	}

	if (!label) return null;

	const error = requestError || updateState?.error || connectorError;

	return (
		<div className="mb-1" aria-live="polite">
			<button
				type="button"
				className="text-foreground hover:bg-hover-fill flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] tracking-[-0.02em] transition disabled:cursor-default disabled:opacity-70"
				disabled={working}
				data-ph-capture-attribute-action={restartReady ? 'restart_to_update' : 'install_update'}
				onClick={() => void update()}
				title={title || undefined}
				aria-busy={working}
			>
				{working ? (
					<LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
				) : restartReady ? (
					<RefreshCw className="size-4 shrink-0" aria-hidden="true" />
				) : (
					<Download className="size-4 shrink-0" aria-hidden="true" />
				)}
				<span>{label}</span>
			</button>
			{confirmRestart && (
				<ConfirmDialog
					title="Restart Sprocket?"
					description="Restarting interrupts active agents. They resume afterward only when automatic continuation is on in Settings."
					confirmLabel="Restart Sprocket"
					onCancel={() => setConfirmRestart(false)}
					onConfirm={() => void update(true)}
				/>
			)}
			{error && (
				<p className="text-destructive px-2 pb-2 text-xs break-words" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
