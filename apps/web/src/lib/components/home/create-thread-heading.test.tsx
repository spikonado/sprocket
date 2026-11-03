import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '$lib/types/sprocket';
import CreateThreadHeading from './create-thread-heading';

function renderHeading(overrides: Partial<ComponentProps<typeof CreateThreadHeading>> = {}) {
	const props: ComponentProps<typeof CreateThreadHeading> = {
		projects: [],
		workspacePath: null,
		onProject: vi.fn(),
		onAddProject: vi.fn(),
		...overrides
	};

	const { rerender } = render(<CreateThreadHeading {...props} />);

	return { ...props, rerender };
}

describe('CreateThreadHeading', () => {
	it('prompts the user to add their first project', async () => {
		const props = renderHeading();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Add project' }));
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('searches projects, selects worktrees by path, and adds projects from the footer', async () => {
		const props = renderHeading({
			projects: [
				{ repositoryKey: 'sprocket', displayName: 'Sprocket', workspacePath: '/sprocket' },
				{ repositoryKey: 'sprocket', displayName: 'Sprocket', workspacePath: '/other' },
				{ repositoryKey: 'robot', displayName: 'Robot', workspacePath: '/robot' }
			],
			workspacePath: '/sprocket'
		});

		const user = userEvent.setup();

		const trigger = screen.getByRole('button', {
			name: 'Select project. Current project: Sprocket'
		});

		await user.click(trigger);
		await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'SPRO');
		expect(
			Array.from(document.querySelectorAll('[aria-pressed]')).map((item) =>
				item.getAttribute('aria-label')
			)
		).toEqual(['Sprocket, /sprocket', 'Sprocket, /other']);
		expect(
			screen.getByRole('button', { name: 'Sprocket, /sprocket' }).getAttribute('aria-pressed')
		).toBe('true');
		await user.click(screen.getByRole('button', { name: 'Sprocket, /other' }));
		expect(props.onProject).toHaveBeenCalledWith('/other');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');

		await user.click(trigger);
		await user.click(screen.getByRole('button', { name: 'Add project' }));
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('removes a searched project with the sidebar X and restores focus', async () => {
		const project: Project = {
			repositoryKey: 'first',
			displayName: 'First',
			workspacePath: '/first'
		};

		const props = renderHeading({
			projects: [project],
			workspacePath: '/first',
			onRemoveProject: vi.fn()
		});

		const user = userEvent.setup();
		const trigger = screen.getByRole('button', { name: 'Select project. Current project: First' });
		await user.click(trigger);
		await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'first');
		await user.tab();
		await user.tab();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Remove First from project list' })
		);
		await user.keyboard('{Enter}');
		expect(props.onRemoveProject).toHaveBeenCalledExactlyOnceWith(project);
		expect(document.activeElement).toBe(trigger);

		props.rerender(<CreateThreadHeading {...props} projects={[]} workspacePath={null} />);
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add project' }));
	});

	it('closes on Escape and restores focus to the heading picker', async () => {
		renderHeading({
			projects: [{ repositoryKey: 'first', displayName: 'First', workspacePath: '/first' }]
		});

		const trigger = screen.getByRole('button', {
			name: 'Select project. Current project: Choose a project'
		});

		const user = userEvent.setup();
		await user.click(trigger);
		await user.keyboard('{Escape}');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(trigger);
	});
});
