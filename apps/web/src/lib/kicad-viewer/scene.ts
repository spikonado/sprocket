import { z } from 'zod';

const layerKind = z.enum([
	'copper',
	'silk',
	'mask',
	'paste',
	'fab',
	'courtyard',
	'edge',
	'adhesive',
	'user',
	'holes'
]);

const layerPart = z.enum([
	'main',
	'zones',
	'labels',
	'npth',
	'padWalls',
	'padHoles',
	'viaWalls',
	'viaHoles'
]);

const sceneLayerMeta = z.object({
	name: z.string(),
	userName: z.string().nullable(),
	kind: layerKind,
	side: z.enum(['front', 'back', 'inner']).nullable(),
	part: layerPart,
	segments: z.number().int().nonnegative(),
	circles: z.number().int().nonnegative(),
	triangleVertices: z.number().int().nonnegative()
});

const itemKind = z.enum([
	'footprint',
	'pad',
	'track',
	'arc',
	'via',
	'zone',
	'text',
	'shape',
	'dimension'
]);

/** `[minX, minY, maxX, maxY]` in mm. */
const bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const sceneItem = z.object({
	kind: itemKind,
	parent: z.number().int().nullable(),
	layer: z.string().nullable(),
	net: z.number().int().nullable(),
	reference: z.string().optional(),
	value: z.string().optional(),
	footprint: z.string().optional(),
	number: z.string().optional(),
	text: z.string().optional(),
	/** `[x, y, angle]` in mm and degrees. */
	position: z.tuple([z.number(), z.number(), z.number()]).optional(),
	bbox: bounds
});

const sceneMeta = z.object({
	kind: z.literal('pcb'),
	bounds,
	layers: z.array(sceneLayerMeta),
	items: z.array(sceneItem),
	nets: z.array(z.string())
});

export type LayerKind = z.infer<typeof layerKind>;

export type LayerPart = z.infer<typeof layerPart>;

export type SceneLayerMeta = z.infer<typeof sceneLayerMeta>;

export type ItemKind = z.infer<typeof itemKind>;

export type Bounds = z.infer<typeof bounds>;

export type SceneItem = z.infer<typeof sceneItem>;

export type SceneMeta = z.infer<typeof sceneMeta>;

export const SEGMENT_BYTES = 24;
export const CIRCLE_BYTES = 20;
export const VERTEX_BYTES = 12;

/** Byte offsets into the scene buffer. Records keep their u32 item in the last 4 bytes. */
export type SceneLayer = SceneLayerMeta & {
	segmentOffset: number;
	circleOffset: number;
	triangleOffset: number;
};

export type Scene = {
	buffer: ArrayBuffer;
	meta: SceneMeta;
	layers: SceneLayer[];
	/** Byte range of all layer buffers, uploaded to the GPU as one buffer. */
	geometryOffset: number;
	geometryBytes: number;
};

/** "SPKS" read as a little-endian u32. */
export const MAGIC = 0x534b5053;
export const FORMAT_VERSION = 2;

export function decodeScene(buffer: ArrayBuffer): Scene {
	const view = new DataView(buffer);

	if (buffer.byteLength < 12 || view.getUint32(0, true) !== MAGIC) {
		throw new Error('This is not a Sprocket board scene.');
	}

	const version = view.getUint32(4, true);

	if (version !== FORMAT_VERSION) {
		throw new Error(`Board scene version ${version} isn’t supported.`);
	}

	const metaLength = view.getUint32(8, true);

	if (12 + metaLength > buffer.byteLength) throw new Error('The board scene is cut off.');

	const parsed = sceneMeta.safeParse(
		JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, metaLength)))
	);

	if (!parsed.success) throw new Error('The board scene’s item list is malformed.');

	const meta = parsed.data;

	const geometryOffset = align4(12 + metaLength);
	let offset = geometryOffset;

	const layers = meta.layers.map((layer) => {
		const segmentOffset = offset;
		const circleOffset = segmentOffset + layer.segments * SEGMENT_BYTES;
		const triangleOffset = circleOffset + layer.circles * CIRCLE_BYTES;
		offset = triangleOffset + layer.triangleVertices * VERTEX_BYTES;

		return { ...layer, segmentOffset, circleOffset, triangleOffset };
	});

	if (offset > buffer.byteLength) throw new Error('The board scene is cut off.');

	return { buffer, meta, layers, geometryOffset, geometryBytes: offset - geometryOffset };
}

function align4(value: number) {
	return (value + 3) & ~3;
}
