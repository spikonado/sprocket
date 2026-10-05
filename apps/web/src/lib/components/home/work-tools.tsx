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
							<p
								key={index}
								data-work-detail
								className="flex min-w-0 items-start gap-1.5"
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
							</p>
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
