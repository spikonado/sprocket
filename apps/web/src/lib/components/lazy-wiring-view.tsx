import { lazy, Suspense, type ReactNode } from 'react';
import RenderErrorBoundary from '$lib/components/render-error-boundary';

const WiringView = lazy(() => import('$lib/components/wiring-view'));

export default function LazyWiringView({
	source,
	fallback
}: {
	source: string;
	fallback: ReactNode;
}) {
	return (
		<RenderErrorBoundary key={source} fallback={fallback}>
			<Suspense fallback={fallback}>
				<WiringView source={source} />
			</Suspense>
		</RenderErrorBoundary>
	);
}
