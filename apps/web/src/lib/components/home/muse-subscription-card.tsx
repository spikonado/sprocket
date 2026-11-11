import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { z } from 'zod';
import type { LocalApi, MuseLoginStart, MuseStatus } from '$lib/types/sprocket';
import CliInstallPrompt from './cli-install-prompt';

const loginPollMs = 2_000;

const caughtError = z.instanceof(Error).catch(new Error());

function ExternalTextLink({ href, children }: { href: string; children: string }) {
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

type Props = {
	userId: string;
	localApi: LocalApi | null;
	status: MuseStatus | null;
	statusError: string | null;
	onStatusChange: (status: MuseStatus) => void;
	onConnected: () => void;
};

export default function MuseSubscriptionCard(props: Props) {
	return <UserMuseSubscriptionCard key={props.userId} {...props} />;
}

function UserMuseSubscriptionCard({
	userId,
	localApi,
	status,
	statusError,
	onStatusChange,
	onConnected
}: Props) {
	const [login, setLogin] = useState<MuseLoginStart | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const loginIdRef = useRef<string | null>(null);
	const attemptRef = useRef(0);

	function cancelOnServer(loginId: string) {
		localApi?.cancelMuseLogin(userId, loginId).catch(() => {});
	}

	function trackLogin(next: MuseLoginStart | null) {
		loginIdRef.current = next?.loginId ?? null;
		setLogin(next);
	}

	useEffect(
		() => () => {
			attemptRef.current += 1;
			const loginId = loginIdRef.current;
			loginIdRef.current = null;

			if (loginId) localApi?.cancelMuseLogin(userId, loginId).catch(() => {});
		},
		[localApi, userId]
	);

	function reportStatus(next: MuseStatus) {
		onStatusChange(next);

		if (next.state === 'ready') onConnected();
	}

	async function install() {
		if (!localApi || pending) return;
		setPending(true);
		setError(null);

		try {
			reportStatus(await localApi.installMuse(userId));
		} catch (caught) {
			setError(caughtError.parse(caught).message || 'Couldn’t start installing Muse.');
		} finally {
			setPending(false);
		}
	}

	async function waitForLogin(api: LocalApi, loginId: string, attempt: number) {
		const stale = () => attempt !== attemptRef.current;

		try {
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, loginPollMs));

				if (stale()) return;
				const next = await api.fetchMuseStatus(userId);

				if (stale()) return;
				reportStatus(next);

				if (next.state !== 'signedOut') break;

				if (next.error) {
					cancelOnServer(loginId);
					break;
				}
			}
		} catch (caught) {
			if (stale()) return;
			cancelOnServer(loginId);
			setError(caughtError.parse(caught).message || 'Couldn’t check Muse sign-in.');
		}

		trackLogin(null);
	}

	async function startLogin() {
		if (!localApi || pending) return;
		const attempt = ++attemptRef.current;
		setPending(true);
		setError(null);

		try {
			const started = await localApi.startMuseLogin(userId);

			if (attempt !== attemptRef.current) {
				cancelOnServer(started.loginId);

				return;
			}

			trackLogin(started);
			void waitForLogin(localApi, started.loginId, attempt);
		} catch (caught) {
			if (attempt !== attemptRef.current) return;
			setError(caughtError.parse(caught).message || 'Couldn’t start Muse sign-in.');
		} finally {
			if (attempt === attemptRef.current) setPending(false);
		}
	}

	function cancelLogin() {
		attemptRef.current += 1;
		const loginId = loginIdRef.current;
		trackLogin(null);

		if (loginId) cancelOnServer(loginId);
	}

	async function checkAgain() {
		if (!localApi || pending) return;
		setPending(true);
		setError(null);

		try {
			reportStatus(await localApi.fetchMuseStatus(userId));
		} catch (caught) {
			setError(caughtError.parse(caught).message || 'Couldn’t check Muse on this computer.');
		} finally {
			setPending(false);
		}
	}

	const shownError = error ?? status?.error ?? statusError;

	const statusLine =
		status?.state === 'ready'
			? status.account
				? `Connected as ${status.account}`
				: 'Connected'
			: status?.state === 'planRequired' && status.account
				? `Signed in as ${status.account}`
				: localApi && !status && !statusError
					? 'Checking configuration…'
					: 'Not configured';

	return (
		<div className="border-border rounded-xl border p-5">
			<div className="flex items-center gap-3">
				<ProviderLogo provider="muse" className="size-5" />
				<div className="min-w-0 flex-1">
					<p className="text-foreground text-[15px]">Muse Code Subscription</p>
					<p className="text-muted-foreground mt-0.5 text-[12px]">{statusLine}</p>
				</div>
			</div>

			{!localApi ? (
				<p className="text-muted-foreground mt-4 text-[12px] leading-5">
					Muse is set up on the computer running Sprocket. Open Sprocket there to install it or sign
					in.
				</p>
			) : !status ? (
				!statusError && <p className="text-muted-foreground mt-4 text-[12px]">Checking Muse…</p>
			) : status.state === 'notInstalled' ||
			  status.state === 'installing' ||
			  status.state === 'outdated' ? (
				<CliInstallPrompt
					name="Muse"
					status={status}
					disabled={pending}
					onInstall={() => void install()}
				/>
			) : status.state === 'planRequired' ? (
				<div className="mt-4 space-y-3">
					<p className="text-muted-foreground text-[12px] leading-5">
						Your Muse Code plan doesn’t include Muse Wonder Full. Upgrade to the Power Usage or
						Maximum Usage plan to use it.
					</p>
					<div className="flex flex-wrap items-center gap-3">
						<ExternalTextLink href="https://accountscenter.meta.com/">
							Upgrade in Accounts Center
						</ExternalTextLink>
						<Button variant="outline" disabled={pending} onclick={() => void checkAgain()}>
							{pending ? 'Checking…' : 'Check again'}
						</Button>
					</div>
				</div>
			) : status.state === 'ready' ? (
				<p className="text-muted-foreground mt-4 text-[12px] leading-5">
					To sign out, run <code className="font-mono">muse logout</code> on this computer.
				</p>
			) : login ? (
				<div className="mt-5 space-y-3">
					<p className="text-muted-foreground text-[12px]">
						Enter this code on the Muse sign-in page
					</p>
					<p className="text-foreground font-mono text-[20px] tracking-[0.2em]">{login.userCode}</p>
					<div className="flex flex-wrap items-center gap-3">
						<ExternalTextLink href={login.verificationUrl}>Open sign-in page</ExternalTextLink>
						<span className="text-muted-foreground text-[12px]">Waiting for sign-in…</span>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground text-[13px]"
							onClick={cancelLogin}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="mt-5">
					<Button disabled={pending} onclick={() => void startLogin()}>
						{pending ? 'Starting…' : 'Sign in with Muse'}
					</Button>
				</div>
			)}

			<p className="text-muted-foreground mt-4 text-[12px] leading-5">
				Usage counts against your Muse Code subscription.
			</p>
			{shownError && (
				<p className="text-destructive mt-4 text-sm" role="alert">
					{shownError}
				</p>
			)}
		</div>
	);
}
