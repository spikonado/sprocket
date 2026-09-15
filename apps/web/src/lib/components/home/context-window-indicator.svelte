<script lang="ts">
	type Props = {
		inputTokens: number;
		totalTokensProcessed: number;
		contextWindowTokens: number;
		autoHandoffTokenLimit: number;
	};

	let { inputTokens, totalTokensProcessed, contextWindowTokens, autoHandoffTokenLimit }: Props =
		$props();

	const contextPercent = $derived(
		contextWindowTokens > 0
			? Math.min(100, Math.round((inputTokens / contextWindowTokens) * 100))
			: 0
	);
	const handoffPercent = $derived(
		contextWindowTokens > 0 ? Math.round((autoHandoffTokenLimit / contextWindowTokens) * 100) : 0
	);

	function formatTokens(value: number): string {
		if (value >= 1_000_000) {
			return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
		}
		if (value >= 1_000) {
			return `${Math.round(value / 1_000)}k`;
		}
		return String(value);
	}
</script>

<div class="group/context relative">
	<button
		type="button"
		class="focus-visible:ring-ring/60 relative flex size-8 cursor-help items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
		aria-label={`Context window ${contextPercent}% full`}
		aria-describedby="context-window-details"
		style={`background: conic-gradient(var(--accent) ${contextPercent * 3.6}deg, var(--hover-fill-strong) 0deg);`}
		onkeydown={(event) => {
			if (event.key === 'Escape') event.currentTarget.blur();
		}}
	>
		<span class="bg-muted size-5.5 rounded-full"></span>
	</button>
	<div
		id="context-window-details"
		class="border-border bg-popover invisible absolute right-0 bottom-full z-50 mb-3 w-76 translate-y-1 rounded-xl border p-4 opacity-0 shadow-(--composer-shadow) transition duration-150 group-focus-within/context:visible group-focus-within/context:translate-y-0 group-focus-within/context:opacity-100 group-hover/context:visible group-hover/context:translate-y-0 group-hover/context:opacity-100"
		role="tooltip"
	>
		<div class="flex items-center justify-between gap-4 text-[13px]">
			<span class="text-foreground font-medium">Context window</span>
			<span class="text-muted-foreground"
				>{contextPercent}% · {formatTokens(inputTokens)}/{formatTokens(contextWindowTokens)}</span
			>
		</div>
		<div class="bg-hover-fill mt-3 h-1.5 overflow-hidden rounded-full">
			<div
				class="bg-accent h-full rounded-full transition-[width] duration-300"
				style={`width: ${contextPercent}%`}
			></div>
		</div>
		<div class="text-muted-foreground mt-3 flex items-center justify-between text-[12px]">
			<span>Total processed</span>
			<span>{formatTokens(totalTokensProcessed)}</span>
		</div>
		<p class="text-muted-foreground mt-4 text-[12px] leading-5">
			At about {handoffPercent}% of the context window, Sprocket writes a handoff document and
			continues the work in a fresh context.
		</p>
	</div>
</div>
