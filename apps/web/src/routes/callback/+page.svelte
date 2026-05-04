<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authState } from '$lib/auth';

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

<div class="flex min-h-screen items-center justify-center px-6">
	<div
		class="bg-card/90 w-full max-w-md rounded-[30px] border border-white/8 p-8 text-center shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
	>
		<p class="text-sm font-medium text-white">Completing sign-in...</p>
		<p class="text-muted-foreground mt-3 text-sm leading-6">
			Sprocket is finishing authentication and will return to your workspace automatically.
		</p>
	</div>
</div>
