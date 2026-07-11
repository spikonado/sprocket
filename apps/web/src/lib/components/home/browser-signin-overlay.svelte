<script lang="ts">
	import { Check, Copy, ExternalLink, LoaderCircle } from '@lucide/svelte';
	import { tick } from 'svelte';

	type Props = {
		open: boolean;
		signInUrl: string | null;
		error?: string | null;
		onCancel: () => void;
	};

	let { open, signInUrl, error = null, onCancel }: Props = $props();

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

		window.open(signInUrl, '_blank', 'noopener,noreferrer');
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-[2px]"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onCancel();
			}
		}}
	>
		<div
			bind:this={dialogEl}
			class="flex w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#1c1c1f] text-white shadow-2xl outline-none"
			role="dialog"
			aria-modal="true"
			aria-labelledby="browser-signin-title"
			tabindex="-1"
		>
			<div class="flex flex-col items-center gap-4 px-10 pt-10 pb-7 text-center">
				<span
					class="flex size-16 items-center justify-center rounded-full border border-sky-400/25 bg-sky-400/10 text-sky-200"
				>
					<LoaderCircle class="size-7 animate-spin" />
				</span>
				<div>
					<h2 id="browser-signin-title" class="text-xl font-semibold text-white">
						Finish signing in
					</h2>
					<p class="mt-2 text-sm leading-6 text-slate-400">
						We opened your browser to complete sign-in. Waiting for you to finish there.
					</p>
				</div>
			</div>

			<div class="px-10 pb-6">
				<p class="text-[11px] tracking-[0.16em] text-slate-500 uppercase">Sign-in link</p>
				<p
					class="mt-2 max-h-24 overflow-y-auto rounded-xl border border-white/8 bg-black/25 px-4 py-3 font-mono text-[11px] leading-5 break-all text-slate-400 select-all"
					title={signInUrl ?? undefined}
				>
					{signInUrl ?? 'Preparing secure sign-in link…'}
				</p>
				<p class="mt-3 text-[13px] leading-5 text-slate-500">
					If your browser did not open automatically, use the buttons below.
				</p>

				{#if error}
					<p
						class="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200"
					>
						{error}
					</p>
				{/if}
				{#if copyError}
					<p
						class="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-100"
					>
						{copyError}
					</p>
				{/if}
			</div>

			<div class="flex gap-3 px-10 pb-6">
				{#if signInUrl}
					<button
						type="button"
						class="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-sky-500/90 px-4 text-sm font-medium text-white transition hover:bg-sky-500"
						onclick={openSignInUrl}
					>
						<ExternalLink class="size-4" />
						Open browser
					</button>
				{:else}
					<span
						class="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-sky-500/40 px-4 text-sm font-medium text-white/50"
					>
						<LoaderCircle class="size-4 animate-spin" />
						Preparing link
					</span>
				{/if}
				<button
					type="button"
					class="flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-white/10 px-4 text-sm text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
					disabled={!signInUrl}
					onclick={() => void copySignInUrl()}
				>
					{#if copied}
						<Check class="size-4" />
						Copied
					{:else}
						<Copy class="size-4" />
						Copy link
					{/if}
				</button>
			</div>

			<footer class="flex justify-center border-t border-white/8 px-10 py-4">
				<button
					type="button"
					class="text-[13px] text-slate-400 transition hover:text-slate-200"
					onclick={onCancel}
				>
					Cancel
				</button>
			</footer>
		</div>
	</div>
{/if}
