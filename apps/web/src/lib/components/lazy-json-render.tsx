import { Component, lazy, Suspense, type ReactNode } from 'react';

const JsonRenderView = lazy(() => import('$lib/components/json-render-view'));

class RenderErrorBoundary extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export default function LazyJsonRender({
	source,
	fallback
}: {
	source: string;
	fallback: ReactNode;
}) {
	return (
		// Keyed on source because JSONUIProvider only seeds state on mount.
		<RenderErrorBoundary key={source} fallback={fallback}>
			<Suspense fallback={fallback}>
				<JsonRenderView source={source} fallback={fallback} />
			</Suspense>
		</RenderErrorBoundary>
	);
}
