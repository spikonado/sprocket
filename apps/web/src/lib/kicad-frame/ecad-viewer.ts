import { z } from 'zod';
import type { KicadSource } from '$lib/kicad-frame/protocol';

export type Context = 'SCH' | 'PCB';

export type NetRef = { name: string; netCode?: number };

type CameraState = { x: number; y: number; zoom: number; rotation: number };

type CrossProbeRequest = {
	sourceContext: Context;
	targetContext: Context;
	mode: 'select';
	kind: 'designator' | 'net';
	value: string;
	designator?: string;
	net?: string;
	netCode?: number;
};

/** The parts of the vendored `<ecad-viewer>` element's API this frame uses. */
export interface EcadViewerElement extends HTMLElement {
	readonly project: EventTarget;
	readonly has_sch: boolean;
	readonly has_pcb: boolean;
	readonly measureMode: boolean;
	readonly insetMode: boolean;
	/** The shown document's view. Setting null does nothing. */
	camera: CameraState | null;
	replaceSources(update: { revisionKey: string; sources: KicadSource[] }): Promise<void>;
	showTab(view: Context): Promise<void>;
	requestCrossProbe(request: CrossProbeRequest): boolean;
	getHighlightedNets(): NetRef[];
	setHighlightedNets(nets: NetRef[]): void;
	clearSelection(): void;
	setMeasureMode(on: boolean): void;
	escapeMeasure(): boolean;
	setInsetPeer(peer: EcadViewerElement | null): void;
	setInsetMode(on: boolean): void;
	escapeInsets(): boolean;
}

declare global {
	interface HTMLElementTagNameMap {
		'ecad-viewer': EcadViewerElement;
	}
}

export const selectionSchema = z.object({
	sourceContext: z.enum(['SCH', 'PCB']),
	operation: z.enum(['replace', 'toggle']).optional(),
	reference: z.string().optional(),
	net: z.string().optional(),
	netCode: z.number().optional()
});

export type Selection = z.infer<typeof selectionSchema>;

export const tabChangeSchema = z.object({ current: z.enum(['SCH', 'PCB', '3D', 'BOM']) });

export type Tab = z.infer<typeof tabChangeSchema>['current'];

/** Dispatched on `window`, with the error message as its detail. */
export const loadErrorEvent = 'ecad-viewer:zip:error';

/** Reads the detail of one of the viewer's events, which its own code dispatches untyped. */
export function eventDetail<T>(event: Event, schema: z.ZodType<T>) {
	if (!(event instanceof CustomEvent)) return null;

	const parsed = schema.safeParse(event.detail);

	return parsed.success ? parsed.data : null;
}
