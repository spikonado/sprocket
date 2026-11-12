import {
	applySpecStreamPatch,
	compileSpecStream,
	parseSpecStreamLine,
	type Spec,
	type UIElement
} from '@json-render/core';
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
	const compiled = compileSpecStream('');

	for (const line of source.split('\n')) {
		const patch = parseSpecStreamLine(line);

		if (!patch) continue;

		try {
			applySpecStreamPatch(compiled, patch);
		} catch {}
	}

	return specSchema.safeParse(compiled).data;
}

export function parseJsonRenderSpec(source: string): Spec | null {
	const spec = parseSpecDocument(source) ?? parseSpecStream(source);

	return spec?.elements[spec.root] ? spec : null;
}
