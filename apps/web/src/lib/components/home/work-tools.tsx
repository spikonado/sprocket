import { LoaderCircle } from 'lucide-react';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import {
	changedFileCount,
	commandSnapshotLabel,
	fullToolSummary,
	toolGroupLabel,
	toolItemSummary,
	toolSummaryClass
} from '$lib/chat/tool-summaries';
import { toolKindIcon, toolLogIcon } from '$lib/chat/tool-icons';
import ToolCallsDisclosure from '$lib/components/home/tool-calls-disclosure';

type Props = {
	tools: AssistantTimelineTool[];
	toolKey?: string;
	running?: boolean;
	preserveExpansion?: boolean;
	inProgress: boolean;
	commands: ReadonlyMap<string, string>;
};

export default function WorkTools({
	tools,
	toolKey = '',
	running = false,
	preserveExpansion = false,
	inProgress,
	commands
}: Props) {
	return (
		<ToolCallsDisclosure
			label={running ? 'Running' : toolGroupLabel(toolKey)}
			icon={running ? LoaderCircle : toolKindIcon(toolKey)}
			iconClass={running ? 'animate-spin' : undefined}
			tools={tools}
			preserveExpansion={preserveExpansion}
			defaultExpanded={
				running ? true : toolKey === 'apply_patch' ? changedFileCount(tools) <= 2 : undefined
			}
			toolRow={(tool) => {
				const summary = toolItemSummary(tool, commands);
				const snapshot = commandSnapshotLabel(tool);

				if (running) {
					const ToolIcon = toolLogIcon(tool);

					return (
						<p className="flex min-w-0 items-start gap-1.5" title={`${summary} (running)`}>
							<ToolIcon
								className="text-muted-foreground mt-1.5 size-3 shrink-0"
								aria-hidden="true"
							/>
							<span className={toolSummaryClass(tool)}>{summary}</span>
						</p>
					);
				}

				const error = assistantTimelineToolError(tool, inProgress);
				const failure = assistantTimelineToolFailureKind(tool, inProgress);

				if (error && failure) {
					const errorClass =
						failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200';

					return (
						<details className="min-w-0">
							<summary
								className="min-w-0 cursor-pointer text-left"
								title={fullToolSummary(tool, inProgress, commands)}
							>
								<span className={toolSummaryClass(tool)}>{summary}</span>
								<span className={errorClass}>({failure})</span>
							</summary>
							<p
								className={`mt-1.5 text-xs leading-5 wrap-break-word whitespace-pre-wrap ${errorClass}`}
								role="status"
							>
								{error}
							</p>
						</details>
					);
				}

				return (
					<div>
						<p
							className={`min-w-0 ${toolSummaryClass(tool)}`}
							title={fullToolSummary(tool, inProgress, commands)}
						>
							{summary}
						</p>
						{snapshot ? <p className="text-xs">{snapshot}</p> : null}
					</div>
				);
			}}
		/>
	);
}
