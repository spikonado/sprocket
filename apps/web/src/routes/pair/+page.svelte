<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';
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

<CalmCentered
	title="Connect to Sprocket"
	description="Enter the pairing token from your running Sprocket server."
>
	<form
		class="space-y-4"
		onsubmit={(event) => {
			event.preventDefault();
			void submitPairing();
		}}
	>
		<label class="block space-y-2">
			<span class="text-sm text-slate-400">Pairing token</span>
			<input
				class="w-full rounded-xl border border-white/10 bg-white/3 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-white/20"
				bind:value={pairingToken}
				placeholder="Paste token"
				autocomplete="off"
			/>
		</label>

		{#if error}
			<p class="text-sm text-rose-300">{error}</p>
		{/if}

		<button
			class="w-full rounded-xl bg-white px-4 py-3 text-sm font-medium text-black transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
			disabled={isSubmitting}
			type="submit"
		>
			{isSubmitting ? 'Connecting…' : 'Connect'}
		</button>
	</form>
</CalmCentered>
