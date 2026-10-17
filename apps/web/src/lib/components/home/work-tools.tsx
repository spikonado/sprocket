import { useState, type ReactNode } from 'react';
import {
	assistantTimelineToolError,
	assistantTimelineToolFailureKind,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import { toolItemLabel, toolItemSummary, toolShellCommand } from '$lib/chat/tool-summaries';
import { toolLogIcon } from '$lib/chat/tool-icons';
import HighlightedCommand from './highlighted-command';

type Props = {
	tools: AssistantTimelineTool[];
	inProgress: boolean;
	commands: ReadonlyMap<string, string>;
};

function ToolRowDisclosure({
	row,
	item,
	command
}: {
	row: ReactNode;
	item: string;
	command: string | undefined;
}) {
	const [open, setOpen] = useState(false);
	const highlightable = open && command && item.startsWith(command);

	return (
		<details className="group min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary
				data-tool-row
				data-work-detail
				className="hover:text-foreground focus-visible:ring-ring/60 group-open:text-foreground flex min-w-0 cursor-pointer list-none items-start gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
			>
				{row}
			</summary>
			<p className="bg-muted/50 text-foreground mt-1 ml-5 max-h-80 overflow-y-auto rounded-md px-2 py-1.5 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">
				{highlightable ? (
					<>
						<HighlightedCommand command={command} />
						{item.slice(command.length)}
					</>
				) : (
					item
				)}
			</p>
		</details>
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
				const command = toolShellCommand(tool, commands);
				const error = assistantTimelineToolError(tool, inProgress);
				const failure = assistantTimelineToolFailureKind(tool, inProgress);

				const errorClass =
					failure === 'failed' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200';

				return (
					<div key={tool.callId} data-tool-kind={kind} className="min-w-0 space-y-1.5">
						{summaries.map((item, index) => {
							const row = (
								<>
									<Icon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
									{label ? (
										<span className="shrink-0">
											{label}
											{item ? ':' : ''}
										</span>
									) : null}
									{item ? <span className="min-w-0 truncate">{item}</span> : null}
									{error && failure && index === summaries.length - 1 ? (
										<span className={`shrink-0 ${errorClass}`}>
											({failure === 'cancelled' ? 'stopped' : failure})
										</span>
									) : null}
								</>
							);

							if (!item) {
								return (
									<div
										key={index}
										data-tool-row
										data-work-detail
										className="flex min-w-0 items-start gap-1.5"
									>
										{row}
									</div>
								);
							}

							return <ToolRowDisclosure key={index} row={row} item={item} command={command} />;
						})}
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
