<script lang="ts">
	import { ArrowDown, ArrowUp, KeyRound } from '@lucide/svelte';
	import { useAction, useAuth, useMutation, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import { completionProviders } from '$convex/lib/providers';
	import type { CompletionProviderId } from '$convex/lib/validators';
	import Button from '$lib/components/ui/button/button.svelte';

	const convexAuth = useAuth();
	const settingsQuery = useQuery(api.providerSettings.getMine, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);
	const setProviderOrder = useMutation(api.providerSettings.setProviderOrder);
	const setOpenAIApiKey = useAction(api.providerCredentials.setOpenAIApiKey);
	const clearOpenAIApiKey = useAction(api.providerCredentials.clearOpenAIApiKey);
	const setChatGPTAuth = useAction(api.providerCredentials.setChatGPTAuth);
	const clearChatGPTAuth = useAction(api.providerCredentials.clearChatGPTAuth);

	let apiKeyDraft = $state('');
	let chatGPTAuthDraft = $state('');
	let savingKey = $state(false);
	let clearingKey = $state(false);
	let savingChatGPT = $state(false);
	let clearingChatGPT = $state(false);
	let reordering = $state(false);
	let actionError = $state<string | null>(null);
	let actionNotice = $state<string | null>(null);

	const providers = $derived(settingsQuery.data?.providers ?? [...completionProviders]);
	const openaiCredential = $derived(
		settingsQuery.data?.credentials.find((credential) => credential.provider === 'openai') ?? null
	);
	const chatgptCredential = $derived(
		settingsQuery.data?.credentials.find((credential) => credential.provider === 'chatgpt') ?? null
	);

	const providerCopy: Record<CompletionProviderId, { label: string; description: string }> = {
		convex: {
			label: 'Sprocket',
			description: 'Hosted models billed against your Sprocket subscription.'
		},
		chatgpt: {
			label: 'ChatGPT',
			description:
				'Your ChatGPT/Codex subscription via auth.json. Tried in the order below for OpenAI catalog models, with fallback if it fails before a response is written.'
		},
		openai: {
			label: 'OpenAI',
			description:
				'Your OpenAI API key for OpenAI catalog models. Tried in the order below, with fallback if it fails before a response is written.'
		}
	};

	function isConfigured(provider: CompletionProviderId): boolean {
		return (
			provider === 'convex' ||
			(settingsQuery.data?.credentials.find((credential) => credential.provider === provider)
				?.configured ??
				false)
		);
	}

	async function moveProvider(index: number, direction: -1 | 1) {
		const nextIndex = index + direction;
		if (nextIndex < 0 || nextIndex >= providers.length) return;
		const next = [...providers];
		const [item] = next.splice(index, 1);
		next.splice(nextIndex, 0, item);
		reordering = true;
		actionError = null;
		actionNotice = null;
		try {
			await setProviderOrder({ providers: next });
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not update provider order.';
		} finally {
			reordering = false;
		}
	}

	async function saveOpenAIKey() {
		savingKey = true;
		actionError = null;
		actionNotice = null;
		try {
			await setOpenAIApiKey({ apiKey: apiKeyDraft });
			apiKeyDraft = '';
			actionNotice = 'OpenAI API key saved.';
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not save OpenAI API key.';
		} finally {
			savingKey = false;
		}
	}

	async function removeOpenAIKey() {
		if (
			typeof window !== 'undefined' &&
			!window.confirm('Remove your OpenAI API key from Sprocket?')
		) {
			return;
		}
		clearingKey = true;
		actionError = null;
		actionNotice = null;
		try {
			await clearOpenAIApiKey({});
			actionNotice = 'OpenAI API key removed.';
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not remove OpenAI API key.';
		} finally {
			clearingKey = false;
		}
	}

	async function saveChatGPT() {
		savingChatGPT = true;
		actionError = null;
		actionNotice = null;
		try {
			await setChatGPTAuth({ authJson: chatGPTAuthDraft });
			chatGPTAuthDraft = '';
			actionNotice = 'ChatGPT auth saved.';
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not save ChatGPT auth.';
		} finally {
			savingChatGPT = false;
		}
	}

	async function removeChatGPT() {
		if (
			typeof window !== 'undefined' &&
			!window.confirm('Remove your ChatGPT auth.json from Sprocket?')
		) {
			return;
		}
		clearingChatGPT = true;
		actionError = null;
		actionNotice = null;
		try {
			await clearChatGPTAuth({});
			actionNotice = 'ChatGPT auth removed.';
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not remove ChatGPT auth.';
		} finally {
			clearingChatGPT = false;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Providers</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-10">
			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Fallback order
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Sprocket tries providers from top to bottom for the selected model. If a provider fails
					before any response is written, the next one is used.
				</p>

				{#if settingsQuery.error}
					<p class="text-muted-foreground mt-4 text-sm">
						Couldn’t load provider settings right now.
					</p>
				{:else if settingsQuery.isLoading || settingsQuery.data === undefined}
					<div class="mt-4 space-y-2" aria-hidden="true">
						{#each [0, 1, 2] as row (row)}
							<div class="h-16 animate-pulse rounded-lg bg-[var(--hover-fill)]"></div>
						{/each}
					</div>
				{:else}
					<ol class="mt-4 space-y-2">
						{#each providers as provider, index (provider)}
							{@const copy = providerCopy[provider]}
							{@const configured = isConfigured(provider)}
							<li
								class="border-border/70 flex items-start justify-between gap-3 rounded-lg border px-3.5 py-3"
							>
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<span class="text-foreground text-[14px] font-medium">{copy.label}</span>
										<span
											class="text-muted-foreground font-mono text-[10px] tracking-[0.14em] uppercase"
										>
											{configured ? 'Ready' : 'Needs key'}
										</span>
									</div>
									<p class="text-muted-foreground mt-1 text-sm leading-5">{copy.description}</p>
								</div>
								<div class="flex shrink-0 flex-col gap-1">
									<button
										type="button"
										class="text-muted-foreground hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition hover:bg-[var(--hover-fill)] disabled:opacity-40"
										aria-label={`Move ${copy.label} up`}
										disabled={reordering || index === 0}
										onclick={() => void moveProvider(index, -1)}
									>
										<ArrowUp class="size-3.5" aria-hidden="true" />
									</button>
									<button
										type="button"
										class="text-muted-foreground hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition hover:bg-[var(--hover-fill)] disabled:opacity-40"
										aria-label={`Move ${copy.label} down`}
										disabled={reordering || index === providers.length - 1}
										onclick={() => void moveProvider(index, 1)}
									>
										<ArrowDown class="size-3.5" aria-hidden="true" />
									</button>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					ChatGPT auth.json
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Paste your Codex/ChatGPT <span class="font-mono">auth.json</span> (access + refresh tokens).
					Stored encrypted with WorkOS Vault and decrypted only for active agent runs.
				</p>

				{#if settingsQuery.error}
					<p class="text-muted-foreground mt-4 text-sm">
						Couldn’t load credential status right now.
					</p>
				{:else if settingsQuery.isLoading || settingsQuery.data === undefined}
					<div
						class="mt-4 h-28 animate-pulse rounded-lg bg-[var(--hover-fill)]"
						aria-hidden="true"
					></div>
				{:else}
					{#if chatgptCredential?.configured}
						<p class="text-foreground mt-3 text-sm">
							Configured auth ending in
							<span class="font-mono">••••{chatgptCredential.keyHint}</span>
						</p>
					{:else}
						<p class="text-muted-foreground mt-3 text-sm">No ChatGPT auth configured.</p>
					{/if}

					<label class="mt-4 block">
						<span class="text-muted-foreground sr-only">ChatGPT auth.json</span>
						<textarea
							autocomplete="off"
							spellcheck="false"
							rows="6"
							placeholder={'{\n  "access_token": "...",\n  "refresh_token": "..."\n}'}
							class="border-border bg-surface text-foreground placeholder:text-muted-foreground focus:border-foreground/40 w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none"
							bind:value={chatGPTAuthDraft}
							disabled={savingChatGPT || clearingChatGPT}></textarea>
					</label>

					<div class="mt-4 flex flex-wrap gap-2">
						<Button
							disabled={savingChatGPT || clearingChatGPT || chatGPTAuthDraft.trim().length === 0}
							onclick={() => void saveChatGPT()}
						>
							<KeyRound class="mr-2 size-4" aria-hidden="true" />
							{chatgptCredential?.configured ? 'Replace auth' : 'Save auth'}
						</Button>
						{#if chatgptCredential?.configured}
							<Button
								variant="outline"
								disabled={savingChatGPT || clearingChatGPT}
								onclick={() => void removeChatGPT()}
							>
								Remove auth
							</Button>
						{/if}
					</div>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					OpenAI API key
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Stored encrypted with WorkOS Vault. The key is only decrypted for active agent runs on
					your machine.
				</p>

				{#if settingsQuery.error}
					<p class="text-muted-foreground mt-4 text-sm">
						Couldn’t load credential status right now.
					</p>
				{:else if settingsQuery.isLoading || settingsQuery.data === undefined}
					<div
						class="mt-4 h-24 animate-pulse rounded-lg bg-[var(--hover-fill)]"
						aria-hidden="true"
					></div>
				{:else}
					{#if openaiCredential?.configured}
						<p class="text-foreground mt-3 text-sm">
							Configured key ending in
							<span class="font-mono">••••{openaiCredential.keyHint}</span>
						</p>
					{:else}
						<p class="text-muted-foreground mt-3 text-sm">No OpenAI key configured.</p>
					{/if}

					<label class="mt-4 block">
						<span class="text-muted-foreground sr-only">OpenAI API key</span>
						<input
							type="password"
							autocomplete="off"
							spellcheck="false"
							placeholder="sk-..."
							class="border-border bg-surface text-foreground placeholder:text-muted-foreground focus:border-foreground/40 h-10 w-full rounded-lg border px-3 text-sm outline-none"
							bind:value={apiKeyDraft}
							disabled={savingKey || clearingKey}
						/>
					</label>

					<div class="mt-4 flex flex-wrap gap-2">
						<Button
							disabled={savingKey || clearingKey || apiKeyDraft.trim().length === 0}
							onclick={() => void saveOpenAIKey()}
						>
							<KeyRound class="mr-2 size-4" aria-hidden="true" />
							{openaiCredential?.configured ? 'Replace key' : 'Save key'}
						</Button>
						{#if openaiCredential?.configured}
							<Button
								variant="outline"
								disabled={savingKey || clearingKey}
								onclick={() => void removeOpenAIKey()}
							>
								Remove key
							</Button>
						{/if}
					</div>
				{/if}
			</div>

			{#if actionError}
				<p class="text-sm text-rose-500/90" role="alert">{actionError}</p>
			{:else if actionNotice}
				<p class="text-muted-foreground text-sm" role="status">{actionNotice}</p>
			{/if}
		</div>
	</div>
</section>
