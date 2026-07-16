<script lang="ts">
	import { Check, Copy, ExternalLink, LoaderCircle } from '@lucide/svelte';
	import { tick } from 'svelte';

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
		class="fixed inset-0 z-50 flex items-center justify-center bg-[#0f1218]/92 px-6"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onCancel();
			}
		}}
	>
		<div
			bind:this={dialogEl}
			class="w-full max-w-md text-center outline-none"
			role="dialog"
			aria-modal="true"
			aria-labelledby="browser-signin-title"
			aria-describedby="browser-signin-desc"
			tabindex="-1"
		>
			{#if !signInUrl}
				<div class="mb-4 flex justify-center text-slate-400" aria-hidden="true">
					<LoaderCircle class="size-5 animate-spin" />
				</div>
			{/if}

			<h2
				id="browser-signin-title"
				class="text-[1.35rem] font-medium tracking-tight text-slate-200"
			>
				{overlayCopy.title}
			</h2>
			<p id="browser-signin-desc" class="mt-3 text-sm leading-[1.55] text-slate-400">
				{overlayCopy.description}
			</p>

			{#if signInUrl}
				<p
					class="mt-6 max-h-24 overflow-y-auto font-mono text-[11px] leading-5 break-all text-slate-500 select-all"
					title={signInUrl}
				>
					{signInUrl}
				</p>
			{/if}

			{#if error}
				<p class="mt-4 text-sm text-rose-300" role="alert">{error}</p>
			{/if}
			{#if copyError}
				<p class="mt-4 text-sm text-amber-200" role="alert">{copyError}</p>
			{/if}

			<div class="mt-6 flex flex-wrap items-center justify-center gap-3">
				{#if signInUrl}
					<button
						type="button"
						class="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-medium text-black transition hover:bg-slate-100"
						onclick={openSignInUrl}
					>
						<ExternalLink class="size-4" aria-hidden="true" />
						Open browser
					</button>
					<button
						type="button"
						class="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/12 px-4 text-sm text-slate-200 transition hover:bg-white/5"
						onclick={() => void copySignInUrl()}
					>
						{#if copied}
							<Check class="size-4" aria-hidden="true" />
							Copied
						{:else}
							<Copy class="size-4" aria-hidden="true" />
							Copy link
						{/if}
					</button>
				{:else}
					<span
						class="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/8 px-4 text-sm text-slate-500"
					>
						Preparing link…
					</span>
				{/if}
			</div>

			<div class="mt-6">
				<button
					type="button"
					class="text-[13px] text-slate-500 transition hover:text-slate-300"
					onclick={onCancel}
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
