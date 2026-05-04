<script lang="ts">
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import '../app.css';
	import { browser } from '$app/environment';
	import { setupConvex, useConvexClient } from 'convex-svelte';
	import { authState, getAccessToken, initializeAuth } from '$lib/auth';

	const { children } = $props();

	const convexUrl = PUBLIC_CONVEX_URL;
	const isDesktopShell = browser && Boolean(window.sprocketDesktop);

	setupConvex(convexUrl || 'https://invalid.invalid', {
		disabled: !browser || !convexUrl,
		unsavedChangesWarning: !isDesktopShell
	});

	const convexClient = useConvexClient();

	$effect(() => {
		if (!$authState.isReady) {
			return;
		}

		if ($authState.user) {
			void convexClient.setAuth(async () => (await getAccessToken()) ?? null);
			return;
		}

		void convexClient.setAuth(async () => null);
	});

	$effect(() => {
		if (!browser || !convexUrl) {
			return;
		}

		void initializeAuth(convexClient);
	});
</script>

{@render children()}
