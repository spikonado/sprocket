import { prepareFileTreeInput } from '@pierre/trees';
import { FileTree, useFileTree, type UseFileTreeResult } from '@pierre/trees/react';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, WorkspaceFilesResult } from '$lib/types/sprocket';

export type FilesApi = Pick<DesktopApi, 'listWorkspaceFiles'>;

type FilesRoot = 'thread' | 'project';

type Props = {
	api: FilesApi | null;
	projectPath?: string;
	threadCwd?: string;
	/** Refetches when the tab becomes active so agent edits show up. */
	active: boolean;
};

type LoadState = {
	path: string;
	result: WorkspaceFilesResult | null;
	error: string | null;
};

const ROOTS: { id: FilesRoot; label: string }[] = [
	{ id: 'thread', label: 'Thread' },
	{ id: 'project', label: 'Project' }
];

const SCAN_POLL_MS = 500;

type TreeModel = UseFileTreeResult['model'];

function expandedDirectories(model: TreeModel, paths: readonly string[]) {
	return paths.filter((path) => {
		if (!path.endsWith('/')) return false;
		const item = model.getItem(path);

		return item !== null && 'isExpanded' in item && item.isExpanded();
	});
}

function samePaths(a: readonly string[], b: readonly string[]) {
	return a.length === b.length && a.every((path, index) => path === b[index]);
}

export default function FilesView({ api, projectPath, threadCwd, active }: Props) {
	const [root, setRoot] = useState<FilesRoot>('thread');
	const [refreshKey, setRefreshKey] = useState(0);
	const [load, setLoad] = useState<LoadState | null>(null);
	const shown = useRef<{ path: string; paths: readonly string[] } | null>(null);

	const { model } = useFileTree({
		paths: [],
		search: true,
		flattenEmptyDirectories: true,
		density: 'compact'
	});

	const rootPath = root === 'thread' ? (threadCwd ?? projectPath) : projectPath;
	const current = load?.path === rootPath ? load : null;
	const paths = current?.result?.paths;

	useEffect(() => {
		if (!api || !rootPath || !active) return;
		const workspacePath = rootPath;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		async function fetchPaths() {
			try {
				const result = await api!.listWorkspaceFiles({ workspacePath }, controller.signal);

				if (controller.signal.aborted) return;
				setLoad({ path: workspacePath, result, error: null });

				if (result.scanning) timer = setTimeout(fetchPaths, SCAN_POLL_MS);
			} catch (error) {
				if (controller.signal.aborted) return;
				setLoad({
					path: workspacePath,
					result: null,
					error: error instanceof Error ? error.message : 'Could not list files.'
				});
			}
		}

		void fetchPaths();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [api, rootPath, active, refreshKey]);

	useEffect(() => {
		if (!rootPath) return;
		const previous = shown.current;
		const sameRoot = previous?.path === rootPath;
		const next = paths ?? (sameRoot ? previous.paths : []);

		if (sameRoot && samePaths(previous.paths, next)) return;

		model.resetPaths({
			preparedInput: prepareFileTreeInput(next, { flattenEmptyDirectories: true }),
			initialExpandedPaths: sameRoot ? expandedDirectories(model, previous.paths) : []
		});
		shown.current = { path: rootPath, paths: next };
	}, [model, paths, rootPath]);

	const status = !api
		? 'Files are available when Sprocket is connected to this machine.'
		: !rootPath
			? 'Select a project to browse its files.'
			: current?.error
				? current.error
				: !current?.result || (current.result.scanning && paths?.length === 0)
					? 'Loading files…'
					: paths?.length === 0
						? 'No files.'
						: null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-hairline flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
				<div
					role="radiogroup"
					aria-label="Files root"
					className="bg-muted flex shrink-0 rounded-md p-0.5 text-xs font-medium"
				>
					{ROOTS.map((item) => (
						<button
							key={item.id}
							type="button"
							role="radio"
							aria-checked={root === item.id}
							onClick={() => setRoot(item.id)}
							className={`focus-visible:ring-ring rounded px-2 py-0.5 transition focus-visible:ring-2 focus-visible:outline-none ${
								root === item.id
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							{item.label}
						</button>
					))}
				</div>
				<span
					className="text-muted-foreground min-w-0 flex-1 truncate text-[11px] [direction:rtl]"
					title={rootPath}
				>
					<bdi>{rootPath}</bdi>
				</span>
				<button
					type="button"
					onClick={() => setRefreshKey((value) => value + 1)}
					disabled={!api || !rootPath}
					aria-label="Refresh files"
					title="Refresh files"
					className="text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring shrink-0 rounded-md p-1 transition focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
				>
					<RefreshCw className="size-3.5" aria-hidden="true" />
				</button>
			</div>
			{current?.result?.truncated ? (
				<p
					role="status"
					className="text-muted-foreground border-hairline border-b px-3 py-1.5 text-xs"
				>
					Showing the first {paths?.length.toLocaleString()} entries.
				</p>
			) : null}
			{status ? (
				<p role={current?.error ? 'alert' : 'status'} className="text-muted-foreground p-3 text-sm">
					{status}
				</p>
			) : null}
			<FileTree
				model={model}
				hidden={status !== null}
				className="workspace-file-tree min-h-0 flex-1"
			/>
		</div>
	);
}
