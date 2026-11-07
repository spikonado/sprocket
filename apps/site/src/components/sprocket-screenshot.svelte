<script lang="ts">
	import screenshot from '@/assets/sprocket.webp';
	import { track } from '@/lib/analytics/client';
	import { lockOverlay, portal } from '@/lib/focus-trap';

	const alt =
		'Sprocket running parallel agent threads, showing AI cost per reply, designing a PCB in KiCad, asking questions before it guesses, keeping commands running, and connecting a ChatGPT subscription or API key';

	let open = $state(false);

	function openLightbox(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
		open = true;
		track('product_media_opened', { media: 'sprocket_screenshot' }, event.currentTarget);
	}

	function closeLightbox() {
		open = false;
	}
</script>

<button
	type="button"
	class="block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
	aria-label="View Sprocket screenshot full size"
	onclick={openLightbox}
>
	<img
		src={screenshot.src}
		width={screenshot.width}
		height={screenshot.height}
		{alt}
		class="h-auto w-full"
		loading="lazy"
		decoding="async"
	/>
</button>

{#if open}
	<div
		use:portal
		{@attach lockOverlay(closeLightbox)}
		class="fixed inset-0 z-100 flex items-center justify-center p-4 sm:p-8"
		role="dialog"
		aria-modal="true"
		aria-label="Sprocket screenshot"
		tabindex="-1"
	>
		<button
			type="button"
			class="bg-ink/90 absolute inset-0"
			aria-label="Close full size image"
			onclick={closeLightbox}
		></button>

		<button
			type="button"
			class="bg-ink/60 hover:bg-ink/80 absolute top-4 right-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-white transition-colors focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
			aria-label="Close full size image"
			onclick={closeLightbox}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				class="h-5 w-5"
				aria-hidden="true"
			>
				<path d="M6 6l12 12M18 6L6 18" />
			</svg>
		</button>

		<img
			src={screenshot.src}
			width={screenshot.width}
			height={screenshot.height}
			{alt}
			class="relative z-10 h-auto max-h-[min(92svh,100%)] w-auto max-w-full rounded-lg object-contain shadow-2xl"
		/>
	</div>
{/if}
