<script lang="ts">
	import { cn } from '$lib/utils';
	import { renderMarkdown } from '$lib/markdown';

	type Props = {
		content: string;
		className?: string;
	};

	let { content, className = '' }: Props = $props();

	const html = $derived(renderMarkdown(content));
</script>

<div class={cn('chat-markdown', className)}>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html html}
</div>
