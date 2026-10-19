import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SidePanel from './side-panel';
import { useArtifactPanel } from '$lib/home/artifact-panel';

const artifact = {
	key: 'notes',
	title: 'Notes',
	artifactType: 'markdown',
	content: '# Notes'
} as const;

function Harness() {
	const panel = useArtifactPanel();

	return (
		<SidePanel
			artifacts={[artifact]}
			tabs={panel.panel.tabs}
			activeTabId={panel.activeTab.id}
			browserApi={null}
			filesApi={null}
			expanded={false}
			onNewTab={() => panel.newTab()}
			onActivateTab={(id) => panel.activateTab(id)}
			onCloseTab={(id) => panel.closeTab(id)}
			onUpdateTab={(id, patch) => panel.updateTab(id, patch)}
			onOpenFile={(file) => panel.openFile(file)}
			onFileRenamed={(workspacePath, from, to) => panel.renameFile(workspacePath, from, to)}
			onFileDeleted={(workspacePath, path) => panel.closeFile(workspacePath, path)}
			onOpenFullscreen={vi.fn()}
			onToggleExpanded={vi.fn()}
			onClose={vi.fn()}
		/>
	);
}

it('keeps each tab open with its own view and switches between them', () => {
	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Artifacts' }));
	fireEvent.click(screen.getByText('Notes'));

	fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Browser' }));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Notes', 'Browser']);

	fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
	expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
	expect(screen.getByRole('tabpanel', { name: 'Notes' })).toBeTruthy();

	fireEvent.keyDown(screen.getByRole('tab', { name: 'Notes' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
	fireEvent.keyDown(screen.getByRole('tab', { name: 'Browser' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notes' }));

	fireEvent.click(screen.getByRole('button', { name: 'Close Notes tab' }));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Browser']);
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
});
