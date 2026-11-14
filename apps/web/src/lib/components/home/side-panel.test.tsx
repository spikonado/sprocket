import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SidePanel from './side-panel';
import { useArtifactPanel } from '$lib/home/artifact-panel';

const artifact = {
	key: 'notes',
	title: 'Notes',
	artifactType: 'markdown'
} as const;

function Harness({ transcript = 'Thread transcript' }: { transcript?: string }) {
	const panel = useArtifactPanel();

	return (
		<SidePanel
			transcript={<p>{transcript}</p>}
			artifacts={[artifact]}
			artifactContents={new Map([[artifact.key, { status: 'ready', content: '# Notes' }]])}
			layout={panel.panel.layout}
			activePaneId={panel.activePane.id}
			browserApi={null}
			filesApi={null}
			onNewTab={(paneId) => panel.newTab(paneId)}
			onActivateTab={(id) => panel.activateTab(id)}
			onCloseTab={(id) => panel.closeTab(id)}
			onUpdateTab={(id, patch) => panel.updateTab(id, patch)}
			onDraftChange={(id, draft) => panel.setFileDraft(id, draft)}
			onFileSaved={(id, doc, version) => panel.fileSaved(id, doc, version)}
			onFocusPane={(id) => panel.focusPane(id)}
			onSplitPane={(id, direction) => panel.splitPane(id, direction)}
			onResizeSplit={(id, ratio) => panel.resizeSplit(id, ratio)}
			onOpenFile={(file) => panel.openFile(file)}
			onFileRenamed={(workspacePath, from, to) => panel.renameFile(workspacePath, from, to)}
			onFileDeleted={(workspacePath, path) => panel.closeFile(workspacePath, path)}
			onOpenFullscreen={vi.fn()}
		/>
	);
}

it('keeps each tab open with its own view and switches between them', () => {
	const { rerender } = render(<Harness />);
	expect(screen.getByRole('tabpanel', { name: 'Thread' }).textContent).toBe('Thread transcript');

	fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Artifacts' }));
	fireEvent.click(screen.getByText('Notes'));

	fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Browser' }));
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
		'Thread',
		'Notes',
		'Browser'
	]);

	fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
	expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
	expect(screen.getByRole('tabpanel', { name: 'Notes' })).toBeTruthy();
	expect(screen.getByText('Thread transcript').closest('section')?.hidden).toBe(true);
	expect(
		document.getElementById(
			screen.getByRole('tab', { name: 'Browser' }).getAttribute('aria-controls')!
		)?.childElementCount
	).toBe(0);

	rerender(<Harness transcript="Updated transcript" />);
	expect(screen.getByText('Thread transcript').closest('section')?.hidden).toBe(true);

	fireEvent.keyDown(screen.getByRole('tab', { name: 'Notes' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
	fireEvent.keyDown(screen.getByRole('tab', { name: 'Browser' }), { key: 'ArrowRight' });
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Thread' }));
	expect(screen.getByRole('tabpanel', { name: 'Thread' }).textContent).toBe('Updated transcript');

	fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
	fireEvent.click(screen.getByRole('button', { name: 'Close Notes tab' }));
	fireEvent(
		screen.getByRole('tab', { name: 'Thread' }),
		new MouseEvent('auxclick', { bubbles: true, button: 1 })
	);
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Thread', 'Browser']);
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' }));
});

it('splits panes right and down, each with its own tabs, and closes empty panes', () => {
	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
	expect(screen.getAllByRole('tablist')).toHaveLength(2);
	expect(screen.getAllByRole('separator', { name: 'Resize panes side by side' })).toHaveLength(1);

	const [, right] = screen.getAllByRole('tablist');
	expect(right!.textContent).toBe('New tab');
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'New tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
	expect(screen.getAllByRole('tabpanel')).toHaveLength(2);

	fireEvent.click(screen.getAllByRole('button', { name: 'Split down' })[1]!);
	expect(screen.getAllByRole('tablist')).toHaveLength(3);
	expect(screen.getByRole('separator', { name: 'Resize stacked panes' })).toBeTruthy();

	fireEvent.click(screen.getByRole('button', { name: 'Close New tab tab' }));
	fireEvent.click(screen.getByRole('button', { name: 'Close Browser tab' }));
	expect(screen.getAllByRole('tablist')).toHaveLength(1);
	expect(screen.queryByRole('separator')).toBeNull();
	expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Thread']);
	expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Thread' }));
});
