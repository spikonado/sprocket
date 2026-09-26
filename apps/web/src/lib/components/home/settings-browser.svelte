<script lang="ts">
	import Button from '$lib/components/ui/button/button.svelte';

	// No browser backend is wired up yet; the local browser implementation will
	// own cookie and profile persistence. These stubs keep the settings UI in
	// place until then.
	let savingEnabled = $state(true);
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Agent's Browser</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-8">
			<p class="text-muted-foreground text-sm leading-6">
				Browser sessions run locally and these settings are not available yet.
			</p>

			<div class="flex items-center justify-between gap-4">
				<p class="text-foreground text-[15px]">Save cookies and login state</p>
				<button
					type="button"
					role="switch"
					aria-checked={savingEnabled}
					aria-label="Save cookies and login state"
					disabled
					class="focus-visible:ring-ring/50 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 {savingEnabled
						? 'bg-foreground'
						: 'bg-hover-fill-strong'}"
				>
					<span
						class="bg-background inline-block size-3.5 rounded-full transition {savingEnabled
							? 'translate-x-[18px]'
							: 'translate-x-[3px]'}"
						aria-hidden="true"
					></span>
				</button>
			</div>

			<div>
				<Button variant="outline" disabled>Reset browser profile</Button>
			</div>
		</div>
	</div>
</section>
