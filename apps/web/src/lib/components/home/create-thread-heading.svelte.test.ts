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
		const select = document.querySelector<HTMLSelectElement>('select');

		expect(select).not.toBeNull();
		expect(document.querySelector('.create-thread-project > span')?.textContent).toBe('Sprocket');
		expect(Array.from(select!.options, (option) => option.text)).toContain('Sprocket (/other)');
		select!.value = '/other';
		select!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(props.onProject).toHaveBeenCalledWith('/other');

		select!.value = '__add__';
		select!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(props.onAddProject).toHaveBeenCalledOnce();
		expect(select!.value).toBe('/sprocket');
	});
});
