import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { z } from 'zod';
import { createLocalTransport } from '$lib/local/transport';
import { resolveLocalApiBaseUrl } from '$lib/local/client';
import { usesLoopbackBrowserAuth } from '../../../../../desktop/local-config.mjs';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { convexClientErrorMessage } from '$lib/convex-error';

type ProviderConfigurationChange = {
	provider: 'openai' | 'chatgpt';
	configured: boolean;
	chatGptModelIds?: string[] | null;
};

type ChatGptLogin = {
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	intervalMs: number;
	expiresAt: number;
};
type BrowserLogin = { state: string; authorizationUrl: string; expiresAt: number };
const browserResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('pending') }),
	z.object({ status: z.literal('connected'), code: z.string() }),
	z.object({ status: z.literal('failed'), error: z.string() })
]);

export default function SettingsProviders({
	openAiConfigured,
	chatGptConfigured,
	chatGptModelIds,
	loading,
	loadError,
	onConfigurationChange
}: {
	openAiConfigured: boolean;
	chatGptConfigured: boolean;
	chatGptModelIds: readonly string[] | null;
	loading: boolean;
	loadError: string | null;
	onConfigurationChange: (change: ProviderConfigurationChange) => void;
}) {
	const saveOpenAiKey = useAction(api.providerCredentials.saveOpenAiKey);
	const removeOpenAiKey = useAction(api.providerCredentials.removeOpenAiKey);
	const beginChatGptDeviceLogin = useAction(api.providerCredentials.beginChatGptDeviceLogin);
	const beginChatGptBrowserLogin = useAction(api.providerCredentials.beginChatGptBrowserLogin);
	const completeChatGptBrowserLogin = useAction(
		api.providerCredentials.completeChatGptBrowserLogin
	);
	const cancelChatGptBrowserLogin = useAction(api.providerCredentials.cancelChatGptBrowserLogin);
	const pollChatGptDeviceLogin = useAction(api.providerCredentials.pollChatGptDeviceLogin);
	const removeChatGptCredential = useAction(api.providerCredentials.removeChatGptCredential);
	const cancelChatGptDeviceLogin = useAction(api.providerCredentials.cancelChatGptDeviceLogin);
	const getMyConfiguration = useAction(api.providerCredentials.getMyConfiguration);
	const [apiKey, setApiKey] = useState('');
	const [showKey, setShowKey] = useState(false);
	const [openAiPending, setOpenAiPending] = useState(false);
	const [confirmOpenAiRemove, setConfirmOpenAiRemove] = useState(false);
	const [openAiError, setOpenAiError] = useState<string | null>(null);
	const [openAiSaved, setOpenAiSaved] = useState(false);
	const [chatGptPending, setChatGptPending] = useState(false);
	const [chatGptLogin, setChatGptLoginState] = useState<ChatGptLogin | null>(null);
	const [browserLogin, setBrowserLoginState] = useState<BrowserLogin | null>(null);
	const [confirmChatGptRemove, setConfirmChatGptRemove] = useState(false);
	const [chatGptError, setChatGptError] = useState<string | null>(null);
	const [chatGptRevocationUnconfirmed, setChatGptRevocationUnconfirmed] = useState(false);
	const chatGptLoginRef = useRef<ChatGptLogin | null>(null);
	const browserLoginRef = useRef<BrowserLogin | null>(null);
	const loginGenerationRef = useRef(0);
	const [localAccess] = useState(() => {
		const appWindow = globalThis.window;
		const isLocalAccess =
			!!appWindow &&
			usesLoopbackBrowserAuth(appWindow.location.hostname, !!appWindow.sprocketDesktopBridge);
		return {
			isLocalAccess,
			localTransport: isLocalAccess ? createLocalTransport(resolveLocalApiBaseUrl() ?? '') : null
		};
	});
	const { isLocalAccess, localTransport } = localAccess;

	const setChatGptLogin = (next: ChatGptLogin | null) => {
		chatGptLoginRef.current = next;
		setChatGptLoginState(next);
	};
	const setBrowserLogin = (next: BrowserLogin | null) => {
		browserLoginRef.current = next;
		setBrowserLoginState(next);
	};

	function errorMessage(error: Error | null, fallback: string): string {
		return (error && convexClientErrorMessage(error)) || fallback;
	}

	function cancelChatGptLogin() {
		loginGenerationRef.current += 1;
		const login = chatGptLoginRef.current;
		const browser = browserLoginRef.current;
		setChatGptLogin(null);
		setBrowserLogin(null);
		setChatGptPending(false);
		return { login, browser };
	}

	const releaseBrowserCallback = useCallback(
		(state: string) => {
			void localTransport
				?.response('/api/chatgpt/browser/cancel', {
					method: 'POST',
					body: JSON.stringify({ state })
				})
				.catch(() => {});
		},
		[localTransport]
	);

	async function stopChatGptLogin() {
		const { login, browser } = cancelChatGptLogin();
		if (!login && !browser) return;
		const generation = loginGenerationRef.current;
		setChatGptPending(true);
		try {
			if (login) {
				await cancelChatGptDeviceLogin({
					deviceAuthId: login.deviceAuthId,
					userCode: login.userCode
				});
			}
			if (browser) {
				releaseBrowserCallback(browser.state);
				await cancelChatGptBrowserLogin({ state: browser.state });
			}
			const configuration = await getMyConfiguration({});
			if (generation === loginGenerationRef.current) {
				onConfigurationChange({
					provider: 'chatgpt',
					configured: configuration.chatgpt,
					chatGptModelIds: configuration.chatgptModelIds
				});
			}
		} catch (error) {
			if (generation === loginGenerationRef.current) {
				setChatGptError(
					errorMessage(
						error instanceof Error ? error : null,
						'Couldn’t stop ChatGPT sign-in. Check your connection status.'
					)
				);
			}
		} finally {
			if (generation === loginGenerationRef.current) setChatGptPending(false);
		}
	}

	async function waitForChatGptLogin(login: ChatGptLogin, generation: number) {
		while (generation === loginGenerationRef.current && Date.now() < login.expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, login.intervalMs));
			if (generation !== loginGenerationRef.current) return;
			try {
				const result = await pollChatGptDeviceLogin({
					deviceAuthId: login.deviceAuthId,
					userCode: login.userCode
				});
				if (generation !== loginGenerationRef.current) return;
				if (result.status === 'pending') continue;
				setChatGptLogin(null);
				setChatGptPending(false);
				onConfigurationChange({
					provider: 'chatgpt',
					configured: true,
					chatGptModelIds: result.modelIds
				});
				return;
			} catch (error) {
				if (generation !== loginGenerationRef.current) return;
				setChatGptError(
					errorMessage(error instanceof Error ? error : null, 'Couldn’t complete ChatGPT sign-in.')
				);
				setChatGptLogin(null);
				setChatGptPending(false);
				return;
			}
		}
		if (generation === loginGenerationRef.current) {
			setChatGptError('ChatGPT sign-in expired. Start again.');
			setChatGptLogin(null);
			setChatGptPending(false);
		}
	}

	async function waitForBrowserLogin(login: BrowserLogin, generation: number) {
		if (!localTransport) return;
		const transport = localTransport;
		while (generation === loginGenerationRef.current && Date.now() < login.expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			if (generation !== loginGenerationRef.current) return;
			try {
				const result = await transport.request('/api/chatgpt/browser/result', browserResultSchema, {
					method: 'POST',
					body: JSON.stringify({ state: login.state })
				});
				if (generation !== loginGenerationRef.current) return;
				if (result.status === 'pending') continue;
				if (result.status === 'failed') {
					setBrowserLogin(null);
					setChatGptPending(false);
					setChatGptError(result.error);
					releaseBrowserCallback(login.state);
					void cancelChatGptBrowserLogin({ state: login.state }).catch(() => {});
					return;
				}
				const modelIds = await completeChatGptBrowserLogin({
					state: login.state,
					code: result.code
				});
				if (generation !== loginGenerationRef.current) return;
				setBrowserLogin(null);
				setChatGptPending(false);
				releaseBrowserCallback(login.state);
				onConfigurationChange({ provider: 'chatgpt', configured: true, chatGptModelIds: modelIds });
				return;
			} catch (error) {
				if (generation !== loginGenerationRef.current) return;
				setChatGptError(
					errorMessage(error instanceof Error ? error : null, 'Couldn’t complete ChatGPT sign-in.')
				);
				setChatGptPending(false);
				return;
			}
		}
		if (generation === loginGenerationRef.current) {
			setChatGptError('ChatGPT sign-in expired. Start again.');
			setBrowserLogin(null);
			setChatGptPending(false);
		}
	}

	function retryBrowserLogin() {
		if (!browserLogin || chatGptPending) return;
		setChatGptPending(true);
		setChatGptError(null);
		void waitForBrowserLogin(browserLogin, ++loginGenerationRef.current);
	}

	async function connectChatGpt() {
		if (chatGptPending) return;
		setChatGptPending(true);
		setChatGptError(null);
		setChatGptRevocationUnconfirmed(false);
		setConfirmChatGptRemove(false);
		const generation = ++loginGenerationRef.current;
		try {
			if (isLocalAccess && localTransport) {
				const { state } = await localTransport.request(
					'/api/chatgpt/browser/start',
					z.object({ state: z.string() }),
					{ method: 'POST' }
				);
				if (generation !== loginGenerationRef.current) return;
				const authorizationUrl = await beginChatGptBrowserLogin({ state });
				if (generation !== loginGenerationRef.current) return;
				const login = { state, authorizationUrl, expiresAt: Date.now() + 5 * 60_000 };
				setBrowserLogin(login);
				void waitForBrowserLogin(login, generation);
				return;
			}
			const login = await beginChatGptDeviceLogin({});
			if (generation !== loginGenerationRef.current) return;
			setChatGptLogin(login);
			void waitForChatGptLogin(login, generation);
		} catch (error) {
			if (generation !== loginGenerationRef.current) return;
			setChatGptError(
				errorMessage(error instanceof Error ? error : null, 'Couldn’t start ChatGPT sign-in.')
			);
			setChatGptPending(false);
		}
	}

	async function removeChatGpt() {
		if (chatGptPending) return;
		await stopChatGptLogin();
		setChatGptPending(true);
		setChatGptError(null);
		setChatGptRevocationUnconfirmed(false);
		try {
			const result = await removeChatGptCredential({
				reportRevocation: true
			});
			setConfirmChatGptRemove(false);
			if (result?.revoked !== true) setChatGptRevocationUnconfirmed(true);
			onConfigurationChange({ provider: 'chatgpt', configured: false });
		} catch (error) {
			setChatGptError(
				errorMessage(error instanceof Error ? error : null, 'Couldn’t disconnect ChatGPT.')
			);
			setChatGptRevocationUnconfirmed(true);
			try {
				const configuration = await getMyConfiguration({});
				onConfigurationChange({
					provider: 'chatgpt',
					configured: configuration.chatgpt,
					chatGptModelIds: configuration.chatgptModelIds
				});
			} catch {
				// Keep the disconnect error if the status check also fails.
			}
		} finally {
			setChatGptPending(false);
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
				errorMessage(error instanceof Error ? error : null, 'Couldn’t save the OpenAI key.')
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
				errorMessage(error instanceof Error ? error : null, 'Couldn’t remove the OpenAI key.')
			);
		} finally {
			setOpenAiPending(false);
		}
	}

	useEffect(() => {
		return () => {
			loginGenerationRef.current += 1;
			const login = chatGptLoginRef.current;
			const browser = browserLoginRef.current;
			chatGptLoginRef.current = null;
			browserLoginRef.current = null;
			if (login) {
				void cancelChatGptDeviceLogin({
					deviceAuthId: login.deviceAuthId,
					userCode: login.userCode
				}).catch(() => {});
			}
			if (browser) {
				releaseBrowserCallback(browser.state);
				void cancelChatGptBrowserLogin({ state: browser.state }).catch(() => {});
			}
		};
	}, [releaseBrowserCallback, cancelChatGptBrowserLogin, cancelChatGptDeviceLogin]);

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">BYOK/BYOS</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					<p className="text-muted-foreground mb-5 text-sm leading-6">
						You can use your own API keys or subscriptions from other providers. Your credentials
						are stored encrypted and are only accessible to your account.
					</p>

					<div className="border-border rounded-xl border p-5">
						<div className="flex items-center gap-3">
							<ProviderLogo provider="openai" className="size-5" />
							<div className="min-w-0 flex-1">
								<p className="text-foreground text-[15px] font-medium">ChatGPT Subscription</p>
								<p className="text-muted-foreground mt-0.5 text-[12px]">
									{loading
										? 'Checking configuration…'
										: chatGptConfigured
											? 'Connected'
											: 'Not connected'}
								</p>
							</div>
						</div>

						{browserLogin ? (
							<div className="border-border bg-hover-fill mt-5 rounded-lg border p-4">
								<p className="text-foreground text-sm">Sign in with your ChatGPT subscription:</p>
								<div className="mt-3 flex items-center gap-3">
									<a
										href={browserLogin.authorizationUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center rounded-full px-5 text-sm font-medium"
									>
										Open ChatGPT <ExternalLink className="ml-2 size-3.5" />
									</a>
									<button
										type="button"
										className="text-muted-foreground text-[13px]"
										onClick={() => void stopChatGptLogin()}
									>
										Cancel
									</button>
									{chatGptError && !chatGptPending ? (
										<button
											type="button"
											className="text-primary text-[13px]"
											onClick={retryBrowserLogin}
										>
											Retry
										</button>
									) : (
										<span className="text-muted-foreground text-[12px]">Waiting for approval…</span>
									)}
								</div>
							</div>
						) : chatGptLogin ? (
							<div className="border-border bg-hover-fill mt-5 rounded-lg border p-4">
								<p className="text-foreground text-sm">
									Open ChatGPT and enter this one-time code:
								</p>
								<p className="text-foreground my-3 font-mono text-xl font-semibold tracking-[0.18em]">
									{chatGptLogin.userCode}
								</p>
								<div className="flex flex-wrap items-center gap-3">
									<a
										href={chatGptLogin.verificationUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
									>
										Open ChatGPT <ExternalLink className="size-3.5" />
									</a>
									<button
										type="button"
										className="text-muted-foreground hover:text-foreground text-[13px]"
										onClick={() => void stopChatGptLogin()}
									>
										Cancel
									</button>
									<span className="text-muted-foreground text-[12px]">Waiting for approval…</span>
								</div>
							</div>
						) : (
							<div className="mt-5 flex flex-wrap items-center gap-3">
								<Button disabled={chatGptPending || loading} onclick={() => void connectChatGpt()}>
									{chatGptPending
										? 'Starting…'
										: chatGptConfigured
											? 'Reconnect ChatGPT'
											: 'Continue with ChatGPT'}
								</Button>
								{chatGptConfigured && !confirmChatGptRemove ? (
									<Button
										type="button"
										variant="outline"
										disabled={chatGptPending}
										onclick={() => setConfirmChatGptRemove(true)}
									>
										Disconnect
									</Button>
								) : confirmChatGptRemove ? (
									<>
										<Button
											type="button"
											variant="outline"
											disabled={chatGptPending}
											onclick={() => void removeChatGpt()}
										>
											{chatGptPending ? 'Disconnecting…' : 'Confirm disconnect'}
										</Button>
										<button
											type="button"
											className="text-muted-foreground hover:text-foreground text-[13px]"
											disabled={chatGptPending}
											onClick={() => setConfirmChatGptRemove(false)}
										>
											Cancel
										</button>
									</>
								) : null}
							</div>
						)}
						{chatGptConfigured && chatGptModelIds === null ? (
							<p className="text-muted-foreground mt-4 text-[12px]">
								ChatGPT models are unavailable. Reload the page to try again.
							</p>
						) : chatGptConfigured && chatGptModelIds?.length === 0 ? (
							<p className="text-muted-foreground mt-4 text-[12px]">
								No ChatGPT models returned for this account.
							</p>
						) : null}
						<p className="text-muted-foreground mt-4 text-[12px] leading-5">
							{!isLocalAccess
								? 'ChatGPT device login must be enabled in your personal security settings or by your workspace administrator. '
								: ''}
							Sprocket uses your ChatGPT plan's Codex usage limits.{' '}
							<a
								href="https://chatgpt.com/settings/usage"
								target="_blank"
								rel="noopener noreferrer"
								className="text-foreground underline underline-offset-2"
							>
								Manage usage
							</a>
						</p>
						{chatGptRevocationUnconfirmed && (
							<p className="mt-4 text-sm text-amber-800 dark:text-amber-200" role="alert">
								ChatGPT remote revocation was not confirmed. To fully disconnect, revoke access in
								your{' '}
								<a
									href="https://chatgpt.com/settings"
									target="_blank"
									rel="noopener noreferrer"
									className="underline underline-offset-2"
								>
									ChatGPT settings
								</a>
								.
							</p>
						)}
						{!loading && !chatGptConfigured && !chatGptRevocationUnconfirmed && (
							<p className="text-muted-foreground mt-4 text-sm">
								If a previous disconnect could not confirm remote revocation, revoke access in your{' '}
								<a
									href="https://chatgpt.com/settings"
									target="_blank"
									rel="noopener noreferrer"
									className="text-foreground underline underline-offset-2"
								>
									ChatGPT settings
								</a>
								.
							</p>
						)}
						{chatGptError && (
							<p className="text-destructive mt-4 text-sm" role="alert">
								{chatGptError}
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
