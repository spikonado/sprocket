import { lazy, Suspense, type ReactNode } from 'react';

const JsonRenderView = lazy(() => import('$lib/components/json-render-view'));

export default function LazyJsonRender({
	source,
	fallback
}: {
	source: string;
	fallback: ReactNode;
}) {
	return (
		<Suspense fallback={fallback}>
			<JsonRenderView source={source} fallback={fallback} />
		</Suspense>
	);
}
