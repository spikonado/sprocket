<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authState } from '$lib/auth';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';

	$effect(() => {
		if (!$authState.isReady) {
			return;
		}

		void goto(resolve('/'), { replaceState: true });
	});
</script>

<svelte:head>
	<title>Signing In</title>
</svelte:head>

<CalmCentered
	title="Completing sign-in"
	description="Sprocket is finishing authentication and will return to your projects automatically."
/>
