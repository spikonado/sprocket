<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import type { SprocketTheme } from '$lib/theme';

	type Props = {
		theme: SprocketTheme;
		onThemeChange: (theme: SprocketTheme) => void;
	};

	let { theme, onThemeChange }: Props = $props();
</script>

<button
	type="button"
	class="text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition hover:bg-[var(--hover-fill)]"
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
