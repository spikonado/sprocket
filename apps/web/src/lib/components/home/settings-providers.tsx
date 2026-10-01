import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { convexClientErrorMessage } from '$lib/convex-error';
import { z } from 'zod';
import type { ChatGptBrowserLoginStart, ChatGptStatus, DesktopApi } from '$lib/types/sprocket';

type ProviderConfigurationChange = {
	provider: 'openai';
	configured: boolean;
};

type PendingBrowserLogin = {
	userId: string;
	login: ChatGptBrowserLoginStart;
};

export default function SettingsProviders({
	userId,
	desktopApi,
	openAiConfigured,
	chatGptStatus,
	chatGptLoading,
	chatGptStatusError,
	loading,
	loadError,
	onChatGptStatusChange,
	onConfigurationChange
}: {
	userId: string;
	desktopApi: DesktopApi | null;
	openAiConfigured: boolean;
	chatGptStatus: ChatGptStatus | null;
	chatGptLoading: boolean;
	chatGptStatusError: string | null;
	loading: boolean;
	loadError: string | null;
	onChatGptStatusChange: (status: ChatGptStatus) => void;
	onConfigurationChange: (change: ProviderConfigurationChange) => void;
}) {
	const saveOpenAiKey = useAction(api.providerCredentials.saveOpenAiKey);
	const removeOpenAiKey = useAction(api.providerCredentials.removeOpenAiKey);
	const [apiKey, setApiKey] = useState('');
	const [showKey, setShowKey] = useState(false);
	const [openAiPending, setOpenAiPending] = useState(false);
	const [confirmOpenAiRemove, setConfirmOpenAiRemove] = useState(false);
	const [openAiError, setOpenAiError] = useState<string | null>(null);
	const [openAiSaved, setOpenAiSaved] = useState(false);
	const [chatGptPending, setChatGptPending] = useState(false);
	const [browserLogin, setBrowserLoginState] = useState<ChatGptBrowserLoginStart | null>(null);
	const [confirmSignOut, setConfirmSignOut] = useState<string | null>(null);
	const [signOutWarning, setSignOutWarning] = useState<string | null>(null);
	const [chatGptError, setChatGptError] = useState<string | null>(null);
	const browserLoginRef = useRef<PendingBrowserLogin | null>(null);
	const generationRef = useRef(0);

	const activeAccount =
		chatGptStatus?.accounts.find(
			(account) => account.connectionId === chatGptStatus.activeConnectionId
		) ?? null;

	const setBrowserLogin = (userIdForLogin: string, next: ChatGptBrowserLoginStart | null) => {
		browserLoginRef.current = next ? { userId: userIdForLogin, login: next } : null;
		setBrowserLoginState(next);
	};

	function errorMessage(error: Error, fallback: string): string {
		return convexClientErrorMessage(error) ?? fallback;
	}

	function cancelLoginOnServer(pending: PendingBrowserLogin) {
		desktopApi
			?.cancelChatGptBrowserLogin({ userId: pending.userId, state: pending.login.state })
			.catch(() => {});
	}

	function cancelLogin() {
		generationRef.current += 1;
		const pending = browserLoginRef.current;
		browserLoginRef.current = null;
		setBrowserLoginState(null);
		setChatGptPending(false);

		return pending;
	}

	useEffect(() => {
		setBrowserLoginState(null);
		setChatGptPending(false);
		setChatGptError(null);
		setConfirmSignOut(null);
		setSignOutWarning(null);

		return () => {
			generationRef.current += 1;
			const pending = browserLoginRef.current;
			browserLoginRef.current = null;

			if (pending) {
				desktopApi
					?.cancelChatGptBrowserLogin({ userId: pending.userId, state: pending.login.state })
					.catch(() => {});
			}
		};
	}, [desktopApi, userId]);

	async function waitForBrowserLogin(
		pending: PendingBrowserLogin,
		api: DesktopApi,
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

				if (generation !== generationRef.current || api !== desktopApi) return;
				onChatGptStatusChange(status);

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
		const api = desktopApi;

		if (!api || chatGptPending) return;
		setChatGptPending(true);
		setChatGptError(null);
		setConfirmSignOut(null);
		setSignOutWarning(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;

		try {
			const login = await api.startChatGptBrowserLogin(
				connectionId ? { userId: userIdAtStart, connectionId } : { userId: userIdAtStart }
			);

			if (generation !== generationRef.current) {
				cancelLoginOnServer({ userId: userIdAtStart, login });

				return;
			}

			setBrowserLogin(userIdAtStart, login);
			void waitForBrowserLogin({ userId: userIdAtStart, login }, api, generation);
		} catch (error) {
			if (generation !== generationRef.current) return;
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

	async function selectAccount(connectionId: string) {
		const api = desktopApi;

		if (!api || chatGptPending) return;
		setChatGptPending(true);
		setChatGptError(null);
		setSignOutWarning(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;

		try {
			await api.selectChatGptAccount({ userId: userIdAtStart, connectionId });
			const status = await api.fetchChatGptStatus({ userId: userIdAtStart });

			if (generation !== generationRef.current || api !== desktopApi) return;
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

	async function signOutAccount(connectionId: string) {
		const api = desktopApi;

		if (!api || chatGptPending) return;
		const pendingLogin = cancelLogin();

		if (pendingLogin) cancelLoginOnServer(pendingLogin);
		setChatGptPending(true);
		setChatGptError(null);
		const userIdAtStart = userId;
		const generation = ++generationRef.current;

		try {
			const warning = await api.disconnectChatGptAccount({
				userId: userIdAtStart,
				connectionId
			});

			const status = await api.fetchChatGptStatus({ userId: userIdAtStart });

			if (generation !== generationRef.current || api !== desktopApi) return;
			setConfirmSignOut(null);
			setSignOutWarning(warning);
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

	async function saveKey(event: FormEvent) {
		event.preventDefault();

		if (!apiKey.trim() || openAiPending) return;
		setOpenAiPending(true);
		setOpenAiError(null);
		setOpenAiSaved(false);

		try {
			await saveOpenAiKey({ apiKey });
			setApiKey('');
			setShowKey(false);
			setOpenAiSaved(true);
			onConfigurationChange({ provider: 'openai', configured: true });
		} catch (error) {
			setOpenAiError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t save the OpenAI key.'
				)
			);
		} finally {
			setOpenAiPending(false);
		}
	}

	async function removeKey() {
		if (openAiPending) return;
		setOpenAiPending(true);
		setOpenAiError(null);
		setOpenAiSaved(false);

		try {
			await removeOpenAiKey({});
			setConfirmOpenAiRemove(false);
			onConfigurationChange({ provider: 'openai', configured: false });
		} catch (error) {
			setOpenAiError(
				errorMessage(
					z.instanceof(Error).catch(new Error()).parse(error),
					'Couldn’t remove the OpenAI key.'
				)
			);
		} finally {
			setOpenAiPending(false);
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
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">BYOK/BYOS</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<p className="text-muted-foreground mb-5 text-sm leading-6">
						Use your own API keys or subscriptions. ChatGPT credentials stay in a protected file on
						this computer. OpenAI API keys are encrypted in WorkOS Vault.
					</p>

					<div className="border-border rounded-xl border p-5">
						<div className="flex items-center gap-3">
							<ProviderLogo provider="openai" className="size-5" />
							<div className="min-w-0 flex-1">
								<p className="text-foreground text-[15px] font-medium">ChatGPT Subscription</p>
								<p className="text-muted-foreground mt-0.5 text-[12px]">{chatGptStatusLine}</p>
							</div>
						</div>

						{browserLogin ? (
							<div className="border-border bg-hover-fill mt-5 rounded-lg border p-4">
								<p className="text-foreground text-sm">Sign in with your ChatGPT subscription:</p>
								<div className="mt-3 flex items-center gap-3">
									<a
										href={browserLogin.authorizeUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center rounded-full px-5 text-sm font-medium"
									>
										Open ChatGPT <ExternalLink className="ml-2 size-3.5" />
									</a>
									<button
										type="button"
										className="text-muted-foreground text-[13px]"
										onClick={stopBrowserLogin}
									>
										Cancel
									</button>
									<span className="text-muted-foreground text-[12px]">Waiting for approval…</span>
								</div>
							</div>
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
														<p className="text-foreground truncate text-[13px] font-medium">
															{account.label}
														</p>
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
													{confirmSignOut === account.connectionId ? (
														<>
															<button
																type="button"
																className="text-destructive text-[13px] disabled:opacity-50"
																disabled={chatGptPending}
																onClick={() => void signOutAccount(account.connectionId)}
															>
																{chatGptPending ? 'Signing out…' : 'Confirm sign out'}
															</button>
															<button
																type="button"
																className="text-muted-foreground hover:text-foreground text-[13px] disabled:opacity-50"
																disabled={chatGptPending}
																onClick={() => setConfirmSignOut(null)}
															>
																Cancel
															</button>
														</>
													) : (
														<button
															type="button"
															className="text-muted-foreground hover:text-foreground text-[13px] disabled:opacity-50"
															disabled={chatGptPending}
															onClick={() => setConfirmSignOut(account.connectionId)}
														>
															Sign out
														</button>
													)}
												</li>
											);
										})}
									</ul>
								)}
								{chatGptStatus?.loginAvailable === false ? (
									<p className="text-muted-foreground text-[12px] leading-5">
										ChatGPT sign-in runs through the local Sprocket server, which isn’t available
										for this window. Open Sprocket on your desktop to sign in.
									</p>
								) : (
									<Button
										disabled={chatGptPending || chatGptLoading || !desktopApi}
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

					<div className="border-border rounded-xl border p-5">
						<div className="flex items-center gap-3">
							<ProviderLogo provider="openai" className="size-5" />
							<div className="min-w-0 flex-1">
								<p className="text-foreground text-[15px] font-medium">OpenAI API</p>
								<p className="text-muted-foreground mt-0.5 text-[12px]">
									{loading
										? 'Checking configuration…'
										: openAiConfigured
											? 'Connected'
											: 'Not configured'}
								</p>
							</div>
						</div>

						<form className="mt-5 space-y-3" onSubmit={(event) => void saveKey(event)}>
							<label className="block space-y-1.5">
								<span className="text-muted-foreground text-[12px]">API key</span>
								<div className="relative">
									<input
										type={showKey ? 'text' : 'password'}
										value={apiKey}
										onChange={(event) => setApiKey(event.currentTarget.value)}
										autoComplete="off"
										spellCheck={false}
										placeholder={openAiConfigured ? 'Enter a replacement key' : 'sk-…'}
										disabled={openAiPending || loading}
										className="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border pr-10 pl-3 font-mono text-[13px] outline-none disabled:opacity-50"
									/>
									<button
										type="button"
										className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
										aria-label={showKey ? 'Hide API key' : 'Show API key'}
										disabled={openAiPending || loading}
										onClick={() => setShowKey((visible) => !visible)}
									>
										{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
									</button>
								</div>
							</label>

							<div className="flex flex-wrap items-center gap-3">
								<Button type="submit" disabled={openAiPending || loading || !apiKey.trim()}>
									{openAiPending ? 'Saving…' : openAiConfigured ? 'Replace key' : 'Connect API key'}
								</Button>
								{openAiConfigured && !confirmOpenAiRemove ? (
									<Button
										type="button"
										variant="outline"
										disabled={openAiPending}
										onclick={() => setConfirmOpenAiRemove(true)}
									>
										Remove
									</Button>
								) : confirmOpenAiRemove ? (
									<>
										<Button
											type="button"
											variant="outline"
											disabled={openAiPending}
											onclick={() => void removeKey()}
										>
											{openAiPending ? 'Removing…' : 'Confirm removal'}
										</Button>
										<button
											type="button"
											className="text-muted-foreground hover:text-foreground text-[13px]"
											disabled={openAiPending}
											onClick={() => setConfirmOpenAiRemove(false)}
										>
											Cancel
										</button>
									</>
								) : null}
								{openAiSaved && <span className="text-muted-foreground text-[12px]">Saved</span>}
							</div>
						</form>

						{openAiError && (
							<p className="text-destructive mt-4 text-sm" role="alert">
								{openAiError}
							</p>
						)}
					</div>

					{loadError && (
						<p className="text-destructive text-sm" role="alert">
							{loadError}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
