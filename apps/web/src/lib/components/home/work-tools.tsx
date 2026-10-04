import { LoaderCircle } from 'lucide-react';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	isAssistantTimelineToolRunning,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import {
	commandSnapshotLabel,
	fullToolSummary,
	toolGroupLabel,
	toolItemSummary,
	toolSummaryClass
} from '$lib/chat/tool-summaries';
import { toolLogIcon } from '$lib/chat/tool-icons';
import { isCommandToolKind } from '$lib/chat/command-tool-kinds';

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
				const snapshot = commandSnapshotLabel(tool);
				const running = isAssistantTimelineToolRunning(tool, inProgress);
				const error = assistantTimelineToolError(tool, inProgress);
				const failure = assistantTimelineToolFailureKind(tool, inProgress);

				const errorClass =
					failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200';

				return (
					<div
						key={tool.callId}
						data-work-detail
						data-tool-kind={kind}
						className="flex min-w-0 items-start gap-1.5"
					>
						<Icon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<p
								className="flex min-w-0 items-start gap-1.5"
								title={fullToolSummary(tool, inProgress, commands)}
							>
								{!isCommandToolKind(kind) ? (
									<span className="shrink-0">{toolGroupLabel(kind)}:</span>
								) : null}
								<span className={`min-w-0 ${toolSummaryClass(tool)}`}>{summary}</span>
								{running ? (
									<>
										<LoaderCircle
											className="mt-1.5 size-3 shrink-0 animate-spin"
											aria-hidden="true"
										/>
										<span className="sr-only">Running</span>
									</>
								) : null}
								{error && failure ? (
									<span className={`shrink-0 ${errorClass}`}>({failure})</span>
								) : null}
							</p>
							{error && failure ? (
								<p
									className={`mt-1.5 text-xs leading-5 wrap-break-word whitespace-pre-wrap ${errorClass}`}
									role="status"
								>
									{error}
								</p>
							) : null}
							{snapshot ? <p className="text-xs">{snapshot}</p> : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}
