import { File, Folder } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { WorkspaceSearchEntry } from '$lib/types/sprocket';
import { workspaceEntryDisplayPath } from '$lib/chat/at-paths';

export default function ComposerPathMenu({
	loadState,
	entries,
	scanning,
	highlightedIndex,
	onRetry,
	onHighlight,
	onSelect
}: {
	loadState: 'loading' | 'ready' | 'error' | 'unavailable';
	entries: WorkspaceSearchEntry[];
	scanning: boolean;
	highlightedIndex: number;
	onRetry: () => void;
	onHighlight: (index: number) => void;
	onSelect: (entry: WorkspaceSearchEntry) => void;
}) {
	const options = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		options.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
	}, [entries, highlightedIndex]);

	return (
		<div
			className="border-border bg-popover absolute inset-x-0 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-xl border py-1 shadow-2xl"
			id="composer-paths-listbox"
			aria-label="Workspace files and directories"
			role="listbox"
			aria-busy={loadState === 'loading' || scanning}
		>
			{loadState === 'unavailable' ? (
				<p className="text-muted-foreground px-3 py-2 text-sm" role="status">
					Select a workspace and connect its server to tag files.
				</p>
			) : loadState === 'error' ? (
				<div className="flex items-center justify-between gap-3 px-3 py-2">
					<p className="text-muted-foreground text-sm" role="status">
						Couldn't search workspace files
					</p>
					<button type="button" className="text-sm hover:underline" onClick={onRetry}>
						Retry
					</button>
				</div>
			) : loadState === 'loading' || (scanning && entries.length === 0) ? (
				<p className="text-muted-foreground px-3 py-2 text-sm" role="status">
					Searching workspace files...
				</p>
			) : entries.length === 0 ? (
				<p className="text-muted-foreground px-3 py-2 text-sm" role="status">
					No matching files or directories
				</p>
			) : (
				entries.map((entry, index) => {
					const Icon = entry.kind === 'directory' ? Folder : File;

					return (
						<button
							key={`${entry.kind}:${entry.path}`}
							ref={(element) => {
								options.current[index] = element;
							}}
							type="button"
							id={`composer-path-option-${index}`}
							className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
								highlightedIndex === index
									? 'text-foreground bg-hover-fill-strong'
									: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
							}`}
							role="option"
							aria-selected={highlightedIndex === index}
							onPointerEnter={() => onHighlight(index)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => onSelect(entry)}
						>
							<Icon className="size-4 shrink-0" aria-hidden="true" />
							<span className="break-all">{workspaceEntryDisplayPath(entry)}</span>
						</button>
					);
				})
			)}
		</div>
	);
}
