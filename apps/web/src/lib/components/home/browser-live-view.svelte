<script lang="ts">
	import { ExternalLink, Globe, LoaderCircle } from '@lucide/svelte';
	import type { BrowserLiveViewState } from '$lib/chat/side-panel';

	type Props = {
		/** undefined while the query is loading, null when no session exists. */
		liveView: BrowserLiveViewState | null | undefined;
		/** Whether the agent is actively working in the browser. */
		active: boolean;
	};

	let { liveView, active }: Props = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if liveView?.url}
		<div class="flex items-center gap-2 border-b px-3 py-1.5">
			<span class="relative flex size-2" aria-hidden="true">
				{#if active}
					<span
						class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60"
					></span>
					<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
				{:else}
					<span class="bg-muted-foreground/40 relative inline-flex size-2 rounded-full"></span>
				{/if}
			</span>
			<span role="status" class="text-muted-foreground text-xs">
				{active ? 'Live — the agent is browsing' : 'Browser session'}
			</span>
			<div class="flex-1"></div>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- external session URL, not an app route -->
			<a
				href={liveView.url}
				target="_blank"
				rel="noopener noreferrer"
				class="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
				aria-label="Open live view in a new tab"
				title="Open live view in a new tab"
			>
				<ExternalLink class="size-3.5" aria-hidden="true" />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
		<!-- Remount on session rotation so the viewer reconnects to the new session. -->
		{#key liveView.url}
			<iframe
				src={liveView.url}
				title="Agent browser live view"
				class="min-h-0 w-full flex-1 border-0"
				allow="clipboard-read; clipboard-write"
			></iframe>
		{/key}
	{:else if liveView}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
			<LoaderCircle class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
			<p class="text-muted-foreground text-sm">Starting the live view…</p>
			<p class="text-muted-foreground text-xs">The agent is browsing in the meantime.</p>
		</div>
	{:else if liveView === null}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
			<Globe class="text-muted-foreground size-5" aria-hidden="true" />
			<p class="text-muted-foreground text-sm">
				No browser session yet. When the agent browses the web, you can watch it here live.
			</p>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 items-center justify-center">
			<LoaderCircle class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
		</div>
	{/if}
</div>
