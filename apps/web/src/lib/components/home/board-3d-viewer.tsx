import { useEffect, useRef, useState } from 'react';
import type { BoardScene } from '$lib/components/home/board-3d-scene';
import ViewerStatusNotice, { type ViewerStatus } from '$lib/components/home/viewer-status';
import type { LocalApi } from '$lib/types/sprocket';

/** KiCad's export takes seconds, so this exports only while `shown` and for a new `revision`. */
export default function Board3dViewer({
	api,
	workspacePath,
	path,
	revision,
	shown
}: {
	api: Pick<LocalApi, 'exportBoard3d'>;
	workspacePath: string;
	path: string;
	revision: string;
	shown: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const scene = useRef<Promise<BoardScene> | null>(null);
	const exported = useRef('');
	const [status, setStatus] = useState<ViewerStatus>({ kind: 'loading' });
	const [showing, setShowing] = useState(false);
	const key = `${workspacePath}\n${path}\n${revision}`;

	useEffect(
		() => () => {
			void scene.current?.then((current) => current.dispose());
			scene.current = null;
			exported.current = '';
		},
		[]
	);

	useEffect(() => {
		const container = containerRef.current;

		if (!shown || !container) return;

		if (exported.current === key) {
			setStatus({ kind: 'ready' });

			return;
		}

		const controller = new AbortController();

		const ready = (scene.current ??= import('$lib/components/home/board-3d-scene').then((module) =>
			module.createBoardScene(container)
		));

		setStatus({ kind: 'loading' });

		void (async () => {
			try {
				const [glb, current] = await Promise.all([
					api.exportBoard3d({ workspacePath, path }, controller.signal),
					ready
				]);

				if (controller.signal.aborted) return;
				await current.show(glb);
				exported.current = key;
				setShowing(true);
				setStatus({ kind: 'ready' });
			} catch (error) {
				if (controller.signal.aborted) return;
				setStatus({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not show the board in 3D.'
				});
			}
		})();

		return () => controller.abort();
	}, [api, workspacePath, path, key, shown]);

	return (
		<div ref={containerRef} className="bg-background absolute inset-0 z-20" hidden={!shown}>
			<ViewerStatusNotice
				status={status}
				drawn={showing}
				opening="Building the 3D model with KiCad…"
			/>
		</div>
	);
}
