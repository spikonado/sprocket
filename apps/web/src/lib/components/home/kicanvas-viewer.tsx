import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { readVisualThemeCss } from '$lib/chat/artifact-preview';
import ViewerStatusNotice, { type ViewerStatus } from '$lib/components/home/viewer-status';
import { readKicadSources } from '$lib/kicad';
import { usePageVisible } from '$lib/page-visibility';
import type { LocalApi, WorkspaceFileTarget } from '$lib/types/sprocket';

export type KicanvasViewerApi = Pick<LocalApi, 'readWorkspaceText' | 'watchWorkspaceFile'>;

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
 * KiCanvas parses on its page's main thread, which a same-site frame still shares with the app in
 * Firefox. Each load gets a fresh frame, since KiCanvas reads its sources only once.
 */
function createFrame(container: HTMLElement, title: string) {
	const frame = document.createElement('iframe');
	frame.title = title;
	frame.src = '/kicanvas-viewer.html';
	frame.sandbox.add('allow-scripts', 'allow-downloads');
	frame.allow = 'fullscreen';
	frame.className = 'absolute inset-0 size-full border-0';
	// A hidden frame stalls its drawing, so a new frame loads behind the shown one.
	container.prepend(frame);

	return frame;
}

export default function KicanvasViewer({
	api,
	file,
	active
}: {
	api: KicanvasViewerApi | null;
	file: WorkspaceFileTarget;
	active: boolean;
}) {
	const visible = usePageVisible();
	const containerRef = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<ViewerStatus>({ kind: 'loading' });
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
					readKicadSources(file.path, async (path) => {
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
					}),
					nextFrameMessage(frame, signal)
				]);

				if (ready.type !== 'ready') throw new Error('Could not load KiCanvas.');
				postTheme(frame);

				// KiCanvas never finishes a load without a non-blank schematic.
				if (!sources.some(({ name, content }) => name.endsWith('.kicad_sch') && content.trim())) {
					throw new Error(
						file.path.endsWith('.kicad_pro')
							? 'This project has no schematic.'
							: 'This KiCad file is empty.'
					);
				}

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

	return (
		<div ref={containerRef} className="absolute inset-0">
			<ViewerStatusNotice status={status} drawn={showing} opening="Opening in KiCanvas…" />
		</div>
	);
}
