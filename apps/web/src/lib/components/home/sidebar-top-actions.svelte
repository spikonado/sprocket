<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import type { SprocketTheme } from '$lib/theme';

	type Props = {
		theme: SprocketTheme;
		disabled?: boolean;
		onThemeChange: (theme: SprocketTheme) => void;
	};

	let { theme, onThemeChange, disabled = false }: Props = $props();
</script>

<button
	{disabled}
	type="button"
	class="text-muted-foreground hover:text-foreground hover:bg-hover-fill inline-flex size-7 shrink-0 items-center justify-center rounded-md transition"
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
