import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useConvexAuth, useQuery_experimental as useConvexQueryResult } from 'convex/react';
import { api } from '@convex/_generated/api';
import {
	requestPackageUpdate,
	restartPackageUpdate,
	updateLabel,
	type UpdateState
} from '$lib/updates';
import RestartConfirmation from './restart-confirmation';

// An error belongs to the update status it was raised from and hides once that status moves on.
type FailedRequest = { error: string; status: UpdateState['status'] };

export default function AppUpdate() {
	const auth = useConvexAuth();

	const preferences = useConvexQueryResult({
		query: api.uiPreferences.getMine,
		args: auth.isAuthenticated && !auth.isLoading ? {} : 'skip'
	});

	const [updateState, setUpdateState] = useState<UpdateState | null>(null);
	const [confirmRestart, setConfirmRestart] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null);
	const [busy, setBusyState] = useState(false);
	const busyRef = useRef(false);
	const revisionRef = useRef(0);
	const label = updateState ? updateLabel(updateState) : null;

	const requestError =
		failedRequest && failedRequest.status === updateState?.status ? failedRequest.error : null;

	const working =
		busy || updateState?.status === 'downloading' || updateState?.status === 'installing';

	const restartReady = updateState?.status === 'installed' || updateState?.status === 'downloaded';

	const setBusy = (next: boolean) => {
		busyRef.current = next;
		setBusyState(next);
	};

	useEffect(() => {
		let disposed = false;
		let polling = false;
		let unsupported = false;
		const bridge = window.sprocketDesktopBridge;
		const updates = bridge?.updates;

		const unsubscribe = updates?.onState((next) => {
			revisionRef.current += 1;
			setUpdateState(next);
		});

		async function refresh() {
			if (polling || disposed || busyRef.current || unsupported) return;
			polling = true;
			const startedRevision = revisionRef.current;

			try {
				const next = updates ? await updates.getState() : await requestPackageUpdate(false);

				if (!disposed && revisionRef.current === startedRevision) {
					setUpdateState(next);
					unsupported = next === null || next.status === 'unavailable';
				}
			} catch {
				// Background checks must not interrupt work when the server or registry is offline.
			} finally {
				polling = false;
			}
		}

		void refresh();
		const timer = setInterval(() => void refresh(), 5_000);

		return () => {
			disposed = true;
			clearInterval(timer);
			unsubscribe?.();
		};
	}, []);

	async function update(confirmed = false) {
		if (!updateState || working) return;

		if (restartReady && !confirmed) {
			if (preferences.status !== 'success') return;

			if (preferences.data?.automaticAgentContinuation === false) {
				setConfirmRestart(true);

				return;
			}
		}

		setConfirmRestart(false);

		const startedRevision = ++revisionRef.current;
		setBusy(true);
		setFailedRequest(null);

		try {
			const updates = window.sprocketDesktopBridge?.updates;

			if (updateState.method === 'desktop' && updates) {
				const next = await (updateState.status === 'downloaded'
					? updates.install()
					: updates.download());

				if (revisionRef.current === startedRevision) setUpdateState(next);
			} else if (updateState.method === 'package') {
				if (updateState.status === 'installed' && updateState.version) {
					setRestarting(true);
					await restartPackageUpdate(updateState.version);
				} else {
					setUpdateState(await requestPackageUpdate(true));
				}
			}
		} catch (error) {
			setFailedRequest({
				error: error instanceof Error ? error.message : String(error),
				status: updateState.status
			});
		} finally {
			setRestarting(false);
			setBusy(false);
		}
	}

	if (!label || !updateState) {
		return null;
	}

	return (
		<div className="mb-1" aria-live="polite">
			<button
				type="button"
				className="text-foreground hover:bg-hover-fill flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium tracking-[-0.02em] transition disabled:cursor-default disabled:opacity-70"
				disabled={working || (restartReady && preferences.status !== 'success')}
				onClick={() => void update()}
				title={updateState.version ? `Sprocket ${updateState.version}` : undefined}
				aria-busy={working}
			>
				{working ? (
					<LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
				) : restartReady ? (
					<RefreshCw className="size-4 shrink-0" aria-hidden="true" />
				) : (
					<Download className="size-4 shrink-0" aria-hidden="true" />
				)}
				<span>{restarting ? 'Restarting Sprocket...' : label}</span>
			</button>
			{confirmRestart && (
				<RestartConfirmation
					onCancel={() => setConfirmRestart(false)}
					onConfirm={() => void update(true)}
				/>
			)}
			{restartReady && preferences.status === 'error' && (
				<p className="text-destructive px-2 pb-2 text-xs" role="alert">
					Couldn't load your restart preference. Reconnect and try again.
				</p>
			)}
			{(requestError || updateState.error) && (
				<p className="text-destructive px-2 pb-2 text-xs break-words" role="alert">
					{requestError || updateState.error}
				</p>
			)}
		</div>
	);
}
