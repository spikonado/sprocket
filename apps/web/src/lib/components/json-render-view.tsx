import { JSONUIProvider, Renderer, type ComponentRenderProps } from '@json-render/react';
import { useMemo, type ReactNode } from 'react';
import { parseJsonRenderSpec } from '$lib/json-render/spec';
import { jsonRenderRegistry } from '$lib/json-render/registry';

function UnknownComponent({ element }: ComponentRenderProps) {
	return <p className="text-muted-foreground text-xs">Unknown component {element.type}</p>;
}

export default function JsonRenderView({
	source,
	fallback
}: {
	source: string;
	/** Shown while the spec has no root element yet, or when it fails to render. */
	fallback: ReactNode;
}) {
	const spec = useMemo(() => parseJsonRenderSpec(source), [source]);

	if (!spec) return fallback;

	return (
		<div className="text-foreground my-3 text-sm leading-normal">
			<JSONUIProvider registry={jsonRenderRegistry} initialState={spec.state}>
				<Renderer spec={spec} registry={jsonRenderRegistry} fallback={UnknownComponent} />
			</JSONUIProvider>
		</div>
	);
}
