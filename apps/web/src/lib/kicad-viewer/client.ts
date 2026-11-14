import type {
	FromWorker,
	PickResult,
	PointerPhase,
	ToWorker,
	ViewerLayer
} from '$lib/kicad-viewer/protocol';

type ViewerEvents = {
	onLoaded: (layers: ViewerLayer[]) => void;
	onPick: (pick: PickResult | null) => void;
	onError: (message: string) => void;
};

/**
 * Owns a canvas whose drawing runs in a worker, so a large board never blocks the page. The
 * main thread only forwards input and size, and gets back the layer list and picked items.
 */
export class BoardViewerClient {
	private readonly canvas = document.createElement('canvas');
	private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	private readonly resizeObserver: ResizeObserver;
	private readonly listeners = new AbortController();
	private size = { width: 0, height: 0 };
	private loads = 0;

	constructor(container: HTMLElement, events: ViewerEvents) {
		const { canvas, worker } = this;
		const { signal } = this.listeners;

		canvas.style.cssText =
			'position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none';
		container.prepend(canvas);

		worker.addEventListener('message', ({ data }: MessageEvent<FromWorker>) => {
			if (data.type === 'loaded') events.onLoaded(data.layers);
			else if (data.type === 'pick') events.onPick(data.pick);
			else events.onError(data.message);
		});

		worker.addEventListener('error', (event) => {
			event.preventDefault();
			events.onError(event.message || 'The board viewer stopped.');
		});

		const offscreen = canvas.transferControlToOffscreen();
		this.post({ type: 'init', canvas: offscreen, ...this.viewport() }, [offscreen]);

		this.resizeObserver = new ResizeObserver(([entry]) => {
			this.size = { width: entry.contentRect.width, height: entry.contentRect.height };
			this.post({ type: 'resize', ...this.viewport() });
		});
		this.resizeObserver.observe(canvas);
		this.watchDpr();

		const onPointer = (phase: PointerPhase) => (event: PointerEvent) => {
			if (phase === 'down') {
				if (event.button > 1) return;
				canvas.setPointerCapture(event.pointerId);
			} else if (!canvas.hasPointerCapture(event.pointerId) && phase === 'move') return;

			this.post({
				type: 'pointer',
				phase,
				id: event.pointerId,
				x: event.offsetX,
				y: event.offsetY
			});
		};

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			this.post({
				type: 'wheel',
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
	}

	/**
	 * Moves each chunk of `scene` to the worker without copying, so the page never holds the
	 * whole scene. Transferring the stream itself makes Firefox copy every chunk on this thread.
	 */
	async load(scene: ReadableStream<Uint8Array<ArrayBuffer>>) {
		const load = ++this.loads;
		const reader = scene.getReader();

		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			if (load !== this.loads) return reader.cancel();

			this.post({ type: 'sceneChunk', load, bytes: chunk.value }, [chunk.value.buffer]);
		}

		if (load === this.loads) this.post({ type: 'sceneEnd', load });
	}

	setLayerVisible(name: string, visible: boolean) {
		this.post({ type: 'layerVisible', name, visible });
	}

	fit() {
		this.post({ type: 'fit' });
	}

	flip(flipped: boolean) {
		this.post({ type: 'flip', flipped });
	}

	clearSelection() {
		this.post({ type: 'clearSelection' });
	}

	dispose() {
		this.worker.terminate();
		this.resizeObserver.disconnect();
		this.listeners.abort();
		this.canvas.remove();
	}

	private viewport() {
		return { ...this.size, dpr: devicePixelRatio };
	}

	/** A resolution query matches only the current ratio, so re-arm it after each change. */
	private watchDpr() {
		const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);

		const onChange = () => {
			this.post({ type: 'resize', ...this.viewport() });
			this.watchDpr();
		};

		query.addEventListener('change', onChange, { once: true, signal: this.listeners.signal });
	}

	private post(message: ToWorker, transfer: Transferable[] = []) {
		this.worker.postMessage(message, transfer);
	}
}
