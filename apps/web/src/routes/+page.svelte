<script lang="ts">
	import { browser } from '$app/environment';
	import { CounterView } from '@sprocket/ui';

	let hasDesktopBridge = $state(false);
	let nativeRuntimeInfo = $state<string | null>(null);
	let nativeRuntimeError = $state<string | null>(null);

	$effect(() => {
		if (!browser) {
			return;
		}

		const desktopApi = window.sprocketDesktop;
		hasDesktopBridge = Boolean(desktopApi);

		if (!desktopApi) {
			nativeRuntimeInfo = null;
			return;
		}

		void desktopApi
			.getNativeRuntimeInfo()
			.then((runtimeInfo) => {
				nativeRuntimeInfo = runtimeInfo;
				nativeRuntimeError = null;
			})
			.catch((error: unknown) => {
				nativeRuntimeError = error instanceof Error ? error.message : 'Unknown desktop error';
			});
	});
</script>

<h1>Web</h1>
<CounterView />
<p>Visit <a href="https://kit.svelte.dev">kit.svelte.dev</a> to read the documentation</p>
{#if nativeRuntimeInfo}
	<p>Native runtime: {nativeRuntimeInfo}</p>
{:else if nativeRuntimeError}
	<p>Native runtime unavailable: {nativeRuntimeError}</p>
{:else if hasDesktopBridge}
	<p>Loading native runtime information…</p>
{/if}
