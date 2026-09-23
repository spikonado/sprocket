<script lang="ts">
	import { Moon, PanelLeft, Sun } from '@lucide/svelte';
	import type { SprocketTheme } from '$lib/theme';

	type Props = {
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
		onClose: () => void;
	};

	let { theme, onThemeChange, onClose }: Props = $props();

	const buttonClass =
		'text-muted-foreground hover:text-foreground hover:bg-hover-fill inline-flex size-7 shrink-0 items-center justify-center rounded-md transition';
</script>

<button
	type="button"
	class={buttonClass}
	aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
	onclick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
>
	{#if theme === 'dark'}
		<Sun class="size-3.5" aria-hidden="true" />
	{:else}
		<Moon class="size-3.5" aria-hidden="true" />
	{/if}
</button>
<button
	type="button"
	class={buttonClass}
	aria-label="Close sidebar"
	title="Close sidebar"
	onclick={onClose}
>
	<PanelLeft class="size-3.5" aria-hidden="true" />
</button>
