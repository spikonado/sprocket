import { useEffect, useRef, useState, type FormEvent } from 'react';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { convexClientErrorMessage } from '$lib/convex-error';
import { z } from 'zod';
import type {
	ChatGptBrowserLoginStart,
	ChatGptStatus,
	ClaudeCodeStatus,
	LocalApi,
	MuseStatus
} from '$lib/types/sprocket';
import type { CompletionProvider } from '@convex/lib/validators';
import ApiKeyCard, { apiKeyProviders, type ApiKeyProvider } from './api-key-card';
import ClaudeSubscriptionCard from './claude-subscription-card';
import { ExternalTextLink } from './device-sign-in';
import MuseSubscriptionCard from './muse-subscription-card';

type ProviderConfigurationChange = {
	provider: ApiKeyProvider | 'claude';
	configured: boolean;
};

type PendingBrowserLogin = {
	userId: string;
	login: ChatGptBrowserLoginStart;
};

type BrowserLoginView = ChatGptBrowserLoginStart | 'starting' | null;

export default function SettingsCredentials({
	userId,
	localApi,
	apiKeysSaved,
	claudeTokenSaved,
	claudeCodeStatus,
	claudeCodeStatusError,
	museStatus,
	museStatusError,
	chatGptStatus,
	chatGptLoading,
	chatGptStatusError,
	loading,
	loadError,
	onChatGptStatusChange,
	onClaudeCodeStatusChange,
	onMuseStatusChange,
	onConfigurationChange,
	onProviderConnected,
	onProviderRemoved
}: {
	userId: string;
	localApi: LocalApi | null;
	apiKeysSaved: Record<ApiKeyProvider, boolean>;
	claudeTokenSaved: boolean;
	claudeCodeStatus: ClaudeCodeStatus | null;
	claudeCodeStatusError: string | null;
	museStatus: MuseStatus | null;
	museStatusError: string | null;
	chatGptStatus: ChatGptStatus | null;
	chatGptLoading: boolean;
	chatGptStatusError: string | null;
	loading: boolean;
	loadError: string | null;
	onChatGptStatusChange: (status: ChatGptStatus) => void;
	onClaudeCodeStatusChange: (status: ClaudeCodeStatus) => void;
	onMuseStatusChange: (status: MuseStatus) => void;
	onConfigurationChange: (change: ProviderConfigurationChange) => void;
	onProviderConnected: (provider: CompletionProvider) => void;
	onProviderRemoved: (provider: CompletionProvider) => void;
}) {
	const [chatGptPending, setChatGptPending] = useState(false);
	const [browserLogin, setBrowserLoginView] = useState<BrowserLoginView>(null);
	const [callbackUrl, setCallbackUrl] = useState('');
	const [finishing, setFinishing] = useState(false);
	const [signOutWarning, setSignOutWarning] = useState<string | null>(null);
	const [chatGptError, setChatGptError] = useState<string | null>(null);
	const browserLoginRef = useRef<PendingBrowserLogin | null>(null);
	const generationRef = useRef(0);

	const activeAccount =
		chatGptStatus?.accounts.find(
			(account) => account.connectionId === chatGptStatus.activeConnectionId
		) ?? null;

	const showBrowserLogin = (next: BrowserLoginView) => {
		setBrowserLoginView(next);
		setCallbackUrl('');
		setFinishing(false);
	};

	const setBrowserLogin = (userIdForLogin: string, next: ChatGptBrowserLoginStart | null) => {
		browserLoginRef.current = next ? { userId: userIdForLogin, login: next } : null;
		showBrowserLogin(next);
	};

	function errorMessage(error: Error, fallback: string): string {
		return convexClientErrorMessage(error) ?? fallback;
	}

	function cancelLoginOnServer(pending: PendingBrowserLogin) {
		localApi
			?.cancelChatGptBrowserLogin({ userId: pending.userId, state: pending.login.state })
			.catch(() => {});
	}

	function cancelLogin() {
		generationRef.current += 1;
		const pending = browserLoginRef.current;
		browserLoginRef.current = null;
		showBrowserLogin(null);
		setChatGptPending(false);

		return pending;
	}

	useEffect(() => {
		showBrowserLogin(null);
		setChatGptPending(false);
		setChatGptError(null);
		setSignOutWarning(null);

		return () => {
			generationRef.current += 1;
			const pending = browserLoginRef.current;
			browserLoginRef.current = null;

			if (pending) {
				localApi
					?.cancelChatGptBrowserLogin({ userId: pending.userId, state: pending.login.state })
					.catch(() => {});
			}
		};
	}, [localApi, userId]);

	async function waitForBrowserLogin(
		pending: PendingBrowserLogin,
		api: LocalApi,
		generation: number
	) {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 1_500));

			if (generation !== generationRef.current) return;

			try {
				const result = await api.fetchChatGptBrowserLoginResult({
					userId: pending.userId,
					state: pending.login.state
				});

				if (generation !== generationRef.current) return;

				if (result.status === 'pending') continue;
				setBrowserLogin(pending.userId, null);
				setChatGptPending(false);

				if (result.status === 'error') {
					setChatGptError(result.error ?? 'ChatGPT sign-in failed.');

					return;
				}

				const status = await api.fetchChatGptStatus({ userId: pending.userId });

				if (generation !== generationRef.current || api !== localApi) return;
				onChatGptStatusChange(status);
				onProviderConnected('chatgpt');

				return;
			} catch (error) {
				if (generation !== generationRef.current) return;
				setBrowserLogin(pending.userId, null);
				setChatGptPending(false);
				setChatGptError(
					errorMessage(
						z.instanceof(Error).catch(new Error()).parse(error),
						'Couldn’t complete ChatGPT sign-in. Check your connection status.'
					)
				);

				return;
			}
		}
	}

	async function startBrowserLogin(connectionId?: string) {
		const api = localApi;

		if (!api || chatGptPending) return;
		setChatGptPending(true);
		showBrowserLogin('starting');
		setChatGptError(null);
		setSignOutWarning(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;
		const bridge = window.sprocketDesktopBridge;
		const loginWindow = bridge ? null : window.open('about:blank', '_blank');
		let pending: PendingBrowserLogin | null = null;

		try {
			if (!bridge && !loginWindow)
				throw new Error('Your browser blocked the sign-in window. Allow popups and try again.');

			const login = await api.startChatGptBrowserLogin(
				connectionId ? { userId: userIdAtStart, connectionId } : { userId: userIdAtStart }
			);

			pending = { userId: userIdAtStart, login };

			if (generation !== generationRef.current) {
				loginWindow?.close();
				cancelLoginOnServer(pending);

				return;
			}

			if (bridge) {
				await bridge.openExternal(login.authorizeUrl);
			} else {
				loginWindow?.location.replace(login.authorizeUrl);
			}

			if (generation !== generationRef.current) {
				cancelLoginOnServer(pending);

				return;
			}

			setBrowserLogin(userIdAtStart, login);
			void waitForBrowserLogin(pending, api, generation);
		} catch (error) {
			loginWindow?.close();

			if (pending) cancelLoginOnServer(pending);

			if (generation !== generationRef.current) return;
			showBrowserLogin(null);
			setChatGptError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t start ChatGPT sign-in.'
				)
			);
			setChatGptPending(false);
		}
	}

	function stopBrowserLogin() {
		const pending = cancelLogin();

		if (pending) cancelLoginOnServer(pending);
	}

	async function finishBrowserLogin(event: FormEvent) {
		event.preventDefault();
		const api = localApi;
		const pending = browserLoginRef.current;
		const address = callbackUrl.trim();

		if (!api || !pending || !address || finishing) return;
		setFinishing(true);
		setChatGptError(null);

		try {
			// The result poll reports when the exchange this starts completes.
			await api.finishChatGptBrowserLogin({ userId: pending.userId, callbackUrl: address });
		} catch (error) {
			if (browserLoginRef.current !== pending) return;
			setFinishing(false);
			setChatGptError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t finish ChatGPT sign-in.'
				)
			);
		}
	}

	async function selectAccount(connectionId: string) {
		const api = localApi;

		if (!api || chatGptPending) return;
		setChatGptPending(true);
		setChatGptError(null);
		setSignOutWarning(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;

		try {
			await api.selectChatGptAccount({ userId: userIdAtStart, connectionId });
			const status = await api.fetchChatGptStatus({ userId: userIdAtStart });

			if (generation !== generationRef.current || api !== localApi) return;
			onChatGptStatusChange(status);
		} catch (error) {
			if (generation !== generationRef.current) return;
			setChatGptError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t switch ChatGPT account.'
				)
			);
		} finally {
			if (generation === generationRef.current) setChatGptPending(false);
		}
	}

	async function refreshChatGptStatus() {
		const api = localApi;

		if (!api || chatGptPending) return;
		const generation = ++generationRef.current;
		setChatGptPending(true);
		setChatGptError(null);

		try {
			const status = await api.fetchChatGptStatus({ userId });

			if (generation === generationRef.current) onChatGptStatusChange(status);
		} catch (error) {
			if (generation === generationRef.current)
				setChatGptError(
					errorMessage(
						z.instanceof(Error).catch(new Error()).parse(error),
						'Could not refresh ChatGPT status.'
					)
				);
		} finally {
			if (generation === generationRef.current) setChatGptPending(false);
		}
	}

	async function signOutAccount(connectionId: string) {
		const api = localApi;

		if (!api || chatGptPending) return;
		const pendingLogin = cancelLogin();

		if (pendingLogin) cancelLoginOnServer(pendingLogin);
		setChatGptPending(true);
		setChatGptError(null);
		setSignOutWarning(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;

		try {
			const warning = await api.disconnectChatGptAccount({
				userId: userIdAtStart,
				connectionId
			});

			const statusAfterSignOut = api.fetchChatGptStatus({ userId: userIdAtStart });

			// Runs even if the page moves on, so a finished sign-out always leaves the provider order.
			void statusAfterSignOut.then(
				(status) => {
					if (!status.accounts.some((account) => account.connected)) onProviderRemoved('chatgpt');
				},
				() => {}
			);

			if (generation !== generationRef.current || api !== localApi) return;
			setSignOutWarning(warning);

			if (chatGptStatus) {
				const activeConnectionId =
					chatGptStatus.activeConnectionId === connectionId
						? null
						: chatGptStatus.activeConnectionId;

				onChatGptStatusChange({
					accounts: chatGptStatus.accounts.filter(
						(account) => account.connectionId !== connectionId
					),
					activeConnectionId,
					loginAvailable: chatGptStatus.loginAvailable
				});
			}

			const status = await statusAfterSignOut;

			if (generation !== generationRef.current || api !== localApi) return;
			onChatGptStatusChange(status);
		} catch (error) {
			if (generation !== generationRef.current) return;
			setChatGptError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t sign out of ChatGPT.'
				)
			);
		} finally {
			if (generation === generationRef.current) setChatGptPending(false);
		}
	}

	const chatGptStatusLine = chatGptLoading
		? 'Checking connection…'
		: chatGptStatusError
			? 'Connection status unavailable'
			: activeAccount?.connected
				? `Connected as ${activeAccount.label}`
				: chatGptStatus && chatGptStatus.accounts.length > 0
					? 'Signed out'
					: 'Not connected';

	return (
		<>
			<div className="border-border rounded-xl border p-5">
				<div className="flex items-center gap-3">
					<ProviderLogo provider="openai" className="size-5" />
					<div className="min-w-0 flex-1">
						<p className="text-foreground text-[15px]">ChatGPT Subscription</p>
						<p className="text-muted-foreground mt-0.5 text-[12px]">{chatGptStatusLine}</p>
					</div>
					<button
						type="button"
						className="text-primary text-[13px] disabled:opacity-50"
						disabled={!localApi || chatGptPending || chatGptLoading}
						onClick={() => void refreshChatGptStatus()}
					>
						Refresh
					</button>
				</div>

				{browserLogin === 'starting' ? (
					<div className="mt-5 flex items-center gap-3">
						<span className="text-muted-foreground text-[12px]">Starting sign-in…</span>
						<button
							type="button"
							className="text-muted-foreground text-[13px]"
							onClick={stopBrowserLogin}
						>
							Cancel
						</button>
					</div>
				) : browserLogin ? (
					<form className="mt-5 space-y-3" onSubmit={(event) => void finishBrowserLogin(event)}>
						<p className="text-muted-foreground text-[12px] leading-5">
							Approve access in your browser. If the page it opens next doesn’t load, copy that
							page’s address and paste it here.
						</p>
						<ExternalTextLink href={browserLogin.authorizeUrl}>Open sign-in page</ExternalTextLink>
						<label className="block space-y-1.5">
							<span className="text-muted-foreground text-[12px]">
								Address of the page your browser opened
							</span>
							<input
								type="text"
								value={callbackUrl}
								onChange={(event) => setCallbackUrl(event.currentTarget.value)}
								autoComplete="off"
								spellCheck={false}
								disabled={finishing}
								placeholder="http://127.0.0.1:…/auth/callback?code=…"
								className="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none disabled:opacity-50"
							/>
						</label>
						<div className="flex flex-wrap items-center gap-3">
							<Button type="submit" disabled={finishing || !callbackUrl.trim()}>
								{finishing ? 'Finishing…' : 'Finish sign-in'}
							</Button>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground text-[13px]"
								onClick={stopBrowserLogin}
							>
								Cancel
							</button>
						</div>
					</form>
				) : (
					<div className="mt-5 space-y-4">
						{chatGptStatus && chatGptStatus.accounts.length > 0 && (
							<ul className="space-y-2">
								{chatGptStatus.accounts.map((account) => {
									const isActive = account.connectionId === chatGptStatus.activeConnectionId;

									return (
										<li
											key={account.connectionId}
											className="border-border flex items-center gap-3 rounded-lg border px-3 py-2"
										>
											<div className="min-w-0 flex-1">
												<p className="text-foreground truncate text-[13px]">{account.label}</p>
												<p className="text-muted-foreground text-[12px]">
													{isActive ? 'Active' : account.connected ? 'Signed in' : 'Signed out'}
												</p>
											</div>
											{!isActive && account.connected && (
												<button
													type="button"
													className="text-primary text-[13px] disabled:opacity-50"
													disabled={chatGptPending}
													onClick={() => void selectAccount(account.connectionId)}
												>
													Use
												</button>
											)}
											{!account.connected && (
												<button
													type="button"
													className="text-primary text-[13px] disabled:opacity-50"
													disabled={chatGptPending || !chatGptStatus.loginAvailable}
													onClick={() => void startBrowserLogin(account.connectionId)}
												>
													Reconnect
												</button>
											)}
											<button
												type="button"
												className="text-muted-foreground hover:text-foreground text-[13px] disabled:opacity-50"
												disabled={chatGptPending}
												onClick={() => void signOutAccount(account.connectionId)}
											>
												Sign out
											</button>
										</li>
									);
								})}
							</ul>
						)}
						{chatGptStatus?.loginAvailable === false ? (
							<p className="text-muted-foreground text-[12px] leading-5">
								ChatGPT sign-in is unavailable because Sprocket can’t read its saved ChatGPT
								sign-ins on this computer.
							</p>
						) : (
							<Button
								disabled={chatGptPending || chatGptLoading || !localApi}
								onclick={() => void startBrowserLogin()}
							>
								{chatGptPending
									? 'Starting…'
									: chatGptStatus?.accounts.length
										? 'Add account'
										: 'Continue with ChatGPT'}
							</Button>
						)}
					</div>
				)}
				{signOutWarning && (
					<p className="text-muted-foreground mt-4 text-[12px]" role="status">
						{signOutWarning}
					</p>
				)}
				<p className="text-muted-foreground mt-4 text-[12px] leading-5">
					Usage counts against your ChatGPT Codex allowance.
				</p>
				{chatGptError && (
					<p className="text-destructive mt-4 text-sm" role="alert">
						{chatGptError}
					</p>
				)}
				{chatGptStatusError && (
					<p className="text-destructive mt-4 text-sm" role="alert">
						{chatGptStatusError}
					</p>
				)}
			</div>

			<ClaudeSubscriptionCard
				userId={userId}
				localApi={localApi}
				tokenSaved={claudeTokenSaved}
				loading={loading}
				status={claudeCodeStatus}
				statusError={claudeCodeStatusError}
				onStatusChange={onClaudeCodeStatusChange}
				onTokenSavedChange={(configured) =>
					onConfigurationChange({ provider: 'claude', configured })
				}
			/>

			<MuseSubscriptionCard
				userId={userId}
				localApi={localApi}
				status={museStatus}
				statusError={museStatusError}
				onStatusChange={onMuseStatusChange}
				onConnected={() => onProviderConnected('muse')}
			/>

			{apiKeyProviders.map((provider) => (
				<ApiKeyCard
					key={`${userId}:${provider}`}
					provider={provider}
					configured={apiKeysSaved[provider]}
					loading={loading}
					onConfiguredChange={(configured) => onConfigurationChange({ provider, configured })}
				/>
			))}

			{loadError && (
				<p className="text-destructive text-sm" role="alert">
					{loadError}
				</p>
			)}
		</>
	);
}
