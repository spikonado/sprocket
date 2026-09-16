import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import ProjectPicker from './project-picker.svelte';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	document.body.replaceChildren();
});

function createDesktopApi() {
	const browseFilesystem = vi.fn(async ({ partialPath }: { partialPath: string }) => {
		if (partialPath === '/home/me/Desktop/') {
			return {
				parentPath: '/home/me/Desktop',
				entries: [
					{ name: '..', fullPath: '/home/me' },
					{ name: 'work', fullPath: '/home/me/Desktop/work' }
				]
			};
		}

		if (partialPath === '/home/') {
			return {
				parentPath: '/home',
				entries: [
					{ name: '..', fullPath: '/' },
					{ name: 'me', fullPath: '/home/me' }
				]
			};
		}

		return {
			parentPath: '/home/me',
			entries: [
				{ name: '..', fullPath: '/home' },
				{ name: 'Arduino', fullPath: '/home/me/Arduino' },
				{ name: 'Desktop', fullPath: '/home/me/Desktop' },
				{ name: 'Documents', fullPath: '/home/me/Documents' }
			]
		};
	});
	const resolveWorkspacePath = vi.fn(async () => ({
		workspacePath: '/home/me',
		displayName: 'me',
		repositoryKey: 'directory:/home/me'
	}));

	return {
		desktopApi: { browseFilesystem, resolveWorkspacePath },
		browseFilesystem,
		resolveWorkspacePath
	};
}

function renderPicker(overrides: Partial<ComponentProps<typeof ProjectPicker>> = {}) {
	const api = createDesktopApi();
	const props: ComponentProps<typeof ProjectPicker> = {
		open: true,
		desktopApi: api.desktopApi,
		onClose: vi.fn(),
		onSelect: vi.fn(),
		...overrides
	};
	const component = mount(ProjectPicker, { target: document.body, props });
	cleanup = () => unmount(component);
	flushSync();
	return { ...api, props };
}

async function waitForDirectories() {
	await vi.waitFor(() => {
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
	});
}

describe('ProjectPicker', () => {
	it('navigates the directory list with arrow keys and selects with Enter', async () => {
		const { resolveWorkspacePath } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;
		const options = () => document.querySelectorAll<HTMLElement>('[role="option"]');

		expect(document.activeElement).toBe(input);
		expect(options()[0]?.getAttribute('aria-selected')).toBe('true');

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(options()[1]?.getAttribute('aria-selected')).toBe('true');

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();

		expect(input.value).toBe('/home/me/Desktop/');
		expect(resolveWorkspacePath).not.toHaveBeenCalled();
	});

	it('goes to the parent directory with Backspace and closes with Escape', async () => {
		const { props } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
		flushSync();
		expect(input.value).toBe('/home/');

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('stops exposing entries as soon as the path changes', async () => {
		const { resolveWorkspacePath } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		input.value = '/tmp/';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(input.value).toBe('/tmp/');
		expect(resolveWorkspacePath).not.toHaveBeenCalled();
	});

	it('adds the current directory with Ctrl+Enter', async () => {
		const { props, resolveWorkspacePath } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
		);

		await vi.waitFor(() => {
			expect(resolveWorkspacePath).toHaveBeenCalledWith({
				workspacePath: '/home/me',
				createIfMissing: false
			});
			expect(props.onSelect).toHaveBeenCalledWith({
				workspacePath: '/home/me',
				displayName: 'me',
				repositoryKey: 'directory:/home/me'
			});
			expect(props.onClose).toHaveBeenCalledOnce();
		});
	});
});
