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

				const errorClass =
					failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200';

				return (
					<div key={tool.callId} data-tool-kind={kind} className="min-w-0 space-y-1.5">
						{summaries.map((item, index) => (
							<details
								key={index}
								className="relative min-w-0"
								onKeyDown={(event) => {
									if (event.key === 'Escape') event.currentTarget.open = false;
								}}
							>
								<summary
									data-work-detail
									className="focus-visible:ring-ring/60 flex min-w-0 cursor-pointer list-none items-start gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
									title={fullToolSummary(tool, inProgress, commands)}
								>
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
								</summary>
								<p className="bg-popover text-popover-foreground absolute top-full left-0 z-20 w-full rounded-md border p-2 text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap shadow-md">
									{item || label}
								</p>
							</details>
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
