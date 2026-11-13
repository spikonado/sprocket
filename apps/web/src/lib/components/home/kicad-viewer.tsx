import { useEffect, useState } from 'react';
import Board3dViewer from '$lib/components/home/board-3d-viewer';
import KicanvasViewer, { type KicanvasViewerApi } from '$lib/components/home/kicanvas-viewer';
import PcbViewer from '$lib/components/home/pcb-viewer';
import { kicadBoardPath } from '$lib/kicad';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

type KicadViewerApi = KicanvasViewerApi & Pick<LocalApi, 'exportBoard3d' | 'kicadScene'>;

type View = 'Schematic' | 'PCB' | '2D' | '3D';

const RECONNECT_MS = 1_000;

/**
 * Boards draw in `PcbViewer`, schematics in KiCanvas. A project shows its schematics first, and
 * its board once `<stem>.kicad_pcb` turns out to exist. Each view stays mounted once opened, so
 * switching back never reloads it.
 */
export default function KicadViewer({
	api,
	file,
	active
}: {
	api: KicadViewerApi | null;
	file: WorkspaceFileTarget;
	active: boolean;
}) {
	const boardPath = kicadBoardPath(file.path);
	const isBoard = boardPath === file.path;
	const boardVersion = useFileVersion(api, file.workspacePath, boardPath, active);
	const first: View = isBoard ? '2D' : 'Schematic';
	const pcbView: View = isBoard ? '2D' : 'PCB';

	const views: View[] = !boardVersion
		? [first]
		: isBoard
			? ['2D', '3D']
			: ['Schematic', 'PCB', '3D'];

	const [chosen, setChosen] = useState<View>(first);
	const view = views.includes(chosen) ? chosen : first;
	const [opened, setOpened] = useState<ReadonlySet<View>>(new Set([first]));

	function choose(next: View) {
		setChosen(next);
		setOpened((current) => new Set([...current, next]));
	}

	return (
		<div className="relative min-h-0 flex-1">
			{!isBoard && <KicanvasViewer api={api} file={file} active={active} />}
			{api && boardPath && opened.has(pcbView) && (
				<PcbViewer
					api={api}
					workspacePath={file.workspacePath}
					path={boardPath}
					version={boardVersion}
					shown={view === pcbView}
				/>
			)}
			{api && boardPath && boardVersion && opened.has('3D') && (
				<Board3dViewer
					api={api}
					workspacePath={file.workspacePath}
					path={boardPath}
					revision={boardVersion}
					shown={view === '3D'}
				/>
			)}
			{views.length > 1 && (
				<div
					role="group"
					aria-label="Board view"
					className="bg-muted absolute top-3 left-3 z-30 flex rounded-full p-0.5 text-xs shadow-sm"
				>
					{views.map((item) => (
						<button
							key={item}
							type="button"
							aria-pressed={view === item}
							onClick={() => choose(item)}
							className={`focus-visible:ring-ring rounded-full px-2.5 py-0.5 transition focus-visible:ring-2 focus-visible:outline-none ${
								view === item
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							{item}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The file's last version from the workspace watch, or null until the file is seen. */
function useFileVersion(
	api: Pick<LocalApi, 'watchWorkspaceFile'> | null,
	workspacePath: string,
	path: string | null,
	active: boolean
) {
	const visible = usePageVisible();
	const [version, setVersion] = useState<string | null>(null);

	useEffect(() => {
		if (!api || !path || !active || !visible) return;

		const controller = new AbortController();
		const { signal } = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const watch = async () => {
			try {
				await api.watchWorkspaceFile(
					{ workspacePath, path },
					{
						signal,
						onEvent: (event) => {
							if (event.kind === 'snapshot') setVersion(event.version);
						}
					}
				);
			} catch {}

			if (!signal.aborted) timer = setTimeout(watch, RECONNECT_MS);
		};

		void watch();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [api, workspacePath, path, active, visible]);

	return version;
}
