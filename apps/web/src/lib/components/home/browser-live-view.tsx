import { ExternalLink, Globe, LoaderCircle, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserLiveViewState } from '$lib/chat/side-panel';

type Props = {
	/** undefined while the query is loading, null when no session exists. */
	liveView: BrowserLiveViewState | null | undefined;
	/** Whether the agent is actively working in the browser. */
	active: boolean;
};

// No browser backend is wired up yet; these stubs keep the component in
// place for the future local browser implementation.
const BROWSER_UNAVAILABLE = 'Browser sessions are not available yet.';
const setHumanControl = async () => {
	throw new Error(BROWSER_UNAVAILABLE);
};
const stopSession = async () => {
	throw new Error(BROWSER_UNAVAILABLE);
};

function formatExpiry(expiresAt: number): string {
	return `Closes by ${new Date(expiresAt).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	})}`;
}

function catchMessage<T>(error: T, fallback: string): string {
	return (error instanceof Error && error.message) || fallback;
}

type SessionActionError = {
	recordId: string | undefined;
	providerId: string | null;
	message: string;
};

export default function BrowserLiveView({ liveView, active }: Props) {
	const [pending, setPending] = useState<'control' | 'stop' | null>(null);
	const [actionError, setActionError] = useState<SessionActionError | null>(null);
	const threadId = liveView?.threadId;
	const sessionRecordId = liveView?.id;
	const providerSessionId = liveView?.providerSessionId ?? null;
	const humanControl = liveView?.humanControl === true;
	const passiveUrl = liveView?.url ?? null;
	const interactiveUrl = liveView?.interactiveUrl ?? null;
	const iframeInteractive = humanControl && interactiveUrl !== null;
	const iframeUrl = iframeInteractive ? interactiveUrl : passiveUrl;
	const ended = liveView?.ended === true;
	const canTakeover = threadId != null;
	const controlDisabled = pending !== null || ended || (interactiveUrl == null && !humanControl);
	const expiryLabel = liveView == null ? null : formatExpiry(liveView.expiresAt);
	const metaLabel = (() => {
		const parts: string[] = [];
		if (expiryLabel) parts.push(expiryLabel);
		if (humanControl && !iframeInteractive) parts.push('Waiting for the interactive view');
		return parts.join(' · ') || null;
	})();
	const statusLabel = humanControl
		? 'You have control'
		: active
			? 'The agent is browsing'
			: 'Browser session';
	// Failures are tagged with the session they started on, so a rotation while
	// the request is in flight cannot surface them for the new session.
	const visibleActionError =
		actionError !== null &&
		actionError.recordId === sessionRecordId &&
		actionError.providerId === providerSessionId
			? actionError.message
			: null;

	useEffect(() => {
		setActionError(null);
	}, [sessionRecordId, providerSessionId]);

	async function setControl(enabled: boolean) {
		if (threadId == null || controlDisabled) return;
		setPending('control');
		setActionError(null);
		try {
			await setHumanControl();
		} catch (error) {
			setActionError({
				recordId: sessionRecordId,
				providerId: providerSessionId,
				message: catchMessage(
					error,
					enabled ? 'Couldn’t take control.' : 'Couldn’t give control back.'
				)
			});
		} finally {
			setPending(null);
		}
	}

	async function stopBrowser() {
		if (sessionRecordId == null || ended || pending !== null) return;
		setPending('stop');
		setActionError(null);
		try {
			await stopSession();
		} catch (error) {
			setActionError({
				recordId: sessionRecordId,
				providerId: providerSessionId,
				message: catchMessage(error, 'Couldn’t stop the browser session.')
			});
		} finally {
			setPending(null);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{liveView && !ended ? (
				<>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
						<span className="relative flex size-2 shrink-0" aria-hidden="true">
							{humanControl ? (
								<span className="relative inline-flex size-2 rounded-full bg-amber-500"></span>
							) : active ? (
								<>
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60"></span>
									<span className="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
								</>
							) : (
								<span className="bg-muted-foreground/40 relative inline-flex size-2 rounded-full"></span>
							)}
						</span>
						<div className="min-w-0 flex-1">
							<span role="status" className="text-muted-foreground text-xs">
								{statusLabel}
							</span>
							{metaLabel ? <p className="text-muted-foreground text-[10px]">{metaLabel}</p> : null}
						</div>
						{canTakeover ? (
							<button
								type="button"
								className="text-foreground hover:bg-muted rounded-md px-2 py-0.5 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-50"
								disabled={controlDisabled}
								aria-busy={pending === 'control'}
								onClick={() => {
									void setControl(!humanControl);
								}}
							>
								{pending === 'control'
									? humanControl
										? 'Giving control back…'
										: 'Taking control…'
									: humanControl
										? 'Give control back'
										: 'Take control'}
							</button>
						) : null}
						{passiveUrl ? (
							<a
								href={passiveUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
								aria-label="Open watch-only live view in a new tab"
								title="Open watch-only live view in a new tab"
							>
								<ExternalLink className="size-3.5" aria-hidden="true" />
							</a>
						) : null}
						<button
							type="button"
							className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:scale-105 hover:bg-rose-500 disabled:pointer-events-none disabled:opacity-60 disabled:hover:scale-100"
							aria-label="Stop browser session"
							title="Stop browser session"
							aria-busy={pending === 'stop'}
							disabled={pending !== null}
							onClick={() => {
								void stopBrowser();
							}}
						>
							{pending === 'stop' ? (
								<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
							) : (
								<Square className="size-3 fill-current" aria-hidden="true" />
							)}
						</button>
					</div>
					{visibleActionError ? (
						<p className="text-destructive border-b px-3 py-1.5 text-xs" role="alert">
							{visibleActionError}
						</p>
					) : null}
					{iframeUrl ? (
						// Remount on session rotation or takeover so the viewer reconnects.
						<iframe
							key={iframeUrl}
							src={iframeUrl}
							title={iframeInteractive ? 'Agent browser (interactive)' : 'Agent browser'}
							className="min-h-0 w-full flex-1 border-0"
							allow="clipboard-read; clipboard-write"
						></iframe>
					) : (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
							<LoaderCircle
								className="text-muted-foreground size-5 animate-spin"
								aria-hidden="true"
							/>
							<p className="text-muted-foreground text-sm">Starting the live view…</p>
							<p className="text-muted-foreground text-xs">
								The agent is browsing in the meantime.
							</p>
						</div>
					)}
				</>
			) : ended || liveView === null ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
					<Globe className="text-muted-foreground size-5" aria-hidden="true" />
					<p className="text-muted-foreground text-sm" role="status">
						{`${
							ended ? 'Browser session ended.' : 'No active browser session.'
						} When the agent browses again, a new session will appear here.`}
					</p>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 items-center justify-center">
					<LoaderCircle className="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
				</div>
			)}
		</div>
	);
}
