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

function createWindowsDesktopApi() {
	const browseFilesystem = vi.fn(async ({ partialPath }: { partialPath: string }) => {
		if (partialPath === '/' || partialPath === '\\') {
			return {
				parentPath: '\\',
				volumeList: true,
				entries: [
					{ name: 'C:\\', fullPath: 'C:\\' },
					{ name: 'D:\\', fullPath: 'D:\\' },
					{ name: 'E:\\', fullPath: 'E:\\' }
				]
			};
		}

		const drive = /^([DE]):(?:[\\/]|$)/i.exec(partialPath)?.[1]?.toUpperCase();

		if (drive) {
			if (partialPath === `${drive}:\\projects\\`) {
				return {
					parentPath: `${drive}:\\projects`,
					volumeList: false,
					entries: [{ name: '..', fullPath: `${drive}:\\` }]
				};
			}

			return {
				parentPath: `${drive}:\\`,
				volumeList: false,
				entries: [
					{ name: '..', fullPath: '\\' },
					{ name: 'projects', fullPath: `${drive}:\\projects` }
				]
			};
		}

		return {
			parentPath: 'C:\\Users\\me',
			volumeList: false,
			entries: [{ name: '..', fullPath: 'C:\\Users' }]
		};
	});

	const resolveWorkspacePath = vi.fn(async ({ workspacePath }: { workspacePath: string }) => {
		const path = workspacePath.endsWith(':')
			? `${workspacePath}\\`
			: workspacePath.replaceAll('/', '\\');

		const displayName = path.slice(3) || 'workspace';

		return {
			workspacePath: path,
			displayName,
			repositoryKey: displayName
		};
	});

	return { browseFilesystem, resolveWorkspacePath };
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
	it('offers recent-project removal without browsing or opening that folder', async () => {
		const recent = { workspacePath: 'D:\\robots', displayName: 'Robots' };
		const onRemoveProject = vi.fn();

		const { props, browseFilesystem } = renderPicker({
			recentProjectPaths: [recent],
			onRemoveProject
		});

		fireEvent.click(document.querySelector('[aria-label="Remove Robots from project list"]')!);
		expect(onRemoveProject).toHaveBeenCalledWith(recent);
		expect(browseFilesystem).toHaveBeenCalledWith({ partialPath: '~/' });
		expect(props.onSelect).not.toHaveBeenCalled();
	});

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

	it.each(['D:', 'D:\\', 'D:/', 'E:', 'E:\\', 'E:/'])(
		'browses and resolves a typed Windows root %s',
		async (query) => {
			const desktopApi = createWindowsDesktopApi();
			const { props } = renderPicker({ desktopApi });

			const input = document.querySelector<HTMLInputElement>(
				'[aria-label="Project directory path"]'
			)!;

			await waitFor(() =>
				expect(desktopApi.browseFilesystem).toHaveBeenCalledWith({ partialPath: '~/' })
			);

			fireEvent.change(input, { target: { value: query } });
			await waitFor(() => {
				expect(desktopApi.browseFilesystem).toHaveBeenCalledWith({ partialPath: query });
				expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
			});
			await keydown(input, { key: 'Enter', ctrlKey: true });

			const root = `${query[0]}:\\`;
			await waitFor(() => {
				expect(desktopApi.resolveWorkspacePath).toHaveBeenCalledWith({
					workspacePath: query.endsWith(':') ? query : root,
					createIfMissing: false
				});
				expect(props.onSelect).toHaveBeenCalledWith({
					workspacePath: root,
					displayName: 'workspace',
					repositoryKey: 'workspace'
				});
			});
		}
	);

	it.each(['/', '\\'])(
		'selects E: from the Windows drive list at %s and returns to it',
		async (query) => {
			const desktopApi = createWindowsDesktopApi();
			const { props } = renderPicker({ desktopApi });

			const input = document.querySelector<HTMLInputElement>(
				'[aria-label="Project directory path"]'
			)!;

			fireEvent.change(input, { target: { value: query } });
			await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3));
			await keydown(input, { key: 'Enter', ctrlKey: true });
			expect(desktopApi.resolveWorkspacePath).not.toHaveBeenCalled();

			fireEvent.click(document.querySelectorAll('[role="option"]')[2]!);
			expect(input.value).toBe('E:\\');
			await waitFor(() => {
				expect(desktopApi.browseFilesystem).toHaveBeenCalledWith({ partialPath: 'E:\\' });
				expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
			});
			await keydown(input, { key: 'Enter', ctrlKey: true });
			await waitFor(() => {
				expect(desktopApi.resolveWorkspacePath).toHaveBeenCalledWith({
					workspacePath: 'E:\\',
					createIfMissing: false
				});
				expect(props.onSelect).toHaveBeenCalledWith({
					workspacePath: 'E:\\',
					displayName: 'workspace',
					repositoryKey: 'workspace'
				});
			});

			fireEvent.click(document.querySelector('[aria-label="Go to parent directory"]')!);
			expect(input.value).toBe('\\');
			await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3));
		}
	);

	it.each(['D', 'D:', '\\D:', 'e:', '/e:'])(
		'filters the Windows drive list locally for %s before selecting it',
		async (query) => {
			const desktopApi = createWindowsDesktopApi();
			renderPicker({ desktopApi });

			const input = document.querySelector<HTMLInputElement>(
				'[aria-label="Project directory path"]'
			)!;

			fireEvent.change(input, { target: { value: '\\' } });
			await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3));
			fireEvent.change(input, { target: { value: query } });
			const root = `${query.replace(/^[\\/]/, '')[0]!.toUpperCase()}:\\`;
			await waitFor(() => {
				const options = document.querySelectorAll('[role="option"]');
				expect(options).toHaveLength(1);
				expect(options[0]?.textContent).toBe(root);
			});
			await keydown(input, { key: 'Enter' });
			expect(input.value).toBe(root);
			await waitFor(() =>
				expect(desktopApi.browseFilesystem).toHaveBeenCalledWith({ partialPath: root })
			);
			expect(desktopApi.browseFilesystem).not.toHaveBeenCalledWith({ partialPath: query });
		}
	);

	it.each(['D', 'E'])(
		'browses into a folder on drive %s and resolves it for selection',
		async (drive) => {
			const desktopApi = createWindowsDesktopApi();
			const { props } = renderPicker({ desktopApi });

			const input = document.querySelector<HTMLInputElement>(
				'[aria-label="Project directory path"]'
			)!;

			fireEvent.change(input, { target: { value: `${drive}:\\` } });
			await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
			fireEvent.click(document.querySelector('[role="option"]')!);
			expect(input.value).toBe(`${drive}:\\projects\\`);
			await waitFor(() => {
				expect(desktopApi.browseFilesystem).toHaveBeenCalledWith({
					partialPath: `${drive}:\\projects\\`
				});
				expect(document.querySelector('[data-project-submit]')?.hasAttribute('disabled')).toBe(
					false
				);
			});
			await keydown(input, { key: 'Enter', ctrlKey: true });
			await waitFor(() => {
				expect(desktopApi.resolveWorkspacePath).toHaveBeenCalledWith({
					workspacePath: `${drive}:\\projects`,
					createIfMissing: false
				});
				expect(props.onSelect).toHaveBeenCalledWith({
					workspacePath: `${drive}:\\projects`,
					displayName: 'projects',
					repositoryKey: 'projects'
				});
			});
		}
	);
});
