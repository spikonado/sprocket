import { useId, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import type { TranscriptScopeRequest } from '$lib/types/sprocket';
import { useRunningCommands, type CommandApi } from '$lib/home/running-commands';

function ScopedRunningCommands({ api, scope }: { api: CommandApi; scope: TranscriptScopeRequest }) {
	const { commands, stopping, error, terminate } = useRunningCommands(api, scope);
	const [expanded, setExpanded] = useState(true);
	const contentId = useId();

	if (commands.length === 0) return null;

	return (
		<section
			aria-label="Running commands"
			className="mx-auto mb-3 w-full max-w-[48rem] shrink-0 px-4"
		>
			<div className="border-hairline bg-surface overflow-hidden rounded-xl border">
				<button
					type="button"
					aria-label="Running commands"
					aria-expanded={expanded}
					aria-controls={contentId}
					onClick={() => setExpanded((previous) => !previous)}
					className="text-muted-foreground hover:bg-hover-fill focus-visible:ring-ring flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
				>
					<ChevronDown
						className={`size-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
						aria-hidden="true"
					/>
					<span className="font-medium">Running commands</span>
					<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] tabular-nums">
						{commands.length}
					</span>
				</button>
				<div id={contentId}>
					{expanded && (
						<>
							<ul className="divide-hairline border-hairline max-h-40 divide-y overflow-y-auto border-t">
								{commands.map((command) => (
									<li key={command.sessionId} className="flex items-center gap-3 px-3 py-2">
										<span
											className="size-1.5 shrink-0 rounded-full bg-emerald-500"
											aria-hidden="true"
										/>
										<div className="min-w-0 flex-1">
											<p
												className="text-foreground truncate font-mono text-xs"
												title={command.command}
											>
												{command.command}
											</p>
											<p
												className="text-muted-foreground mt-0.5 truncate text-[11px]"
												title={command.workdir}
											>
												{command.workdir}
											</p>
										</div>
										<button
											type="button"
											aria-label={`Stop command: ${command.command}`}
											title="Stop command"
											disabled={stopping.includes(command.sessionId)}
											onClick={() => void terminate(command.sessionId)}
											className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-md transition focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40"
										>
											<Trash2 className="size-3.5" aria-hidden="true" />
										</button>
									</li>
								))}
							</ul>
							{error && (
								<p
									role="alert"
									className="text-destructive border-hairline border-t px-3 py-2 text-xs"
								>
									{error}
								</p>
							)}
						</>
					)}
				</div>
			</div>
		</section>
	);
}

export default function RunningCommands(props: { api: CommandApi; scope: TranscriptScopeRequest }) {
	return <ScopedRunningCommands key={`${props.scope.userId}:${props.scope.threadId}`} {...props} />;
}
