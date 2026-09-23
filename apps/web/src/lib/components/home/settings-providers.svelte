<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Eye, EyeOff, ExternalLink } from '@lucide/svelte';
	import { useAction } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import { z } from 'zod';
	import { createLocalTransport } from '$lib/local/transport';
	import { resolveLocalApiBaseUrl } from '$lib/local/client';
	import { usesLoopbackBrowserAuth } from '../../../../../desktop/local-config.mjs';
	import Button from '$lib/components/ui/button/button.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
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

	type Props = {
		openAiConfigured: boolean;
		chatGptConfigured: boolean;
		chatGptModelIds: readonly string[] | null;
		loading: boolean;
		loadError: string | null;
		onConfigurationChange: (change: ProviderConfigurationChange) => void;
	};

	let {
		openAiConfigured,
		chatGptConfigured,
		chatGptModelIds,
		loading,
		loadError,
		onConfigurationChange
	}: Props = $props();
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
	let apiKey = $state('');
	let showKey = $state(false);
	let openAiPending = $state(false);
	let confirmOpenAiRemove = $state(false);
	let openAiError = $state<string | null>(null);
	let openAiSaved = $state(false);
	let chatGptPending = $state(false);
	let chatGptLogin = $state<ChatGptLogin | null>(null);
	let browserLogin = $state<BrowserLogin | null>(null);
	let confirmChatGptRemove = $state(false);
	let chatGptError = $state<string | null>(null);
	let loginGeneration = 0;
	const appWindow = globalThis.window;
	const isLocalAccess =
		!!appWindow &&
		usesLoopbackBrowserAuth(appWindow.location.hostname, !!appWindow.sprocketDesktopBridge);
	const localTransport = isLocalAccess
		? createLocalTransport(resolveLocalApiBaseUrl() ?? '')
		: null;

	function errorMessage(error: Error | null, fallback: string): string {
		return (error && convexClientErrorMessage(error)) || fallback;
	}

	function cancelChatGptLogin() {
		loginGeneration += 1;
		const login = chatGptLogin;
		const browser = browserLogin;
		chatGptLogin = null;
		browserLogin = null;
		chatGptPending = false;
		return { login, browser };
	}

	function releaseBrowserCallback(state: string) {
		void localTransport
			?.response('/api/chatgpt/browser/cancel', {
				method: 'POST',
				body: JSON.stringify({ state })
			})
			.catch(() => {});
	}

	async function stopChatGptLogin() {
		const { login, browser } = cancelChatGptLogin();
		if (!login && !browser) return;
		const generation = loginGeneration;
		chatGptPending = true;
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
			if (generation === loginGeneration) {
				onConfigurationChange({
					provider: 'chatgpt',
					configured: configuration.chatgpt,
					chatGptModelIds: configuration.chatgptModelIds
				});
			}
		} catch (error) {
			if (generation === loginGeneration) {
				chatGptError = errorMessage(
					error instanceof Error ? error : null,
					'Couldn’t stop ChatGPT sign-in. Check your connection status.'
				);
			}
		} finally {
			if (generation === loginGeneration) chatGptPending = false;
		}
	}

	async function waitForChatGptLogin(login: ChatGptLogin, generation: number) {
		while (generation === loginGeneration && Date.now() < login.expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, login.intervalMs));
			if (generation !== loginGeneration) return;
			try {
				const result = await pollChatGptDeviceLogin({
					deviceAuthId: login.deviceAuthId,
					userCode: login.userCode
				});
				if (generation !== loginGeneration) return;
				if (result.status === 'pending') continue;
				chatGptLogin = null;
				chatGptPending = false;
				onConfigurationChange({
					provider: 'chatgpt',
					configured: true,
					chatGptModelIds: result.modelIds
				});
				return;
			} catch (error) {
				if (generation !== loginGeneration) return;
				chatGptError = errorMessage(
					error instanceof Error ? error : null,
					'Couldn’t complete ChatGPT sign-in.'
				);
				chatGptLogin = null;
				chatGptPending = false;
				return;
			}
		}
		if (generation === loginGeneration) {
			chatGptError = 'ChatGPT sign-in expired. Start again.';
			chatGptLogin = null;
			chatGptPending = false;
		}
	}

	async function waitForBrowserLogin(login: BrowserLogin, generation: number) {
		while (generation === loginGeneration && Date.now() < login.expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			if (generation !== loginGeneration) return;
			try {
				const result = await localTransport!.request(
					'/api/chatgpt/browser/result',
					browserResultSchema,
					{
						method: 'POST',
						body: JSON.stringify({ state: login.state })
					}
				);
				if (generation !== loginGeneration) return;
				if (result.status === 'pending') continue;
				if (result.status === 'failed') {
					browserLogin = null;
					chatGptPending = false;
					chatGptError = result.error;
					releaseBrowserCallback(login.state);
					void cancelChatGptBrowserLogin({ state: login.state }).catch(() => {});
					return;
				}
				const modelIds = await completeChatGptBrowserLogin({
					state: login.state,
					code: result.code
				});
				if (generation !== loginGeneration) return;
				browserLogin = null;
				chatGptPending = false;
				releaseBrowserCallback(login.state);
				onConfigurationChange({ provider: 'chatgpt', configured: true, chatGptModelIds: modelIds });
				return;
			} catch (error) {
				if (generation !== loginGeneration) return;
				chatGptError = errorMessage(
					error instanceof Error ? error : null,
					'Couldn’t complete ChatGPT sign-in.'
				);
				chatGptPending = false;
				return;
			}
		}
		if (generation === loginGeneration) {
			chatGptError = 'ChatGPT sign-in expired. Start again.';
			browserLogin = null;
			chatGptPending = false;
		}
	}

	function retryBrowserLogin() {
		if (!browserLogin || chatGptPending) return;
		chatGptPending = true;
		chatGptError = null;
		void waitForBrowserLogin(browserLogin, ++loginGeneration);
	}

	async function connectChatGpt() {
		if (chatGptPending) return;
		chatGptPending = true;
		chatGptError = null;
		confirmChatGptRemove = false;
		const generation = ++loginGeneration;
		try {
			if (isLocalAccess && localTransport) {
				const { state } = await localTransport.request(
					'/api/chatgpt/browser/start',
					z.object({ state: z.string() }),
					{ method: 'POST' }
				);
				if (generation !== loginGeneration) return;
				const authorizationUrl = await beginChatGptBrowserLogin({ state });
				if (generation !== loginGeneration) return;
				const login = { state, authorizationUrl, expiresAt: Date.now() + 5 * 60_000 };
				browserLogin = login;
				void waitForBrowserLogin(login, generation);
				return;
			}
			const login = await beginChatGptDeviceLogin({});
			if (generation !== loginGeneration) return;
			chatGptLogin = login;
			void waitForChatGptLogin(login, generation);
		} catch (error) {
			if (generation !== loginGeneration) return;
			chatGptError = errorMessage(
				error instanceof Error ? error : null,
				'Couldn’t start ChatGPT sign-in.'
			);
			chatGptPending = false;
		}
	}

	async function removeChatGpt() {
		if (chatGptPending) return;
		await stopChatGptLogin();
		chatGptPending = true;
		chatGptError = null;
		try {
			await removeChatGptCredential({});
			confirmChatGptRemove = false;
			onConfigurationChange({ provider: 'chatgpt', configured: false });
		} catch (error) {
			chatGptError = errorMessage(
				error instanceof Error ? error : null,
				'Couldn’t disconnect ChatGPT.'
			);
		} finally {
			chatGptPending = false;
		}
	}

	async function saveKey(event: Event) {
		event.preventDefault();
		if (!apiKey.trim() || openAiPending) return;
		openAiPending = true;
		openAiError = null;
		openAiSaved = false;
		try {
			await saveOpenAiKey({ apiKey });
			apiKey = '';
			showKey = false;
			openAiSaved = true;
			onConfigurationChange({ provider: 'openai', configured: true });
		} catch (error) {
			openAiError = errorMessage(
				error instanceof Error ? error : null,
				'Couldn’t save the OpenAI key.'
			);
		} finally {
			openAiPending = false;
		}
	}

	async function removeKey() {
		if (openAiPending) return;
		openAiPending = true;
		openAiError = null;
		openAiSaved = false;
		try {
			await removeOpenAiKey({});
			confirmOpenAiRemove = false;
			onConfigurationChange({ provider: 'openai', configured: false });
		} catch (error) {
			openAiError = errorMessage(
				error instanceof Error ? error : null,
				'Couldn’t remove the OpenAI key.'
			);
		} finally {
			openAiPending = false;
		}
	}

	onDestroy(() => {
		const { login, browser } = cancelChatGptLogin();
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
	});
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">BYOK/BYOS</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-4">
			<p class="text-muted-foreground mb-5 text-sm leading-6">
				You can use your own API keys or subscriptions from other providers. Your credentials are
				stored encrypted and are only accessible to your account.
			</p>

			<div class="border-border rounded-xl border p-5">
				<div class="flex items-center gap-3">
					<ProviderLogo provider="openai" className="size-5" />
					<div class="min-w-0 flex-1">
						<p class="text-foreground text-[15px] font-medium">ChatGPT Subscription</p>
						<p class="text-muted-foreground mt-0.5 text-[12px]">
							{loading
								? 'Checking configuration…'
								: chatGptConfigured
									? 'Connected'
									: 'Not connected'}
						</p>
					</div>
				</div>

				{#if browserLogin}
					<div class="border-border bg-hover-fill mt-5 rounded-lg border p-4">
						<p class="text-foreground text-sm">Sign in with your ChatGPT subscription:</p>
						<div class="mt-3 flex items-center gap-3">
							<!-- eslint-disable svelte/no-navigation-without-resolve -- external ChatGPT authorization URL -->
							<a
								href={browserLogin.authorizationUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center rounded-full px-5 text-sm font-medium"
								>Open ChatGPT <ExternalLink class="ml-2 size-3.5" /></a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							<button
								type="button"
								class="text-muted-foreground text-[13px]"
								onclick={stopChatGptLogin}>Cancel</button
							>
							{#if chatGptError && !chatGptPending}
								<button type="button" class="text-primary text-[13px]" onclick={retryBrowserLogin}
									>Retry</button
								>
							{:else}
								<span class="text-muted-foreground text-[12px]">Waiting for approval…</span>
							{/if}
						</div>
					</div>
				{:else if chatGptLogin}
					<div class="border-border bg-hover-fill mt-5 rounded-lg border p-4">
						<p class="text-foreground text-sm">Open ChatGPT and enter this one-time code:</p>
						<p class="text-foreground my-3 font-mono text-xl font-semibold tracking-[0.18em]">
							{chatGptLogin.userCode}
						</p>
						<div class="flex flex-wrap items-center gap-3">
							<!-- eslint-disable svelte/no-navigation-without-resolve -- external ChatGPT verification URL -->
							<a
								href={chatGptLogin.verificationUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
							>
								Open ChatGPT <ExternalLink class="size-3.5" />
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground text-[13px]"
								onclick={stopChatGptLogin}>Cancel</button
							>
							<span class="text-muted-foreground text-[12px]">Waiting for approval…</span>
						</div>
					</div>
				{:else}
					<div class="mt-5 flex flex-wrap items-center gap-3">
						<Button disabled={chatGptPending || loading} onclick={connectChatGpt}>
							{chatGptPending
								? 'Starting…'
								: chatGptConfigured
									? 'Reconnect ChatGPT'
									: 'Connect ChatGPT'}
						</Button>
						{#if chatGptConfigured && !confirmChatGptRemove}
							<Button
								type="button"
								variant="outline"
								disabled={chatGptPending}
								onclick={() => (confirmChatGptRemove = true)}>Disconnect</Button
							>
						{:else if confirmChatGptRemove}
							<Button
								type="button"
								variant="outline"
								disabled={chatGptPending}
								onclick={removeChatGpt}
							>
								{chatGptPending ? 'Disconnecting…' : 'Confirm disconnect'}
							</Button>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground text-[13px]"
								disabled={chatGptPending}
								onclick={() => (confirmChatGptRemove = false)}>Cancel</button
							>
						{/if}
					</div>
				{/if}
				{#if chatGptConfigured && chatGptModelIds === null}
					<p class="text-muted-foreground mt-4 text-[12px]">
						ChatGPT models are unavailable. Reload the page to try again.
					</p>
				{:else if chatGptConfigured && chatGptModelIds?.length === 0}
					<p class="text-muted-foreground mt-4 text-[12px]">
						No ChatGPT models returned for this account.
					</p>
				{/if}
				<p class="text-muted-foreground mt-4 text-[12px] leading-5">
					{!isLocalAccess
						? 'ChatGPT device login must be enabled in your personal security settings or by your workspace administrator. '
						: ''}Usage counts against your ChatGPT Codex allowance.
				</p>
				{#if chatGptError}
					<p class="text-destructive mt-4 text-sm" role="alert">{chatGptError}</p>
				{/if}
			</div>

			<div class="border-border rounded-xl border p-5">
				<div class="flex items-center gap-3">
					<ProviderLogo provider="openai" className="size-5" />
					<div class="min-w-0 flex-1">
						<p class="text-foreground text-[15px] font-medium">OpenAI API</p>
						<p class="text-muted-foreground mt-0.5 text-[12px]">
							{loading
								? 'Checking configuration…'
								: openAiConfigured
									? 'Connected'
									: 'Not configured'}
						</p>
					</div>
				</div>

				<form class="mt-5 space-y-3" onsubmit={saveKey}>
					<label class="block space-y-1.5">
						<span class="text-muted-foreground text-[12px]">API key</span>
						<div class="relative">
							<input
								type={showKey ? 'text' : 'password'}
								bind:value={apiKey}
								autocomplete="off"
								spellcheck="false"
								placeholder={openAiConfigured ? 'Enter a replacement key' : 'sk-…'}
								disabled={openAiPending || loading}
								class="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border pr-10 pl-3 font-mono text-[13px] outline-none disabled:opacity-50"
							/>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
								aria-label={showKey ? 'Hide API key' : 'Show API key'}
								disabled={openAiPending || loading}
								onclick={() => (showKey = !showKey)}
							>
								{#if showKey}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
							</button>
						</div>
					</label>

					<div class="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={openAiPending || loading || !apiKey.trim()}>
							{openAiPending ? 'Saving…' : openAiConfigured ? 'Replace key' : 'Connect API key'}
						</Button>
						{#if openAiConfigured && !confirmOpenAiRemove}
							<Button
								type="button"
								variant="outline"
								disabled={openAiPending}
								onclick={() => (confirmOpenAiRemove = true)}>Remove</Button
							>
						{:else if confirmOpenAiRemove}
							<Button type="button" variant="outline" disabled={openAiPending} onclick={removeKey}>
								{openAiPending ? 'Removing…' : 'Confirm removal'}
							</Button>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground text-[13px]"
								disabled={openAiPending}
								onclick={() => (confirmOpenAiRemove = false)}>Cancel</button
							>
						{/if}
						{#if openAiSaved}<span class="text-muted-foreground text-[12px]">Saved</span>{/if}
					</div>
				</form>

				{#if openAiError}
					<p class="text-destructive mt-4 text-sm" role="alert">{openAiError}</p>
				{/if}
			</div>

			{#if loadError}
				<p class="text-destructive text-sm" role="alert">{loadError}</p>
			{/if}
		</div>
	</div>
</section>
