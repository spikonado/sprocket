import { act, type ComponentProps } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProjectPicker from './project-picker';

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
	render(<ProjectPicker {...props} />);
	return { ...api, props };
}

async function keydown(target: Element, init: KeyboardEventInit) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
	});
}

async function waitForDirectories() {
	await waitFor(() => {
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
		expect(document.querySelector('[role="option"][aria-selected="true"]')).not.toBeNull();
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

		await keydown(input, { key: 'ArrowDown' });
		expect(options()[1]?.getAttribute('aria-selected')).toBe('true');

		await keydown(input, { key: 'ArrowUp' });
		await keydown(input, { key: 'ArrowDown' });
		await keydown(input, { key: 'Enter' });

		expect(input.value).toBe('/home/me/Desktop/');
		expect(resolveWorkspacePath).not.toHaveBeenCalled();
	});

	it('goes to the parent directory with Backspace and closes with Escape', async () => {
		const { props } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		await keydown(input, { key: 'Backspace' });
		expect(input.value).toBe('/home/');

		await keydown(input, { key: 'Escape' });
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('stops exposing entries as soon as the path changes', async () => {
		const { resolveWorkspacePath } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		fireEvent.change(input, { target: { value: '/tmp/' } });
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

		await keydown(input, { key: 'Enter' });
		await keydown(input, { key: 'Enter', ctrlKey: true });
		expect(input.value).toBe('/tmp/');
		expect(resolveWorkspacePath).not.toHaveBeenCalled();
	});

	it('adds the current directory with Ctrl+Enter', async () => {
		const { props, resolveWorkspacePath } = renderPicker();
		await waitForDirectories();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Project directory path"]'
		)!;

		await keydown(input, { key: 'Enter', ctrlKey: true });

		await waitFor(() => {
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
