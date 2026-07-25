<script module lang="ts">
	export type ViewerImage = {
		url: string;
		name: string;
		mediaType: string;
	};
</script>

<script lang="ts">
	import { Check, Copy, Download, LoaderCircle } from '@lucide/svelte';
	import { tick } from 'svelte';

	type Props = {
		image: ViewerImage | null;
		onClose: () => void;
	};

	let { image, onClose }: Props = $props();

	let dialogEl = $state<HTMLDivElement | null>(null);
	let copied = $state(false);
	let copying = $state(false);
	let downloading = $state(false);
	let copyError = $state<string | null>(null);
	let downloadError = $state<string | null>(null);
	let copiedTimeout: number | null = null;
	let viewerGeneration = 0;

	const extensionByMediaType: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/gif': 'gif',
		'image/webp': 'webp'
	};

	function downloadFilename(current: ViewerImage) {
		const name = current.name.trim() || 'image';
		const extension = extensionByMediaType[current.mediaType];
		if (!extension) {
			return name;
		}
		const existingExtension = name.match(/\.([a-z0-9]{2,5})$/i);
		if (!existingExtension) {
			return `${name}.${extension}`;
		}
		const validExtensions = current.mediaType === 'image/jpeg' ? ['jpg', 'jpeg'] : [extension];
		return validExtensions.includes(existingExtension[1].toLowerCase())
			? name
			: `${name.slice(0, -existingExtension[0].length)}.${extension}`;
	}

	$effect(() => {
		viewerGeneration += 1;
		if (!image) {
			return;
		}
		copied = false;
		copying = false;
		downloading = false;
		copyError = null;
		downloadError = null;

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		let disposed = false;
		void tick().then(() => {
			if (!disposed) {
				dialogEl?.focus();
			}
		});

		const previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		function handleWindowKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				onClose();
				return;
			}

			if (event.key !== 'Tab' || !dialogEl) {
				return;
			}

			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter((element) => !element.hasAttribute('hidden'));

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
			document.body.style.overflow = previousBodyOverflow;
			if (copiedTimeout !== null) {
				window.clearTimeout(copiedTimeout);
				copiedTimeout = null;
			}
			if (previouslyFocused?.isConnected) {
				previouslyFocused.focus();
			}
		};
	});

	async function fetchImageBlob(current: ViewerImage) {
		const response = await fetch(current.url);
		if (!response.ok) {
			throw new Error(`Fetch failed with status ${response.status}`);
		}
		return response.blob();
	}

	/** Clipboard image writes are PNG-only in most browsers, so re-encode when needed. */
	async function toPngBlob(blob: Blob) {
		if (blob.type === 'image/png') {
			return blob;
		}
		const bitmap = await createImageBitmap(blob);
		try {
			const canvas = document.createElement('canvas');
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('Canvas 2D context unavailable');
			}
			context.drawImage(bitmap, 0, 0);
			return await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(
					(png) => (png ? resolve(png) : reject(new Error('PNG encoding failed'))),
					'image/png'
				);
			});
		} finally {
			bitmap.close();
		}
	}

	async function copyImage(current: ViewerImage) {
		if (copying) {
			return;
		}
		const generation = viewerGeneration;
		copying = true;
		copyError = null;
		downloadError = null;
		try {
			if (typeof ClipboardItem === 'undefined') {
				throw new Error('Clipboard images unsupported');
			}
			const png = fetchImageBlob(current).then(toPngBlob);
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
			if (generation !== viewerGeneration) {
				return;
			}
			copied = true;
			if (copiedTimeout !== null) {
				window.clearTimeout(copiedTimeout);
			}
			copiedTimeout = window.setTimeout(() => {
				copied = false;
				copiedTimeout = null;
			}, 2_000);
		} catch {
			if (generation === viewerGeneration) {
				copied = false;
				copyError = 'Could not copy the image to the clipboard.';
			}
		} finally {
			if (generation === viewerGeneration) {
				copying = false;
			}
		}
	}

	async function downloadImage(current: ViewerImage) {
		if (downloading) {
			return;
		}
		const generation = viewerGeneration;
		downloading = true;
		copyError = null;
		downloadError = null;
		try {
			const blob = await fetchImageBlob(current);
			if (generation !== viewerGeneration) {
				return;
			}
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = objectUrl;
			anchor.download = downloadFilename(current);
			document.body.append(anchor);
			try {
				anchor.click();
			} finally {
				anchor.remove();
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
			}
		} catch {
			if (generation === viewerGeneration) {
				downloadError = 'Could not download the image.';
			}
		} finally {
			if (generation === viewerGeneration) {
				downloading = false;
			}
		}
	}

	const actionButtonClass =
		'inline-flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/65 text-white shadow-lg backdrop-blur-sm transition hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none aria-disabled:cursor-wait aria-disabled:opacity-60';
</script>

{#if image}
	{@const current = image}
	<div
		class="bg-background/92 fixed inset-0 z-50 flex items-center justify-center px-3 py-4 sm:px-6 sm:py-12"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) {
				onClose();
			}
		}}
	>
		<div
			bind:this={dialogEl}
			class="relative inline-flex max-h-full max-w-full outline-none"
			role="dialog"
			aria-modal="true"
			aria-label="Image preview: {current.name}"
			tabindex="-1"
		>
			<img
				src={current.url}
				alt={current.name}
				class="border-border block max-h-[calc(100dvh-2rem)] max-w-full rounded-2xl border object-contain sm:max-h-[calc(100dvh-6rem)]"
			/>

			<div class="absolute right-3 bottom-3 flex items-center gap-2">
				<button
					type="button"
					class={actionButtonClass}
					aria-disabled={copying}
					aria-label={copying ? 'Copying image' : copied ? 'Image copied' : 'Copy image'}
					title={copying ? 'Copying image' : copied ? 'Image copied' : 'Copy image'}
					onclick={() => void copyImage(current)}
				>
					{#if copying}
						<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
					{:else if copied}
						<Check class="size-4" aria-hidden="true" />
					{:else}
						<Copy class="size-4" aria-hidden="true" />
					{/if}
				</button>
				<button
					type="button"
					class={actionButtonClass}
					aria-disabled={downloading}
					aria-label={downloading ? 'Downloading image' : 'Download image'}
					title={downloading ? 'Downloading image' : 'Download image'}
					onclick={() => void downloadImage(current)}
				>
					{#if downloading}
						<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
					{:else}
						<Download class="size-4" aria-hidden="true" />
					{/if}
				</button>
			</div>
			<span class="sr-only" aria-live="polite">
				{copying
					? 'Copying image'
					: copied
						? 'Image copied'
						: downloading
							? 'Downloading image'
							: ''}
			</span>

			{#if copyError || downloadError}
				<p
					class="border-border absolute right-3 bottom-14 max-w-[min(20rem,calc(100%-1.5rem))] rounded-lg border bg-black/80 px-3 py-2 text-xs text-amber-100 shadow-lg backdrop-blur-sm"
					role="alert"
				>
					{copyError ?? downloadError}
				</p>
			{/if}
		</div>
	</div>
{/if}
