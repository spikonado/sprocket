<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CalmCentered from '$lib/components/home/calm-centered.svelte';
	import {
		bootstrapLocalSession,
		clearLaunchHash,
		fetchLocalBootstrap,
		readPairingTokenFromHash,
		readWorkspaceLaunchFromHash,
		resolveLocalApiBaseUrl,
		workspaceLaunchHash
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
			const workspacePath = readWorkspaceLaunchFromHash();
			const destination: '/' | `/#${string}` = workspacePath
				? `/${workspaceLaunchHash(workspacePath)}`
				: '/';
			await bootstrapLocalSession(baseUrl, pairingToken.trim());
			clearLaunchHash();
			await goto(resolve(destination), {
				replaceState: true
			});
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
			<span class="text-muted-foreground text-sm">Pairing token</span>
			<input
				class="border-border bg-surface text-foreground placeholder:text-muted-foreground focus:border-ring w-full rounded-xl border px-4 py-3 text-sm outline-none"
				bind:value={pairingToken}
				placeholder="Paste token"
				autocomplete="off"
			/>
		</label>

		{#if error}
			<p class="text-destructive text-sm">{error}</p>
		{/if}

		<button
			class="bg-primary text-primary-foreground w-full rounded-full px-4 py-3 text-sm font-medium transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
			disabled={isSubmitting}
			type="submit"
		>
			{isSubmitting ? 'Connecting…' : 'Connect'}
		</button>
	</form>
</CalmCentered>
