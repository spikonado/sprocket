<script lang="ts">
	import { browser } from '$app/environment';
	import { CreditCard, ShieldCheck, TriangleAlert } from '@lucide/svelte';
	import { PravaSDK } from '@prava-sdk/core';
	import type { MandateApproval } from '$lib/chat/mandate';

	type Props = {
		approval: MandateApproval;
		publishableKey?: string;
		merchant?: string;
	};

	let { approval, publishableKey, merchant }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let errorMessage = $state<string | null>(null);
	let completed = $state(false);

	let sdk: PravaSDK | null = null;
	let mounted = false;

	// Mount the Prava approval iframe once on first render. Completion is tracked
	// by the agent polling mandate status, not by the iframe callback, so the
	// card only needs to render the approval surface.
	$effect(() => {
		if (!browser || !container || !publishableKey || mounted) {
			return;
		}
		mounted = true;
		status = 'loading';
		sdk = new PravaSDK({ publishableKey });
		sdk
			.collectPAN({
				sessionToken: approval.sessionToken,
				iframeUrl: approval.approvalUrl,
				container,
				onReady: () => {
					status = 'ready';
				},
				onSuccess: () => {
					completed = true;
					status = 'ready';
				},
				onError: (err) => {
					status = 'error';
					errorMessage = err.message ?? 'The approval form failed to load.';
				}
			})
			.catch((err) => {
				status = 'error';
				errorMessage = err instanceof Error ? err.message : 'The approval form failed to load.';
			});
		return () => {
			sdk?.destroy();
			sdk = null;
			mounted = false;
		};
	});
</script>

<div class="bg-card my-2 max-w-md overflow-hidden rounded-lg border">
	<div class="border-hairline flex items-center gap-2 border-b px-3.5 py-2.5">
		<CreditCard class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<p class="text-foreground truncate text-sm font-medium">
				Approve spending mandate{merchant ? ` · ${merchant}` : ''}
			</p>
			<p class="text-muted-foreground text-xs">
				Confirm with your passkey to let the agent charge within the cap.
			</p>
		</div>
		{#if completed}
			<span
				class="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
			>
				<ShieldCheck class="size-3" aria-hidden="true" />
				Approved
			</span>
		{/if}
	</div>

	{#if publishableKey}
		<div class="relative px-1.5 py-1.5">
			{#if status === 'loading' || status === 'idle'}
				<p class="text-muted-foreground px-2 py-6 text-center text-xs" role="status">
					Loading secure approval…
				</p>
			{/if}
			{#if status === 'error'}
				<div class="flex flex-col items-center gap-2 px-2 py-4" role="alert">
					<p class="text-destructive inline-flex items-center gap-1.5 text-xs">
						<TriangleAlert class="size-3.5" aria-hidden="true" />
						{errorMessage}
					</p>
					<button
						type="button"
						onclick={() => window.open(approval.approvalUrl, '_blank')}
						class="text-foreground hover:bg-muted inline-flex items-center rounded-md border px-2.5 py-1 text-xs transition"
					>
						Open approval page
					</button>
				</div>
			{/if}
			<div bind:this={container} class="min-h-[300px] overflow-hidden"></div>
		</div>
	{:else}
		<div class="px-3.5 py-4">
			<p class="text-muted-foreground text-xs">
				Add <code>PUBLIC_PRAVA_PUBLISHABLE_KEY</code> to approve inline, or
			</p>
			<button
				type="button"
				onclick={() => window.open(approval.approvalUrl, '_blank')}
				class="text-foreground hover:bg-muted mt-2 inline-flex items-center rounded-md border px-2.5 py-1 text-xs transition"
			>
				Open approval page
			</button>
		</div>
	{/if}
</div>
