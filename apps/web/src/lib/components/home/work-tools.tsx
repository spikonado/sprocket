import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
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

type TooltipAnchor = { top: number; left: number; maxHeight: number; maxWidth: number };

const TOOLTIP_GAP = 8;

function placeTooltip(row: HTMLElement, tooltip?: HTMLElement | null): TooltipAnchor | null {
	const rowRect = row.getBoundingClientRect();
	const viewport = row.closest('[data-conversation-viewport]')?.getBoundingClientRect();
	const visibleTop = Math.max(0, viewport?.top ?? 0);
	const visibleBottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight);
	const visibleLeft = Math.max(0, viewport?.left ?? 0);
	const visibleRight = Math.min(window.innerWidth, viewport?.right ?? window.innerWidth);

	if (rowRect.bottom < visibleTop || rowRect.top > visibleBottom) return null;

	const tooltipHeight = tooltip?.scrollHeight ?? 0;
	const maxWidth = Math.max(0, Math.min(448, visibleRight - visibleLeft - TOOLTIP_GAP * 2));
	const tooltipWidth = Math.min(tooltip?.offsetWidth ?? 0, maxWidth);
	const spaceBelow = visibleBottom - rowRect.bottom - TOOLTIP_GAP * 2;
	const spaceAbove = rowRect.top - visibleTop - TOOLTIP_GAP * 2;
	const placeAbove = tooltipHeight > spaceBelow && spaceAbove > spaceBelow;
	const maxHeight = Math.max(placeAbove ? spaceAbove : spaceBelow, 0);
	const height = Math.min(tooltipHeight || maxHeight, maxHeight);
	const top = placeAbove ? rowRect.top - height - TOOLTIP_GAP : rowRect.bottom + TOOLTIP_GAP;
	const maxLeft = visibleRight - tooltipWidth - TOOLTIP_GAP;
	const minLeft = visibleLeft + TOOLTIP_GAP;

	return {
		top: Math.max(visibleTop + TOOLTIP_GAP, top),
		left: Math.min(Math.max(rowRect.left, minLeft), Math.max(minLeft, maxLeft)),
		maxHeight,
		maxWidth
	};
}

function sameAnchor(left: TooltipAnchor, right: TooltipAnchor) {
	return (
		left.top === right.top &&
		left.left === right.left &&
		left.maxHeight === right.maxHeight &&
		left.maxWidth === right.maxWidth
	);
}

function ToolLogRow({ tooltip, children }: { tooltip: string; children: ReactNode }) {
	const tooltipId = useId();
	const rowRef = useRef<HTMLDivElement>(null);
	const tooltipRef = useRef<HTMLParagraphElement>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const open = (hovered || focused) && !dismissed;

	function updateAnchor() {
		const row = rowRef.current;

		if (!row) return;

		const next = placeTooltip(row, tooltipRef.current);
		setAnchor((current) => (current && next && sameAnchor(current, next) ? current : next));
	}

	useLayoutEffect(() => {
		if (!open) {
			setAnchor(null);

			return;
		}

		updateAnchor();
	}, [open, tooltip]);

	useEffect(() => {
		if (!open) return;

		function onScroll(event: Event) {
			if (event.target === tooltipRef.current) return;

			updateAnchor();
		}

		function onEscape(event: globalThis.KeyboardEvent) {
			if (event.key === 'Escape') setDismissed(true);
		}

		const observer = globalThis.ResizeObserver ? new ResizeObserver(updateAnchor) : null;

		if (rowRef.current) observer?.observe(rowRef.current);

		if (tooltipRef.current) observer?.observe(tooltipRef.current);

		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', updateAnchor);
		window.addEventListener('keydown', onEscape);

		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', updateAnchor);
			window.removeEventListener('keydown', onEscape);
			observer?.disconnect();
		};
	}, [open]);

	useEffect(() => clearCloseTimer, []);

	function clearCloseTimer() {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}

	function onMouseEnter() {
		clearCloseTimer();

		if (!hovered && !focused) setDismissed(false);
		setHovered(true);
	}

	function onMouseLeave() {
		clearCloseTimer();
		closeTimer.current = setTimeout(() => setHovered(false), 100);
	}

	function onKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (!open) return;

		const log = tooltipRef.current;

		if (!anchor || !log || log.scrollHeight <= log.clientHeight) return;

		const offset = new Map([
			['ArrowDown', 40],
			['ArrowUp', -40],
			['PageDown', log.clientHeight],
			['PageUp', -log.clientHeight],
			['Home', -log.scrollHeight],
			['End', log.scrollHeight]
		]).get(event.key);

		if (offset === undefined) return;

		event.preventDefault();
		event.stopPropagation();
		log.scrollTop += offset;
	}

	return (
		<div
			ref={rowRef}
			data-tool-row
			data-work-detail
			tabIndex={0}
			aria-describedby={open && anchor ? tooltipId : undefined}
			className="focus-visible:ring-ring/60 relative flex min-w-0 items-start gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onFocus={() => {
				setFocused(true);
				setDismissed(false);
			}}
			onBlur={() => setFocused(false)}
			onKeyDown={onKeyDown}
		>
			{children}
			{open && tooltip
				? createPortal(
						<p
							ref={tooltipRef}
							id={tooltipId}
							role="tooltip"
							className="bg-tooltip text-tooltip-foreground ring-border fixed z-100 w-max overflow-y-auto overscroll-contain rounded-md px-2.5 py-1.5 text-[12px] leading-4 [overflow-wrap:anywhere] whitespace-pre-wrap shadow-lg ring-1"
							onMouseEnter={onMouseEnter}
							onMouseLeave={onMouseLeave}
							style={{
								top: anchor?.top ?? 0,
								left: anchor?.left ?? 0,
								maxHeight: anchor?.maxHeight,
								maxWidth: anchor?.maxWidth,
								visibility: anchor ? 'visible' : 'hidden'
							}}
						>
							{tooltip}
						</p>,
						document.body
					)
				: null}
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
