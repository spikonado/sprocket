import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import type { LocalApi, SignInStatus, SignInTarget } from '$lib/types/sprocket';
import { caughtMessage } from './use-connectors';

const SIGN_IN_POLL_MS = 2_000;

export type SignInApi = Pick<
	LocalApi,
	'fetchConnectorSignIn' | 'startConnectorSignIn' | 'cancelConnectorSignIn'
>;

export function useDeviceSignIn(
	api: SignInApi,
	userId: string,
	target: SignInTarget,
	onSignedIn: () => void
) {
	const [status, setStatus] = useState<SignInStatus>({ state: 'idle' });
	const fetchStatus = useEffectEvent(() => api.fetchConnectorSignIn(userId, target));
	const signedIn = useEffectEvent(onSignedIn);
	const pendingStart = useRef<Promise<unknown> | null>(null);

	useEffect(() => {
		let stopped = false;
		// A sign-in keeps running on the machine while this page is closed.
		fetchStatus().then(
			(current) => {
				if (!stopped && (current.state === 'starting' || current.state === 'waiting')) {
					setStatus(current);
				}
			},
			() => {}
		);

		return () => {
			stopped = true;
		};
	}, []);

	useEffect(() => {
		if (status.state !== 'starting' && status.state !== 'waiting') return;
		let stopped = false;

		const timer = setTimeout(() => {
			fetchStatus().then(
				(next) => {
					if (stopped) return;
					setStatus(next);

					if (next.state === 'idle') signedIn();
				},
				(caught) => {
					if (stopped) return;
					setStatus({
						state: 'failed',
						error: caughtMessage.parse(caught) || 'Couldn’t check the sign-in.'
					});
				}
			);
		}, SIGN_IN_POLL_MS);

		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [status]);

	async function start() {
		setStatus({ state: 'starting' });
		const request = api.startConnectorSignIn(userId, target);
		pendingStart.current = request;

		try {
			const started = await request;

			if (pendingStart.current === request) setStatus(started);
		} catch (caught) {
			if (pendingStart.current !== request) return;
			setStatus({
				state: 'failed',
				error: caughtMessage.parse(caught) || 'Couldn’t start the sign-in.'
			});
		} finally {
			if (pendingStart.current === request) pendingStart.current = null;
		}
	}

	async function cancel() {
		const starting = pendingStart.current;
		pendingStart.current = null;

		try {
			// Cancelling before the machine has started would leave its sign-in running.
			await starting?.catch(() => {});
			setStatus(await api.cancelConnectorSignIn(userId, target));
		} catch (caught) {
			setStatus({
				state: 'failed',
				error: caughtMessage.parse(caught) || 'Couldn’t cancel the sign-in.'
			});
		}
	}

	const running = status.state === 'starting' || status.state === 'waiting';

	return { status, running, start, cancel };
}

export function DeviceSignInPanel({
	status,
	onCancel
}: {
	status: SignInStatus;
	onCancel: () => void;
}) {
	if (status.state === 'idle') return null;

	if (status.state === 'failed') {
		return (
			<p role="alert" className="text-destructive mt-3 text-[12px] leading-5">
				{status.error}
			</p>
		);
	}

	return (
		<div className="bg-hover-fill/60 mt-3 rounded-lg p-3">
			{status.state === 'starting' ? (
				<div className="flex items-center gap-3">
					<span className="text-muted-foreground inline-flex items-center gap-1.5 text-[12px]">
						<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
						Starting sign-in…
					</span>
					<CancelButton onCancel={onCancel} />
				</div>
			) : (
				<DeviceCodePrompt url={status.url} code={status.code} onCancel={onCancel} />
			)}
		</div>
	);
}

export function DeviceCodePrompt({
	url,
	code,
	onCancel
}: {
	url: string;
	code: string | null;
	onCancel: () => void;
}) {
	const host = URL.canParse(url) ? new URL(url).host : 'the sign-in page';

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-[12px]">
				{code ? `Enter this code on ${host}` : `Finish signing in on ${host}`}
			</p>
			{code && (
				<div className="flex items-center gap-2">
					<p className="text-foreground font-mono text-[20px] tracking-[0.2em]">{code}</p>
					<CopyCodeButton code={code} />
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<ExternalTextLink href={url}>{`Open ${host}`}</ExternalTextLink>
				<span className="text-muted-foreground text-[12px]">Waiting for sign-in…</span>
				<CancelButton onCancel={onCancel} />
			</div>
		</div>
	);
}

export function ExternalTextLink({ href, children }: { href: string; children: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="text-primary inline-flex items-center gap-1 text-[13px] hover:underline"
		>
			{children}
			<ExternalLink className="size-3" aria-hidden="true" />
		</a>
	);
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
	return (
		<button
			type="button"
			className="text-muted-foreground hover:text-foreground text-[13px]"
			onClick={onCancel}
		>
			Cancel
		</button>
	);
}

function CopyCodeButton({ code }: { code: string }) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2_000);

		return () => clearTimeout(timer);
	}, [copied]);

	// Browsers hide the clipboard from plain-HTTP pages such as tailnet UIs.
	if (!('clipboard' in navigator)) return null;

	return (
		<button
			type="button"
			className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-7 items-center justify-center rounded-md transition"
			aria-label={copied ? 'Copied' : 'Copy code'}
			title={copied ? 'Copied' : 'Copy code'}
			onClick={() =>
				void navigator.clipboard.writeText(code).then(
					() => setCopied(true),
					() => {}
				)
			}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</button>
	);
}
