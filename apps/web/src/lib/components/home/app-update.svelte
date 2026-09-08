<script lang="ts">
	import { onMount } from 'svelte';
	import { Download, LoaderCircle, RefreshCw } from '@lucide/svelte';
	import { requestPackageUpdate, updateLabel, type UpdateState } from '$lib/updates';

	let updateState = $state<UpdateState | null>(null);
	let requestError = $state<string | null>(null);
	let busy = $state(false);
	let confirmInstall = $state(false);
	let revision = 0;
	const label = $derived(updateState ? updateLabel(updateState) : null);
	const working = $derived(
		busy || updateState?.status === 'downloading' || updateState?.status === 'installing'
	);

	function acceptUpdate(next: UpdateState | null) {
		updateState = next;
		if (next && ['downloading', 'downloaded', 'installing', 'installed'].includes(next.status)) {
			requestError = null;
		}
	}

	onMount(() => {
		let disposed = false;
		let polling = false;
		let unsupported = false;
		const bridge = window.sprocketDesktopBridge;
		const updates = bridge?.updates;
		const unsubscribe = updates?.onState((next) => {
			revision += 1;
			acceptUpdate(next);
		});
		async function refresh() {
			if (polling || disposed || busy || unsupported || (bridge && !updates)) return;
			polling = true;
			const startedRevision = revision;
			try {
				const next = updates ? await updates.getState() : await requestPackageUpdate(false);
				if (!disposed && revision === startedRevision) {
					acceptUpdate(next);
					unsupported = next === null || next.status === 'unavailable';
				}
			} catch {
				// Background checks must not interrupt work when the server or registry is offline.
			} finally {
				polling = false;
			}
		}
		void refresh();
		const timer = setInterval(() => void refresh(), 5_000);
		return () => {
			disposed = true;
			clearInterval(timer);
			unsubscribe?.();
		};
	});

	async function update() {
		if (!updateState || working) return;
		if (updateState.method === 'package' && !confirmInstall) {
			confirmInstall = true;
			return;
		}
		confirmInstall = false;
		const startedRevision = ++revision;
		busy = true;
		requestError = null;
		try {
			const updates = window.sprocketDesktopBridge?.updates;
			if (updateState.method === 'desktop' && updates) {
				const next = await (updateState.status === 'downloaded'
					? updates.install()
					: updates.download());
				if (revision === startedRevision) acceptUpdate(next);
			} else if (updateState.method === 'package') {
				acceptUpdate(await requestPackageUpdate(true));
			}
		} catch (error) {
			requestError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}
</script>

{#if label && updateState}
	<div class="mb-1" aria-live="polite">
		<button
			type="button"
			class="text-foreground hover:bg-hover-fill flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium tracking-[-0.02em] transition disabled:cursor-default disabled:opacity-70"
			disabled={working || updateState.status === 'installed'}
			onclick={() => void update()}
			title={updateState.version ? `Sprocket ${updateState.version}` : undefined}
			aria-busy={working}
		>
			{#if working}
				<LoaderCircle class="size-4 shrink-0 animate-spin" aria-hidden="true" />
			{:else if updateState.status === 'downloaded'}
				<RefreshCw class="size-4 shrink-0" aria-hidden="true" />
			{:else}
				<Download class="size-4 shrink-0" aria-hidden="true" />
			{/if}
			<span>{label}</span>
		</button>
		{#if confirmInstall}
			<div class="text-muted-foreground px-2 pb-2 text-xs">
				<p>
					Install {updateState.version} using your package manager? Restart Sprocket from your terminal
					afterward to use the new version.
				</p>
				<p class="mt-1">
					On Windows, a locked executable may require stopping Sprocket and running
					<code>sprocket update</code> instead.
				</p>
				<div class="mt-2 flex gap-3">
					<button type="button" class="text-foreground underline" onclick={() => void update()}
						>Install update</button
					>
					<button type="button" class="underline" onclick={() => (confirmInstall = false)}
						>Cancel</button
					>
				</div>
			</div>
		{/if}
		{#if updateState.status === 'installed'}
			<p class="text-muted-foreground px-2 pb-2 text-xs">
				Wait for active agents to finish, then stop Sprocket in your terminal and launch it again.
			</p>
		{/if}
		{#if requestError || updateState.error}
			<p class="text-destructive px-2 pb-2 text-xs break-words" role="alert">
				{requestError || updateState.error}
			</p>
		{/if}
	</div>
{/if}
