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

function parseSpecStream(source: string): Spec | undefined {
	try {
		return specSchema.safeParse(compileSpecStream(source)).data;
	} catch {
		return undefined;
	}
}

export function parseJsonRenderSpec(source: string): Spec | null {
	const spec = parseSpecDocument(source) ?? parseSpecStream(source);

	return spec?.elements[spec.root] ? spec : null;
}
