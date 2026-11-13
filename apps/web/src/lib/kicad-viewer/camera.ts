import type { Bounds } from '$lib/kicad-viewer/scene';

/** `zoom` is CSS pixels per mm. Flipping mirrors x around the view's center. */
export type Camera = { cx: number; cy: number; zoom: number; flipped: boolean };

export type Size = { width: number; height: number };

const FIT_MARGIN = 0.92;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 100_000;

export function fitCamera(bounds: Bounds, size: Size, flipped: boolean): Camera {
	const [minX, minY, maxX, maxY] = bounds;
	const width = Math.max(maxX - minX, 1);
	const height = Math.max(maxY - minY, 1);

	return {
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		zoom: clampZoom(Math.min(size.width / width, size.height / height) * FIT_MARGIN),
		flipped
	};
}

export function toBoard(camera: Camera, size: Size, x: number, y: number): [number, number] {
	const sign = camera.flipped ? -1 : 1;

	return [
		camera.cx + (sign * (x - size.width / 2)) / camera.zoom,
		camera.cy + (y - size.height / 2) / camera.zoom
	];
}

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
	const sign = camera.flipped ? -1 : 1;

	return { ...camera, cx: camera.cx - (sign * dx) / camera.zoom, cy: camera.cy - dy / camera.zoom };
}

/** Keeps the board point under `(x, y)` in place. */
export function zoomCamera(camera: Camera, size: Size, x: number, y: number, factor: number) {
	const zoom = clampZoom(camera.zoom * factor);
	const [bx, by] = toBoard(camera, size, x, y);
	const sign = camera.flipped ? -1 : 1;

	return {
		...camera,
		zoom,
		cx: bx - (sign * (x - size.width / 2)) / zoom,
		cy: by - (y - size.height / 2) / zoom
	};
}

/** Maps board mm to clip space as `clip = board * scale + offset`. */
export function clipTransform(camera: Camera, size: Size) {
	const sx = ((camera.flipped ? -2 : 2) * camera.zoom) / size.width;
	const sy = (-2 * camera.zoom) / size.height;

	return { scale: [sx, sy], offset: [-camera.cx * sx, -camera.cy * sy] } as const;
}

function clampZoom(zoom: number) {
	return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}
