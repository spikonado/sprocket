<script lang="ts">
	import { Sparkles, UserRound } from 'lucide-svelte';
	import Button from '$lib/components/ui/button/button.svelte';

	type AuthGateState = {
		isLoading: boolean;
		error: string | null;
	};

	type Props = {
		authState: AuthGateState;
		onSignIn: () => void;
		onSignUp: () => void;
	};

	let { authState, onSignIn, onSignUp }: Props = $props();
</script>

<div class="flex min-h-screen items-center justify-center px-6">
	<div
		class="bg-card/90 w-full max-w-xl rounded-[30px] border border-white/8 p-8 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
	>
		<div class="mb-6 flex items-center gap-3">
			<div
				class="flex size-10 items-center justify-center rounded-2xl border border-white/8 bg-white/4"
			>
				<Sparkles class="size-4 text-slate-100" />
			</div>
			<div>
				<p class="text-sm font-medium text-white">Sprocket</p>
				<p class="text-muted-foreground text-[11px] tracking-[0.2em] uppercase">Convex Agent</p>
			</div>
		</div>

		<h1 class="text-2xl font-medium tracking-tight text-white">Sign in to access your threads.</h1>
		<p class="text-muted-foreground mt-3 text-sm leading-6">
			Sprocket now stores coding threads, streaming responses, and workspace sessions in Convex.
			Local workspace execution still requires the desktop app.
		</p>

		{#if authState.error}
			<div
				class="mt-5 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
			>
				{authState.error}
			</div>
		{/if}

		<div class="mt-6 flex gap-3">
			<Button onclick={onSignIn} disabled={authState.isLoading}>
				<UserRound class="mr-2 size-4" />
				Sign In
			</Button>
			<Button variant="outline" onclick={onSignUp} disabled={authState.isLoading}>
				Create Account
			</Button>
		</div>
	</div>
</div>
