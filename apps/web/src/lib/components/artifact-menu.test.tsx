import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ArtifactMenu from './artifact-menu';
import ArtifactDisplay from './home/artifact-display';
import SidePanel from './home/side-panel';
import type { ArtifactEntry } from '$lib/chat/artifacts';

const artifact: ArtifactEntry = {
	key: 'artifact-id',
	title: 'Notes',
	artifactType: 'markdown',
	content: '# Notes'
};

function sidePanelProps(overrides: Partial<ComponentProps<typeof SidePanel>> = {}) {
	return {
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
		onDeleteArtifact: vi.fn(async () => {}),
		...overrides
	};
}

it('opens by right click, runs deletion once, and restores focus', async () => {
	const pending = Promise.withResolvers<void>();
	const onDelete = vi.fn(() => pending.promise);
	render(
		<ArtifactMenu trigger="context" title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactMenu>
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
		<ArtifactMenu trigger="context" title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactMenu>
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
		<ArtifactMenu trigger="context" title="Notes" onDelete={onDelete}>
			<button>Notes</button>
		</ArtifactMenu>
	);
	fireEvent.contextMenu(screen.getByRole('button', { name: 'Notes' }));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(screen.getByRole('alert').textContent).toBe('Disconnected');
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDelete).toHaveBeenCalledTimes(2);
	expect(screen.queryByRole('menu')).toBeNull();
});

it('deletes from both the sidebar list and selected preview', async () => {
	const onDeleteArtifact = vi.fn<(id: string) => Promise<void>>(async () => {});

	const props = sidePanelProps({ onDeleteArtifact });

	const view = render(<SidePanel {...props} />);
	fireEvent.contextMenu(screen.getByText('Notes'));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	view.rerender(<SidePanel {...props} selectedKey={artifact.key} />);
	fireEvent.click(screen.getByRole('button', { name: 'Notes actions' }));
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDeleteArtifact).toHaveBeenCalledTimes(2);
	expect(onDeleteArtifact).toHaveBeenLastCalledWith(artifact.key);
});

it('opens the top-bar menu from the keyboard and restores focus on dismissal', () => {
	render(<ArtifactMenu trigger="button" title="Notes" onDelete={vi.fn(async () => {})} />);
	const trigger = screen.getByRole('button', { name: 'Notes actions' });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: 'ArrowDown' });
	expect(trigger.getAttribute('aria-expanded')).toBe('true');
	fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Tab' });
	expect(screen.queryByRole('menu')).toBeNull();
	expect(document.activeElement).toBe(trigger);
	expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('toggles the top-bar menu when its button is clicked again', () => {
	render(<ArtifactMenu trigger="button" title="Notes" onDelete={vi.fn(async () => {})} />);
	const trigger = screen.getByRole('button', { name: 'Notes actions' });
	fireEvent.click(trigger);
	expect(screen.getByRole('menu')).toBeTruthy();
	fireEvent.mouseDown(trigger);
	fireEvent.click(trigger);
	expect(screen.queryByRole('menu')).toBeNull();
});

it('dismisses the top-bar menu when the preview receives focus without taking focus back', () => {
	const onDelete = vi.fn(async () => {});
	render(
		<ArtifactDisplay
			title="Interactive"
			artifactType="html"
			content="<button>App</button>"
			onDelete={onDelete}
		/>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Interactive actions' }));
	expect(screen.getByRole('menu')).toBeTruthy();
	const preview = screen.getByTitle('Interactive preview');
	preview.focus();
	fireEvent.blur(window);
	expect(screen.queryByRole('menu')).toBeNull();
	expect(document.activeElement).toBe(preview);
	expect(onDelete).not.toHaveBeenCalled();
});

it('keeps a failed pending deletion visible after the preview dismisses its menu', async () => {
	const pending = Promise.withResolvers<void>();

	const onDelete = vi
		.fn<() => Promise<void>>()
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValue(undefined);

	render(
		<ArtifactDisplay
			title="Interactive"
			artifactType="html"
			content="<button>App</button>"
			onDelete={onDelete}
		/>
	);
	const trigger = screen.getByRole('button', { name: 'Interactive actions' });
	fireEvent.click(trigger);
	fireEvent.click(screen.getByRole('menuitem'));
	const preview = screen.getByTitle('Interactive preview');
	preview.focus();
	fireEvent.blur(window);
	expect(screen.queryByRole('menu')).toBeNull();
	await act(async () => pending.reject(new Error('Disconnected')));
	expect(screen.getByRole('alert').textContent).toContain('Interactive: Disconnected');
	expect(document.activeElement).toBe(preview);
	fireEvent.click(trigger);
	expect(screen.getByRole('alert').textContent).toBe('Disconnected');
	await act(async () => fireEvent.click(screen.getByRole('menuitem')));
	expect(onDelete).toHaveBeenCalledTimes(2);
	expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps a failure visible after keyboard dismissal and allows acknowledging it', async () => {
	const pending = Promise.withResolvers<void>();
	render(<ArtifactMenu trigger="button" title="Notes" onDelete={() => pending.promise} />);
	const trigger = screen.getByRole('button', { name: 'Notes actions' });
	fireEvent.click(trigger);
	fireEvent.click(screen.getByRole('menuitem'));
	fireEvent.keyDown(window, { key: 'Escape' });
	await act(async () => pending.reject(new Error('Disconnected')));
	expect(screen.getByRole('alert').textContent).toContain('Notes: Disconnected');
	fireEvent.click(screen.getByRole('button', { name: 'Dismiss deletion error' }));
	expect(screen.queryByRole('alert')).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

it('does not steal focus when a dismissed deletion finishes', async () => {
	const pending = Promise.withResolvers<void>();
	render(
		<>
			<ArtifactMenu trigger="context" title="Notes" onDelete={() => pending.promise}>
				<button>Notes</button>
			</ArtifactMenu>
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
	render(<SidePanel {...sidePanelProps({ expanded: true, onToggleExpanded })} />);
	fireEvent.contextMenu(screen.getByText('Notes'));
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(screen.queryByRole('menu')).toBeNull();
	expect(onToggleExpanded).not.toHaveBeenCalled();
	fireEvent.keyDown(window, { key: 'Escape' });
	expect(onToggleExpanded).toHaveBeenCalledOnce();
});
