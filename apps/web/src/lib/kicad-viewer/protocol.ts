import type { Size } from '$lib/kicad-viewer/camera';
import type { SceneItem } from '$lib/kicad-viewer/scene';

export type ViewportSize = Size & { dpr: number };

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

export type ToWorker =
	| ({ type: 'init'; canvas: OffscreenCanvas } & ViewportSize)
	| { type: 'sceneChunk'; load: number; bytes: Uint8Array<ArrayBuffer> }
	| { type: 'sceneEnd'; load: number }
	| ({ type: 'resize' } & ViewportSize)
	| { type: 'pointer'; phase: PointerPhase; id: number; x: number; y: number }
	| { type: 'wheel'; x: number; y: number; deltaY: number; deltaMode: number; pinch: boolean }
	| { type: 'layerVisible'; name: string; visible: boolean }
	| { type: 'fit' }
	| { type: 'flip'; flipped: boolean }
	| { type: 'clearSelection' };

export type ViewerLayer = {
	name: string;
	label: string;
	color: string;
	visible: boolean;
};

export type PickedItem = Omit<SceneItem, 'parent' | 'net' | 'bbox'> & { net: string | null };

export type PickResult = { item: PickedItem; parent: PickedItem | null };

export type FromWorker =
	| { type: 'loaded'; layers: ViewerLayer[] }
	| { type: 'pick'; pick: PickResult | null }
	| { type: 'error'; message: string };
