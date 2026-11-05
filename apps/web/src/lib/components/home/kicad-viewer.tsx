import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { readVisualThemeCss } from '$lib/chat/artifact-preview';
import Board3dViewer from '$lib/components/home/board-3d-viewer';
import { readKicadSources } from '$lib/kicad';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

type KicadViewerApi = Pick<LocalApi, 'readWorkspaceText' | 'watchWorkspaceFile' | 'exportBoard3d'>;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

type Board = { path: string; version: string };

const VIEWS = ['2D', '3D'] as const;

/** Agents write a project's files one after another, so wait for the batch to land. */
const RELOAD_DELAY_MS = 1_000;

const RECONNECT_MS = 1_000;

const frameMessageSchema = z.union([
	z.object({ type: z.enum(['ready', 'parsed', 'loaded']) }),
	z.object({ type: z.literal('failed'), error: z.string().optional() }),
	z.object({
		type: z.literal('view'),
		view: z.object({ page: z.string(), x: z.number(), y: z.number(), zoom: z.number() }).nullable()
	})
]);

type FrameMessage = z.infer<typeof frameMessageSchema>;

const malformedFile = 'KiCanvas could not read this file. It may be malformed.';

function frameFailure(message: FrameMessage, fallback: string) {
	return new Error(
		message.type === 'failed' && message.error
			? `KiCanvas could not open this file: ${message.error}`
			: fallback
	);
}

function nextFrameMessage(frame: HTMLIFrameElement, signal: AbortSignal) {
	return new Promise<FrameMessage>((resolve, reject) => {
		const stop = () => {
			removeEventListener('message', onMessage);
			signal.removeEventListener('abort', onAbort);
		};

		const onAbort = () => {
			stop();
			reject(signal.reason);
		};

		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.source !== frame.contentWindow) return;

			const message = frameMessageSchema.safeParse(event.data);

			if (!message.success) return;
			stop();
			resolve(message.data);
		};

		if (signal.aborted) return reject(signal.reason);
		addEventListener('message', onMessage);
		signal.addEventListener('abort', onAbort);
	});
}

async function currentView(frame: HTMLIFrameElement, signal: AbortSignal) {
	const reply = nextFrameMessage(frame, signal);
	frame.contentWindow?.postMessage({ type: 'getView' }, '*');
	const message = await reply;

	return message.type === 'view' ? message.view : null;
}

function postTheme(frame: HTMLIFrameElement) {
	frame.contentWindow?.postMessage({ type: 'theme', css: readVisualThemeCss() }, '*');
}

/**
 * KiCanvas parses and draws on its page's main thread, which takes tens of seconds for large
 * boards. A sandboxed frame gets its own process in Chromium, so the rest of the app stays live.
 * Each load gets a fresh frame, since KiCanvas reads its sources only once.
 */
function createFrame(container: HTMLElement, title: string) {
	const frame = document.createElement('iframe');
	frame.title = title;
	frame.src = '/kicanvas-viewer.html';
	frame.sandbox.add('allow-scripts', 'allow-downloads');
	frame.allow = 'fullscreen';
	frame.className = 'absolute inset-0 size-full border-0';
	// Behind the shown frame until it has drawn. Hiding it instead would stall its drawing.
	container.prepend(frame);

	return frame;
}

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
	const containerRef = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<Status>({ kind: 'loading' });
	const [showing, setShowing] = useState(false);
	const [watched, setWatched] = useState('');
	const [board, setBoard] = useState<Board | null>(null);
	const [view, setView] = useState<(typeof VIEWS)[number]>('2D');
	const scheduleReload = useRef(() => {});
	const versions = useRef(new Map<string, string | null>());

	useEffect(() => {
		const container = containerRef.current;

		if (!api || !container) return;

		const closed = new AbortController();
		let shown: HTMLIFrameElement | null = null;
		let attempt: AbortController | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		versions.current = new Map();
		setShowing(false);
		setWatched('');
		setBoard(null);
		setView('2D');

		const load = async () => {
			attempt?.abort();
			const own = new AbortController();
			attempt = own;

			const signal = AbortSignal.any([closed.signal, own.signal]);
			const frame = createFrame(container, `KiCanvas viewer for ${file.path}`);
			const read = new Set<string>();

			setStatus({ kind: 'loading' });

			try {
				const [sources, ready] = await Promise.all([
					readKicadSources(file.path, async (path) => {
						read.add(path);

						try {
							const text = await api.readWorkspaceText(
								{ workspacePath: file.workspacePath, path },
								signal
							);

							// The watch compares its first version with this, so writes during the load count.
							if (!signal.aborted) versions.current.set(path, text.version);

							return text.content;
						} catch (error) {
							if (!signal.aborted) versions.current.set(path, null);
							throw error;
						}
					}),
					nextFrameMessage(frame, signal)
				]);

				if (ready.type !== 'ready') throw new Error('Could not load KiCanvas.');
				postTheme(frame);

				// KiCanvas skips blank sources without ever finishing its load.
				if (sources.every(({ content }) => !content.trim())) {
					throw new Error('This KiCad file is empty.');
				}

				const boardName = sources.find(({ name }) => name.endsWith('.kicad_pcb'))?.name;

				const boardPath =
					boardName && file.path.slice(0, file.path.lastIndexOf('/') + 1) + boardName;

				// Set before KiCanvas parses, so 3D still works for a board KiCanvas can't draw.
				setBoard(
					boardPath ? { path: boardPath, version: versions.current.get(boardPath) ?? '' } : null
				);

				const parsed = nextFrameMessage(frame, signal);
				frame.contentWindow?.postMessage({ type: 'sources', sources }, '*');
				const parse = await parsed;

				if (parse.type !== 'parsed') throw frameFailure(parse, malformedFile);

				const view = shown ? await currentView(shown, signal) : null;
				const outcome = nextFrameMessage(frame, signal);
				frame.contentWindow?.postMessage({ type: 'show', view }, '*');
				const result = await outcome;

				if (result.type !== 'loaded') throw frameFailure(result, malformedFile);

				shown?.remove();
				shown = frame;
				setShowing(true);
				setStatus({ kind: 'ready' });
			} catch (error) {
				frame.remove();

				if (signal.aborted) return;

				setStatus({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not open the KiCad file.'
				});
			} finally {
				if (!signal.aborted) setWatched([...read].sort().join('\n'));
				// Drops listeners that a failed read left waiting on the frame.
				own.abort();
			}
		};

		scheduleReload.current = () => {
			clearTimeout(timer);
			timer = setTimeout(() => void load(), RELOAD_DELAY_MS);
		};

		void load();

		const themeObserver = new MutationObserver(() =>
			container.querySelectorAll('iframe').forEach(postTheme)
		);

		themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });

		return () => {
			closed.abort();
			clearTimeout(timer);
			themeObserver.disconnect();
			shown?.remove();
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
								// `null` while the file can't be read, such as before an agent creates it.
								const version = event.kind === 'snapshot' ? event.version : null;
								const known = versions.current.get(path);

								versions.current.set(path, version);

								if (known !== undefined && known !== version) scheduleReload.current();
							}
						}
					);
				} catch {
					// A dropped socket ends the watch; the next one starts from a fresh snapshot.
				}

				if (!signal.aborted) timers.add(setTimeout(watch, RECONNECT_MS));
			};

			void watch();
		}

		return () => {
			controller.abort();
			timers.forEach(clearTimeout);
		};
	}, [api, file.workspacePath, watched, active, visible]);

	return (
		<div ref={containerRef} className="relative min-h-0 flex-1">
			{board && api && (
				<>
					<Board3dViewer
						api={api}
						workspacePath={file.workspacePath}
						path={board.path}
						revision={board.version}
						shown={view === '3D'}
					/>
					<div
						role="group"
						aria-label="Board view"
						className="bg-muted absolute top-3 left-3 z-30 flex rounded-full p-0.5 text-xs font-medium shadow-sm"
					>
						{VIEWS.map((item) => (
							<button
								key={item}
								type="button"
								aria-pressed={view === item}
								onClick={() => setView(item)}
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
				</>
			)}
			{status.kind !== 'ready' && (
				<div
					role={status.kind === 'error' ? 'alert' : 'status'}
					className={
						showing
							? 'bg-background/80 text-muted-foreground border-hairline absolute bottom-3 left-1/2 z-10 max-w-[80%] -translate-x-1/2 truncate rounded-md border px-3 py-1.5 text-xs backdrop-blur'
							: 'bg-background text-muted-foreground absolute inset-0 z-10 flex items-center justify-center p-4 text-center text-sm'
					}
				>
					{status.kind === 'error'
						? status.message
						: showing
							? 'Updating…'
							: 'Opening in KiCanvas…'}
				</div>
			)}
		</div>
	);
}
