<script lang="ts">
	import { Eye, EyeOff } from '@lucide/svelte';
	import { useAction } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import Button from '$lib/components/ui/button/button.svelte';
	import ProviderLogo from '$lib/components/provider-logo.svelte';
	import { convexClientErrorMessage } from '$lib/convex-error';

	type Props = {
		openAiConfigured: boolean;
		loading: boolean;
		loadError: string | null;
		onConfigurationChange: (configured: boolean) => void;
	};

	let { openAiConfigured, loading, loadError, onConfigurationChange }: Props = $props();
	const saveOpenAiKey = useAction(api.providerCredentials.saveOpenAiKey);
	const removeOpenAiKey = useAction(api.providerCredentials.removeOpenAiKey);
	let apiKey = $state('');
	let showKey = $state(false);
	let pending = $state(false);
	let confirmRemove = $state(false);
	let actionError = $state<string | null>(null);
	let saved = $state(false);

	async function saveKey(event: Event) {
		event.preventDefault();
		if (!apiKey.trim() || pending) return;
		pending = true;
		actionError = null;
		saved = false;
		try {
			await saveOpenAiKey({ apiKey });
			apiKey = '';
			showKey = false;
			saved = true;
			onConfigurationChange(true);
		} catch (error) {
			actionError =
				(error instanceof Error && convexClientErrorMessage(error)) ||
				'Couldn’t save the OpenAI key.';
		} finally {
			pending = false;
		}
	}

	async function removeKey() {
		if (pending) return;
		pending = true;
		actionError = null;
		saved = false;
		try {
			await removeOpenAiKey({});
			confirmRemove = false;
			onConfigurationChange(false);
		} catch (error) {
			actionError =
				(error instanceof Error && convexClientErrorMessage(error)) ||
				'Couldn’t remove the OpenAI key.';
		} finally {
			pending = false;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Providers</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl">
			<div class="border-border rounded-xl border p-5">
				<div class="flex items-center gap-3">
					<ProviderLogo provider="openai" className="size-5" />
					<div class="min-w-0 flex-1">
						<p class="text-foreground text-[15px] font-medium">OpenAI</p>
						<p class="text-muted-foreground mt-0.5 text-[12px]">
							{loading
								? 'Checking configuration…'
								: openAiConfigured
									? 'Connected'
									: 'Not configured'}
						</p>
					</div>
				</div>

				<p class="text-muted-foreground mt-4 text-sm leading-6">
					OpenAI requests run directly from your local Sprocket server. They do not use your
					Spikonado quota. Your key is encrypted in WorkOS Vault and is never shown again.
				</p>

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
								disabled={pending || loading}
								class="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border pr-10 pl-3 font-mono text-[13px] outline-none disabled:opacity-50"
							/>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
								aria-label={showKey ? 'Hide API key' : 'Show API key'}
								disabled={pending || loading}
								onclick={() => (showKey = !showKey)}
							>
								{#if showKey}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
							</button>
						</div>
					</label>

					<div class="flex flex-wrap items-center gap-3">
						<Button disabled={pending || loading || !apiKey.trim()}>
							{pending ? 'Saving…' : openAiConfigured ? 'Replace key' : 'Connect OpenAI'}
						</Button>
						{#if openAiConfigured && !confirmRemove}
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onclick={() => (confirmRemove = true)}>Remove</Button
							>
						{:else if confirmRemove}
							<Button type="button" variant="outline" disabled={pending} onclick={removeKey}>
								{pending ? 'Removing…' : 'Confirm removal'}
							</Button>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground text-[13px]"
								disabled={pending}
								onclick={() => (confirmRemove = false)}>Cancel</button
							>
						{/if}
						{#if saved}<span class="text-muted-foreground text-[12px]">Saved</span>{/if}
					</div>
				</form>

				{#if loadError}
					<p class="text-destructive mt-4 text-sm" role="alert">{loadError}</p>
				{/if}
				{#if actionError}
					<p class="text-destructive mt-4 text-sm" role="alert">{actionError}</p>
				{/if}
			</div>
		</div>
	</div>
</section>
