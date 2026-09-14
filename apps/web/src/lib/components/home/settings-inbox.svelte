<script lang="ts">
	import { useMutation } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	let { online, days }: { online: boolean; days: number | null } = $props();
	const update = useMutation(api.inbox.setAutoSettle);
	let saving = $state(false);
	let error = $state<string | null>(null);
	async function save(value: number | null) {
		saving = true;
		error = null;
		try {
			await update({ days: value });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save settings.';
		} finally {
			saving = false;
		}
	}
</script>

<section class="mx-auto w-full max-w-2xl px-8 py-16">
	<h1 class="text-2xl font-medium">Thread inbox</h1>
	<h2 class="mt-10 text-base font-medium">Automatic settling</h2>
	<p class="text-muted-foreground mt-2 text-sm">
		Move inactive threads into Settled. Pinned threads, running agents, snoozed threads, and
		unanswered questions stay where they are.
	</p>
	<label class="mt-6 flex items-center gap-3"
		><input
			type="checkbox"
			checked={days !== null}
			disabled={!online || saving}
			onchange={(event) => void save(event.currentTarget.checked ? 7 : null)}
		/>Automatically settle inactive threads</label
	>
	{#if days !== null}<label class="mt-4 flex items-center gap-3"
			>After <input
				class="w-20 rounded-md border border-[var(--hairline)] px-3 py-2"
				type="number"
				min="1"
				max="365"
				value={days}
				disabled={!online || saving}
				onchange={(event) => void save(event.currentTarget.valueAsNumber)}
			/> days</label
		>{/if}
	<p class="text-muted-foreground mt-4 text-xs">
		This setting applies across your devices. Unsettling a thread updates its activity time.
	</p>
	{#if !online}<p class="mt-4 text-sm">Reconnect to change this setting.</p>{/if}
	{#if error}<p class="text-destructive mt-4 text-sm" role="alert">{error}</p>{/if}
</section>
