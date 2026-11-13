import {
	CIRCLE_BYTES,
	SEGMENT_BYTES,
	VERTEX_BYTES,
	type Bounds,
	type Scene
} from '$lib/kicad-viewer/scene';

export type Hit = { item: number; layer: number };

const SEGMENT = 0;
const CIRCLE = 1;
const TRIANGLE = 2;

/** Zone fills cover many cells, so entries grow with cells times copper layers. This caps that. */
const MAX_CELLS = 1 << 18;
const PRIMITIVES_PER_CELL = 4;

/**
 * A uniform grid over every primitive, with one flat entry list per cell. Primitives get global
 * ids, numbered by layer and then by segments, circles and triangles, so an entry is one u32.
 */
export class PickIndex {
	private readonly f32: Float32Array;
	private readonly u32: Uint32Array;
	/** `starts[layer * 3 + kind]` is the first global id of that layer's primitives of that kind. */
	private readonly starts: Uint32Array;
	private readonly minX: number;
	private readonly minY: number;
	private readonly cell: number;
	private readonly cols: number;
	private readonly rows: number;
	private readonly cellStarts: Uint32Array;
	private readonly entries: Uint32Array;
	private readonly outline = new Float64Array(8);

	constructor(private readonly scene: Scene) {
		this.f32 = new Float32Array(scene.buffer, 0, scene.buffer.byteLength >> 2);
		this.u32 = new Uint32Array(scene.buffer, 0, scene.buffer.byteLength >> 2);
		this.starts = new Uint32Array(scene.layers.length * 3 + 1);

		let total = 0;

		scene.layers.forEach((layer, index) => {
			this.starts[index * 3 + SEGMENT] = total;
			total += layer.segments;
			this.starts[index * 3 + CIRCLE] = total;
			total += layer.circles;
			this.starts[index * 3 + TRIANGLE] = total;
			total += layer.triangleVertices / 3;
		});
		this.starts[scene.layers.length * 3] = total;

		const [minX, minY, maxX, maxY] = gridBounds(scene);
		const area = Math.max(maxX - minX, 1e-3) * Math.max(maxY - minY, 1e-3);
		const cells = Math.min(Math.max(Math.ceil(total / PRIMITIVES_PER_CELL), 1), MAX_CELLS);
		this.cell = Math.sqrt(area / cells);
		this.minX = minX;
		this.minY = minY;
		this.cols = Math.max(Math.ceil((maxX - minX) / this.cell), 1);
		this.rows = Math.max(Math.ceil((maxY - minY) / this.cell), 1);

		const counts = new Uint32Array(this.cols * this.rows + 1);

		this.visitAll((_, cell) => counts[cell + 1]++);

		for (let cell = 1; cell < counts.length; cell++) counts[cell] += counts[cell - 1];

		const entries = new Uint32Array(counts[counts.length - 1]);
		const next = counts.slice(0, -1);

		this.visitAll((id, cell) => (entries[next[cell]++] = id));
		this.cellStarts = counts;
		this.entries = entries;
	}

	/** Items within `tolerance` mm of a point, once per layer, on layers that `visible` accepts. */
	hits(x: number, y: number, tolerance: number, visible: (layer: number) => boolean): Hit[] {
		const seen = new Set<number>();
		const hits: Hit[] = [];
		const itemCount = this.scene.meta.items.length;
		const [c0, r0] = [this.col(x - tolerance), this.row(y - tolerance)];
		const [c1, r1] = [this.col(x + tolerance), this.row(y + tolerance)];

		for (let row = r0; row <= r1; row++) {
			for (let col = c0; col <= c1; col++) {
				const cell = row * this.cols + col;

				for (let entry = this.cellStarts[cell]; entry < this.cellStarts[cell + 1]; entry++) {
					const range = this.rangeOf(this.entries[entry]);
					const layer = Math.floor(range / 3);

					if (!visible(layer)) continue;

					const index = this.entries[entry] - this.starts[range];
					const item = this.hitTest(layer, range % 3, index, x, y, tolerance);
					const key = layer * itemCount + item;

					if (item < 0 || seen.has(key)) continue;
					seen.add(key);
					hits.push({ item, layer });
				}
			}
		}

		return hits;
	}

	/** The `starts` slot whose range holds `id`. */
	private rangeOf(id: number) {
		let low = 0;
		let high = this.starts.length - 2;

		while (low < high) {
			const middle = (low + high + 1) >> 1;

			if (this.starts[middle] <= id) low = middle;
			else high = middle - 1;
		}

		return low;
	}

	/** The primitive's item when the point hits it, otherwise -1. */
	private hitTest(layer: number, kind: number, index: number, x: number, y: number, tol: number) {
		const { f32, u32 } = this;
		const source = this.scene.layers[layer];

		if (kind === SEGMENT) {
			const base = (source.segmentOffset + index * SEGMENT_BYTES) >> 2;

			const distance = segmentDistance(
				x,
				y,
				f32[base],
				f32[base + 1],
				f32[base + 2],
				f32[base + 3]
			);

			return distance <= f32[base + 4] / 2 + tol ? u32[base + 5] : -1;
		}

		if (kind === CIRCLE) {
			const base = (source.circleOffset + index * CIRCLE_BYTES) >> 2;
			const distance = Math.hypot(x - f32[base], y - f32[base + 1]);
			const radius = f32[base + 2];
			const stroke = f32[base + 3];

			const hit =
				stroke === 0 ? distance <= radius + tol : Math.abs(distance - radius) <= stroke / 2 + tol;

			return hit ? u32[base + 4] : -1;
		}

		const base = (source.triangleOffset + index * 3 * VERTEX_BYTES) >> 2;
		const inside = pointInTriangle(x, y, f32.subarray(base, base + 8));

		return inside ? u32[base + 2] : -1;
	}

	private col(x: number) {
		return clamp(Math.floor((x - this.minX) / this.cell), 0, this.cols - 1);
	}

	private row(y: number) {
		return clamp(Math.floor((y - this.minY) / this.cell), 0, this.rows - 1);
	}

	private visitAll(visit: (id: number, cell: number) => void) {
		const { f32, outline } = this;
		let id = 0;

		for (const layer of this.scene.layers) {
			for (let index = 0; index < layer.segments; index++, id++) {
				const base = (layer.segmentOffset + index * SEGMENT_BYTES) >> 2;
				segmentOutline(
					outline,
					f32[base],
					f32[base + 1],
					f32[base + 2],
					f32[base + 3],
					f32[base + 4] / 2
				);
				this.visitCells(id, 4, visit);
			}

			for (let index = 0; index < layer.circles; index++, id++) {
				const base = (layer.circleOffset + index * CIRCLE_BYTES) >> 2;
				const r = f32[base + 2] + f32[base + 3] / 2;
				outline[0] = outline[6] = f32[base] - r;
				outline[2] = outline[4] = f32[base] + r;
				outline[1] = outline[3] = f32[base + 1] - r;
				outline[5] = outline[7] = f32[base + 1] + r;
				this.visitCells(id, 4, visit);
			}

			for (let index = 0; index < layer.triangleVertices / 3; index++, id++) {
				const base = (layer.triangleOffset + index * 3 * VERTEX_BYTES) >> 2;
				outline[0] = f32[base];
				outline[1] = f32[base + 1];
				outline[2] = f32[base + 3];
				outline[3] = f32[base + 4];
				outline[4] = f32[base + 6];
				outline[5] = f32[base + 7];
				this.visitCells(id, 3, visit);
			}
		}
	}

	/** Visits the cells a convex outline overlaps, row by row, so long slivers stay cheap. */
	private visitCells(id: number, corners: number, visit: (id: number, cell: number) => void) {
		const { outline } = this;
		let minY = Infinity;
		let maxY = -Infinity;

		for (let corner = 0; corner < corners; corner++) {
			minY = Math.min(minY, outline[corner * 2 + 1]);
			maxY = Math.max(maxY, outline[corner * 2 + 1]);
		}

		const firstRow = this.row(minY);
		const lastRow = this.row(maxY);

		for (let row = firstRow; row <= lastRow; row++) {
			const top = row === firstRow ? minY : this.minY + row * this.cell;
			const bottom = row === lastRow ? maxY : this.minY + (row + 1) * this.cell;
			let minX = Infinity;
			let maxX = -Infinity;

			for (let corner = 0; corner < corners; corner++) {
				const next = (corner + 1) % corners;
				const ax = outline[corner * 2];
				const ay = outline[corner * 2 + 1];
				const bx = outline[next * 2];
				const by = outline[next * 2 + 1];
				const low = Math.max(Math.min(ay, by), top);
				const high = Math.min(Math.max(ay, by), bottom);

				if (low > high) continue;

				const xLow = ay === by ? ax : ax + ((bx - ax) * (low - ay)) / (by - ay);
				const xHigh = ay === by ? bx : ax + ((bx - ax) * (high - ay)) / (by - ay);
				minX = Math.min(minX, xLow, xHigh);
				maxX = Math.max(maxX, xLow, xHigh);
			}

			const lastCol = this.col(maxX);

			for (let col = this.col(minX); col <= lastCol; col++) visit(id, row * this.cols + col);
		}
	}
}

/** Prefers anything over zones, then the topmost layer, then the smallest item. */
export function bestHit(hits: Hit[], scene: Scene, rank: (layer: number) => number) {
	const { items } = scene.meta;

	const score = ({ item, layer }: Hit) => [
		items[item].kind === 'zone' ? 1 : 0,
		-rank(layer),
		area(items[item].bbox)
	];

	const compare = (a: number[], b: number[]) =>
		a.map((value, index) => value - b[index]).find((difference) => difference !== 0) ?? 0;

	return hits.reduce<Hit | null>(
		(best, hit) => (!best || compare(score(hit), score(best)) < 0 ? hit : best),
		null
	);
}

function area([minX, minY, maxX, maxY]: Bounds) {
	return (maxX - minX) * (maxY - minY);
}

function gridBounds(scene: Scene): Bounds {
	let [minX, minY, maxX, maxY] = scene.meta.bounds;

	for (const { bbox } of scene.meta.items) {
		minX = Math.min(minX, bbox[0]);
		minY = Math.min(minY, bbox[1]);
		maxX = Math.max(maxX, bbox[2]);
		maxY = Math.max(maxY, bbox[3]);
	}

	return [minX, minY, maxX, maxY];
}

/** The rectangle around a round-capped segment of half width `r`. */
function segmentOutline(
	out: Float64Array,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	r: number
) {
	const length = Math.hypot(x2 - x1, y2 - y1);
	const dx = length > 0 ? ((x2 - x1) / length) * r : r;
	const dy = length > 0 ? ((y2 - y1) / length) * r : 0;

	out[0] = x1 - dx - dy;
	out[1] = y1 - dy + dx;
	out[2] = x2 + dx - dy;
	out[3] = y2 + dy + dx;
	out[4] = x2 + dx + dy;
	out[5] = y2 + dy - dx;
	out[6] = x1 - dx + dy;
	out[7] = y1 - dy - dx;
}

function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared > 0 ? clamp(((px - x1) * dx + (py - y1) * dy) / lengthSquared, 0, 1) : 0;

	return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

/** `v` holds three vertex records of x, y and item. */
function pointInTriangle(px: number, py: number, v: Float32Array) {
	const d1 = (px - v[3]) * (v[1] - v[4]) - (v[0] - v[3]) * (py - v[4]);
	const d2 = (px - v[6]) * (v[4] - v[7]) - (v[3] - v[6]) * (py - v[7]);
	const d3 = (px - v[0]) * (v[7] - v[1]) - (v[6] - v[0]) * (py - v[1]);

	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}
