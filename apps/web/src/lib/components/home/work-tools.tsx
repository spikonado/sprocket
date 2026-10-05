import {
	useId,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
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

type TooltipAnchor = { top: number; left: number };

function tooltipAnchor(target: HTMLElement): TooltipAnchor {
	const rect = target.getBoundingClientRect();

	return { top: rect.bottom + 8, left: rect.left };
}

function ToolLogRow({ tooltip, children }: { tooltip: string; children: ReactNode }) {
	const tooltipId = useId();
	const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);

	function show(event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) {
		setAnchor(tooltipAnchor(event.currentTarget));
	}

	function hide() {
		setAnchor(null);
	}

	function onKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.key !== 'Escape' || !anchor) return;

		event.currentTarget.blur();
		hide();
	}

	return (
		<div
			data-tool-row
			data-work-detail
			tabIndex={0}
			aria-describedby={anchor ? tooltipId : undefined}
			className="focus-visible:ring-ring/60 relative flex min-w-0 items-start gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			onKeyDown={onKeyDown}
		>
			{children}
			{anchor && tooltip ? (
				<p
					id={tooltipId}
					role="tooltip"
					className="bg-tooltip text-tooltip-foreground ring-border pointer-events-none fixed z-100 max-w-md rounded-md px-2.5 py-1.5 text-[12px] leading-4 [overflow-wrap:anywhere] whitespace-pre-wrap shadow-lg ring-1"
					style={{ top: anchor.top, left: anchor.left }}
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
