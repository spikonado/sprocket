import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { requestPackageUpdate, updateLabel, type UpdateState } from '$lib/updates';

const UPDATED_STATUSES: ReadonlyArray<UpdateState['status']> = [
	'downloading',
	'downloaded',
	'installing',
	'installed'
];

export default function AppUpdate() {
	const [updateState, setUpdateState] = useState<UpdateState | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [busy, setBusyState] = useState(false);
	const [confirmInstall, setConfirmInstall] = useState(false);
	const busyRef = useRef(false);
	const revisionRef = useRef(0);
	const label = updateState ? updateLabel(updateState) : null;
	const working =
		busy || updateState?.status === 'downloading' || updateState?.status === 'installing';

	const setBusy = (next: boolean) => {
		busyRef.current = next;
		setBusyState(next);
	};

	const acceptUpdate = useCallback((next: UpdateState | null) => {
		setUpdateState(next);
		if (next && UPDATED_STATUSES.includes(next.status)) {
			setRequestError(null);
		}
	}, []);

	useEffect(() => {
		let disposed = false;
		let polling = false;
		let unsupported = false;
		const bridge = window.sprocketDesktopBridge;
		const updates = bridge?.updates;
		const unsubscribe = updates?.onState((next) => {
			revisionRef.current += 1;
			acceptUpdate(next);
		});
		async function refresh() {
			if (polling || disposed || busyRef.current || unsupported) return;
			polling = true;
			const startedRevision = revisionRef.current;
			try {
				const next = updates ? await updates.getState() : await requestPackageUpdate(false);
				if (!disposed && revisionRef.current === startedRevision) {
					acceptUpdate(next);
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
	}, [acceptUpdate]);

	async function update() {
		if (!updateState || working) return;
		if (updateState.method === 'package' && !confirmInstall) {
			setConfirmInstall(true);
			return;
		}
		setConfirmInstall(false);
		const startedRevision = ++revisionRef.current;
		setBusy(true);
		setRequestError(null);
		try {
			const updates = window.sprocketDesktopBridge?.updates;
			if (updateState.method === 'desktop' && updates) {
				const next = await (updateState.status === 'downloaded'
					? updates.install()
					: updates.download());
				if (revisionRef.current === startedRevision) acceptUpdate(next);
			} else if (updateState.method === 'package') {
				acceptUpdate(await requestPackageUpdate(true));
			}
		} catch (error) {
			setRequestError(error instanceof Error ? error.message : String(error));
		} finally {
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
				disabled={working || updateState.status === 'installed'}
				onClick={() => void update()}
				title={updateState.version ? `Sprocket ${updateState.version}` : undefined}
				aria-busy={working}
			>
				{working ? (
					<LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
				) : updateState.status === 'downloaded' ? (
					<RefreshCw className="size-4 shrink-0" aria-hidden="true" />
				) : (
					<Download className="size-4 shrink-0" aria-hidden="true" />
				)}
				<span>{label}</span>
			</button>
			{confirmInstall && (
				<div className="text-muted-foreground px-2 pb-2 text-xs">
					<p>
						Install {updateState.version} using your package manager? Restart Sprocket from your
						terminal afterward to use the new version.
					</p>
					<p className="mt-1">
						On Windows, a locked executable may require stopping Sprocket and running
						<code>sprocket update</code> instead.
					</p>
					<div className="mt-2 flex gap-3">
						<button
							type="button"
							className="text-foreground underline"
							onClick={() => void update()}
						>
							Install update
						</button>
						<button type="button" className="underline" onClick={() => setConfirmInstall(false)}>
							Cancel
						</button>
					</div>
				</div>
			)}
			{updateState.status === 'installed' && (
				<p className="text-muted-foreground px-2 pb-2 text-xs">
					Wait for active agents to finish, then stop Sprocket in your terminal and launch it again.
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
