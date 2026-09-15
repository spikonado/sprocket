import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import CreateThreadHeading from './create-thread-heading.svelte';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
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
	const component = mount(CreateThreadHeading, { target: document.body, props });
	cleanup = () => unmount(component);
	flushSync();
	return props;
}

describe('CreateThreadHeading', () => {
	it('prompts the user to add their first project', () => {
		const props = renderHeading();
		const addProjectButton = document.querySelector<HTMLButtonElement>('button');

		expect(document.body.textContent).toContain('What should we work on?');
		expect(addProjectButton).not.toBeNull();
		addProjectButton!.click();
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('selects worktrees by path and disambiguates matching project names', () => {
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
		trigger!.click();
		flushSync();

		const projectOptions = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		expect(projectOptions).toHaveLength(2);
		expect(projectOptions[0]?.getAttribute('aria-checked')).toBe('true');
		expect(projectOptions[1]?.getAttribute('aria-label')).toBe('Sprocket, /other');
		expect(projectOptions[1]?.textContent).toContain('/other');
		projectOptions[1]!.click();
		flushSync();
		expect(props.onProject).toHaveBeenCalledWith('/other');
		expect(document.querySelector('[role="menu"]')).toBeNull();

		trigger!.click();
		flushSync();
		document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
		expect(props.onAddProject).toHaveBeenCalledOnce();
	});

	it('supports keyboard navigation and restores focus after Escape', async () => {
		const props = renderHeading({
			projects: [
				{ repositoryKey: 'first', displayName: 'First', workspacePath: '/first' },
				{ repositoryKey: 'second', displayName: 'Second', workspacePath: '/second' }
			],
			workspacePath: '/first'
		});
		const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;

		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		await Promise.resolve();

		const projectOptions = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		expect(document.activeElement).toBe(projectOptions[0]);
		projectOptions[0]!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
		);
		await Promise.resolve();
		expect(document.activeElement).toBe(projectOptions[1]);

		projectOptions[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(props.onProject).toHaveBeenCalledWith('/second');
		await Promise.resolve();
		expect(document.activeElement).toBe(trigger);

		trigger.click();
		flushSync();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();
		await Promise.resolve();
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(trigger);
	});
});
