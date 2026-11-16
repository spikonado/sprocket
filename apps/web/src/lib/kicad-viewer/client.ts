import type {
	FromWorker,
	PickResult,
	PointerPhase,
	Stream,
	ToWorker,
	View,
	ViewerLayer
} from '$lib/kicad-viewer/protocol';

type ViewerEvents = {
	onLoaded: (layers: ViewerLayer[], models: string | null) => void;
	onPick: (pick: PickResult | null) => void;
	onError: (view: View, message: string) => void;
	onModels: (error: string | null) => void;
};

/**
 * Both canvases share a worker. The 3D canvas and three.js start only on the first `show('3d')`.
 */
export class BoardViewerClient {
	private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	private readonly canvases = new Map<View, HTMLCanvasElement>();
	private readonly sizes = new Map<View, { width: number; height: number }>();
	private readonly resizeObserver: ResizeObserver;
	private readonly listeners = new AbortController();
	private readonly loads: Record<Stream, number> = { scene: 0, models: 0 };

	constructor(
		private readonly container: HTMLElement,
		events: ViewerEvents
	) {
		this.worker.addEventListener('message', ({ data }: MessageEvent<FromWorker>) => {
			if (data.type === 'loaded') events.onLoaded(data.layers, data.models);
			else if (data.type === 'pick') events.onPick(data.pick);
			else if (data.type === 'models') events.onModels(data.error);
			else events.onError(data.view, data.message);
		});

		this.worker.addEventListener('error', (event) => {
			event.preventDefault();
			events.onError('2d', event.message || 'The board viewer stopped.');
		});

		this.resizeObserver = new ResizeObserver((entries) => {
			for (const { target, contentRect } of entries) {
				const view = target === this.canvases.get('3d') ? '3d' : '2d';
				this.sizes.set(view, { width: contentRect.width, height: contentRect.height });
				this.post({ type: 'resize', view, ...this.viewport(view) });
			}
		});

		this.attach('2d');
		this.watchDpr();
	}

	/** Shows one view and draws only it, or hides both with `null`. */
	show(view: View | null) {
		if (view && !this.canvases.has(view)) this.attach(view);

		for (const [name, canvas] of this.canvases) canvas.hidden = name !== view;
		this.post({ type: 'show', view });
	}

	/**
	 * Moves each chunk of `stream` to the worker without copying, so the page never holds the
	 * whole file. Transferring the stream itself makes Firefox copy every chunk on this thread.
	 * A `null` stream sends an empty file.
	 */
	async load(kind: Stream, stream: ReadableStream<Uint8Array<ArrayBuffer>> | null) {
		const load = ++this.loads[kind];
		const reader = stream?.getReader();

		if (reader) {
			while (true) {
				const chunk = await reader.read();

				if (chunk.done) break;

				if (load !== this.loads[kind]) return reader.cancel();

				this.post({ type: 'chunk', stream: kind, load, bytes: chunk.value }, [chunk.value.buffer]);
			}
		}

		if (load === this.loads[kind]) this.post({ type: 'end', stream: kind, load });
	}

	setLayerVisible(name: string, visible: boolean) {
		this.post({ type: 'layerVisible', name, visible });
	}

	setComponentsVisible(visible: boolean) {
		this.post({ type: 'componentsVisible', visible });
	}

	fit(view: View) {
		this.post({ type: 'fit', view });
	}

	flip(view: View, flipped: boolean) {
		this.post({ type: 'flip', view, flipped });
	}

	clearSelection() {
		this.post({ type: 'clearSelection' });
	}

	dispose() {
		this.worker.terminate();
		this.resizeObserver.disconnect();
		this.listeners.abort();

		for (const canvas of this.canvases.values()) canvas.remove();
	}

	private attach(view: View) {
		const canvas = document.createElement('canvas');
		const { signal } = this.listeners;

		canvas.style.cssText =
			'position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none';
		this.container.prepend(canvas);
		this.canvases.set(view, canvas);
		this.sizes.set(view, { width: 0, height: 0 });

		const offscreen = canvas.transferControlToOffscreen();
		this.post({ type: 'init', view, canvas: offscreen, ...this.viewport(view) }, [offscreen]);
		this.resizeObserver.observe(canvas);

		const maxButton = view === '3d' ? 2 : 1;

		const onPointer = (phase: PointerPhase) => (event: PointerEvent) => {
			if (phase === 'down') {
				if (event.button > maxButton) return;
				canvas.setPointerCapture(event.pointerId);
			} else if (!canvas.hasPointerCapture(event.pointerId) && phase === 'move') return;

			this.post({
				type: 'pointer',
				view,
				phase,
				id: event.pointerId,
				x: event.offsetX,
				y: event.offsetY,
				button: event.button,
				shift: event.shiftKey
			});
		};

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			this.post({
				type: 'wheel',
				view,
				x: event.offsetX,
				y: event.offsetY,
				deltaY: event.deltaY,
				deltaMode: event.deltaMode,
				pinch: event.ctrlKey
			});
		};

		canvas.addEventListener('pointerdown', onPointer('down'), { signal });
		canvas.addEventListener('pointermove', onPointer('move'), { signal });
		canvas.addEventListener('pointerup', onPointer('up'), { signal });
		canvas.addEventListener('pointercancel', onPointer('cancel'), { signal });
		canvas.addEventListener('wheel', onWheel, { passive: false, signal });

		if (view === '3d') {
			canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
		}
	}

	private viewport(view: View) {
		return { ...this.sizes.get(view)!, dpr: devicePixelRatio };
	}

	/** A resolution query matches only the current ratio, so re-arm it after each change. */
	private watchDpr() {
		const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);

		const onChange = () => {
			for (const view of this.canvases.keys()) {
				this.post({ type: 'resize', view, ...this.viewport(view) });
			}

			this.watchDpr();
		};

		query.addEventListener('change', onChange, { once: true, signal: this.listeners.signal });
	}

	private post(message: ToWorker, transfer: Transferable[] = []) {
		this.worker.postMessage(message, transfer);
	}
}
