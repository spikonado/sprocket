import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { readKicadSources } from '$lib/kicad';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type KicadViewerApi = Pick<LocalApi, 'readWorkspaceText'>;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

const frameMessageSchema = z.object({ type: z.enum(['ready', 'loaded', 'failed']) });

function nextFrameMessage(frame: HTMLIFrameElement, signal: AbortSignal) {
	return new Promise<z.infer<typeof frameMessageSchema>['type']>((resolve) => {
		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.source !== frame.contentWindow) return;

			const message = frameMessageSchema.safeParse(event.data);

			if (!message.success) return;
			removeEventListener('message', onMessage);
			resolve(message.data.type);
		};

		addEventListener('message', onMessage);
		signal.addEventListener('abort', () => removeEventListener('message', onMessage));
	});
}

/**
 * KiCanvas parses and draws on its page's main thread, which takes tens of seconds for large
 * boards. A sandboxed frame gets its own process in Chromium, so the rest of the app stays live.
 */
export default function KicadViewer({
	api,
	file
}: {
	api: KicadViewerApi | null;
	file: WorkspaceFileTarget;
}) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
	const [reloads, setReloads] = useState(0);

	useEffect(() => {
		const frame = frameRef.current;

		if (!api || !frame) return;

		const controller = new AbortController();
		const { signal } = controller;

		setStatus({ kind: 'loading' });

		void (async () => {
			try {
				const [sources, ready] = await Promise.all([
					readKicadSources(file.path, (path) =>
						api.readWorkspaceText({ workspacePath: file.workspacePath, path }, signal)
					),
					nextFrameMessage(frame, signal)
				]);

				if (ready !== 'ready') throw new Error('Could not load KiCanvas.');

				const outcome = nextFrameMessage(frame, signal);
				frame.contentWindow?.postMessage({ type: 'sources', sources }, '*');

				if ((await outcome) !== 'loaded') {
					throw new Error('KiCanvas could not read this file. It may be malformed.');
				}

				if (!signal.aborted) setStatus({ kind: 'ready' });
			} catch (error) {
				if (signal.aborted) return;

				setStatus({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not open the KiCad file.'
				});
			}
		})();

		return () => controller.abort();
	}, [api, file.workspacePath, file.path, reloads]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{/* A fresh frame per load, since KiCanvas reads its sources only once. */}
			<iframe
				key={`${file.workspacePath}:${file.path}:${reloads}`}
				ref={frameRef}
				title={`KiCanvas viewer for ${file.path}`}
				src="/kicanvas-viewer.html"
				sandbox="allow-scripts allow-downloads"
				allow="fullscreen"
				className="min-h-0 w-full flex-1 border-0"
			/>
			{status.kind === 'ready' ? null : (
				<div
					role={status.kind === 'error' ? 'alert' : 'status'}
					className="bg-background text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-sm"
				>
					{status.kind === 'error' ? status.message : 'Opening in KiCanvas…'}
				</div>
			)}
			<button
				type="button"
				onClick={() => setReloads((count) => count + 1)}
				aria-label="Reload from disk"
				title="Reload from disk"
				className="bg-background/80 text-muted-foreground hover:text-foreground border-hairline absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-md border backdrop-blur transition"
			>
				<RefreshCw className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
