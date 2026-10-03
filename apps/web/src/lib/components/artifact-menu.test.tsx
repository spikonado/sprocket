import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ArtifactMenu from './artifact-menu';
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

it('keeps transcript references as open controls without a deletion menu', () => {
	const onOpenArtifact = vi.fn();
	render(
		<ChatMarkdown
			content={`artifact:${artifact.key}`}
			artifacts={[artifact]}
			onOpenArtifact={onOpenArtifact}
		/>
	);
	const button = screen.getByRole('button', { name: 'View Notes' });
	fireEvent.contextMenu(button);
	fireEvent.keyDown(button, { key: 'F10', shiftKey: true });
	expect(screen.queryByRole('menu')).toBeNull();
	fireEvent.click(button);
	expect(onOpenArtifact).toHaveBeenCalledWith(artifact.key);
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

it('opens a list deletion menu only from the artifact button', () => {
	const props = sidePanelProps();
	render(<SidePanel {...props} />);
	const artifactButton = screen.getByRole('button', { name: /^Notes.*markdown/ });
	const fullscreenButton = screen.getByRole('button', { name: 'Open Notes fullscreen' });
	const row = fullscreenButton.parentElement;

	if (!row) throw new Error('Artifact row is missing');
	fireEvent.contextMenu(row);
	expect(screen.queryByRole('menu')).toBeNull();
	fireEvent.contextMenu(fullscreenButton);
	fireEvent.keyDown(fullscreenButton, { key: 'F10', shiftKey: true });
	expect(screen.queryByRole('menu')).toBeNull();
	fireEvent.click(fullscreenButton);
	expect(props.onOpenFullscreen).toHaveBeenCalledWith(artifact.key);
	fireEvent.contextMenu(artifactButton);
	expect(screen.getByRole('menu', { name: 'Notes actions' })).toBeTruthy();
	expect(props.onDeleteArtifact).not.toHaveBeenCalled();
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

it.each(['markdown', 'html', 'react'] as const)(
	'keeps %s rendered content and its title free of deletion gestures',
	(artifactType) => {
		render(
			<ArtifactDisplay
				title="Interactive"
				artifactType={artifactType}
				content="<button>App</button>"
				onDelete={vi.fn(async () => {})}
			/>
		);
		const title = screen.getByText('Interactive');
		fireEvent.contextMenu(title);
		fireEvent.keyDown(title, { key: 'F10', shiftKey: true });

		const content =
			artifactType === 'markdown'
				? screen.getByText('App')
				: screen.getByTitle('Interactive preview');

		fireEvent.contextMenu(content);
		fireEvent.keyDown(content, { key: 'F10', shiftKey: true });

		if (content instanceof HTMLIFrameElement) {
			expect(content.srcdoc).not.toContain('sprocket-artifact-menu');
			fireEvent(
				window,
				new MessageEvent('message', {
					data: { type: 'sprocket-artifact-menu', x: 10, y: 20 },
					source: content.contentWindow
				})
			);
		}

		expect(screen.queryByRole('menu')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Interactive actions' }));
		expect(screen.getByRole('menu')).toBeTruthy();
	}
);
