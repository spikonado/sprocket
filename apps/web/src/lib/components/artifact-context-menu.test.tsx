import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ArtifactContextMenu from './artifact-context-menu';
import ChatMarkdown from './chat-markdown';
import ArtifactDisplay from './home/artifact-display';
import SidePanel from './home/side-panel';
import type { ArtifactEntry } from '$lib/chat/artifacts';

const artifact: ArtifactEntry = {
	key: 'artifact-id',
	title: 'Notes',
	artifactType: 'markdown',
	content: '# Notes'
};

it('opens by right click, runs deletion once, and restores focus', async () => {
	const pending = Promise.withResolvers<void>();
	const onDelete = vi.fn(() => pending.promise);
	render(
		<ArtifactContextMenu title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactContextMenu>
	);
	const trigger = screen.getByRole('button', { name: 'Notes' });
	fireEvent.contextMenu(trigger, { clientX: 20, clientY: 40 });
	const remove = screen.getByRole('menuitem', { name: 'Delete artifact' });
	expect(document.activeElement).toBe(remove);
	fireEvent.click(remove);
	fireEvent.click(remove);
	expect(onDelete).toHaveBeenCalledOnce();
	expect(remove.hasAttribute('disabled')).toBe(true);
	await act(async () => pending.resolve());
	expect(screen.queryByRole('menu')).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

it('opens from the keyboard and dismisses Escape without deleting', () => {
	const onDelete = vi.fn(async () => {});
	render(
		<ArtifactContextMenu title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactContextMenu>
	);
	const trigger = screen.getByRole('button', { name: 'Notes' });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: 'F10', shiftKey: true });
	expect(screen.getByRole('menu', { name: 'Notes actions' })).toBeTruthy();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(screen.queryByRole('menu')).toBeNull();
	expect(document.activeElement).toBe(trigger);
	expect(onDelete).not.toHaveBeenCalled();
});

it('keeps deletion errors visible and allows a retry', async () => {
	const onDelete = vi
		.fn<() => Promise<void>>()
		.mockRejectedValueOnce(new Error('Disconnected'))
		.mockResolvedValue(undefined);

	render(
		<ArtifactContextMenu title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactContextMenu>
	);
	fireEvent.contextMenu(screen.getByRole('button', { name: 'Notes' }));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(screen.getByRole('alert').textContent).toBe('Disconnected');
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDelete).toHaveBeenCalledTimes(2);
	expect(screen.queryByRole('menu')).toBeNull();
});

it('deletes the referenced artifact from a transcript card', async () => {
	const onDeleteArtifact = vi.fn<(id: string) => Promise<void>>(async () => {});
	render(
		<ChatMarkdown
			content={`artifact:${artifact.key}`}
			artifacts={[artifact]}
			onOpenArtifact={vi.fn()}
			onDeleteArtifact={onDeleteArtifact}
		/>
	);
	fireEvent.contextMenu(screen.getByRole('button', { name: 'View Notes' }));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDeleteArtifact).toHaveBeenCalledWith(artifact.key);
});

it('deletes from both the sidebar list and selected preview', async () => {
	const onDeleteArtifact = vi.fn<(id: string) => Promise<void>>(async () => {});

	const props = {
		artifacts: [artifact],
		selectedKey: null,
		tab: 'artifacts' as const,
		liveView: null,
		liveActive: false,
		expanded: false,
		onSelect: vi.fn(),
		onBack: vi.fn(),
		onTabChange: vi.fn(),
		onOpenFullscreen: vi.fn(),
		onToggleExpanded: vi.fn(),
		onClose: vi.fn(),
		onDeleteArtifact
	};

	const view = render(<SidePanel {...props} />);
	fireEvent.contextMenu(screen.getByText('Notes'));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	view.rerender(<SidePanel {...props} selectedKey={artifact.key} />);
	fireEvent.contextMenu(screen.getByRole('heading', { name: 'Notes' }));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDeleteArtifact).toHaveBeenCalledTimes(2);
	expect(onDeleteArtifact).toHaveBeenLastCalledWith(artifact.key);
});

it('restores focus to the artifact control when a title menu is dismissed by Tab', () => {
	render(
		<ArtifactContextMenu title="Notes" onDelete={vi.fn(async () => {})}>
			<span>Notes title</span>
			<button>View Notes</button>
		</ArtifactContextMenu>
	);
	fireEvent.contextMenu(screen.getByText('Notes title'));
	fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Tab' });
	expect(screen.queryByRole('menu')).toBeNull();
	expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View Notes' }));
});

it('does not steal focus when a dismissed deletion finishes', async () => {
	const pending = Promise.withResolvers<void>();
	render(
		<>
			<ArtifactContextMenu title="Notes" onDelete={() => pending.promise}>
				<button>Notes</button>
			</ArtifactContextMenu>
			<button>Other control</button>
		</>
	);
	fireEvent.contextMenu(screen.getByRole('button', { name: 'Notes' }));
	fireEvent.click(screen.getByRole('menuitem'));
	fireEvent.keyDown(window, { key: 'Escape' });
	const otherControl = screen.getByRole('button', { name: 'Other control' });
	otherControl.focus();
	await act(async () => pending.resolve());
	expect(document.activeElement).toBe(otherControl);
});

it('dismisses a preview menu before collapsing the expanded sidebar', () => {
	const onToggleExpanded = vi.fn();
	render(
		<SidePanel
			artifacts={[artifact]}
			selectedKey={null}
			tab="artifacts"
			liveView={null}
			liveActive={false}
			expanded
			onSelect={vi.fn()}
			onBack={vi.fn()}
			onTabChange={vi.fn()}
			onOpenFullscreen={vi.fn()}
			onToggleExpanded={onToggleExpanded}
			onClose={vi.fn()}
			onDeleteArtifact={vi.fn(async () => {})}
		/>
	);
	fireEvent.contextMenu(screen.getByText('Notes'));
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(screen.queryByRole('menu')).toBeNull();
	expect(onToggleExpanded).not.toHaveBeenCalled();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(onToggleExpanded).toHaveBeenCalledOnce();
});

it('opens a preview menu only for gestures from its own sandboxed frame', async () => {
	const onDelete = vi.fn(async () => {});
	render(
		<ArtifactDisplay
			title="Interactive"
			artifactType="html"
			content="<button>App</button>"
			onDelete={onDelete}
		/>
	);
	const frame = screen.getByTitle('Interactive preview');

	if (!(frame instanceof HTMLIFrameElement)) throw new Error('Expected a preview frame.');
	expect(frame.srcdoc).toContain('sprocket-artifact-menu');
	const data = { type: 'sprocket-artifact-menu', x: 10, y: 20 };
	fireEvent(window, new MessageEvent('message', { data, source: window }));
	expect(screen.queryByRole('menu')).toBeNull();
	fireEvent(window, new MessageEvent('message', { data, source: frame.contentWindow }));
	expect(screen.getByRole('menu')).toBeTruthy();
	expect(onDelete).not.toHaveBeenCalled();
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDelete).toHaveBeenCalledOnce();
});
