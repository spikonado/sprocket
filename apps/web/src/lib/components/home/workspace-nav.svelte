<script lang="ts">
	import { X } from '@lucide/svelte';
	import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss.svelte';

	type Props = {
		drawer: boolean;
		open: boolean;
		onOpenChange: (open: boolean) => void;
		children: import('svelte').Snippet;
	};

	let { drawer, open, onOpenChange, children }: Props = $props();
	let panel = $state<HTMLElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (!drawer || !open) {
			return;
		}

		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeButton?.focus();
		const stop = listenOpenMenuDismiss({
			getRoot: () => panel,
			onOutside: () => {
				onOpenChange(false);
			},
			onEscape: () => {
				onOpenChange(false);
			}
		});
		return () => {
			stop();
			previous?.focus();
		};
	});
</script>

<div class={!drawer ? 'contents' : open ? 'fixed inset-0 z-50' : 'hidden'}>
	{#if drawer && open}
		<div class="absolute inset-0 bg-black/40" aria-hidden="true"></div>
	{/if}
	<div
		bind:this={panel}
		id="hosted-workspace-nav"
		class={drawer
			? 'bg-background absolute inset-y-0 left-0 flex h-full w-[min(292px,100vw)] flex-col shadow-lg'
			: 'contents'}
		role={drawer && open ? 'dialog' : undefined}
		aria-modal={drawer && open ? 'true' : undefined}
		aria-label={drawer && open ? 'Workspace navigation' : undefined}
	>
		{#if drawer && open}
			<div class="flex justify-end px-2 pt-2">
				<button
					bind:this={closeButton}
					type="button"
					class="text-muted-foreground hover:text-foreground hover:bg-hover-fill inline-flex size-11 items-center justify-center rounded-md transition"
					aria-label="Close navigation"
					onclick={() => {
						onOpenChange(false);
					}}
				>
					<X class="size-4" aria-hidden="true" />
				</button>
			</div>
		{/if}
		<div class={drawer ? 'min-h-0 flex-1 overflow-hidden [&>aside]:h-full' : 'contents'}>
			{@render children()}
		</div>
	</div>
</div>
