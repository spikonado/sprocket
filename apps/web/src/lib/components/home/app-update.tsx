import { useEffect, useRef, useState, type ReactNode } from 'react';
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

type FailedRequest = { error: string; status: UpdateState['status'] };

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
	const updateState = tracked?.state ?? null;
	const label = updateState ? updateLabel(updateState) : null;

	const requestError =
		failedRequest && failedRequest.status === updateState?.status ? failedRequest.error : null;

	const working =
		busy || updateState?.status === 'downloading' || updateState?.status === 'installing';

	const restartReady = updateState?.status === 'installed' || updateState?.status === 'downloaded';

	const continuesAgents =
		preferences.status === 'success' && preferences.data?.automaticAgentContinuation !== false;

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

	async function update(confirmed = false) {
		if (!updateState || working) return;

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
			const updates = window.sprocketDesktopBridge?.updates;

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
		} catch (error) {
			setTracked(withRestartWhenReady(false));
			setFailedRequest({
				error: error instanceof Error ? error.message : String(error),
				status: updateState.status
			});
		} finally {
			setBusy(false);
		}
	}

	if (!label || !updateState) {
		return userId && localApi ? <ConnectorUpdate userId={userId} localApi={localApi} /> : null;
	}

	return (
		<UpdateButton
			label={busy && restartReady ? 'Restarting Sprocket...' : label}
			title={updateState.version ? `Sprocket ${updateState.version}` : undefined}
			working={working}
			restartReady={restartReady}
			error={requestError || updateState.error}
			onClick={() => void update()}
		>
			{confirmRestart && (
				<ConfirmDialog
					title="Restart Sprocket?"
					description="Restarting interrupts active agents. They resume afterward only when automatic continuation is on in Settings."
					confirmLabel="Restart Sprocket"
					onCancel={() => setConfirmRestart(false)}
					onConfirm={() => void update(true)}
				/>
			)}
		</UpdateButton>
	);
}

/** Shown only when Sprocket is current, since a Sprocket update also updates connectors on startup. */
function ConnectorUpdate({ userId, localApi }: { userId: string; localApi: ConnectorUpdatesApi }) {
	const { connectors, replace } = useConnectors(userId, localApi);
	const [busy, setBusy] = useState(false);
	const [requestError, setRequestError] = useState<string | null>(null);
	const outdated = connectors?.filter((connector) => connector.updateAvailable) ?? [];
	const installing = outdated.some((connector) => connector.state === 'installing');
	const error = requestError ?? outdated.find((connector) => connector.error)?.error ?? null;

	async function update() {
		setBusy(true);
		setRequestError(null);

		try {
			await Promise.all(
				outdated.map(async (connector) =>
					replace(await localApi.installOrUpdateConnector(userId, connector.id))
				)
			);
		} catch (caught) {
			setRequestError(caughtMessage.parse(caught) || 'Something went wrong.');
		} finally {
			setBusy(false);
		}
	}

	if (outdated.length === 0) return null;

	return (
		<UpdateButton
			label={installing ? 'Installing update…' : error ? 'Retry update' : 'Update available'}
			title={outdated.map((connector) => `${connector.name} connector`).join(', ')}
			working={busy || installing}
			restartReady={false}
			error={error}
			onClick={() => void update()}
		/>
	);
}

function UpdateButton({
	label,
	title,
	working,
	restartReady,
	error,
	onClick,
	children
}: {
	label: string;
	title: string | undefined;
	working: boolean;
	restartReady: boolean;
	error: string | null;
	onClick: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="mb-1" aria-live="polite">
			<button
				type="button"
				className="text-foreground hover:bg-hover-fill flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] tracking-[-0.02em] transition disabled:cursor-default disabled:opacity-70"
				disabled={working}
				data-ph-capture-attribute-action={restartReady ? 'restart_to_update' : 'install_update'}
				onClick={onClick}
				title={title}
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
			{children}
			{error && (
				<p className="text-destructive px-2 pb-2 text-xs break-words" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
