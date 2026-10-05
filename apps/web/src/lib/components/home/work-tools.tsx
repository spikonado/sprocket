import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import { fullToolSummary, toolItemLabel, toolItemSummary } from '$lib/chat/tool-summaries';
import { toolLogIcon } from '$lib/chat/tool-icons';

type Props = {
	tools: AssistantTimelineTool[];
	inProgress: boolean;
	commands: ReadonlyMap<string, string>;
};

type TooltipAnchor = { top: number; left: number; maxHeight: number };

const TOOLTIP_GAP = 8;

function placeTooltip(row: HTMLElement, tooltip?: HTMLElement | null): TooltipAnchor {
	const rowRect = row.getBoundingClientRect();
	const tooltipHeight = tooltip?.offsetHeight ?? 0;
	const tooltipWidth = tooltip?.offsetWidth ?? 0;
	const spaceBelow = window.innerHeight - rowRect.bottom - TOOLTIP_GAP;
	const spaceAbove = rowRect.top - TOOLTIP_GAP;
	const placeAbove = tooltipHeight > spaceBelow && spaceAbove > spaceBelow;
	const maxHeight = Math.max(placeAbove ? spaceAbove : spaceBelow, 0);
	const height = Math.min(tooltipHeight || maxHeight, maxHeight);
	const top = placeAbove ? rowRect.top - height - TOOLTIP_GAP : rowRect.bottom + TOOLTIP_GAP;
	const maxLeft = window.innerWidth - (tooltipWidth || 0) - TOOLTIP_GAP;

	return {
		top: Math.max(TOOLTIP_GAP, top),
		left: Math.min(Math.max(rowRect.left, TOOLTIP_GAP), Math.max(TOOLTIP_GAP, maxLeft)),
		maxHeight
	};
}

function sameAnchor(left: TooltipAnchor, right: TooltipAnchor) {
	return left.top === right.top && left.left === right.left && left.maxHeight === right.maxHeight;
}

function ToolLogRow({ tooltip, children }: { tooltip: string; children: ReactNode }) {
	const tooltipId = useId();
	const rowRef = useRef<HTMLDivElement>(null);
	const tooltipRef = useRef<HTMLParagraphElement>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
	const open = hovered || focused;

	useLayoutEffect(() => {
		if (!open) {
			setAnchor(null);

			return;
		}

		const row = rowRef.current;

		if (!row) return;

		const next = placeTooltip(row, tooltipRef.current);
		setAnchor((current) => (current && sameAnchor(current, next) ? current : next));
	}, [open, tooltip]);

	useEffect(() => {
		if (!open) return;

		function onScroll() {
			setHovered(false);
			setFocused(false);
			rowRef.current?.blur();
		}

		window.addEventListener('scroll', onScroll, true);

		return () => window.removeEventListener('scroll', onScroll, true);
	}, [open]);

	function onKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.key !== 'Escape' || !open) return;

		setHovered(false);
		event.currentTarget.blur();
	}

	return (
		<div
			ref={rowRef}
			data-tool-row
			data-work-detail
			tabIndex={0}
			aria-describedby={open ? tooltipId : undefined}
			className="focus-visible:ring-ring/60 relative flex min-w-0 items-start gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			onKeyDown={onKeyDown}
		>
			{children}
			{open && tooltip ? (
				<p
					ref={tooltipRef}
					id={tooltipId}
					role="tooltip"
					className="bg-tooltip text-tooltip-foreground ring-border pointer-events-none fixed z-100 max-w-md overflow-hidden rounded-md px-2.5 py-1.5 text-[12px] leading-4 [overflow-wrap:anywhere] whitespace-pre-wrap shadow-lg ring-1"
					style={{
						top: anchor?.top ?? 0,
						left: anchor?.left ?? 0,
						maxHeight: anchor?.maxHeight,
						visibility: anchor ? 'visible' : 'hidden'
					}}
				>
					{tooltip}
				</p>
			) : null}
		</div>
	);
}

export default function WorkTools({ tools, inProgress, commands }: Props) {
	return (
		<div className="text-muted-foreground space-y-1.5 text-[13px] leading-6">
			{tools.map((tool) => {
				const kind = tool.job?.kind ?? tool.name;
				const Icon = toolLogIcon(tool);
				const summary = toolItemSummary(tool, commands);
				const summaries = kind === 'apply_patch' ? summary.split('\n') : [summary];
				const label = toolItemLabel(kind);
				const error = assistantTimelineToolError(tool, inProgress);
				const failure = assistantTimelineToolFailureKind(tool, inProgress);
				const tooltip = fullToolSummary(tool, inProgress, commands);

				const errorClass =
					failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200';

				return (
					<div key={tool.callId} data-tool-kind={kind} className="min-w-0 space-y-1.5">
						{summaries.map((item, index) => (
							<ToolLogRow key={index} tooltip={tooltip}>
								<Icon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
								{label ? (
									<span className="shrink-0">
										{label}
										{item ? ':' : ''}
									</span>
								) : null}
								{item ? <span className="min-w-0 truncate">{item}</span> : null}
								{error && failure && index === summaries.length - 1 ? (
									<span className={`shrink-0 ${errorClass}`}>({failure})</span>
								) : null}
							</ToolLogRow>
						))}
						{error && failure ? (
							<p
								data-work-detail
								className={`pl-5 text-xs leading-5 wrap-break-word whitespace-pre-wrap ${errorClass}`}
								role="status"
							>
								{error}
							</p>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
