<script lang="ts">
	import { captureException, track } from '@/lib/analytics/client';
	import { cn } from '@/utils';

	interface Props {
		command: string;
		class?: string;
	}

	let { command, class: className = '' }: Props = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyCommand(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
		const button = event.currentTarget;

		try {
			await navigator.clipboard.writeText(command);
			copied = true;
			track('install_command_copied', { command }, button);

			if (copyTimer) {
				clearTimeout(copyTimer);
			}

			copyTimer = setTimeout(() => {
				copied = false;
			}, 1800);
		} catch (error) {
			copied = false;
			captureException(error, 'install_command_copy');
		}
	}
</script>

<div
	class={cn(
		'border-border bg-background text-foreground flex min-w-0 items-center gap-2 rounded-xl border px-3 py-3 font-mono text-sm sm:text-[0.95rem]',
		className
	)}
>
	<span
		class="scrollbar-thumb-border min-w-0 flex-1 scrollbar-thin scrollbar-track-transparent overflow-x-auto whitespace-nowrap"
	>
		{command}
	</span>
	<button
		type="button"
		class="border-border bg-surface text-foreground hover:bg-accent-soft focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-lg border p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
		onclick={copyCommand}
		aria-label={copied ? 'Copied' : 'Copy command'}
	>
		{#if copied}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-4 w-4"
				aria-hidden="true"
			>
				<path d="M20 6 9 17l-5-5" />
			</svg>
		{:else}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-4 w-4"
				aria-hidden="true"
			>
				<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
				<path d="M4 16V4a2 2 0 0 1 2-2h12" />
			</svg>
		{/if}
	</button>
</div>
