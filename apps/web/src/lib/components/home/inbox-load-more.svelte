<script lang="ts">
	import type { InboxSectionData } from '$lib/project/inbox.svelte';
	let { section }: { section: InboxSectionData } = $props();
	let element: HTMLDivElement;
	let visible = $state(false);
	$effect(() => {
		if (!element || !('IntersectionObserver' in window)) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				visible = entry?.isIntersecting ?? false;
			},
			{ rootMargin: '100px' }
		);
		observer.observe(element);
		return () => observer.disconnect();
	});
	$effect(() => {
		if (visible && section.canLoadMore && !section.error) section.loadMore();
	});
</script>

<div bind:this={element} class="inbox-load-more" aria-live="polite">
	{#if section.error}<span role="alert">{section.error}</span>{/if}
	{#if section.loading}<span>Loading threads…</span>{:else if section.canLoadMore}<button
			onclick={() => section.loadMore()}>Load more</button
		>{/if}
</div>
