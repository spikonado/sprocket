import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Project } from '$lib/types/sprocket';
import CreateThreadHeading from './create-thread-heading';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	document.body.replaceChildren();
});

function renderHeading(overrides: Partial<ComponentProps<typeof CreateThreadHeading>> = {}) {
	const props: ComponentProps<typeof CreateThreadHeading> = {
		projects: [],
		workspacePath: null,
		onProject: vi.fn(),
		onAddProject: vi.fn(),
		...overrides
	};
	act(() => {
		root.render(<CreateThreadHeading {...props} />);
	});
	return props;
}

async function click(target: Element | null) {
	if (!target) throw new Error('Expected element to click was not rendered');
	await act(async () => {
		(target as HTMLElement).click();
		await Promise.resolve();
	});
}

async function dispatchKeydown(target: EventTarget, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		await Promise.resolve();
	});
}

describe('CreateThreadHeading', () => {
	it('prompts the user to add their first project', async () => {
		const props = renderHeading();
		const addProjectButton = document.querySelector<HTMLButtonElement>('button');

		expect(document.body.textContent).toContain('What should we work on?');
		expect(addProjectButton).not.toBeNull();
		await click(addProjectButton);
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('selects worktrees by path and disambiguates matching project names', async () => {
		const props = renderHeading({
			projects: [
				{ repositoryKey: 'sprocket', displayName: 'Sprocket', workspacePath: '/sprocket' },
				{ repositoryKey: 'sprocket', displayName: 'Sprocket', workspacePath: '/other' }
			],
			workspacePath: '/sprocket'
		});
		const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');

		expect(document.querySelector('select')).toBeNull();
		expect(trigger?.textContent).toContain('Sprocket');
		await click(trigger);

		const projectOptions = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		expect(projectOptions).toHaveLength(2);
		expect(projectOptions[0]?.getAttribute('aria-checked')).toBe('true');
		expect(projectOptions[1]?.getAttribute('aria-label')).toBe('Sprocket, /other');
		expect(projectOptions[1]?.textContent).toContain('/other');
		await click(projectOptions[1]);
		expect(props.onProject).toHaveBeenCalledWith('/other');
		expect(document.querySelector('[role="menu"]')).toBeNull();

		await click(trigger);
		await click(document.querySelector<HTMLButtonElement>('[role="menuitem"]'));
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('supports keyboard navigation and restores focus after Escape', async () => {
		const projects: Project[] = [
			{ repositoryKey: 'first', displayName: 'First', workspacePath: '/first' },
			{ repositoryKey: 'second', displayName: 'Second', workspacePath: '/second' }
		];
		const props = renderHeading({ projects, workspacePath: '/first' });
		const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;

		await dispatchKeydown(trigger, 'ArrowDown');

		const projectOptions = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		expect(document.activeElement).toBe(projectOptions[0]);
		await dispatchKeydown(projectOptions[0]!, 'ArrowDown');
		expect(document.activeElement).toBe(projectOptions[1]);

		await dispatchKeydown(projectOptions[1]!, 'Enter');
		expect(props.onProject).toHaveBeenCalledWith('/second');
		expect(document.activeElement).toBe(trigger);

		await click(trigger);
		await dispatchKeydown(document, 'Escape');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(trigger);
	});
});
