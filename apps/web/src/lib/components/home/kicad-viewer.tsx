import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { readKicadSources } from '$lib/kicad';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type KicadViewerApi = Pick<LocalApi, 'readWorkspaceText' | 'watchWorkspaceFile'>;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/** Agents write a project's files one after another, so wait for the batch to land. */
const RELOAD_DELAY_MS = 1_000;

const RECONNECT_MS = 1_000;

const frameMessageSchema = z.union([
	z.object({ type: z.enum(['ready', 'loaded', 'failed']) }),
	z.object({
		type: z.literal('view'),
		view: z.object({ page: z.string(), x: z.number(), y: z.number(), zoom: z.number() }).nullable()
	})
]);

type FrameMessage = z.infer<typeof frameMessageSchema>;

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

/** Reloads when any file the project read changes, keeping the user's page and camera. */
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
					readKicadSources(file.path, (path) => {
						read.add(path);

						return api.readWorkspaceText({ workspacePath: file.workspacePath, path }, signal);
					}),
					nextFrameMessage(frame, signal)
				]);

				if (ready.type !== 'ready') throw new Error('Could not load KiCanvas.');

				const view = shown ? await currentView(shown, signal) : null;
				const outcome = nextFrameMessage(frame, signal);
				frame.contentWindow?.postMessage({ type: 'sources', sources, view }, '*');

				if ((await outcome).type !== 'loaded') {
					throw new Error('KiCanvas could not read this file. It may be malformed.');
				}

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

		return () => {
			closed.abort();
			clearTimeout(timer);
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
			{showing ? (
				status.kind !== 'ready' && (
					<div
						role={status.kind === 'error' ? 'alert' : 'status'}
						className="bg-background/80 text-muted-foreground border-hairline absolute bottom-3 left-1/2 z-10 max-w-[80%] -translate-x-1/2 truncate rounded-md border px-3 py-1.5 text-xs backdrop-blur"
					>
						{status.kind === 'error' ? status.message : 'Updating…'}
					</div>
				)
			) : (
				<div
					role={status.kind === 'error' ? 'alert' : 'status'}
					className="bg-background text-muted-foreground absolute inset-0 z-10 flex items-center justify-center p-4 text-center text-sm"
				>
					{status.kind === 'error' ? status.message : 'Opening in KiCanvas…'}
				</div>
			)}
		</div>
	);
}
