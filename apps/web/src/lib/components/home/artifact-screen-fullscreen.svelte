<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import ChatMarkdown from '$lib/components/chat-markdown.svelte';
	import type { ArtifactEntry } from '$lib/chat/artifacts';
	import { buildArtifactPreviewDocument } from '$lib/chat/artifact-preview';

	type Props = {
		artifact: ArtifactEntry;
		onClose: () => void;
	};

	let { artifact, onClose }: Props = $props();

	const previewDocument = $derived(
		buildArtifactPreviewDocument(artifact.artifactType, artifact.content)
	);

	let rootEl: HTMLDivElement | null = $state(null);
	/** Shown only when the Fullscreen API is unavailable or rejects (iframe Escape cannot reach us). */
	let showFallbackClose = $state(false);

	onMount(() => {
		const el = rootEl;
		if (!el) return;

		let active = true;
		// Click handler requests FS on documentElement before this mounts; treat any
		// current fullscreen session as ours so we don't re-request (and bounce) later.
		let wasFullscreen = Boolean(document.fullscreenElement);
		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const close = () => {
			if (!active) return;
			active = false;
			untrack(() => {
				onClose();
			});
		};

		const onFullscreenChange = () => {
			if (document.fullscreenElement) {
				wasFullscreen = true;
				untrack(() => {
					showFallbackClose = false;
				});
				return;
			}
			if (wasFullscreen) {
				close();
			}
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Claim Escape so an expanded workspace panel underneath does not also collapse.
			event.stopImmediatePropagation();
			// Browser fullscreen already exits on Escape; fullscreenchange handles close.
			if (document.fullscreenElement || wasFullscreen) return;
			event.preventDefault();
			close();
		};

		document.addEventListener('fullscreenchange', onFullscreenChange);
		window.addEventListener('keydown', onKeyDown, true);

		void tick().then(() => {
			if (active) el.focus();
		});

		// Parent requests fullscreen in the user-gesture click handler. If that
		// failed or was skipped, expose a dismiss control; do not re-request here
		// (Firefox will deny it outside the gesture and can bounce the session).
		const fallbackTimer = window.setTimeout(() => {
			if (!active || document.fullscreenElement) return;
			untrack(() => {
				showFallbackClose = true;
			});
		}, 250);

		return () => {
			active = false;
			window.clearTimeout(fallbackTimer);
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			window.removeEventListener('keydown', onKeyDown, true);
			if (document.fullscreenElement) {
				void document.exitFullscreen?.().catch(() => {});
			}
			const focusTarget = previouslyFocused;
			void tick().then(() => {
				if (focusTarget?.isConnected) focusTarget.focus();
			});
		};
	});
</script>

<div
	bind:this={rootEl}
	data-artifact-screen-fullscreen=""
	class="bg-background fixed inset-0 z-200 flex h-screen w-screen flex-col outline-none"
	role="dialog"
	aria-modal="true"
	aria-label={`${artifact.title} fullscreen. Press Escape to exit.`}
	tabindex="-1"
>
	{#if previewDocument}
		<iframe
			title={`${artifact.title} preview`}
			srcdoc={previewDocument}
			sandbox="allow-scripts"
			class="block h-full w-full flex-1 bg-white"
		></iframe>
	{:else}
		<div class="min-h-0 flex-1 overflow-auto p-6">
			<ChatMarkdown content={artifact.content} className="text-sm text-foreground" />
		</div>
	{/if}
	{#if showFallbackClose}
		<button
			type="button"
			class="bg-background/90 text-muted-foreground hover:text-foreground absolute top-3 right-3 z-10 rounded-md border p-2 transition"
			onclick={() => onClose()}
			aria-label="Exit fullscreen"
		>
			<X class="size-4" aria-hidden="true" />
		</button>
	{/if}
</div>
