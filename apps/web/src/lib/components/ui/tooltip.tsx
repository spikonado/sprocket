import type { LockTooltipState } from '$lib/components/ui/lock-tooltip';

export default function Tooltip({ tooltip }: { tooltip: LockTooltipState | null }) {
	if (!tooltip) return null;

	return (
		<div
			className="text-tooltip-foreground bg-tooltip ring-border pointer-events-none fixed z-100 -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-1.5 text-[12px] leading-4 whitespace-nowrap shadow-lg ring-1"
			style={{ top: tooltip.top, left: tooltip.left }}
			role="tooltip"
		>
			{tooltip.label}
		</div>
	);
}
