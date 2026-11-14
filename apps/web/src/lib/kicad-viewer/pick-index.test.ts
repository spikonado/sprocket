import { describe, expect, it } from 'vitest';
import { bestHit, PickIndex } from './pick-index';
import {
	decodeScene,
	FORMAT_VERSION,
	MAGIC,
	type SceneItem,
	type SceneLayerMeta,
	type SceneMeta
} from './scene';

type Records = { segments?: number[][]; circles?: number[][]; triangles?: number[][] };

/** Writes the SPKS layout: f32 fields with the u32 item last in each record. */
function encode(
	meta: Omit<SceneMeta, 'layers'>,
	layers: (Pick<SceneLayerMeta, 'name' | 'kind'> & Records)[]
) {
	const full: SceneMeta = {
		...meta,
		layers: layers.map(({ name, kind, segments = [], circles = [], triangles = [] }) => ({
			name,
			kind,
			userName: null,
			side: null,
			part: kind === 'holes' ? 'padHoles' : 'main',
			segments: segments.length,
			circles: circles.length,
			triangleVertices: triangles.length
		}))
	};

	const json = new TextEncoder().encode(JSON.stringify(full));

	const records = layers.flatMap(({ segments = [], circles = [], triangles = [] }) => [
		...segments,
		...circles,
		...triangles
	]);

	const geometry = 12 + Math.ceil(json.length / 4) * 4;

	const buffer = new ArrayBuffer(
		geometry + records.reduce((sum, record) => sum + record.length * 4, 0)
	);

	const view = new DataView(buffer);

	view.setUint32(0, MAGIC, true);
	view.setUint32(4, FORMAT_VERSION, true);
	view.setUint32(8, json.length, true);
	new Uint8Array(buffer, 12).set(json);

	let offset = geometry;

	for (const record of records) {
		record.forEach((value, index) => {
			if (index === record.length - 1) view.setUint32(offset, value, true);
			else view.setFloat32(offset, value, true);
			offset += 4;
		});
	}

	return decodeScene(buffer);
}

const item = (
	kind: SceneItem['kind'],
	bbox: SceneItem['bbox'],
	parent: number | null = null
): SceneItem => ({
	kind,
	parent,
	layer: null,
	net: null,
	bbox
});

const scene = encode(
	{
		kind: 'pcb',
		bounds: [0, 0, 10, 10],
		nets: [''],
		items: [
			item('footprint', [1, 1, 3, 3]),
			item('pad', [1.5, 1.5, 2.5, 2.5], 0),
			item('zone', [0, 0, 10, 10]),
			item('track', [6, 0.9, 9, 1.1]),
			item('via', [4, 4, 6, 6])
		]
	},
	[
		{ name: 'B.Cu', kind: 'copper', circles: [[5, 5, 1, 0.2, 4]] },
		{
			name: 'F.Cu',
			kind: 'copper',
			segments: [[6, 1, 9, 1, 0.2, 3]],
			circles: [[2, 2, 0.5, 0, 1]],
			triangles: [
				[0, 0, 2],
				[10, 0, 2],
				[0, 10, 2]
			]
		},
		{ name: 'Holes', kind: 'holes', circles: [[2, 2, 0.2, 0, 1]] }
	]
);

const index = new PickIndex(scene);
const all = () => true;

const pickAt = (x: number, y: number, visible: (layer: number) => boolean = all) =>
	bestHit(index.hits(x, y, 0.1, visible), scene, (layer) => layer)?.item ?? null;

describe('PickIndex', () => {
	it('hits each primitive shape and prefers a pad over the zone under it', () => {
		expect(index.hits(2, 2, 0.1, all)).toEqual(
			expect.arrayContaining([
				{ item: 1, layer: 1 },
				{ item: 2, layer: 1 },
				{ item: 1, layer: 2 }
			])
		);
		expect(pickAt(2, 2)).toBe(1);
		expect(pickAt(7, 1.15)).toBe(3);
		expect(pickAt(5.9, 5)).toBe(4);
		expect(pickAt(5.5, 5)).toBe(null);
		expect(pickAt(3, 4)).toBe(2);
	});

	it('skips hidden layers', () => {
		expect(pickAt(5.9, 5, (layer) => layer !== 0)).toBe(null);
		expect(index.hits(2, 2, 0.1, (layer) => layer === 2)).toEqual([{ item: 1, layer: 2 }]);
	});
});
