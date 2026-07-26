<script lang="ts">
	import { Check, Copy, ExternalLink, LoaderCircle } from '@lucide/svelte';
	import { tick } from 'svelte';
	import Button from '$lib/components/ui/button/button.svelte';

	type Props = {
		open: boolean;
		signInUrl: string | null;
		error?: string | null;
		onCancel: () => void;
		onClearOpenError?: () => void;
	};

	let { open, signInUrl, error = null, onCancel, onClearOpenError }: Props = $props();

	let copied = $state(false);
	let copyError = $state<string | null>(null);
	let dialogEl = $state<HTMLDivElement | null>(null);
	let copiedTimeout: number | null = null;

	$effect(() => {
		if (!open) {
			copied = false;
			copyError = null;
			return;
		}

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		let disposed = false;
		void tick().then(() => {
			if (!disposed) {
				dialogEl?.focus();
			}
		});

		function handleWindowKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				onCancel();
				return;
			}

			if (event.key !== 'Tab' || !dialogEl) {
				return;
			}

			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);

			if (focusable.length === 0) {
				event.preventDefault();
				dialogEl.focus();
				return;
			}

			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (
				event.shiftKey &&
				(active === dialogEl || active === first || !dialogEl.contains(active))
			) {
				event.preventDefault();
				last.focus();
			} else if (
				!event.shiftKey &&
				(active === dialogEl || active === last || !dialogEl.contains(active))
			) {
				event.preventDefault();
				first.focus();
			}
		}

		window.addEventListener('keydown', handleWindowKeydown, true);
		return () => {
			disposed = true;
			window.removeEventListener('keydown', handleWindowKeydown, true);
			if (copiedTimeout !== null) {
				window.clearTimeout(copiedTimeout);
				copiedTimeout = null;
			}
			if (previouslyFocused?.isConnected) {
				previouslyFocused.focus();
			}
		};
	});

	async function copySignInUrl() {
		if (!signInUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signInUrl);
			copied = true;
			copyError = null;
			if (copiedTimeout !== null) {
				window.clearTimeout(copiedTimeout);
			}
			copiedTimeout = window.setTimeout(() => {
				copied = false;
				copiedTimeout = null;
			}, 2_000);
		} catch {
			copied = false;
			copyError = 'Could not copy the sign-in link. Select it above and copy manually.';
		}
	}

	function openSignInUrl() {
		if (!signInUrl) {
			return;
		}

		// Don't pass noopener in features — browsers then return null even on success.
		const opened = window.open(signInUrl, '_blank');
		if (!opened) {
			return;
		}
		try {
			opened.opener = null;
		} catch {
			// Best-effort isolation if the browser rejects opener writes.
		}
		onClearOpenError?.();
	}

	const overlayCopy = $derived(
		!signInUrl
			? {
					title: 'Preparing sign-in',
					description: 'Preparing a secure sign-in link. This usually takes a moment.'
				}
			: error
				? {
						title: 'Open the sign-in link',
						description: 'Your browser didn’t open automatically. Continue with the options below.'
					}
				: {
						title: 'Finish signing in',
						description:
							'We opened your browser to complete sign-in. Waiting for you to finish there.'
					}
	);
</script>

{#if open}
	<div
		class="app-entry-shell fixed inset-0 z-50 flex items-center justify-center px-6"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onCancel();
			}
		}}
	>
		<div
			bind:this={dialogEl}
			class="border-border/70 bg-surface relative z-10 w-full max-w-md rounded-2xl border p-8 text-center shadow-[0_18px_50px_-28px_oklch(0.2_0.02_260/0.45)] outline-none"
			role="dialog"
			aria-modal="true"
			aria-labelledby="browser-signin-title"
			aria-describedby="browser-signin-desc"
			tabindex="-1"
		>
			{#if !signInUrl}
				<div class="text-muted-foreground mb-4 flex justify-center" aria-hidden="true">
					<LoaderCircle class="size-5 animate-spin" />
				</div>
			{/if}

			<h2
				id="browser-signin-title"
				class="font-brand text-foreground text-[1.35rem] font-semibold tracking-tight"
			>
				{overlayCopy.title}
			</h2>
			<p id="browser-signin-desc" class="text-muted-foreground mt-3 text-sm leading-[1.55]">
				{overlayCopy.description}
			</p>

			{#if signInUrl}
				<p
					class="text-muted-foreground mt-6 max-h-24 overflow-y-auto font-mono text-[11px] leading-5 break-all select-all"
					title={signInUrl}
				>
					{signInUrl}
				</p>
			{/if}

			{#if error}
				<p class="text-destructive mt-4 text-sm" role="alert">{error}</p>
			{/if}
			{#if copyError}
				<p class="mt-4 text-sm text-amber-700" role="alert">{copyError}</p>
			{/if}

			<div class="mt-6 flex flex-wrap items-center justify-center gap-3">
				{#if signInUrl}
					<Button onclick={openSignInUrl}>
						<ExternalLink class="size-4" aria-hidden="true" />
						Open browser
					</Button>
					<Button variant="outline" onclick={() => void copySignInUrl()}>
						{#if copied}
							<Check class="size-4" aria-hidden="true" />
							Copied
						{:else}
							<Copy class="size-4" aria-hidden="true" />
							Copy link
						{/if}
					</Button>
				{:else}
					<span
						class="text-muted-foreground border-border inline-flex h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm"
					>
						Preparing link…
					</span>
				{/if}
			</div>

			<div class="mt-6">
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground decoration-foreground/30 hover:decoration-foreground text-[13px] underline underline-offset-4 transition-colors"
					onclick={onCancel}
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
