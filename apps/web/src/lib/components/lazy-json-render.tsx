import { lazy, Suspense, type ReactNode } from 'react';
import RenderErrorBoundary from '$lib/components/render-error-boundary';

const JsonRenderView = lazy(() => import('$lib/components/json-render-view'));

export default function LazyJsonRender({
	source,
	fallback
}: {
	source: string;
	fallback: ReactNode;
}) {
	return (
		<RenderErrorBoundary key={source} fallback={fallback}>
			<Suspense fallback={fallback}>
				<JsonRenderView source={source} fallback={fallback} />
			</Suspense>
		</RenderErrorBoundary>
	);
}
