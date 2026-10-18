import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import SidePanel from './side-panel';
import type { SidePanelView } from '$lib/chat/side-panel';

function Harness() {
	const [view, setView] = useState<SidePanelView | null>(null);

	return (
		<SidePanel
			artifacts={[]}
			selectedKey={null}
			view={view}
			browserApi={null}
			expanded={false}
			onSelect={vi.fn()}
			onBack={vi.fn()}
			onViewChange={setView}
			onOpenFullscreen={vi.fn()}
			onToggleExpanded={vi.fn()}
			onClose={vi.fn()}
		/>
	);
}

it('opens views from the picker, focuses them, and returns via the new tab button', () => {
	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
	expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Artifacts' }));

	fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Browser' }));
});
