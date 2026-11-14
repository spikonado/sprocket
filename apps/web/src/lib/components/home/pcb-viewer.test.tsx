import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PcbViewer from './pcb-viewer';

vi.mock('$lib/kicad-viewer/client', () => ({
	BoardViewerClient: class {
		private onLoaded: (layers: []) => void;

		constructor(_container: HTMLElement, events: { onLoaded: (layers: []) => void }) {
			this.onLoaded = events.onLoaded;
		}

		async load() {
			this.onLoaded([]);
		}

		dispose() {}
	}
}));

it('retries a failed load when the watch sends the same version again', async () => {
	const api = {
		kicadScene: vi
			.fn()
			.mockRejectedValueOnce(new Error('Server unreachable'))
			.mockResolvedValue({ scene: new ReadableStream(), version: 'v1' })
	};
	const props = { api, workspacePath: '/repo', path: 'board.kicad_pcb', shown: true };
	const view = render(<PcbViewer {...props} snapshot={{ version: 'v1' }} />);

	await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
	view.rerender(<PcbViewer {...props} snapshot={{ version: 'v1' }} />);

	await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
	expect(api.kicadScene).toHaveBeenCalledTimes(2);
});
