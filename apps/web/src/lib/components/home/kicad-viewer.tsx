import { useEffect, useRef, useState } from 'react';
import { readVisualThemeCss } from '$lib/chat/artifact-preview';
import { readKicadSources } from '$lib/kicad';
import { frameMessageSchema, type ParentMessage } from '$lib/kicad-frame/protocol';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

type KicadViewerApi = Pick<LocalApi, 'readWorkspaceText' | 'watchWorkspaceFile' | 'exportBoard3d'>;

type Status =
	| { kind: 'opening' }
	| { kind: 'shown'; updating: boolean; notice: string | null }
	| { kind: 'error'; message: string };

const RELOAD_DELAY_MS = 1_000;

const RECONNECT_MS = 1_000;

/**
 * Shows KiCad files in the vendored ecad-viewer. It parses and draws large boards for seconds on
 * its page's main thread, so it runs in a sandboxed frame, which gets its own process in Chromium.
 * The frame stays for the file's lifetime and swaps in new sources as they change on disk.
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
	const visible = usePageVisible();
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [status, setStatus] = useState<Status>({ kind: 'opening' });
	const [watched, setWatched] = useState('');
	const scheduleReload = useRef(() => {});
	const versions = useRef(new Map<string, string | null>());

	useEffect(() => {
		const frame = frameRef.current;

		if (!api || !frame) return;

		const closed = new AbortController();
		let revision = 0;
		let shown = false;
		let boardPath: string | null = null;
		let reading: AbortController | null = null;
		let exporting: AbortController | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		versions.current = new Map();
		setStatus({ kind: 'opening' });
		setWatched('');

		const post = (message: ParentMessage, transfer: Transferable[] = []) =>
			frame.contentWindow?.postMessage(message, '*', transfer);

		const postTheme = () => post({ type: 'theme', css: readVisualThemeCss() });

		const fail = (message: string) => {
			if (shown) setStatus({ kind: 'shown', updating: false, notice: message });
			else setStatus({ kind: 'error', message });
		};

		const load = async () => {
			reading?.abort();
			const own = new AbortController();
			reading = own;

			const signal = AbortSignal.any([closed.signal, own.signal]);
			const read = new Set<string>();

			if (shown) setStatus({ kind: 'shown', updating: true, notice: null });

			try {
				const sources = await readKicadSources(file.path, async (path) => {
					read.add(path);

					try {
						const text = await api.readWorkspaceText(
							{ workspacePath: file.workspacePath, path },
							signal
						);

						if (!signal.aborted) versions.current.set(path, text.version);

						return text.content;
					} catch (error) {
						if (!signal.aborted) versions.current.set(path, null);
						throw error;
					}
				});

				if (signal.aborted) return;

				if (sources.every(({ content }) => !content.trim())) {
					throw new Error('This KiCad file is empty.');
				}

				const board = sources.find(({ filename }) => filename.endsWith('.kicad_pcb'));

				boardPath = board
					? file.path.slice(0, file.path.lastIndexOf('/') + 1) + board.filename
					: null;
				post({
					type: 'sources',
					revision: ++revision,
					sources,
					boardVersion: boardPath && (versions.current.get(boardPath) ?? null)
				});
			} catch (error) {
				if (signal.aborted) return;
				fail(error instanceof Error ? error.message : 'Could not open the KiCad file.');
			} finally {
				if (!signal.aborted) setWatched([...read].sort().join('\n'));
			}
		};

		const exportBoard = async (boardVersion: string) => {
			exporting?.abort();
			const own = new AbortController();
			exporting = own;

			const signal = AbortSignal.any([closed.signal, own.signal]);

			try {
				if (!boardPath) throw new Error('This project has no board.');

				const glb = await api.exportBoard3d(
					{ workspacePath: file.workspacePath, path: boardPath },
					signal
				);

				if (!signal.aborted) post({ type: 'board3d', boardVersion, glb }, [glb]);
			} catch (error) {
				if (signal.aborted) return;
				post({
					type: 'board3dFailed',
					boardVersion,
					message: error instanceof Error ? error.message : 'Could not build the 3D model.'
				});
			}
		};

		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.source !== frame.contentWindow) return;

			const parsed = frameMessageSchema.safeParse(event.data);

			if (!parsed.success) return;

			const message = parsed.data;

			switch (message.type) {
				case 'ready':
					postTheme();
					void load();
					break;
				case 'board3dRequest':
					void exportBoard(message.boardVersion);
					break;
				case 'loaded':
					// Otherwise the frame already has newer sources.
					if (message.revision !== revision) break;
					shown = true;
					setStatus({ kind: 'shown', updating: false, notice: null });
					break;
				case 'failed':
					if (message.revision !== null && message.revision !== revision) break;

					if (message.recovered) {
						fail(`Showing the last version that opened. ${message.message}`);
					} else {
						shown = false;
						setStatus({ kind: 'error', message: message.message });
					}
			}
		};

		scheduleReload.current = () => {
			clearTimeout(timer);
			timer = setTimeout(() => void load(), RELOAD_DELAY_MS);
		};

		addEventListener('message', onMessage);
		post({ type: 'hello' });

		const themeObserver = new MutationObserver(postTheme);

		themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });

		return () => {
			closed.abort();
			clearTimeout(timer);
			themeObserver.disconnect();
			removeEventListener('message', onMessage);
		};
	}, [api, file.workspacePath, file.path]);

	useEffect(() => {
		if (!api || !watched || !active || !visible) return;

		const controller = new AbortController();
		const { signal } = controller;
		const timers = new Set<ReturnType<typeof setTimeout>>();

		for (const path of watched.split('\n')) {
			const watch = async () => {
				try {
					await api.watchWorkspaceFile(
						{ workspacePath: file.workspacePath, path },
						{
							signal,
							onEvent: (event) => {
								const version = event.kind === 'snapshot' ? event.version : null;
								const known = versions.current.get(path);

								versions.current.set(path, version);

								if (known !== undefined && known !== version) scheduleReload.current();
							}
						}
					);
				} catch {}

				if (!signal.aborted) timers.add(setTimeout(watch, RECONNECT_MS));
			};

			void watch();
		}

		return () => {
			controller.abort();
			timers.forEach(clearTimeout);
		};
	}, [api, file.workspacePath, watched, active, visible]);

	const pill =
		status.kind === 'shown' ? (status.notice ?? (status.updating ? 'Updating…' : null)) : null;

	return (
		<div className="relative min-h-0 flex-1">
			{/* Keyed so each file gets a fresh viewer. */}
			<iframe
				key={`${file.workspacePath}\n${file.path}`}
				ref={frameRef}
				title={`KiCad viewer for ${file.path}`}
				src="/kicad-viewer.html"
				sandbox="allow-scripts allow-downloads"
				allow="fullscreen"
				className="absolute inset-0 size-full border-0"
			/>
			{status.kind !== 'shown' && (
				<div
					role={status.kind === 'error' ? 'alert' : 'status'}
					className="bg-background text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-sm"
				>
					{status.kind === 'error' ? status.message : 'Opening the KiCad viewer…'}
				</div>
			)}
			{pill && (
				<div
					role={status.kind === 'shown' && status.notice ? 'alert' : 'status'}
					className="bg-background/80 text-muted-foreground border-hairline absolute top-10 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md border px-3 py-1.5 text-xs backdrop-blur"
				>
					{pill}
				</div>
			)}
		</div>
	);
}
