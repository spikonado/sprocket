<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setupAuth, setupConvex } from 'convex-svelte';
	import PromptComposer from './prompt-composer.svelte';

	let { composerProps }: { composerProps: ComponentProps<typeof PromptComposer> } = $props();

	setupConvex('https://example.convex.cloud', {
		disabled: true,
		unsavedChangesWarning: false
	});
	setupAuth(
		() => ({
			isLoading: false,
			isAuthenticated: false,
			fetchAccessToken: async () => null
		}),
		{ initialState: { isAuthenticated: false } }
	);
</script>

<PromptComposer {...composerProps} />
