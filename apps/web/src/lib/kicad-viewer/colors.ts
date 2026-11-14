import type { LayerKind, LayerPart, SceneLayerMeta } from '$lib/kicad-viewer/scene';

export type Rgba = [r: number, g: number, b: number, a: number];

/** Colors from KiCad's built-in default PCB theme, `builtin_color_themes.h` and `themes.h`. */
export const BACKGROUND: Rgba = [0, 16, 35, 1];

export const SELECTION: Rgba = [255, 255, 255, 0.55];

/** KiCad's default zone opacity. Everything else uses its theme color's alpha. */
const ZONE_OPACITY = 0.6;

const PAD_LABEL: Rgba = [255, 255, 255, 0.9];

const VIA_HOLE: Rgba = [227, 183, 46, 1];

/** KiCad paints pad hole walls in the via hole color and fills plated holes with the background. */
const HOLE_COLORS: Partial<Record<LayerPart, Rgba>> = {
	npth: [26, 196, 210, 1],
	padWalls: VIA_HOLE,
	padHoles: BACKGROUND,
	viaWalls: [236, 236, 236, 1],
	viaHoles: VIA_HOLE
};

const INNER_COPPER: [number, number, number][] = [
	[127, 200, 127],
	[206, 125, 44],
	[79, 203, 203],
	[219, 98, 139],
	[167, 165, 198],
	[40, 204, 217],
	[232, 178, 167],
	[242, 237, 161],
	[141, 203, 129],
	[237, 124, 51],
	[91, 195, 235],
	[247, 111, 142],
	[167, 165, 198],
	[40, 204, 217],
	[232, 178, 167],
	[242, 237, 161],
	[237, 124, 51],
	[91, 195, 235],
	[247, 111, 142],
	[167, 165, 198],
	[40, 204, 217],
	[232, 178, 167],
	[242, 237, 161],
	[237, 124, 51],
	[91, 195, 235],
	[247, 111, 142],
	[167, 165, 198],
	[40, 204, 217],
	[232, 178, 167],
	[242, 237, 161]
];

const USER_COLORS: [number, number, number][] = [
	[194, 194, 194],
	[89, 148, 220],
	[180, 219, 210],
	[216, 200, 82]
];

const NAMED = new Map<string, Rgba>([
	['F.Cu', [200, 52, 52, 1]],
	['B.Cu', [77, 127, 196, 1]],
	['Dwgs.User', [194, 194, 194, 1]],
	['Cmts.User', [89, 148, 220, 1]],
	['Eco1.User', [180, 219, 210, 1]],
	['Eco2.User', [216, 200, 82, 1]],
	['Edge.Cuts', [208, 210, 205, 1]],
	['Margin', [255, 38, 226, 1]]
]);

const SIDED: Partial<Record<LayerKind, { front: Rgba; back: Rgba }>> = {
	silk: { front: [242, 237, 161, 1], back: [232, 178, 167, 1] },
	mask: { front: [216, 100, 255, 0.4], back: [2, 255, 238, 0.4] },
	paste: { front: [180, 160, 154, 0.9], back: [0, 194, 194, 0.9] },
	adhesive: { front: [132, 0, 132, 1], back: [0, 0, 132, 1] },
	courtyard: { front: [255, 38, 226, 1], back: [38, 233, 255, 1] },
	fab: { front: [175, 175, 175, 1], back: [88, 93, 132, 1] }
};

function themeColor(layer: Pick<SceneLayerMeta, 'name' | 'kind' | 'side'>): Rgba {
	const named = NAMED.get(layer.name);

	if (named) return named;

	const inner = /^In(\d+)\.Cu$/.exec(layer.name);

	if (inner) return [...INNER_COPPER[(Number(inner[1]) - 1) % INNER_COPPER.length], 1];

	const sided = SIDED[layer.kind];

	if (sided) return layer.side === 'back' ? sided.back : sided.front;

	const user = /^User\.(\d+)$/.exec(layer.name);

	return [...USER_COLORS[user ? (Number(user[1]) - 1) % USER_COLORS.length : 0], 1];
}

export function layerColor(layer: Pick<SceneLayerMeta, 'name' | 'kind' | 'side' | 'part'>): Rgba {
	const hole = HOLE_COLORS[layer.part];

	if (hole) return hole;

	if (layer.part === 'labels') return PAD_LABEL;

	const [r, g, b, a] = themeColor(layer);

	return layer.part === 'zones' ? [r, g, b, a * ZONE_OPACITY] : [r, g, b, a];
}

export function cssColor([r, g, b]: Rgba) {
	return `rgb(${r} ${g} ${b})`;
}
