<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		bootstrapLocalSession,
		clearPairingTokenFromHash,
		fetchLocalBootstrap,
		readPairingTokenFromHash,
		resolveLocalApiBaseUrl
	} from '$lib/local/client';

	let pairingToken = $state('');
	let error = $state<string | null>(null);
	let isSubmitting = $state(false);

	onMount(() => {
		void tryAutoPair();
	});

	async function tryAutoPair() {
		const baseUrl = resolveLocalApiBaseUrl();
		if (!baseUrl) {
			return;
		}

		const hashToken = readPairingTokenFromHash();
		if (hashToken) {
			pairingToken = hashToken;
			await submitPairing();
			return;
		}

		const bootstrap = await fetchLocalBootstrap(baseUrl);
		if (bootstrap?.pairingCredential) {
			pairingToken = bootstrap.pairingCredential;
			await submitPairing();
		}
	}

	async function submitPairing() {
		const baseUrl = resolveLocalApiBaseUrl();
		if (!baseUrl) {
			error = 'Unable to resolve the Sprocket server URL.';
			return;
		}

		if (!pairingToken.trim()) {
			error = 'Enter a pairing token to connect.';
			return;
		}

		isSubmitting = true;
		error = null;

		try {
			await bootstrapLocalSession(baseUrl, pairingToken.trim());
			clearPairingTokenFromHash();
			await goto(resolve('/'), { replaceState: true });
		} catch (submitError) {
			error =
				submitError instanceof Error
					? submitError.message
					: 'Failed to pair with the Sprocket server.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Pair with Sprocket</title>
</svelte:head>

<div
	class="flex h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(22,22,24,0.98),rgba(15,15,17,1))] px-6"
>
	<div
		class="w-full max-w-lg rounded-4xl border border-white/8 bg-[linear-gradient(180deg,rgba(33,33,36,0.96),rgba(24,24,27,0.98))] p-8 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
	>
		<h1 class="text-2xl font-medium tracking-tight text-white">Connect to Sprocket</h1>
		<p class="mt-3 text-sm leading-6 text-slate-300">
			Enter the pairing token from your running Sprocket server.
		</p>

		<form
			class="mt-6 space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void submitPairing();
			}}
		>
			<label class="block space-y-2">
				<span class="text-sm text-slate-300">Pairing token</span>
				<input
					class="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white ring-0 outline-none placeholder:text-slate-500 focus:border-white/20"
					bind:value={pairingToken}
					placeholder="Paste token"
					autocomplete="off"
				/>
			</label>

			{#if error}
				<p class="text-sm text-rose-300">{error}</p>
			{/if}

			<button
				class="w-full rounded-2xl bg-white px-4 py-3 text-sm font-medium text-black transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
				disabled={isSubmitting}
				type="submit"
			>
				{isSubmitting ? 'Connecting…' : 'Connect'}
			</button>
		</form>
	</div>
</div>
