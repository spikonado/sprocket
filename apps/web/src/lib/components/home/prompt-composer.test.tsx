import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ModelCatalog } from '$lib/chat/model-catalog';
import PromptComposerTestHarness from './prompt-composer-test-harness';
import type { PromptComposerProps } from './prompt-composer';
import type { WorkspaceSearchResult } from '$lib/types/sprocket';
import { fixtureId } from '$lib/convex-test-client';

const modelCatalog: ModelCatalog = {
	defaultModelId: 'model-one',
	defaultReasoningEffort: 'medium',
	models: [
		{
			id: 'model-one',
			label: 'Model One',
			provider: 'spikonado',
			supportsImages: false,
			contextWindowTokens: 100_000,
			autoHandoffTokenLimit: 80_000,
			reasoningEfforts: ['low', 'medium'],
			defaultReasoningEffort: 'medium',
			supportsFastMode: true
		},
		{
			id: 'model-two',
			label: 'Model Two',
			provider: 'spikonado',
			supportsImages: false,
			contextWindowTokens: 100_000,
			autoHandoffTokenLimit: 80_000,
			reasoningEfforts: ['high'],
			defaultReasoningEffort: 'high',
			supportsFastMode: false
		}
	]
};

const skills = [
	{ name: 'kicad', description: 'Author KiCad schematics', disableModelInvocation: false },
	{ name: 'zap', description: 'Zap tooling', disableModelInvocation: true }
];

const ultrafastCatalog: ModelCatalog = {
	...modelCatalog,
	models: modelCatalog.models.map((model, index) =>
		index === 0 ? { ...model, provider: 'openai', byokServiceTiers: ['ultrafast'] } : model
	)
};

function composerProps(overrides: Partial<PromptComposerProps> = {}): PromptComposerProps {
	return {
		attachments: [],
		onAttachFiles: vi.fn(),
		onRemoveAttachment: vi.fn(),
		canSend: true,
		submitting: null,
		isRunning: false,
		isWorking: false,
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
		...overrides
	};
}

function renderComposer(overrides: Partial<PromptComposerProps> = {}) {
	const props = composerProps(overrides);
	const view = render(<PromptComposerTestHarness composerProps={props} />);
	const composer = document.querySelector<HTMLElement>('[aria-label="Message composer"]');

	if (!composer) throw new Error('Message composer was not rendered');
	const textarea = composer.querySelector<HTMLTextAreaElement>('textarea');

	if (!textarea) throw new Error('Composer textarea was not rendered');

	return {
		props,
		composer,
		textarea,
		rerender: (next: PromptComposerProps) =>
			view.rerender(<PromptComposerTestHarness composerProps={next} />)
	};
}

async function click(target: HTMLElement | null) {
	if (!target) throw new Error('Expected element to click was not rendered');
	await act(async () => {
		target.click();
		await Promise.resolve();
	});
}

async function pressKey(
	target: EventTarget,
	init: { key: string; shiftKey?: boolean; isComposing?: boolean }
) {
	const event = new KeyboardEvent('keydown', {
		key: init.key,
		shiftKey: init.shiftKey ?? false,
		bubbles: true,
		cancelable: true
	});

	if (init.isComposing) {
		Object.defineProperty(event, 'isComposing', { value: true });
	}

	await act(async () => {
		target.dispatchEvent(event);
		await Promise.resolve();
	});

	return event;
}

async function typeInComposer(textarea: HTMLTextAreaElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
		setter?.call(textarea, value);
		textarea.setSelectionRange(value.length, value.length);
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
	});
}

function findButton(text: string) {
	const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
		candidate.textContent?.includes(text)
	);

	if (!button) throw new Error(`Button containing "${text}" was not rendered`);

	return button;
}

function dataTransfer(
	types: string[],
	files: File[] = [],
	dropEffect: DataTransfer['dropEffect'] = 'none'
) {
	return { types, files, dropEffect };
}

function dispatchDrag(
	target: HTMLElement,
	type: string,
	transfer: ReturnType<typeof dataTransfer>
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		dataTransfer: { value: transfer },
		relatedTarget: { value: null }
	});
	act(() => {
		target.dispatchEvent(event);
	});

	return event;
}

describe('PromptComposer running commands', () => {
	it('places commands inside the footer and collapses them when Continue working appears', async () => {
		const { props, composer, rerender } = renderComposer({
			runningCommands: {
				api: {
					watchRunningCommands: vi.fn(async (_request, { onEvent }) => {
						onEvent([{ sessionId: '1', command: 'bun run dev', workdir: '/work', startedAt: 1 }]);
						await new Promise(() => {});
					}),
					terminateCommand: vi.fn()
				},
				scope: { userId: 'user', threadId: fixtureId<'threadRecords'>('thread') }
			},
			onContinueWorking: vi.fn()
		});

		const toggle = await screen.findByRole('button', { name: 'Running commands' });
		const dashboard = screen.getByRole('region', { name: 'Running commands' });
		expect(dashboard.closest('footer')).toBe(composer.closest('footer'));
		expect(dashboard.nextElementSibling).toBe(composer);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		await click(toggle);
		expect(screen.getByRole('button', { name: 'Stop command: bun run dev' })).toBeTruthy();

		rerender({ ...props, showContinueWorking: true });
		const continueButton = screen.getByRole('button', { name: 'Continue working' });
		expect(dashboard.nextElementSibling).toBe(continueButton.parentElement);
		expect(continueButton.parentElement?.nextElementSibling).toBe(composer);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		await click(continueButton);
		expect(props.onContinueWorking).toHaveBeenCalledOnce();
		await click(toggle);
		expect(screen.getByRole('button', { name: 'Stop command: bun run dev' })).toBeTruthy();
	});
});

describe('PromptComposer file drag and drop', () => {
	it('shows a drop target and attaches dropped files', () => {
		const { composer, props } = renderComposer();
		const file = new File(['schematic'], 'board.kicad_sch');
		const transfer = dataTransfer(['Files'], [file]);

		dispatchDrag(composer, 'dragenter', transfer);
		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			'Drop files to attach'
		);

		const dragOver = dispatchDrag(composer, 'dragover', transfer);
		expect(dragOver.defaultPrevented).toBe(true);
		expect(transfer.dropEffect).toBe('copy');

		dispatchDrag(composer, 'drop', transfer);
		expect(props.onAttachFiles).toHaveBeenCalledWith([file]);
		expect(document.querySelector('[role="status"]')).toBeNull();
	});

	it('clears the drop target and rejects files when attachments become disabled', () => {
		const { composer, props, rerender } = renderComposer();
		const transfer = dataTransfer(['Files'], [new File(['data'], 'notes.txt')]);

		dispatchDrag(composer, 'dragenter', transfer);
		expect(document.querySelector('[role="status"]')).not.toBeNull();
		rerender({ ...props, submitting: 'request' });
		expect(within(composer).queryByText('Drop files to attach')).toBeNull();

		dispatchDrag(composer, 'dragover', transfer);
		expect(transfer.dropEffect).toBe('none');
		dispatchDrag(composer, 'drop', transfer);
		expect(props.onAttachFiles).not.toHaveBeenCalled();
	});

	it('leaves text drags to the browser', () => {
		const { composer, props } = renderComposer();
		const transfer = dataTransfer(['text/plain'], [], 'move');

		const dragEnter = dispatchDrag(composer, 'dragenter', transfer);
		const dragOver = dispatchDrag(composer, 'dragover', transfer);
		const drop = dispatchDrag(composer, 'drop', transfer);

		expect(dragEnter.defaultPrevented).toBe(false);
		expect(dragOver.defaultPrevented).toBe(false);
		expect(drop.defaultPrevented).toBe(false);
		expect(transfer.dropEffect).toBe('move');
		expect(props.onAttachFiles).not.toHaveBeenCalled();
		expect(document.querySelector('[role="status"]')).toBeNull();
	});
});

describe('PromptComposer workspace path mentions', () => {
	const entries = [
		{ path: 'src/app.tsx', kind: 'file' as const },
		{ path: 'src/my components', kind: 'directory' as const }
	];

	function renderWithPathSearch(overrides: Partial<PromptComposerProps> = {}) {
		return renderComposer({
			projectPaths: {
				workspacePath: '/workspace',
				search: vi.fn(async () => ({ entries, scanning: false }))
			},
			...overrides
		});
	}

	async function waitForPathOptions(count: number) {
		await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(count));
	}

	it.each([
		['unavailable', 'Select a workspace'],
		['loading', 'Searching workspace files'],
		['scanning', 'Searching workspace files'],
		['empty', 'No matching files or directories'],
		['error', "Couldn't search workspace files"]
	])('allows submission and focus navigation while search is %s', async (state, message) => {
		const pending = Promise.withResolvers<WorkspaceSearchResult>();

		const { props, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			projectPaths:
				state === 'unavailable'
					? null
					: {
							workspacePath: '/workspace',
							search: vi.fn(async () => {
								if (state === 'loading') return pending.promise;

								if (state === 'error') throw new Error('Search failed');

								return { entries: [], scanning: state === 'scanning' };
							})
						}
		});

		await typeInComposer(textarea, 'Inspect @missing');
		await waitFor(() =>
			expect(document.querySelector('[role="listbox"]')?.textContent).toContain(message)
		);
		const tab = await pressKey(textarea, { key: 'Tab' });
		expect(tab.defaultPrevented).toBe(false);
		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it('returns focus to the composer after retry so results can be selected by keyboard', async () => {
		const search = vi
			.fn()
			.mockRejectedValueOnce(new Error('Search failed'))
			.mockResolvedValueOnce({ entries, scanning: false });

		const { textarea } = renderComposer({
			projectPaths: { workspacePath: '/workspace', search }
		});

		await typeInComposer(textarea, '@src');
		await waitFor(() =>
			expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
				"Couldn't search workspace files"
			)
		);
		const retry = findButton('Retry');
		await act(async () => retry.focus());
		await click(retry);
		expect(document.activeElement).toBe(textarea);
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'Enter' });
		expect(textarea.value).toBe('[app.tsx](src/app.tsx) ');
	});

	it('opens completion for a second identical mention after dismissing the first', async () => {
		const { textarea } = renderWithPathSearch();

		await typeInComposer(textarea, '@src @src');
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'Escape' });
		expect(textarea.getAttribute('aria-expanded')).toBe('false');
		await act(async () => {
			textarea.setSelectionRange(4, 4);
			textarea.click();
		});
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'Enter' });
		expect(textarea.value).toBe('[app.tsx](src/app.tsx) @src');
	});

	it('selects files and directories by keyboard without submitting', async () => {
		const { props, textarea } = renderWithPathSearch();

		await typeInComposer(textarea, 'Fix @src');
		await waitForPathOptions(2);
		expect(textarea.getAttribute('aria-expanded')).toBe('true');
		await pressKey(textarea, { key: 'Enter', isComposing: true });
		expect(textarea.value).toBe('Fix @src');
		await pressKey(textarea, { key: 'Enter' });
		expect(textarea.value).toBe('Fix [app.tsx](src/app.tsx) ');
		expect(textarea.selectionStart).toBe(textarea.value.length);

		await typeInComposer(textarea, 'Inspect @src');
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'ArrowDown' });
		expect(textarea.getAttribute('aria-activedescendant')).toBe('composer-path-option-1');
		await pressKey(textarea, { key: 'Tab' });
		expect(textarea.value).toBe('Inspect [my components](src/my%20components/) ');
		expect(props.onSubmit).not.toHaveBeenCalled();
	});

	it('selects with the mouse and dismisses with Escape', async () => {
		const { textarea } = renderWithPathSearch();

		await typeInComposer(textarea, '@app');
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'Escape' });
		expect(textarea.getAttribute('aria-expanded')).toBe('false');
		await typeInComposer(textarea, '@apps');
		await waitForPathOptions(2);
		await click(findButton('src/app.tsx'));
		expect(textarea.value).toBe('[app.tsx](src/app.tsx) ');
		expect(document.activeElement).toBe(textarea);
	});

	it('explains how to enable search without a connected workspace', async () => {
		const { textarea } = renderComposer();
		await typeInComposer(textarea, '@');
		expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
			'Select a workspace and connect its server'
		);
	});
});

describe('PromptComposer submission', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('leaves touchscreen Enter to insert a newline and sends through the button', async () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query) => ({ matches: query === '(pointer: coarse)' }))
		);

		const { props, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			prompt: 'Hello',
			onPromptChange: vi.fn()
		});

		const event = await pressKey(textarea, { key: 'Enter' });
		expect(event.defaultPrevented).toBe(false);
		await typeInComposer(textarea, 'Hello\nAnother line');
		expect(props.onPromptChange).toHaveBeenCalledWith('Hello\nAnother line');
		expect(textarea.value).toBe('Hello\nAnother line');
		await click(screen.getByRole('button', { name: 'Send message' }));
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it('keeps touchscreen Enter as a newline while skill suggestions are open', async () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query) => ({ matches: query === '(pointer: coarse)' }))
		);

		const { textarea } = renderComposer({
			projectSkills: { workspacePath: '/work', load: async () => skills }
		});

		await typeInComposer(textarea, '$ki');
		await screen.findByRole('option', { name: /kicad/ });
		const event = await pressKey(textarea, { key: 'Enter' });
		expect(event.defaultPrevented).toBe(false);
		await typeInComposer(textarea, '$ki\n');
		expect(textarea.value).toBe('$ki\n');
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
	});

	it('submits on Enter, ignores Shift+Enter, and ignores Enter while composing', async () => {
		vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

		const { props, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			prompt: 'Hello'
		});

		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();

		await pressKey(textarea, { key: 'Enter', shiftKey: true });
		expect(props.onSubmit).toHaveBeenCalledOnce();

		await pressKey(textarea, { key: 'Enter', isComposing: true });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it('allows retrying after a run failure', async () => {
		const { props, composer, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			prompt: 'Try again',
			notices: <div role="alert">A previous run failed.</div>
		});

		expect(composer.querySelector('[role="alert"]')?.textContent).toBe('A previous run failed.');
		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});
});

describe('PromptComposer attachments', () => {
	it('renders attachment status and removes by local id during a run', async () => {
		const { props } = renderComposer({
			isRunning: true,
			attachments: [
				{
					localId: 'ready-1',
					name: 'board.kicad_sch',
					mediaType: 'application/octet-stream',
					size: 2048,
					status: 'ready'
				},
				{
					localId: 'upload-1',
					name: 'photo.png',
					mediaType: 'image/png',
					previewUrl: 'blob:photo',
					size: 512,
					status: 'uploading'
				},
				{
					localId: 'error-1',
					name: 'notes.txt',
					mediaType: 'text/plain',
					size: 12,
					status: 'error',
					error: 'Upload failed'
				}
			]
		});

		expect(document.querySelector('[aria-label="Attached files"]')).not.toBeNull();
		expect(document.body.textContent).toContain('board.kicad_sch');
		expect(document.body.textContent).toContain('2 KiB');
		expect(document.body.textContent).toContain('Failed');
		expect(document.querySelector('[aria-label="Uploading photo.png"]')).not.toBeNull();
		expect(
			document
				.querySelector('[aria-label="Remove notes.txt"]')
				?.closest('li')
				?.getAttribute('title')
		).toBe('Upload failed');

		await click(document.querySelector<HTMLButtonElement>('[aria-label="Remove board.kicad_sch"]'));
		expect(props.onRemoveAttachment).toHaveBeenCalledWith('ready-1');
	});

	it('attaches pasted files during a run when the clipboard has no text', async () => {
		const { props, textarea } = renderComposer({ isRunning: true });
		const file = new File(['png'], 'shot.png', { type: 'image/png' });
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', {
			value: { files: [file], getData: () => '' }
		});

		act(() => {
			textarea.dispatchEvent(event);
		});

		expect(props.onAttachFiles).toHaveBeenCalledWith([file]);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('PromptComposer skill menu', () => {
	it('submits a message ending in an unmatched slash token with Enter', async () => {
		const { textarea, props } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills },
			modelCatalog,
			selectedModel: 'model-one'
		});

		await typeInComposer(textarea, 'inspect /tmp');
		expect(screen.getByText('No matching commands')).toBeTruthy();
		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it.each(['/', '$'])(
		'inserts a disabled skill with slash when selected through %s',
		async (prefix) => {
			const { textarea, props } = renderComposer({
				projectSkills: { workspacePath: '/demo', load: async () => skills },
				onPromptChange: vi.fn(),
				onSubmit: vi.fn()
			});

			await typeInComposer(textarea, prefix);

			const listbox = await screen.findByRole('listbox', {
				name: prefix === '/' ? 'Available commands' : 'Available skills'
			});

			expect(within(listbox).getAllByRole('option')).toHaveLength(prefix === '/' ? 1 : 2);
			await click(within(listbox).getByText(`${prefix}zap`));
			expect(props.onPromptChange).toHaveBeenCalledWith('/zap ');
			expect(textarea.value).toBe('/zap ');
			expect(document.activeElement).toBe(textarea);
			expect(props.onSubmit).not.toHaveBeenCalled();
		}
	);

	it('filters slash commands and selects with Tab', async () => {
		const { textarea, props } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills },
			onPromptChange: vi.fn()
		});

		await typeInComposer(textarea, '/za');
		expect(screen.getByRole('option').textContent).toContain('/zap');
		await pressKey(textarea, { key: 'Tab' });
		expect(props.onPromptChange).toHaveBeenCalledWith('/zap ');
	});

	it('loads project skills on $ and selects the highlighted one', async () => {
		const { textarea, props } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills },
			onPromptChange: vi.fn()
		});

		await typeInComposer(textarea, '$');
		const listbox = document.getElementById('composer-skills-listbox');
		expect(listbox?.getAttribute('role')).toBe('listbox');
		const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]');
		expect(options).toHaveLength(2);
		expect(options[0]?.textContent).toContain('$kicad');

		await pressKey(textarea, { key: 'ArrowDown' });
		expect(options[1]?.getAttribute('aria-selected')).toBe('true');

		await pressKey(textarea, { key: 'Enter' });
		expect(props.onPromptChange).toHaveBeenCalledWith('/zap ');
		expect(textarea.value).toBe('/zap ');
		expect(document.getElementById('composer-skills-listbox')).toBeNull();
		expect(document.activeElement).toBe(textarea);
	});

	it('wraps highlight navigation and dismisses on Escape', async () => {
		const { textarea } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills }
		});

		await typeInComposer(textarea, '$');
		const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]');

		await pressKey(textarea, { key: 'ArrowUp' });
		expect(options[1]?.getAttribute('aria-selected')).toBe('true');
		await pressKey(textarea, { key: 'ArrowDown' });
		expect(options[0]?.getAttribute('aria-selected')).toBe('true');

		await pressKey(textarea, { key: 'Escape' });
		expect(document.getElementById('composer-skills-listbox')).toBeNull();
	});

	it('filters skills by the typed query', async () => {
		const { textarea, props } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills },
			onPromptChange: vi.fn()
		});

		await typeInComposer(textarea, '$ki');
		const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]');
		expect(options).toHaveLength(1);
		expect(options[0]?.textContent).toContain('$kicad');

		await pressKey(textarea, { key: 'Tab' });
		expect(props.onPromptChange).toHaveBeenCalledWith('$kicad ');
	});

	it('retries a failed skill load', async () => {
		const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(skills);

		const { textarea } = renderComposer({
			projectSkills: { workspacePath: '/demo', load }
		});

		await typeInComposer(textarea, '$');
		expect(document.body.textContent).toContain('Couldn’t load skills');

		await click(findButton('Retry'));
		expect(load).toHaveBeenCalledTimes(2);
		expect(document.getElementById('composer-skills-listbox')?.getAttribute('role')).toBe(
			'listbox'
		);
	});

	it('loads the new project skills when the project changes', async () => {
		const { textarea, props, rerender } = renderComposer({
			projectSkills: { workspacePath: '/demo', load: async () => skills }
		});

		await typeInComposer(textarea, '$');
		expect(screen.getAllByRole('option')).toHaveLength(2);

		await act(async () =>
			rerender({
				...props,
				projectSkills: { workspacePath: '/other', load: async () => skills.slice(0, 1) }
			})
		);
		expect(screen.getAllByRole('option')).toHaveLength(1);
	});

	it('ignores a stale load for a project the user left and came back to', async () => {
		const stale = Promise.withResolvers<typeof skills>();
		const fresh = Promise.withResolvers<typeof skills>();
		const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
		const demo = { workspacePath: '/demo', load };
		const { textarea, props, rerender } = renderComposer({ projectSkills: demo });

		await typeInComposer(textarea, '$');
		await act(async () =>
			rerender({ ...props, projectSkills: { workspacePath: '/other', load: async () => [] } })
		);
		await act(async () => rerender({ ...props, projectSkills: demo }));
		await act(async () => stale.reject(new Error('offline')));
		await act(async () => fresh.resolve(skills));

		expect(screen.getAllByRole('option')).toHaveLength(2);
	});
});

describe('PromptComposer mobile selectors', () => {
	beforeEach(() => {
		vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('applies model, reasoning, and speed together after Done', async () => {
		const { props } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onSelectedModelChange: vi.fn(),
			onSelectedReasoningEffortChange: vi.fn(),
			onServiceTierChange: vi.fn()
		});

		await click(screen.getByRole('button', { name: 'Select model' }));
		const sheet = screen.getByRole('dialog', { name: 'Model settings' });
		expect(within(sheet).getByText('Default: Medium')).toBeTruthy();
		await click(within(sheet).getByRole('button', { name: 'Low' }));
		await click(within(sheet).getByRole('switch', { name: 'Fast mode' }));
		expect(props.onSelectedModelChange).not.toHaveBeenCalled();
		await click(within(sheet).getByRole('button', { name: 'Done' }));
		expect(props.onSelectedModelChange).toHaveBeenCalledWith('model-one');
		expect(props.onSelectedReasoningEffortChange).toHaveBeenCalledWith('low');
		expect(props.onServiceTierChange).toHaveBeenCalledWith('fast');
	});

	it('applies the explicit Ultrafast choice after Done', async () => {
		const { props } = renderComposer({
			modelCatalog: ultrafastCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			isDirectOpenAIByok: () => true,
			onServiceTierChange: vi.fn()
		});

		await click(screen.getByRole('button', { name: 'Select model' }));
		const sheet = screen.getByRole('dialog', { name: 'Model settings' });
		await click(within(sheet).getByRole('switch', { name: 'Ultrafast mode' }));
		expect(props.onServiceTierChange).not.toHaveBeenCalled();
		await click(within(sheet).getByRole('button', { name: 'Done' }));
		expect(props.onServiceTierChange).toHaveBeenLastCalledWith('ultrafast');
	});

	it('resets reasoning for a new model and discards edits on close', async () => {
		const { props } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onSelectedModelChange: vi.fn()
		});

		await click(screen.getByRole('button', { name: 'Select model' }));
		await click(screen.getByRole('button', { name: 'Model Two' }));
		expect(screen.getByText('Default: High')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'High', pressed: true })).toBeTruthy();
		expect(screen.queryByRole('switch')).toBeNull();
		await click(screen.getByRole('button', { name: 'Close model settings' }));
		expect(props.onSelectedModelChange).not.toHaveBeenCalled();
		await click(screen.getByRole('button', { name: 'Select model' }));
		expect(screen.getByRole('button', { name: 'Model One', pressed: true })).toBeTruthy();
	});
});

describe('PromptComposer model selection', () => {
	it('shows the model selector with the catalog default once the catalog loads', () => {
		const { props, rerender } = renderComposer();

		expect(screen.queryByRole('button', { name: 'Select model' })).toBeNull();

		rerender({ ...props, modelCatalog: { ...modelCatalog, defaultModelId: 'model-two' } });

		expect(screen.getByRole('button', { name: 'Select model' }).title).toBe('Model Two · High');
	});

	it('uses the fallback model default reasoning', async () => {
		renderComposer({
			modelCatalog: {
				...modelCatalog,
				models: [
					{ ...modelCatalog.models[1], reasoningEfforts: ['low', 'high'] },
					{ ...modelCatalog.models[0], provider: 'openai' }
				]
			},
			selectedModel: 'removed-model',
			selectedReasoningEffort: 'low'
		});

		expect(screen.getByRole('button', { name: 'Select model' }).title).toBe('Model One · Medium');
	});

	it("fills unset reasoning with the model's own default", () => {
		const onSelectedReasoningEffortChange = vi.fn();
		renderComposer({ modelCatalog, selectedModel: 'model-two', onSelectedReasoningEffortChange });

		expect(onSelectedReasoningEffortChange).toHaveBeenCalledWith('high');
	});

	it('keeps the model menu anchored when a parent scrolls', async () => {
		const { composer } = renderComposer({ modelCatalog, selectedModel: 'model-one' });
		const trigger = screen.getByRole('button', { name: 'Select model' });
		const rect = vi.spyOn(trigger, 'getBoundingClientRect');
		rect.mockReturnValue(new DOMRect(100, 400, 44, 44));
		await click(trigger);
		const menu = screen.getByRole('dialog', { name: 'Model' });
		expect(menu.style.bottom).toBe(`${window.innerHeight - 400 + 12}px`);

		rect.mockReturnValue(new DOMRect(100, 280, 44, 44));
		fireEvent.scroll(composer.parentElement!);
		expect(menu.style.bottom).toBe(`${window.innerHeight - 280 + 12}px`);
	});

	it('previews a hovered model and selects its reasoning without changing models on hover', async () => {
		const onSelectedModelChange = vi.fn();
		const onSelectedReasoningEffortChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onSelectedModelChange,
			onSelectedReasoningEffortChange
		});
		const trigger = screen.getByRole('button', { name: 'Select model' });
		expect(trigger.textContent).toBe('Model One · Medium');
		await click(trigger);
		const menu = screen.getByRole('dialog', { name: 'Model' });
		const modelTwo = within(menu).getByRole('button', { name: 'Model Two' });
		fireEvent.mouseEnter(modelTwo);
		expect(onSelectedModelChange).not.toHaveBeenCalled();
		expect(trigger.textContent).toBe('Model One · Medium');
		const settings = within(menu).getByRole('group', { name: 'Reasoning for Model Two' });
		await click(within(settings).getByRole('button', { name: 'High (default)' }));
		expect(onSelectedModelChange).toHaveBeenCalledWith('model-two');
		expect(onSelectedReasoningEffortChange).toHaveBeenCalledWith('high');
		expect(trigger.textContent).toBe('Model Two · High');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		await click(trigger);
		await pressKey(document, { key: 'Escape' });
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(trigger);
		await click(trigger);
		await act(async () => {
			document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		});
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
	});

	it('offers a selectable default alongside the other reasoning choices', async () => {
		renderComposer({ modelCatalog, selectedModel: 'model-one', selectedReasoningEffort: 'low' });
		await click(screen.getByRole('button', { name: 'Select model' }));
		const model = screen.getByRole('button', { name: 'Model One' });
		fireEvent.mouseEnter(model);
		const settings = screen.getByRole('group', { name: 'Reasoning for Model One' });
		expect(within(settings).getByRole('button', { name: 'Low', pressed: true })).toBeTruthy();
		expect(within(settings).getByText('Default')).toBeTruthy();
		await click(within(settings).getByRole('button', { name: 'Medium (default)', pressed: false }));
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model One · Medium'
		);
	});

	it('navigates from model rows to reasoning with the keyboard', async () => {
		renderComposer({ modelCatalog, selectedModel: 'model-one', selectedReasoningEffort: 'medium' });
		await click(screen.getByRole('button', { name: 'Select model' }));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model One' }));
		await pressKey(document.activeElement!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model Two' }));
		await pressKey(document.activeElement!, { key: 'ArrowRight' });
		const high = screen.getByRole('button', { name: /^High/ });
		expect(document.activeElement).toBe(high);
		await pressKey(high, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model Two' }));
		await pressKey(document.activeElement!, { key: 'ArrowUp' });
		await pressKey(document.activeElement!, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Medium (default)' }));
		await pressKey(document.activeElement!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Fast mode' }));
		await pressKey(document.activeElement!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Low' }));
	});

	it('opens reasoning on touch before selecting a model and effort', async () => {
		renderComposer({ modelCatalog, selectedModel: 'model-one', selectedReasoningEffort: 'medium' });
		await click(screen.getByRole('button', { name: 'Select model' }));
		const model = screen.getByRole('button', { name: 'Model Two' });
		const touch = new Event('pointerdown', { bubbles: true });
		Object.defineProperty(touch, 'pointerType', { value: 'touch' });
		fireEvent(model, touch);
		await click(model);
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model One · Medium'
		);
		await click(screen.getByRole('button', { name: /^High/ }));
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model Two · High'
		);
	});

	it('focuses the selected model on open and selects a model with its default reasoning', async () => {
		renderComposer({ modelCatalog, selectedModel: 'model-one', selectedReasoningEffort: 'medium' });
		await click(screen.getByRole('button', { name: 'Select model' }));
		const menu = screen.getByRole('dialog', { name: 'Model' });
		expect(document.activeElement).toBe(within(menu).getByRole('button', { name: 'Model One' }));
		await click(within(menu).getByRole('button', { name: 'Model Two', pressed: false }));
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model Two · High'
		);
		await click(screen.getByRole('button', { name: 'Select model' }));
		const reopenedMenu = screen.getByRole('dialog', { name: 'Model' });
		expect(document.activeElement).toBe(
			within(reopenedMenu).getByRole('button', { name: 'Model Two', pressed: true })
		);
	});

	it.each([true, false])(
		'shows provider-managed models with only their supported speed controls (Fast: %s)',
		async (supportsFastMode) => {
			renderComposer({
				modelCatalog: {
					...modelCatalog,
					models: [
						{
							...modelCatalog.models[0],
							reasoningEfforts: ['none'],
							defaultReasoningEffort: 'none',
							supportsFastMode
						}
					]
				},
				selectedModel: 'model-one',
				selectedReasoningEffort: 'none'
			});
			const trigger = screen.getByRole('button', { name: 'Select model' });
			expect(trigger.textContent).toBe('Model One');
			await click(trigger);
			const menu = screen.getByRole('dialog', { name: 'Model' });
			expect(within(menu).getAllByRole('button')).toHaveLength(1);

			if (supportsFastMode) {
				fireEvent.mouseEnter(within(menu).getByRole('button', { name: 'Model One' }));
				await click(within(menu).getByRole('switch', { name: 'Fast mode' }));
				expect(trigger.textContent).toBe('Model One · Fast');
			} else {
				expect(within(menu).getByRole('button', { name: 'Model One', pressed: true })).toBeTruthy();
			}
		}
	);

	it('normalizes unsupported reasoning before the model menu is opened', () => {
		const onSelectedReasoningEffortChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-two',
			selectedReasoningEffort: 'medium',
			onSelectedReasoningEffortChange
		});
		expect(onSelectedReasoningEffortChange).toHaveBeenCalledWith('high');
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model Two · High'
		);
	});

	it('selects another model and resets reasoning', async () => {
		const onSelectedModelChange = vi.fn();
		const onSelectedReasoningEffortChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onSelectedModelChange,
			onSelectedReasoningEffortChange
		});

		await click(screen.getByRole('button', { name: 'Select model' }));
		await click(
			within(screen.getByRole('dialog', { name: 'Model' })).getByRole('button', {
				name: 'Model Two'
			})
		);

		expect(onSelectedModelChange).toHaveBeenCalledWith('model-two');
		expect(onSelectedReasoningEffortChange).toHaveBeenCalledWith('high');
	});
});

describe('PromptComposer Fast mode', () => {
	it('offers exclusive speed toggles below reasoning and resets when the provider changes', async () => {
		const { props, rerender } = renderComposer({
			modelCatalog: ultrafastCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			isDirectOpenAIByok: () => true,
			onServiceTierChange: vi.fn()
		});

		const trigger = screen.getByRole('button', { name: 'Select model' });
		await click(trigger);
		const settings = screen.getByRole('group', { name: 'Reasoning for Model One' });
		const speeds = screen.getByRole('group', { name: 'Speed' });
		expect(settings.lastElementChild).toBe(speeds);
		const fast = within(speeds).getByRole('switch', { name: 'Fast mode' });
		const ultrafast = within(speeds).getByRole('switch', { name: 'Ultrafast mode' });
		await click(fast);
		expect(fast.getAttribute('aria-checked')).toBe('true');
		await click(ultrafast);
		expect(fast.getAttribute('aria-checked')).toBe('false');
		expect(ultrafast.getAttribute('aria-checked')).toBe('true');
		expect(trigger.title).toBe('Model One · Medium · Ultrafast');
		expect(props.onServiceTierChange).toHaveBeenLastCalledWith('ultrafast');
		await click(ultrafast);
		expect(props.onServiceTierChange).toHaveBeenLastCalledWith('standard');
		await click(ultrafast);
		rerender({ ...props, isDirectOpenAIByok: () => false });
		expect(props.onServiceTierChange).toHaveBeenLastCalledWith('standard');
		expect(screen.getByRole('switch', { name: 'Fast mode' })).toBeTruthy();
	});

	it('offers and toggles Fast for a supported model', async () => {
		const onServiceTierChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onServiceTierChange
		});

		const trigger = screen.getByRole('button', { name: 'Select model' });
		await click(trigger);
		fireEvent.mouseEnter(screen.getByRole('button', { name: 'Model One' }));
		const toggle = screen.getByRole('switch', { name: 'Fast mode' });
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await click(toggle);
		expect(onServiceTierChange).toHaveBeenCalledWith('fast');
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(trigger.textContent).toBe('Model One · Medium · Fast');
	});

	it('applies speed to the previewed model even without reasoning options', async () => {
		const onSelectedModelChange = vi.fn();
		renderComposer({
			modelCatalog: {
				...modelCatalog,
				models: modelCatalog.models.map((model) => ({
					...model,
					supportsFastMode: true,
					reasoningEfforts: ['none'],
					defaultReasoningEffort: 'none'
				}))
			},
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			onSelectedModelChange
		});
		await click(screen.getByRole('button', { name: 'Select model' }));
		fireEvent.mouseEnter(screen.getByRole('button', { name: 'Model Two' }));
		await click(screen.getByRole('switch', { name: 'Fast mode' }));
		expect(screen.getByRole('button', { name: 'Select model' }).textContent).toBe(
			'Model Two · Fast'
		);
		expect(onSelectedModelChange).toHaveBeenCalledWith('model-two');
	});

	it('turns Fast off only when the model does not support it', async () => {
		const onServiceTierChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-two',
			selectedReasoningEffort: 'high',
			serviceTier: 'fast',
			onServiceTierChange
		});

		expect(onServiceTierChange).toHaveBeenCalledWith('standard');
		await click(screen.getByRole('button', { name: 'Select model' }));
		expect(screen.queryByRole('switch')).toBeNull();
	});
});

describe('PromptComposer agent questions', () => {
	it('drops the answer draft and shows one question action at a time', async () => {
		const onSelectedQuestionOptionIdChange = vi.fn();
		const onSkipQuestion = vi.fn();

		const actions = () =>
			Array.from(document.querySelectorAll('button'))
				.map((button) => button.getAttribute('aria-label') ?? button.textContent)
				.filter((name) =>
					['Send answer', 'Skip question', 'Stop generation', 'Send message'].includes(name ?? '')
				);

		const { textarea } = renderComposer({
			prompt: 'draft answer',
			pendingQuestion: {
				questionId: 'question-1',
				question: 'Which board should I target?',
				options: [
					{ id: 'option-a', label: 'Option A' },
					{ id: 'option-b', label: 'Option B' }
				]
			},
			isRunning: true,
			onSelectedQuestionOptionIdChange,
			onSkipQuestion
		});

		expect(textarea.value).toBe('');
		expect(textarea.getAttribute('placeholder')).toBe('Add detail, or type a custom answer');
		expect(actions()).toEqual(['Skip question']);

		await click(findButton('Skip question'));
		expect(onSkipQuestion).toHaveBeenCalled();

		await click(findButton('Option A'));
		expect(onSelectedQuestionOptionIdChange).toHaveBeenCalledWith('option-a');
		expect(actions()).toEqual(['Send answer']);
	});

	it('expands the question from its text but collapses it only from the chevron', async () => {
		const { props, rerender } = renderComposer({
			pendingQuestion: {
				questionId: 'question-1',
				question: 'Which board should I target?',
				options: [{ id: 'option-a', label: 'Option A' }]
			}
		});

		const answerOptions = () => document.querySelector('[aria-label="Answer options"]');

		expect(answerOptions()).not.toBeNull();
		rerender({ ...props, runEnded: true });
		expect(answerOptions()).toBeNull();

		const questionText = () => screen.getByText('Which board should I target?');

		await click(questionText());
		expect(answerOptions()).not.toBeNull();

		await click(questionText());
		expect(answerOptions()).not.toBeNull();

		await click(document.querySelector<HTMLElement>('[aria-label="Collapse question"]'));
		expect(answerOptions()).toBeNull();
	});
});

describe('PromptComposer attach tooltip', () => {
	it('shows the attach tooltip while the button is focused', async () => {
		renderComposer();
		const attachButton = document.querySelector<HTMLButtonElement>('[aria-label="Attach files"]');

		await act(async () => {
			attachButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		});
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Attach files');

		await act(async () => {
			attachButton?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
		});
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
	});
});
