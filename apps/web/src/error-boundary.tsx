import { Component, type ReactNode } from 'react';
import CalmCentered from '$lib/components/home/calm-centered';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<CalmCentered
				title="Unable to display Sprocket"
				description="Reload the app to try again."
				actions={
					<button
						type="button"
						className="text-foreground rounded-lg border border-[var(--hairline)] px-4 py-2 text-sm"
						onClick={() => window.location.reload()}
					>
						Reload
					</button>
				}
			/>
		);
	}
}
