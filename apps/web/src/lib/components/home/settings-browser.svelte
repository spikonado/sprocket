<script lang="ts">
	import { useAuth, useMutation, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import Button from '$lib/components/ui/button/button.svelte';
	import { convexClientErrorMessage } from '$lib/convex-error';
	let { online = true }: { online?: boolean } = $props();

	const convexAuth = useAuth();
	const profileQuery = useQuery(api.browserProfiles.getMine, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);
	const setSaving = useMutation(api.browserProfiles.setSaving);
	const resetProfile = useMutation(api.browserProfiles.reset);

	let pending = $state(false);
	let confirmReset = $state(false);
	let actionError = $state<string | null>(null);

	const loaded = $derived(profileQuery.data !== undefined);
	const savingEnabled = $derived(profileQuery.data?.savingEnabled ?? true);
	const controlsDisabled = $derived(!online || !loaded || pending);

	function catchMessage<T>(error: T, fallback: string): string {
		return (error instanceof Error && convexClientErrorMessage(error)) || fallback;
	}

	async function toggleSaving() {
		if (controlsDisabled) return;
		pending = true;
		actionError = null;
		try {
			await setSaving({ enabled: !savingEnabled });
		} catch (error) {
			actionError = catchMessage(error, 'Couldn’t update browser saving.');
		} finally {
			pending = false;
		}
	}

	async function runReset() {
		if (controlsDisabled) return;
		pending = true;
		actionError = null;
		try {
			await resetProfile({});
			confirmReset = false;
		} catch (error) {
			actionError = catchMessage(error, 'Couldn’t reset browser profile.');
		} finally {
			pending = false;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Agent's Browser</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		{#if !online}<p class="text-muted-foreground mb-6 text-sm">
				Reconnect to change browser settings.
			</p>{/if}
		<div class="max-w-xl space-y-8">
			<div class="flex items-center justify-between gap-4">
				<p class="text-foreground text-[15px]">Save cookies and login state</p>
				<button
					type="button"
					role="switch"
					aria-checked={savingEnabled}
					aria-busy={!loaded || pending}
					aria-label="Save cookies and login state"
					disabled={controlsDisabled}
					class="focus-visible:ring-ring/50 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 {savingEnabled
						? 'bg-foreground'
						: 'bg-hover-fill-strong'}"
					onclick={() => void toggleSaving()}
				>
					<span
						class="bg-background inline-block size-3.5 rounded-full transition {savingEnabled
							? 'translate-x-[18px]'
							: 'translate-x-[3px]'}"
						aria-hidden="true"
					></span>
				</button>
			</div>

			{#if profileQuery.error}
				<p class="text-destructive text-sm" role="alert">
					Couldn't load your browser settings right now.
				</p>
			{/if}
			{#if actionError}
				<p class="text-destructive text-sm" role="alert">{actionError}</p>
			{/if}

			<div>
				{#if confirmReset}
					<p class="text-muted-foreground text-sm leading-6">
						This reset closes your current browser sessions, signs future sessions out, and starts
						fresh.
					</p>
					<div class="mt-4 flex flex-wrap items-center gap-3">
						<Button onclick={() => void runReset()} disabled={controlsDisabled}>
							{pending ? 'Resetting…' : 'Confirm reset'}
						</Button>
						<Button
							variant="outline"
							disabled={pending}
							onclick={() => {
								confirmReset = false;
							}}
						>
							Cancel
						</Button>
					</div>
				{:else}
					<Button
						variant="outline"
						disabled={controlsDisabled}
						onclick={() => {
							confirmReset = true;
							actionError = null;
						}}
					>
						Reset browser profile
					</Button>
				{/if}
			</div>
		</div>
	</div>
</section>
