import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { convexClientErrorMessage } from '$lib/convex-error';
import { z } from 'zod';
import type { ClaudeCodeStatus, LocalApi } from '$lib/types/sprocket';

const caughtError = z.instanceof(Error).catch(new Error());

function errorMessage(error: Error, fallback: string): string {
	return convexClientErrorMessage(error) ?? fallback;
}

/** Mount with `key={userId}` so a user switch drops and cancels any pending sign-in. */
export default function ClaudeSubscriptionCard({
	userId,
	localApi,
	tokenSaved,
	loading,
	status,
	statusError,
	onStatusChange,
	onTokenSavedChange
}: {
	userId: string;
	localApi: LocalApi | null;
	tokenSaved: boolean;
	loading: boolean;
	status: ClaudeCodeStatus | null;
	statusError: string | null;
	onStatusChange: (status: ClaudeCodeStatus) => void;
	onTokenSavedChange: (saved: boolean) => void;
}) {
	const saveClaudeToken = useAction(api.providerCredentials.saveClaudeToken);
	const removeClaudeToken = useAction(api.providerCredentials.removeClaudeToken);
	const [loginId, setLoginId] = useState<string | null>(null);
	const [code, setCode] = useState('');
	const [pending, setPending] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const loginIdRef = useRef<string | null>(null);
	const attemptRef = useRef(0);

	function cancelOnServer(id: string) {
		localApi?.cancelClaudeCodeLogin(userId, id).catch(() => {});
	}

	function trackLogin(id: string | null) {
		loginIdRef.current = id;
		setLoginId(id);
		setCode('');
	}

	useEffect(
		() => () => {
			attemptRef.current += 1;
			const id = loginIdRef.current;
			loginIdRef.current = null;

			if (id) localApi?.cancelClaudeCodeLogin(userId, id).catch(() => {});
		},
		[localApi, userId]
	);

	async function install() {
		if (!localApi || pending) return;
		setPending(true);
		setError(null);

		try {
			onStatusChange(await localApi.installClaudeCode(userId));
		} catch (caught) {
			setError(errorMessage(caughtError.parse(caught), 'Couldn’t start installing Claude Code.'));
		} finally {
			setPending(false);
		}
	}

	async function startLogin() {
		if (!localApi || pending) return;
		const attempt = ++attemptRef.current;
		setPending(true);
		setError(null);
		const bridge = window.sprocketDesktopBridge;
		const loginWindow = bridge ? null : window.open('about:blank', '_blank');

		try {
			if (!bridge && !loginWindow)
				throw new Error('Your browser blocked the sign-in window. Allow popups and try again.');

			const login = await localApi.startClaudeCodeLogin(userId);

			if (attempt !== attemptRef.current) {
				loginWindow?.close();
				cancelOnServer(login.loginId);

				return;
			}

			trackLogin(login.loginId);

			if (bridge) {
				await bridge.openExternal(login.url);
			} else {
				loginWindow?.location.replace(login.url);
			}
		} catch (caught) {
			loginWindow?.close();

			if (attempt !== attemptRef.current) return;

			if (loginIdRef.current) cancelOnServer(loginIdRef.current);
			trackLogin(null);
			setError(errorMessage(caughtError.parse(caught), 'Couldn’t start Claude sign-in.'));
		} finally {
			if (attempt === attemptRef.current) setPending(false);
		}
	}

	async function finishLogin(event: FormEvent) {
		event.preventDefault();
		const id = loginIdRef.current;

		if (!localApi || !id || !code.trim() || pending) return;
		const attempt = attemptRef.current;
		setPending(true);
		setError(null);

		try {
			const token = await localApi.finishClaudeCodeLogin(userId, id, code.trim());

			if (attempt !== attemptRef.current) return;
			loginIdRef.current = null;
			await saveClaudeToken({ token });

			if (attempt !== attemptRef.current) return;
			trackLogin(null);
			onTokenSavedChange(true);
			localApi
				.fetchClaudeCodeStatus(userId)
				.then(onStatusChange)
				.catch(() => {});
		} catch (caught) {
			if (attempt !== attemptRef.current) return;

			trackLogin(null);
			setError(errorMessage(caughtError.parse(caught), 'Couldn’t finish Claude sign-in.'));
		} finally {
			if (attempt === attemptRef.current) setPending(false);
		}
	}

	function cancelLogin() {
		attemptRef.current += 1;
		const id = loginIdRef.current;
		trackLogin(null);
		setPending(false);

		if (id) cancelOnServer(id);
	}

	async function removeToken() {
		if (pending) return;
		setPending(true);
		setError(null);

		try {
			await removeClaudeToken({});
			setConfirmRemove(false);
			onTokenSavedChange(false);
		} catch (caught) {
			setError(errorMessage(caughtError.parse(caught), 'Couldn’t remove the Claude token.'));
		} finally {
			setPending(false);
		}
	}

	const installing = status?.state === 'installing';
	const shownError = error ?? status?.error ?? statusError;

	return (
		<div className="border-border rounded-xl border p-5">
			<div className="flex items-center gap-3">
				<ProviderLogo provider="claude" className="size-5" />
				<div className="min-w-0 flex-1">
					<p className="text-foreground text-[15px] font-medium">Claude Subscription</p>
					<p className="text-muted-foreground mt-0.5 text-[12px]">
						{loading ? 'Checking configuration…' : tokenSaved ? 'Connected' : 'Not configured'}
					</p>
				</div>
			</div>

			{!localApi ? (
				<p className="text-muted-foreground mt-4 text-[12px] leading-5">
					Claude Code is set up on the computer running Sprocket. Open Sprocket there to install it
					or sign in.
				</p>
			) : !status ? (
				!statusError && (
					<p className="text-muted-foreground mt-4 text-[12px]">Checking Claude Code…</p>
				)
			) : status.state !== 'installed' ? (
				<div className="mt-4 space-y-3">
					<p className="text-muted-foreground text-[12px] leading-5">
						{status.version
							? `Claude Code ${status.version} is older than ${status.minimumVersion}, which Sprocket needs. Update it with:`
							: 'Sprocket uses Claude Code on this computer. Install it with:'}
					</p>
					<pre className="border-border bg-hover-fill text-foreground overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[12px]">
						<code>{status.installCommand}</code>
					</pre>
					<Button disabled={pending || installing} onclick={() => void install()}>
						{installing && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
						{installing
							? 'Installing…'
							: status.state === 'outdated'
								? 'Update Claude Code'
								: 'Install Claude Code'}
					</Button>
				</div>
			) : tokenSaved ? null : loginId ? (
				<form className="mt-5 space-y-3" onSubmit={(event) => void finishLogin(event)}>
					<label className="block space-y-1.5">
						<span className="text-muted-foreground text-[12px]">
							Paste the code Claude shows after you sign in
						</span>
						<input
							type="text"
							value={code}
							onChange={(event) => setCode(event.currentTarget.value)}
							autoComplete="off"
							spellCheck={false}
							disabled={pending}
							className="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none disabled:opacity-50"
						/>
					</label>
					<div className="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={pending || !code.trim()}>
							{pending ? 'Finishing…' : 'Finish'}
						</Button>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground text-[13px]"
							onClick={cancelLogin}
						>
							Cancel
						</button>
					</div>
				</form>
			) : (
				<div className="mt-5">
					<Button disabled={pending || loading} onclick={() => void startLogin()}>
						{pending ? 'Starting…' : 'Sign in with Claude'}
					</Button>
				</div>
			)}

			{tokenSaved && (
				<div className="mt-5 flex flex-wrap items-center gap-3">
					{confirmRemove ? (
						<>
							<Button variant="outline" disabled={pending} onclick={() => void removeToken()}>
								{pending ? 'Removing…' : 'Confirm removal'}
							</Button>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground text-[13px]"
								disabled={pending}
								onClick={() => setConfirmRemove(false)}
							>
								Cancel
							</button>
						</>
					) : (
						<Button variant="outline" disabled={pending} onclick={() => setConfirmRemove(true)}>
							Remove
						</Button>
					)}
				</div>
			)}

			<p className="text-muted-foreground mt-4 text-[12px] leading-5">
				Usage counts against your Claude subscription.
			</p>
			{shownError && (
				<p className="text-destructive mt-4 text-sm" role="alert">
					{shownError}
				</p>
			)}
		</div>
	);
}
