<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { setupAuth, setupConvex } from 'convex-svelte';
	import { authState, getAccessToken, initializeAuth } from '$lib/auth';
	import type { RuntimeConfig } from './+layout';

	const { children, data }: { children: import('svelte').Snippet; data: RuntimeConfig } = $props();

	const convexUrl = () => data.env.PUBLIC_CONVEX_URL;

	const convexClient = setupConvex(convexUrl() || 'https://invalid.invalid', {
		disabled: !browser || !convexUrl(),
		unsavedChangesWarning: false
	});

	setupAuth(() => ({
		isLoading: !$authState.isReady || $authState.isLoading,
		isAuthenticated: Boolean($authState.user),
		fetchAccessToken: getAccessToken
	}));

	$effect(() => {
		if (!browser || !convexUrl()) {
			return;
		}

		void initializeAuth(convexClient);
	});
</script>

{@render children()}
