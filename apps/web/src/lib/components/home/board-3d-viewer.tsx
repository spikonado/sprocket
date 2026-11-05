import { useEffect, useRef, useState } from 'react';
import type { BoardScene } from '$lib/components/home/board-3d-scene';
import type { LocalApi } from '$lib/types/sprocket';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/**
 * Shows KiCad's own glTF export, so copper, mask, silkscreen and component models match KiCad's
 * 3D viewer. Exports take seconds, so this exports only while `shown` and only when `revision`
 * moves past the last export.
 */
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
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
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

		// Such as an edit undone while its export ran, which brings back the shown board.
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
			{status.kind !== 'ready' && (
				<div
					role={status.kind === 'error' ? 'alert' : 'status'}
					className={
						showing
							? 'bg-background/80 text-muted-foreground border-hairline absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md border px-3 py-1.5 text-xs backdrop-blur'
							: 'bg-background text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-sm'
					}
				>
					{status.kind === 'error'
						? status.message
						: showing
							? 'Updating…'
							: 'Building the 3D model with KiCad…'}
				</div>
			)}
		</div>
	);
}
