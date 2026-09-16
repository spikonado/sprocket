<script lang="ts">
	import type { InboxSectionData } from '$lib/project/inbox.svelte';

	let { section }: { section: InboxSectionData } = $props();
</script>

<div class="inbox-load-more" aria-live="polite">
	{#if section.error}
		<span role="alert">{section.error}</span>
	{:else if section.loading}
		<span>Loading...</span>
	{:else if section.canLoadMore}
		<button type="button" onclick={section.loadMore}>Show more</button>
	{/if}
</div>
