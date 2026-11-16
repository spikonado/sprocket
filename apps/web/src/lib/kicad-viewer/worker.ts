import {
	clipTransform,
	fitCamera,
	panCamera,
	toBoard,
	wheelZoomFactor,
	zoomCamera,
	type Camera
} from '$lib/kicad-viewer/camera';
import { cssColor, layerColor } from '$lib/kicad-viewer/colors';
import {
	compareRanks,
	drawRank,
	drawsOverSelection,
	visibleByDefault
} from '$lib/kicad-viewer/layers';
import { bestHit, PickIndex } from '$lib/kicad-viewer/pick-index';
import type {
	FromWorker,
	PickedItem,
	PointerPhase,
	Stream,
	ToWorker,
	View,
	ViewportSize,
	ViewerLayer
} from '$lib/kicad-viewer/protocol';
import { BoardRenderer, type DrawLayer } from '$lib/kicad-viewer/renderer';
import type { Board3d } from '$lib/kicad-viewer/board-3d';
import { decodeScene, type Scene } from '$lib/kicad-viewer/scene';

const CLICK_SLOP_PX = 4;
const PICK_TOLERANCE_PX = 3;
const LABEL_MIN_STROKE_PX = 0.5;

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let size: ViewportSize = { width: 0, height: 0, dpr: 1 };
let scene: Scene | null = null;
let renderer: BoardRenderer | null = null;
let index: PickIndex | null = null;
let camera: Camera | null = null;
let flipped = false;
let visible: boolean[] = [];
let selected: number | null = null;
let flags = new Uint8Array(0);
let frameRequested = false;
let shown: View | null = '2d';
let board3d: Promise<Board3d | null> | null = null;

const incoming: Record<Stream, { load: number; chunks: Uint8Array[] }> = {
	scene: { load: 0, chunks: [] },
	models: { load: 0, chunks: [] }
};

const pointers = new Map<number, { x: number; y: number }>();
let gesture = { moved: false, startX: 0, startY: 0, distance: 0 };

self.addEventListener('message', ({ data }: MessageEvent<ToWorker>) => {
	try {
		handle(data);
	} catch (error) {
		post({ type: 'error', view: '2d', message: errorMessage(error) });
	}
});

function handle(message: ToWorker) {
	switch (message.type) {
		case 'init':
			return message.view === '2d'
				? init(message.canvas, message)
				: init3d(message.canvas, message);
		case 'chunk':
			receiveChunk(message.stream, message.load).push(message.bytes);

			return;
		case 'end': {
			const bytes = concat(receiveChunk(message.stream, message.load).splice(0));

			if (message.stream === 'models') return with3d((board) => board.setModels(bytes));

			// Without a context, init already reported why the board can't be drawn.
			if (gl) load(gl, bytes);

			return;
		}

		case 'resize':
			return message.view === '2d' ? resize(message) : with3d((board) => board.resize(message));
		case 'pointer':
			if (message.view === '3d') return with3d((board) => board.pointer(message));

			return pointer(message.phase, message.id, message.x, message.y);
		case 'wheel': {
			if (message.view === '3d') return with3d((board) => board.wheel(message));

			return moveCamera((current) =>
				zoomCamera(current, size, message.x, message.y, 1 / wheelZoomFactor(message, size.height))
			);
		}

		case 'show':
			shown = message.view;
			with3d((board) => board.setShown(shown === '3d'));

			return requestFrame();
		case 'layerVisible': {
			scene?.layers.forEach(({ name }, layer) => {
				if (name === message.name) visible[layer] = message.visible;
			});

			return requestFrame();
		}

		case 'componentsVisible':
			return with3d((board) => board.setComponentsVisible(message.visible));
		case 'fit':
			if (message.view === '3d') return with3d((board) => board.fit());
			camera = null;

			return requestFrame();
		case 'flip':
			if (message.view === '3d') return with3d((board) => board.flip(message.flipped));
			flipped = message.flipped;

			return moveCamera((current) => ({ ...current, flipped }));
		case 'clearSelection':
			return select(null);
	}
}

/** three.js loads only once the 3D view first opens, so 2D-only use never pays for it. */
function init3d(offscreen: OffscreenCanvas, viewport: ViewportSize) {
	board3d = import('$lib/kicad-viewer/board-3d')
		.then(({ Board3d }) => new Board3d(offscreen, viewport, post))
		.catch((cause: unknown) => {
			post({ type: 'error', view: '3d', message: errorMessage(cause) });

			return null;
		});

	with3d((board) => {
		if (scene) board.setScene(scene);
		board.setShown(shown === '3d');
	});
}

/** Runs `use` once the 3D view exists, in message order. */
function with3d(use: (board: Board3d) => void) {
	board3d =
		board3d?.then((board) => {
			try {
				if (board) use(board);
			} catch (error) {
				post({ type: 'error', view: '3d', message: errorMessage(error) });
			}

			return board;
		}) ?? null;
}

function errorMessage(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

function init(offscreen: OffscreenCanvas, viewport: ViewportSize) {
	canvas = offscreen;

	const context = offscreen.getContext('webgl2', {
		antialias: true,
		alpha: false,
		depth: false,
		stencil: true
	});

	if (!context) throw new Error('This browser can’t draw boards: WebGL2 isn’t available.');

	gl = context;

	offscreen.addEventListener('webglcontextlost', (event) => {
		event.preventDefault();
		renderer = null;
	});

	offscreen.addEventListener('webglcontextrestored', () => {
		if (scene) {
			renderer = new BoardRenderer(context, scene);
			renderer.setFlags(flags);
		}

		requestFrame();
	});

	resize(viewport);
}

/** The chunks of load `load`. A newer load drops the chunks of an unfinished older one. */
function receiveChunk(stream: Stream, load: number) {
	const current = incoming[stream];

	if (load > current.load) {
		current.load = load;
		current.chunks = [];
	}

	return load === current.load ? current.chunks : [];
}

function concat(chunks: Uint8Array[]) {
	const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}

	return bytes.buffer;
}

/**
 * Keeps each layer's visibility by name, so a reload keeps the user's layer choices. The layer
 * list has one entry per board layer, which toggles all of that layer's parts.
 */
function load(context: WebGL2RenderingContext, buffer: ArrayBuffer) {
	const next = decodeScene(buffer);
	const previous = new Map(scene?.layers.map(({ name }, layer) => [name, visible[layer]]));

	renderer?.dispose();
	renderer = null;
	scene = next;
	index = null;
	visible = next.layers.map((layer) => previous.get(layer.name) ?? visibleByDefault(layer));
	renderer = new BoardRenderer(context, next);

	const listed = new Map<string, ViewerLayer>();

	for (const part of drawOrder(next, false)) {
		const layer = next.layers[part];

		if (listed.has(layer.name)) continue;
		listed.set(layer.name, {
			name: layer.name,
			label: layer.userName ?? layer.name,
			color: cssColor(layerColor(layer)),
			visible: visible[part]
		});
	}

	post({ type: 'loaded', layers: [...listed.values()].reverse(), models: next.meta.models });
	with3d((board) => board.setScene(next));

	// Item indexes don't survive a reload, so the selection can't either.
	select(null, selected !== null);
}

function resize(viewport: ViewportSize) {
	size = viewport;

	// A hidden viewer reports zero. Keeping the old canvas size avoids a blank frame on return.
	if (!canvas || !hasSize()) return;

	canvas.width = Math.round(viewport.width * viewport.dpr);
	canvas.height = Math.round(viewport.height * viewport.dpr);
	requestFrame();
}

function hasSize() {
	return size.width > 0 && size.height > 0;
}

function pointer(phase: PointerPhase, id: number, x: number, y: number) {
	const previous = pointers.get(id);

	if (phase === 'down') {
		pointers.set(id, { x, y });

		if (pointers.size === 1) gesture = { moved: false, startX: x, startY: y, distance: 0 };
		else gesture = { ...gesture, moved: true, distance: pinchDistance() };

		return;
	}

	if (!previous) return;

	if (phase === 'move') {
		const before = pinchCenter();
		pointers.set(id, { x, y });

		if (Math.hypot(x - gesture.startX, y - gesture.startY) > CLICK_SLOP_PX) gesture.moved = true;

		if (pointers.size === 1)
			return moveCamera((current) => panCamera(current, x - previous.x, y - previous.y));

		const after = pinchCenter();
		const distance = pinchDistance();
		const factor = gesture.distance > 0 ? distance / gesture.distance : 1;
		gesture.distance = distance;

		return moveCamera((current) =>
			zoomCamera(
				panCamera(current, after.x - before.x, after.y - before.y),
				size,
				after.x,
				after.y,
				factor
			)
		);
	}

	pointers.delete(id);

	if (pointers.size > 1) gesture.distance = pinchDistance();

	if (phase === 'up' && pointers.size === 0 && !gesture.moved) pick(x, y);
}

function pinchCenter() {
	const points = [...pointers.values()].slice(0, 2);

	return {
		x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
		y: points.reduce((sum, point) => sum + point.y, 0) / points.length
	};
}

function pinchDistance() {
	const [a, b] = [...pointers.values()];

	return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function moveCamera(change: (current: Camera) => Camera) {
	const current = currentCamera();

	if (!current) return;
	camera = change(current);
	requestFrame();
}

/** Fits once the viewport has a size, since a hidden panel reports zero. */
function currentCamera() {
	if (!camera && scene && hasSize()) {
		camera = fitCamera(scene.meta.bounds, size, flipped);
	}

	return camera;
}

/** Layer part indexes from bottom to top for one side of the board. */
function drawOrder(current: Scene, fromBack: boolean) {
	const ranks = current.layers.map((layer) => drawRank(layer, fromBack));

	return current.layers.map((_, layer) => layer).sort((a, b) => compareRanks(ranks[a], ranks[b]));
}

function pick(x: number, y: number) {
	const current = currentCamera();

	if (!scene || !current) return;
	index ??= new PickIndex(scene);

	const order = drawOrder(scene, flipped);
	const [bx, by] = toBoard(current, size, x, y);
	const hits = index.hits(bx, by, PICK_TOLERANCE_PX / current.zoom, (layer) => visible[layer]);
	const best = bestHit(hits, scene, (layer) => order.indexOf(layer));

	select(best?.item ?? null);
}

function select(item: number | null, announce = true) {
	if (!scene) return;

	const { items } = scene.meta;
	selected = item;
	flags = new Uint8Array(items.length);

	if (item !== null) {
		flags[item] = 1;

		if (items[item].kind === 'footprint') {
			items.forEach(({ parent }, child) => {
				if (parent === item) flags[child] = 1;
			});
		}
	}

	renderer?.setFlags(flags);
	requestFrame();

	if (!announce) return;

	const parent = item === null ? null : items[item].parent;

	post({
		type: 'pick',
		pick:
			item === null
				? null
				: { item: describe(item), parent: parent === null ? null : describe(parent) }
	});
}

function describe(item: number): PickedItem {
	const { kind, layer, net, reference, value, footprint, number, text, position } =
		scene!.meta.items[item];

	return {
		kind,
		layer,
		net: net ? scene!.meta.nets[net] || null : null,
		reference,
		value,
		footprint,
		number,
		text,
		position
	};
}

function requestFrame() {
	if (frameRequested) return;
	frameRequested = true;

	if ('requestAnimationFrame' in self) self.requestAnimationFrame(drawFrame);
	else setTimeout(drawFrame, 16);
}

function drawFrame() {
	frameRequested = false;

	const current = currentCamera();

	if (shown !== '2d' || !scene || !renderer || !current || !hasSize() || gl?.isContextLost()) {
		return;
	}

	const layers: DrawLayer[] = [];
	const overlays: DrawLayer[] = [];

	for (const part of drawOrder(scene, flipped)) {
		if (!visible[part]) continue;

		const layer = scene.layers[part];

		(drawsOverSelection(drawRank(layer, flipped)) ? overlays : layers).push({
			index: part,
			color: layerColor(layer),
			minWidthPx: layer.part === 'labels' ? LABEL_MIN_STROKE_PX * size.dpr : 0
		});
	}

	const { scale, offset } = clipTransform(current, size);

	renderer.draw({
		scale,
		offset,
		pxPerMm: current.zoom * size.dpr,
		layers,
		overlays,
		selection: selected !== null
	});

	// Build the pick index after the first frame is on screen, so opening shows the board first.
	if (!index) setTimeout(() => (index ??= scene && new PickIndex(scene)), 0);
}

function post(message: FromWorker) {
	self.postMessage(message);
}
