import { z } from 'zod';

export type KicadSource = { filename: string; content: string };

export type ParentMessage =
	/** Asks a frame that started before the parent listened to say it's ready again. */
	| { type: 'hello' }
	| { type: 'theme'; css: string }
	| { type: 'sources'; revision: number; sources: KicadSource[]; boardVersion: string | null }
	| { type: 'board3d'; boardVersion: string; glb: ArrayBuffer }
	| { type: 'board3dFailed'; boardVersion: string; message: string };

/** The frame runs a third-party viewer, so the parent checks everything it sends. */
export const frameMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready') }),
	z.object({ type: z.literal('loaded'), revision: z.number() }),
	z.object({
		type: z.literal('failed'),
		revision: z.number().nullable(),
		message: z.string(),
		/** Whether the frame went back to the last sources it drew. */
		recovered: z.boolean()
	}),
	z.object({ type: z.literal('board3dRequest'), boardVersion: z.string() })
]);

export type FrameMessage = z.infer<typeof frameMessageSchema>;
