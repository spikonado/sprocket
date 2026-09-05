<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { setupAuth, setupConvex } from 'convex-svelte';
	import {
		convexAuthLoading,
		convexAuthUserId,
		convexAuthRetryVersion,
		getAccessToken,
		initializeAuth
	} from '$lib/auth';
	import type { RuntimeConfig } from './+layout';

	const { children, data }: { children: import('svelte').Snippet; data: RuntimeConfig } = $props();

	const convexUrl = () => data.env.PUBLIC_CONVEX_URL;

	const convexClient = setupConvex(convexUrl() || 'https://invalid.invalid', {
		disabled: !browser || !convexUrl(),
		unsavedChangesWarning: false
	});

	setupAuth(() => {
		// A successful manual refresh increments this value so setupAuth installs
		// a fresh Convex auth configuration and waits for backend confirmation.
		void $convexAuthRetryVersion;
		return {
			isLoading: $convexAuthLoading,
			isAuthenticated: Boolean($convexAuthUserId),
			fetchAccessToken: getAccessToken
		};
	});

	$effect(() => {
		if (!browser || !convexUrl()) {
			return;
		}

		void initializeAuth(convexClient);
	});
</script>

{@render children()}
