<script lang="ts">
	import { LoaderCircle, Sparkles, UserRound } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';

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
		onSignUp: () => void;
	};

	let { authState, overlayOpen = false, onSignIn, onSignOut, onRetry, onSignUp }: Props = $props();

	const showConfirming = $derived(
		authState.isAuthenticated && (authState.isLoading || !authState.connectionFailed)
	);
	const showPreparing = $derived(!authState.isAuthenticated && authState.isLoading);

	const headline = $derived(
		!authState.isConfigured
			? 'Sign-in unavailable.'
			: showConfirming
				? 'Confirming your session'
				: authState.connectionFailed
					? 'Couldn’t connect your account.'
					: showPreparing
						? 'Preparing sign-in'
						: 'Sign in to access your threads.'
	);

	const description = $derived(
		!authState.isConfigured
			? 'Account sign-in is not configured on this deployment, so account actions are disabled.'
			: showConfirming
				? 'Verifying your secure connection before opening your workspace.'
				: authState.connectionFailed
					? 'You’re signed in, but the secure connection could not be confirmed. Retry or sign out and sign in again.'
					: showPreparing
						? 'Getting account sign-in ready. This usually takes a moment.'
						: 'Sign in to sync your coding threads, streaming responses, and projects.'
	);

	const loadingLabel = $derived(authState.isAuthenticated ? 'Almost there' : 'One moment');
</script>

<div
	class="flex min-h-screen items-center justify-center px-6"
	inert={overlayOpen}
	aria-hidden={overlayOpen ? true : undefined}
>
	<div
		class="bg-card/90 w-full max-w-xl rounded-[30px] border border-white/8 p-8 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
	>
		<div class="mb-6 flex items-center gap-3">
			<div
				class="flex size-10 items-center justify-center rounded-2xl border border-white/8 bg-white/4"
			>
				<Sparkles class="size-4 text-slate-100" aria-hidden="true" />
			</div>
			<div>
				<p class="text-sm font-medium text-white">Sprocket</p>
				<p class="text-muted-foreground text-[11px] tracking-[0.2em] uppercase">Account</p>
			</div>
		</div>

		<h1 class="text-2xl font-medium tracking-tight text-white">{headline}</h1>
		<p class="text-muted-foreground mt-3 text-sm leading-6">{description}</p>

		{#if authState.isConfigured && authState.error && !overlayOpen}
			<div
				class="mt-5 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
				role="alert"
			>
				{authState.error}
			</div>
		{/if}

		{#if authState.isLoading}
			<div
				class="text-muted-foreground mt-5 flex items-center gap-2 text-sm"
				aria-live="polite"
				aria-busy="true"
			>
				<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
				<span>{loadingLabel}</span>
			</div>
		{/if}

		{#if authState.isAuthenticated}
			<div class="mt-6 flex gap-3">
				{#if authState.connectionFailed}
					<Button onclick={onRetry} disabled={authState.isLoading}>Retry Connection</Button>
				{/if}
				<Button variant="outline" onclick={onSignOut}>Sign Out</Button>
			</div>
		{:else if authState.isConfigured}
			<div class="mt-6 flex gap-3">
				<Button onclick={onSignIn} disabled={authState.isLoading}>
					<UserRound class="mr-2 size-4" aria-hidden="true" />
					Sign In
				</Button>
				<Button variant="outline" onclick={onSignUp} disabled={authState.isLoading}>
					Create Account
				</Button>
			</div>
		{/if}
	</div>
</div>
