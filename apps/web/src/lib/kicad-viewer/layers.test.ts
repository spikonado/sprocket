import { describe, expect, it } from 'vitest';
import { compareRanks, drawRank } from './layers';
import type { LayerKind, LayerPart, SceneLayerMeta } from './scene';

type Layer = Pick<SceneLayerMeta, 'name' | 'kind' | 'side' | 'part'>;

const PARTS: LayerPart[] = ['zones', 'labels', 'viaWalls', 'viaHoles'];

const KINDS = new Map<string, LayerKind>([
	['Cu', 'copper'],
	['SilkS', 'silk'],
	['Mask', 'mask']
]);

const SIDES = new Map<string, Layer['side']>([
	['F', 'front'],
	['B', 'back'],
	['In1', 'inner'],
	['In2', 'inner']
]);

/** Reads keys such as `F.Cu/labels`. The part defaults to `main`. */
const layer = (key: string): Layer => {
	const [name, partName] = key.split('/');
	const [prefix, suffix] = name.split('.');

	return {
		name,
		part: PARTS.find((part) => part === partName) ?? 'main',
		side: SIDES.get(prefix) ?? null,
		kind: name === 'Holes' ? 'holes' : (KINDS.get(suffix) ?? 'user')
	};
};

const sorted = (keys: string[], flipped: boolean) =>
	keys
		.map(layer)
		.sort((a, b) => compareRanks(drawRank(a, flipped), drawRank(b, flipped)))
		.map(({ name, part }) => (part === 'main' ? name : `${name}/${part}`));

describe('drawRank', () => {
	const keys = [
		'Holes/viaHoles',
		'F.Cu/labels',
		'F.Cu',
		'F.Cu/zones',
		'F.Mask',
		'F.SilkS',
		'Dwgs.User',
		'In2.Cu',
		'In1.Cu',
		'B.Cu/labels',
		'B.Cu',
		'B.SilkS',
		'Holes/viaWalls'
	];

	it('stacks layers like KiCad with the front copper on top', () => {
		expect(sorted(keys, false)).toEqual([
			'B.SilkS',
			'B.Cu',
			'B.Cu/labels',
			'In2.Cu',
			'In1.Cu',
			'Dwgs.User',
			'F.SilkS',
			'F.Mask',
			'F.Cu/zones',
			'F.Cu',
			'Holes/viaWalls',
			'Holes/viaHoles',
			'F.Cu/labels'
		]);
	});

	it('puts the back copper on top when flipped', () => {
		expect(sorted(keys, true)).toEqual([
			'F.SilkS',
			'F.Mask',
			'F.Cu/zones',
			'F.Cu',
			'F.Cu/labels',
			'In1.Cu',
			'In2.Cu',
			'Dwgs.User',
			'B.SilkS',
			'B.Cu',
			'Holes/viaWalls',
			'Holes/viaHoles',
			'B.Cu/labels'
		]);
	});
});
