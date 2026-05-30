<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { setupConvex, useConvexClient } from 'convex-svelte';
	import { authState, getAccessToken, initializeAuth } from '$lib/auth';
	import type { RuntimeConfig } from './+layout';

	const { children, data }: { children: import('svelte').Snippet; data: RuntimeConfig } = $props();

	const convexUrl = () => data.env.PUBLIC_CONVEX_URL;

	setupConvex(convexUrl() || 'https://invalid.invalid', {
		disabled: !browser || !convexUrl(),
		unsavedChangesWarning: false
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
		if (!browser || !convexUrl()) {
			return;
		}

		void initializeAuth(convexClient);
	});
</script>

{@render children()}
