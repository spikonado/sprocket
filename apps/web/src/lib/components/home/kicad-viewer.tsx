import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { readKicadSources } from '$lib/kicad';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type KicadViewerApi = Pick<LocalApi, 'readWorkspaceText'>;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

let kicanvas: Promise<void> | undefined;

// Vite refuses `import()` of files in `static/`, so the vendored bundle loads through a script tag.
function loadKicanvas() {
	kicanvas ??= new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.type = 'module';
		script.src = '/kicanvas/kicanvas.js';
		script.onload = () => resolve();
		script.onerror = () => {
			script.remove();
			// A failed load retries on the next open.
			kicanvas = undefined;
			reject(new Error('Could not load KiCanvas.'));
		};

		document.head.append(script);
	});

	return kicanvas;
}

/** KiCanvas loads after it connects and reports the outcome only through these attributes. */
function whenLoaded(embed: HTMLElement, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const observer = new MutationObserver(() => {
			if (embed.hasAttribute('loading')) return;

			observer.disconnect();

			if (embed.hasAttribute('loaded')) resolve();
			else reject(new Error('KiCanvas could not read this file. It may be malformed.'));
		});

		observer.observe(embed, { attributeFilter: ['loading', 'loaded'] });
		signal.addEventListener('abort', () => observer.disconnect());
	});
}

export default function KicadViewer({
	api,
	file
}: {
	api: KicadViewerApi | null;
	file: WorkspaceFileTarget;
}) {
	const container = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
	const [reloads, setReloads] = useState(0);

	useEffect(() => {
		if (!api) return;

		const controller = new AbortController();
		const { signal } = controller;

		setStatus({ kind: 'loading' });

		void (async () => {
			try {
				const [sources] = await Promise.all([
					readKicadSources(file.path, (path) =>
						api.readWorkspaceText({ workspacePath: file.workspacePath, path }, signal)
					),
					loadKicanvas()
				]);

				if (signal.aborted || !container.current) return;

				const embed = document.createElement('kicanvas-embed');
				embed.setAttribute('controls', 'full');
				embed.style.cssText = 'width: 100%; height: 100%; max-height: none; aspect-ratio: auto;';

				for (const { name, content } of sources) {
					const source = document.createElement('kicanvas-source');
					source.setAttribute('name', name);
					source.textContent = content;
					embed.append(source);
				}

				container.current.replaceChildren(embed);
				await whenLoaded(embed, signal);

				if (signal.aborted) return;

				setStatus({ kind: 'ready' });
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
			<div ref={container} className="min-h-0 flex-1" />
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
