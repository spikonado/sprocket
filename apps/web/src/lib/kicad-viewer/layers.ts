import type { LayerKind, LayerPart, SceneLayerMeta } from '$lib/kicad-viewer/scene';

type Layer = Pick<SceneLayerMeta, 'name' | 'kind' | 'side' | 'part'>;

/** Bottom-to-top groups for one view, after KiCad's `GAL_LAYER_ORDER` with the near copper on top. */
const GROUP = {
	farTechnical: 0,
	farCopper: 1,
	inner: 2,
	user: 3,
	nearTechnical: 4,
	nearCopper: 5,
	holes: 6,
	nearLabels: 7
};

const TECHNICAL: LayerKind[] = ['fab', 'courtyard', 'adhesive', 'paste', 'silk', 'mask'];

const PARTS: LayerPart[] = ['zones', 'main', 'labels'];

const HOLE_PARTS: LayerPart[] = ['npth', 'padWalls', 'padHoles', 'viaWalls', 'viaHoles'];

/** Drawn after `User.N` … `User.1`. */
const NAMED_USER = ['Margin', 'Edge.Cuts', 'Eco2.User', 'Eco1.User', 'Cmts.User', 'Dwgs.User'];

const SHOWN_BY_DEFAULT: LayerKind[] = ['copper', 'silk', 'edge', 'holes'];

export type Rank = [group: number, layer: number, part: number];

export function drawRank(layer: Layer, flipped: boolean): Rank {
	const near = layer.side === (flipped ? 'back' : 'front');
	const part = PARTS.indexOf(layer.part);

	switch (layer.kind) {
		case 'holes':
			return [GROUP.holes, HOLE_PARTS.indexOf(layer.part), 0];
		case 'copper': {
			if (layer.side === 'inner') {
				const number = Number(/^In(\d+)\.Cu$/.exec(layer.name)?.[1] ?? 0);

				return [GROUP.inner, flipped ? number : -number, part];
			}

			if (!near) return [GROUP.farCopper, 0, part];

			return layer.part === 'labels' ? [GROUP.nearLabels, 0, 0] : [GROUP.nearCopper, 0, part];
		}

		case 'edge':
		case 'user':
			return [GROUP.user, userRank(layer.name), part];
		default:
			return [near ? GROUP.nearTechnical : GROUP.farTechnical, TECHNICAL.indexOf(layer.kind), part];
	}
}

function userRank(name: string) {
	const numbered = /^User\.(\d+)$/.exec(name);

	if (numbered) return -Number(numbered[1]);

	const named = NAMED_USER.indexOf(name);

	return named >= 0 ? named : NAMED_USER.length;
}

export function compareRanks(a: Rank, b: Rank) {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Holes and near-side pad labels draw over the selection highlight, so they stay readable. */
export function drawsOverSelection(rank: Rank) {
	return rank[0] >= GROUP.holes;
}

export function visibleByDefault(layer: Pick<SceneLayerMeta, 'kind'>) {
	return SHOWN_BY_DEFAULT.includes(layer.kind);
}
