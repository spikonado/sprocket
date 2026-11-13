import {
	clipTransform,
	fitCamera,
	panCamera,
	toBoard,
	zoomCamera,
	type Camera
} from '$lib/kicad-viewer/camera';
import { cssColor, layerColor } from '$lib/kicad-viewer/colors';
import { bestHit, PickIndex } from '$lib/kicad-viewer/pick-index';
import type {
	FromWorker,
	PickedItem,
	PointerPhase,
	ToWorker,
	ViewportSize
} from '$lib/kicad-viewer/protocol';
import { BoardRenderer, type DrawLayer } from '$lib/kicad-viewer/renderer';
import { decodeScene, type Scene, type SceneLayerMeta } from '$lib/kicad-viewer/scene';

const CLICK_SLOP_PX = 4;
const PICK_TOLERANCE_PX = 3;
const WHEEL_ZOOM_PER_PX = 0.002;
const PINCH_ZOOM_PER_PX = 0.01;
const LINE_PX = 16;

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
let incomingLoad = 0;
let incomingChunks: Uint8Array[] = [];

const pointers = new Map<number, { x: number; y: number }>();
let gesture = { moved: false, startX: 0, startY: 0, distance: 0 };

self.addEventListener('message', ({ data }: MessageEvent<ToWorker>) => {
	try {
		handle(data);
	} catch (error) {
		post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
	}
});

function handle(message: ToWorker) {
	switch (message.type) {
		case 'init':
			return init(message.canvas, message);
		case 'sceneChunk':
			receiveChunk(message.load).push(message.bytes);

			return;
		case 'sceneEnd': {
			const chunks = receiveChunk(message.load).splice(0);

			// Without a context, init already reported why the board can't be drawn.
			if (gl) load(gl, concat(chunks));

			return;
		}

		case 'resize':
			return resize(message);
		case 'pointer':
			return pointer(message.phase, message.id, message.x, message.y);
		case 'wheel': {
			const pixels =
				message.deltaY *
				(message.deltaMode === 1 ? LINE_PX : message.deltaMode === 2 ? size.height : 1);

			const rate = message.pinch ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX;

			return moveCamera((current) =>
				zoomCamera(current, size, message.x, message.y, Math.exp(-pixels * rate))
			);
		}

		case 'layerVisible': {
			const layer = scene?.layers.findIndex(({ name }) => name === message.name) ?? -1;

			if (layer >= 0) visible[layer] = message.visible;

			return requestFrame();
		}

		case 'fit':
			camera = null;

			return requestFrame();
		case 'flip':
			flipped = message.flipped;

			return moveCamera((current) => ({ ...current, flipped }));
		case 'clearSelection':
			return select(null);
	}
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
function receiveChunk(load: number) {
	if (load > incomingLoad) {
		incomingLoad = load;
		incomingChunks = [];
	}

	return load === incomingLoad ? incomingChunks : [];
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

/** Keeps each layer's visibility by name, so a reload keeps the user's layer choices. */
function load(context: WebGL2RenderingContext, buffer: ArrayBuffer) {
	const next = decodeScene(buffer);
	const previous = new Map(scene?.layers.map(({ name }, layer) => [name, visible[layer]]));

	renderer?.dispose();
	renderer = null;
	scene = next;
	index = null;
	visible = next.layers.map((layer) => previous.get(layer.name) ?? visibleByDefault(layer));
	renderer = new BoardRenderer(context, next);

	post({
		type: 'loaded',
		layers: next.layers
			.map((layer, layerIndex) => ({
				name: layer.name,
				label: layer.userName ?? layer.name,
				color: cssColor(layerColor(layer)),
				visible: visible[layerIndex]
			}))
			.reverse()
	});

	// Item indexes don't survive a reload, so the selection can't either.
	select(null, selected !== null);
}

function visibleByDefault(layer: SceneLayerMeta) {
	return layer.kind !== 'paste' && layer.name !== 'Margin';
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

/** Bottom to top for the current side. Holes always come last. */
function drawOrder(current: Scene) {
	const order = current.layers
		.map((_, layer) => layer)
		.filter((layer) => current.layers[layer].kind !== 'holes');

	if (flipped) order.reverse();

	const holes = current.layers.findIndex(({ kind }) => kind === 'holes');

	return holes >= 0 ? [...order, holes] : order;
}

function pick(x: number, y: number) {
	const current = currentCamera();

	if (!scene || !current) return;
	index ??= new PickIndex(scene);

	const order = drawOrder(scene);
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

	if (!scene || !renderer || !current || !hasSize() || gl?.isContextLost()) return;

	const layerOf = (layer: number): DrawLayer => ({
		index: layer,
		color: layerColor(scene!.layers[layer])
	});

	const shown = drawOrder(scene).filter((layer) => visible[layer]);
	const top = shown.at(-1);
	const holes = top !== undefined && scene.layers[top].kind === 'holes' ? top : null;
	const { scale, offset } = clipTransform(current, size);

	renderer.draw({
		scale,
		offset,
		pxPerMm: current.zoom * size.dpr,
		layers: (holes === null ? shown : shown.slice(0, -1)).map(layerOf),
		holes: holes === null ? null : layerOf(holes),
		selection: selected !== null
	});

	// Build the pick index after the first frame is on screen, so opening shows the board first.
	if (!index) setTimeout(() => (index ??= scene && new PickIndex(scene)), 0);
}

function post(message: FromWorker) {
	self.postMessage(message);
}
