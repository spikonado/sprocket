import { compileSpecStream, type Spec, type UIElement } from '@json-render/core';
import { z } from 'zod';

const specSchema = z.object({
	root: z.string(),
	elements: z.record(z.string(), z.custom<UIElement>()),
	state: z.record(z.string(), z.unknown()).optional()
});

function parseSpecDocument(source: string): Spec | undefined {
	try {
		return specSchema.safeParse(JSON.parse(source)).data;
	} catch {
		return undefined;
	}
}

/** Reads a spec written as one JSON document or as JSONL patches, which may still be streaming. */
export function parseJsonRenderSpec(source: string): Spec | null {
	const spec = parseSpecDocument(source) ?? specSchema.safeParse(compileSpecStream(source)).data;

	return spec?.elements[spec.root] ? spec : null;
}
