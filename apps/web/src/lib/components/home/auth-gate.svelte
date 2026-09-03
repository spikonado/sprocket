<script lang="ts">
	import { LoaderCircle } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';

	type AuthGateState = {
		isLoading: boolean;
		isConfigured: boolean;
		isAuthenticated: boolean;
		connectionFailed: boolean;
		error: string | null;
	};

	type Props = {
		authState: AuthGateState;
		overlayOpen?: boolean;
		onSignIn: () => void;
		onSignOut: () => void;
		onRetry: () => void;
		retryLabel?: string;
		onSignUp: () => void;
	};

	let {
		authState,
		overlayOpen = false,
		onSignIn,
		onSignOut,
		onRetry,
		retryLabel = 'Retry',
		onSignUp
	}: Props = $props();

	const showConfirming = $derived(
		authState.isAuthenticated && (authState.isLoading || !authState.connectionFailed)
	);
	const showPreparing = $derived(!authState.isAuthenticated && authState.isLoading);

	const headline = $derived(
		!authState.isConfigured
			? 'Sign-in unavailable'
			: showConfirming
				? 'Confirming your session'
				: authState.connectionFailed
					? 'Couldn’t connect your account'
					: showPreparing
						? 'Preparing sign-in'
						: 'Sign in to continue'
	);

	const description = $derived(
		!authState.isConfigured
			? 'Account sign-in is not configured on this deployment, so account actions are disabled.'
			: showConfirming
				? 'Verifying your secure connection before opening your projects.'
				: authState.connectionFailed
					? 'You’re signed in, but the secure connection could not be confirmed. Retry or sign out and sign in again.'
					: showPreparing
						? 'Getting account sign-in ready. This usually takes a moment.'
						: 'Sign in to sync your coding threads, streaming responses, and projects.'
	);

	const loadingLabel = $derived(authState.isAuthenticated ? 'Almost there' : 'One moment');
	const showError = $derived(Boolean(authState.isConfigured && authState.error && !overlayOpen));
</script>

<div inert={overlayOpen} aria-hidden={overlayOpen ? true : undefined}>
	<CalmCentered title={headline} {description}>
		{#if showError}
			<p class="text-destructive text-center text-sm" role="alert">{authState.error}</p>
		{/if}

		{#if authState.isLoading}
			<div
				class="text-muted-foreground flex items-center justify-center gap-2 text-sm"
				aria-live="polite"
				aria-busy="true"
			>
				<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
				<span>{loadingLabel}</span>
			</div>
		{/if}

		{#snippet actions()}
			{#if authState.isAuthenticated}
				{#if authState.connectionFailed}
					<Button onclick={onRetry} disabled={authState.isLoading}>{retryLabel}</Button>
				{/if}
				<Button variant="outline" onclick={onSignOut}>Sign Out</Button>
			{:else if authState.isConfigured}
				<Button onclick={onSignIn} disabled={authState.isLoading}>Sign In</Button>
				<Button variant="outline" onclick={onSignUp} disabled={authState.isLoading}>
					Create Account
				</Button>
			{/if}
		{/snippet}
	</CalmCentered>
</div>
