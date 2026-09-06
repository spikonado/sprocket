<script lang="ts">
	import { ExternalLink, Globe, LoaderCircle } from '@lucide/svelte';
	import { useMutation } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import type { BrowserLiveViewState } from '$lib/chat/side-panel';

	type Props = {
		/** undefined while the query is loading, null when no session exists. */
		liveView: BrowserLiveViewState | null | undefined;
		/** Whether the agent is actively working in the browser. */
		active: boolean;
	};

	let { liveView, active }: Props = $props();

	const setHumanControl = useMutation(api.browserProfiles.setHumanControl);

	let now = $state(Date.now());
	let pending = $state(false);
	let actionError = $state<string | null>(null);

	const threadId = $derived(liveView?.threadId);
	const humanControl = $derived(liveView?.humanControl === true);
	const passiveUrl = $derived(liveView?.url ?? null);
	const interactiveUrl = $derived(liveView?.interactiveUrl ?? null);
	const iframeInteractive = $derived(humanControl && interactiveUrl !== null);
	const iframeUrl = $derived(iframeInteractive ? interactiveUrl : passiveUrl);
	const expired = $derived(liveView?.expiresAt != null && liveView.expiresAt <= now);
	const canTakeover = $derived(threadId != null);
	const controlDisabled = $derived(pending || expired || (interactiveUrl == null && !humanControl));
	const savingLabel = $derived(
		liveView?.saving === undefined ? null : liveView.saving ? 'Saving' : 'Not saving'
	);
	const expiryLabel = $derived(
		liveView?.expiresAt == null ? null : formatExpiry(liveView.expiresAt, now)
	);
	const metaLabel = $derived.by(() => {
		const parts: string[] = [];
		if (savingLabel) parts.push(savingLabel);
		if (expiryLabel) parts.push(expiryLabel);
		if (humanControl && !iframeInteractive) parts.push('Waiting for the interactive view');
		return parts.join(' · ') || null;
	});
	const statusLabel = $derived(
		expired
			? 'Browser session ended'
			: humanControl
				? 'You have control'
				: active
					? 'The agent is browsing'
					: 'Browser session'
	);

	$effect(() => {
		const expiresAt = liveView?.expiresAt;
		if (expiresAt == null) return;
		now = Date.now();
		const id = window.setInterval(() => {
			now = Date.now();
		}, 1_000);
		return () => window.clearInterval(id);
	});

	$effect(() => {
		void threadId;
		actionError = null;
	});

	function friendlyError(error: Error, fallback: string): string {
		const match = error.message.match(/Uncaught Error: ([^(\n]+)/);
		return (match?.[1] ?? error.message).trim() || fallback;
	}

	function catchMessage<T>(error: T, fallback: string): string {
		return error instanceof Error ? friendlyError(error, fallback) : fallback;
	}

	function formatExpiry(expiresAt: number, current: number): string {
		if (expiresAt <= current) return 'Expired';
		const expires = new Date(expiresAt);
		const sameDay = expires.toDateString() === new Date(current).toDateString();
		return `Closes by ${expires.toLocaleString(
			undefined,
			sameDay
				? { hour: 'numeric', minute: '2-digit' }
				: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
		)}`;
	}

	async function setControl(enabled: boolean) {
		if (threadId == null || controlDisabled) return;
		pending = true;
		actionError = null;
		try {
			await setHumanControl({ threadId, enabled });
		} catch (error) {
			actionError = catchMessage(
				error,
				enabled ? 'Couldn’t take control.' : 'Couldn’t give control back.'
			);
		} finally {
			pending = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if liveView}
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
			<span class="relative flex size-2 shrink-0" aria-hidden="true">
				{#if expired}
					<span class="bg-muted-foreground/40 relative inline-flex size-2 rounded-full"></span>
				{:else if humanControl}
					<span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
				{:else if active}
					<span
						class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60"
					></span>
					<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
				{:else}
					<span class="bg-muted-foreground/40 relative inline-flex size-2 rounded-full"></span>
				{/if}
			</span>
			<div class="min-w-0 flex-1">
				<span role="status" class="text-muted-foreground text-xs">
					{statusLabel}
				</span>
				{#if metaLabel}
					<p class="text-muted-foreground text-[10px]">{metaLabel}</p>
				{/if}
			</div>
			{#if canTakeover}
				<button
					type="button"
					class="text-foreground hover:bg-muted rounded-md px-2 py-0.5 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-50"
					disabled={controlDisabled}
					aria-busy={pending}
					onclick={() => {
						void setControl(!humanControl);
					}}
				>
					{#if pending}
						{humanControl ? 'Giving control back…' : 'Taking control…'}
					{:else if humanControl}
						Give control back
					{:else}
						Take control
					{/if}
				</button>
			{/if}
			{#if passiveUrl}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- external watch-only session URL, not an app route -->
				<a
					href={passiveUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
					aria-label="Open watch-only live view in a new tab"
					title="Open watch-only live view in a new tab"
				>
					<ExternalLink class="size-3.5" aria-hidden="true" />
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		</div>
		{#if actionError}
			<p class="text-destructive border-b px-3 py-1.5 text-xs" role="alert">{actionError}</p>
		{/if}
		{#if iframeUrl}
			<!-- Remount on session rotation or takeover so the viewer reconnects. -->
			{#key iframeUrl}
				<iframe
					src={iframeUrl}
					title={iframeInteractive ? 'Agent browser (interactive)' : 'Agent browser'}
					class="min-h-0 w-full flex-1 border-0"
					allow="clipboard-read; clipboard-write"
				></iframe>
			{/key}
		{:else}
			<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				<LoaderCircle class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
				<p class="text-muted-foreground text-sm">Starting the live view…</p>
				<p class="text-muted-foreground text-xs">The agent is browsing in the meantime.</p>
			</div>
		{/if}
	{:else if liveView === null}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
			<Globe class="text-muted-foreground size-5" aria-hidden="true" />
			<p class="text-muted-foreground text-sm">
				No active browser session. When the agent browses again, a new session will appear here.
			</p>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 items-center justify-center">
			<LoaderCircle class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
		</div>
	{/if}
</div>
