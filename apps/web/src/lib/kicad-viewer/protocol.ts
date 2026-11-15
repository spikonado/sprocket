import type { Size } from '$lib/kicad-viewer/camera';
import type { SceneItem } from '$lib/kicad-viewer/scene';

export type ViewportSize = Size & { dpr: number };

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

export type View = '2d' | '3d';

/** The board scene, or the GLB of its component models from KiCad. */
export type Stream = 'scene' | 'models';

export type PointerInput = {
	phase: PointerPhase;
	id: number;
	x: number;
	y: number;
	/** Pressed button on `down`: 0 primary, 1 middle, 2 secondary. */
	button: number;
	shift: boolean;
};

export type WheelInput = {
	x: number;
	y: number;
	deltaY: number;
	deltaMode: number;
	pinch: boolean;
};

export type ToWorker =
	| ({ type: 'init'; view: View; canvas: OffscreenCanvas } & ViewportSize)
	| { type: 'chunk'; stream: Stream; load: number; bytes: Uint8Array<ArrayBuffer> }
	| { type: 'end'; stream: Stream; load: number }
	| ({ type: 'resize'; view: View } & ViewportSize)
	| ({ type: 'pointer'; view: View } & PointerInput)
	| ({ type: 'wheel'; view: View } & WheelInput)
	| { type: 'show'; view: View | null }
	| { type: 'layerVisible'; name: string; visible: boolean }
	| { type: 'componentsVisible'; visible: boolean }
	| { type: 'fit'; view: View }
	| { type: 'flip'; view: View; flipped: boolean }
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
	| { type: 'loaded'; layers: ViewerLayer[]; models: string | null }
	| { type: 'pick'; pick: PickResult | null }
	| { type: 'error'; view: View; message: string }
	| { type: 'models'; error: string | null };
