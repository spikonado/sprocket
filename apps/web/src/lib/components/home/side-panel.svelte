<script lang="ts">
	import { Expand, FileCode, FileText, Fullscreen, Globe, Shrink, X } from '@lucide/svelte';
	import ArtifactDisplay from '$lib/components/home/artifact-display.svelte';
	import BrowserLiveView from '$lib/components/home/browser-live-view.svelte';
	import type { ArtifactEntry } from '$lib/chat/artifacts';
	import type { BrowserLiveViewState, SidePanelTab } from '$lib/chat/side-panel';
	import type { ArtifactType } from '$convex/lib/validators';

	type Props = {
		artifacts: ArtifactEntry[];
		selectedKey: string | null;
		tab: SidePanelTab;
		/** undefined while the query is loading, null when no session exists. */
		liveView: BrowserLiveViewState | null | undefined;
		/** Whether the agent is actively working in the browser. */
		liveActive: boolean;
		/** When true, the panel covers the full Sprocket workspace UI (not browser fullscreen). */
		expanded: boolean;
		onSelect: (key: string) => void;
		onBack: () => void;
		onTabChange: (tab: SidePanelTab) => void;
		/** Enter true browser fullscreen for a single artifact (content only). */
		onOpenFullscreen: (key: string) => void;
		onToggleExpanded: () => void;
		onClose: () => void;
	};

	let {
		artifacts,
		selectedKey,
		tab,
		liveView,
		liveActive,
		expanded,
		onSelect,
		onBack,
		onTabChange,
		onOpenFullscreen,
		onToggleExpanded,
		onClose
	}: Props = $props();

	const selected = $derived(artifacts.find((artifact) => artifact.key === selectedKey) ?? null);

	const TYPE_ICONS = {
		markdown: FileText,
		html: Globe,
		react: FileCode
	} as const satisfies Record<ArtifactType, typeof FileCode>;

	const TABS: { id: SidePanelTab; label: string }[] = [
		{ id: 'artifacts', label: 'Artifacts' },
		{ id: 'live', label: 'Live view' }
	];

	// Roving tabindex for the WAI-ARIA tabs keyboard pattern.
	function focusTab(tabId: SidePanelTab) {
		document.getElementById(`side-panel-tab-${tabId}`)?.focus();
	}

	function onTabKeydown(event: KeyboardEvent) {
		const current = TABS.findIndex((item) => item.id === tab);
		let next = -1;
		if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
		else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = TABS.length - 1;
		if (next === -1) return;
		event.preventDefault();
		onTabChange(TABS[next].id);
		// Focus moves with selection (automatic activation).
		focusTab(TABS[next].id);
	}

	$effect(() => {
		if (!expanded) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Artifact screen-fullscreen (browser FS or CSS fallback) owns Escape.
			if (
				document.fullscreenElement ||
				document.querySelector('[data-artifact-screen-fullscreen]')
			) {
				return;
			}
			event.preventDefault();
			onToggleExpanded();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	});
</script>

<aside class="bg-background flex h-full min-h-0 w-full flex-col {expanded ? '' : 'border-l'}">
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		<div role="tablist" aria-label="Side panel views" class="flex items-center gap-1">
			{#each TABS as item (item.id)}
				<button
					type="button"
					role="tab"
					id="side-panel-tab-{item.id}"
					aria-controls="side-panel-tabpanel"
					aria-selected={tab === item.id}
					tabindex={tab === item.id ? 0 : -1}
					class="rounded-md px-2.5 py-1 text-xs font-medium transition {tab === item.id
						? 'bg-muted text-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => onTabChange(item.id)}
					onkeydown={onTabKeydown}
				>
					<span class="inline-flex items-center gap-1.5">
						{#if item.id === 'live' && liveActive && tab !== 'live'}
							<span class="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true"
							></span>
						{/if}
						{item.label}
					</span>
				</button>
			{/each}
		</div>
		<div class="flex-1"></div>
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
			onclick={onToggleExpanded}
			aria-label={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
			title={expanded ? 'Exit full workspace' : 'Expand to full workspace'}
			aria-pressed={expanded}
		>
			{#if expanded}
				<Shrink class="size-4" aria-hidden="true" />
			{:else}
				<Expand class="size-4" aria-hidden="true" />
			{/if}
		</button>
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground rounded-md p-1 transition"
			onclick={onClose}
			aria-label="Close panel"
		>
			<X class="size-4" aria-hidden="true" />
		</button>
	</div>
	<div
		role="tabpanel"
		id="side-panel-tabpanel"
		aria-labelledby="side-panel-tab-{tab}"
		class="flex min-h-0 flex-1 flex-col"
	>
		{#if tab === 'live'}
			<BrowserLiveView {liveView} active={liveActive} />
		{:else if selected}
			<div class="flex min-h-0 flex-1 flex-col p-3">
				<ArtifactDisplay
					title={selected.title}
					artifactType={selected.artifactType}
					content={selected.content}
					variant="full"
					onOpenFullscreen={() => onOpenFullscreen(selected.key)}
					{onBack}
				/>
			</div>
		{:else}
			<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
				{#each artifacts as artifact (artifact.key)}
					{@const TypeIcon = TYPE_ICONS[artifact.artifactType]}
					<div
						class="group hover:bg-muted focus-within:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5"
					>
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-2 text-left"
							onclick={() => onSelect(artifact.key)}
						>
							<TypeIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
							<span class="text-foreground min-w-0 truncate text-sm">{artifact.title}</span>
						</button>
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
							onclick={() => onOpenFullscreen(artifact.key)}
							aria-label={`Open ${artifact.title} fullscreen`}
							title="Open fullscreen"
						>
							<Fullscreen class="size-3.5" aria-hidden="true" />
						</button>
					</div>
				{:else}
					<p class="text-muted-foreground p-3 text-sm">No artifacts yet.</p>
				{/each}
			</div>
		{/if}
	</div>
</aside>
