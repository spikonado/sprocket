import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, waitFor } from '@testing-library/react';
import type { ModelCatalog } from '$lib/chat/model-catalog';
import PromptComposerTestHarness from './prompt-composer-test-harness';
import type { PromptComposerViewProps } from './prompt-composer';
import type { WorkspaceSearchResult } from '$lib/types/sprocket';

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
	{ name: 'kicad', description: 'Author KiCad schematics' },
	{ name: 'zap', description: 'Zap tooling' }
];

function composerProps(overrides: Partial<PromptComposerViewProps> = {}): PromptComposerViewProps {
	return {
		attachments: [],
		onAttachFiles: vi.fn(),
		onRemoveAttachment: vi.fn(),
		canSend: true,
		isSubmitting: false,
		isStarting: false,
		isRunning: false,
		runStartedAt: null,
		usage: undefined,
		usageFailed: false,
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
		...overrides
	};
}

function renderComposer(overrides: Partial<PromptComposerViewProps> = {}) {
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
		rerender: (next: PromptComposerViewProps) =>
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
		rerender({ ...props, isRunning: true });
		expect(document.querySelector('[role="status"]')).toBeNull();

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

	function renderWithPathSearch(overrides: Partial<PromptComposerViewProps> = {}) {
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
			usage: { tier: 'pro', exhausted: false, resetsAt: null },
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
		expect(textarea.value).toBe('@src/app.tsx ');
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
		expect(textarea.value).toBe('@src/app.tsx @src');
	});

	it('selects files and directories by keyboard without submitting', async () => {
		const { props, textarea } = renderWithPathSearch();

		await typeInComposer(textarea, 'Fix @src');
		await waitForPathOptions(2);
		expect(textarea.getAttribute('aria-expanded')).toBe('true');
		await pressKey(textarea, { key: 'Enter', isComposing: true });
		expect(textarea.value).toBe('Fix @src');
		await pressKey(textarea, { key: 'Enter' });
		expect(textarea.value).toBe('Fix @src/app.tsx ');
		expect(textarea.selectionStart).toBe(textarea.value.length);

		await typeInComposer(textarea, 'Inspect @src');
		await waitForPathOptions(2);
		await pressKey(textarea, { key: 'ArrowDown' });
		expect(textarea.getAttribute('aria-activedescendant')).toBe('composer-path-option-1');
		await pressKey(textarea, { key: 'Tab' });
		expect(textarea.value).toBe('Inspect @"src/my components/" ');
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
		expect(textarea.value).toBe('@src/app.tsx ');
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
	it('submits on Enter, ignores Shift+Enter, and ignores Enter while composing', async () => {
		const { props, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			prompt: 'Hello',
			usage: { tier: 'pro', exhausted: false, resetsAt: null }
		});

		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();

		await pressKey(textarea, { key: 'Enter', shiftKey: true });
		expect(props.onSubmit).toHaveBeenCalledOnce();

		await pressKey(textarea, { key: 'Enter', isComposing: true });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it('blocks submission and explains the limit when usage is exhausted', async () => {
		const { props, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			prompt: 'Hello',
			usage: { tier: 'pro', exhausted: true, resetsAt: null }
		});

		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("You're out of usage");
		expect(alert?.textContent).toContain('Upgrade your subscription to keep going.');
		expect(document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(
			true
		);

		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).not.toHaveBeenCalled();
	});
});

describe('PromptComposer attachments', () => {
	it('renders attachment status and removes by local id', async () => {
		const { props } = renderComposer({
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

	it('attaches pasted files when the clipboard has no text', async () => {
		const { props, textarea } = renderComposer();
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
		expect(props.onPromptChange).toHaveBeenCalledWith('$zap ');
		expect(textarea.value).toBe('$zap ');
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

		await typeInComposer(textarea, '$za');
		const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]');
		expect(options).toHaveLength(1);
		expect(options[0]?.textContent).toContain('$zap');

		await pressKey(textarea, { key: 'Tab' });
		expect(props.onPromptChange).toHaveBeenCalledWith('$zap ');
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
});

describe('PromptComposer model selection', () => {
	it('offers ChatGPT gateway models and allows sending when connected', async () => {
		const onSelectedModelChange = vi.fn();

		const { props, textarea } = renderComposer({
			modelCatalog: {
				...modelCatalog,
				models: [
					{
						...modelCatalog.models[0],
						id: 'gpt-6.1-sol',
						label: 'GPT-6.1 Sol',
						provider: 'openai'
					},
					{ ...modelCatalog.models[1], id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' },
					modelCatalog.models[0]
				]
			},
			configuredProviders: ['spikonado', 'chatgpt'],
			selectedCompletionProvider: 'chatgpt',
			selectedModel: 'gpt-6.1-sol',
			prompt: 'Hello',
			onSelectedModelChange
		});

		await click(document.querySelector<HTMLButtonElement>('[aria-label="Select model"]'));
		const menu = document.querySelector('[role="dialog"][aria-label="Model"]');
		expect(
			Array.from(menu?.querySelectorAll('button') ?? [], (button) => button.textContent)
		).toEqual([expect.stringContaining('GPT-6.1 Sol'), expect.stringContaining('GPT-6 Luna')]);
		await click(findButton('GPT-6 Luna'));
		expect(onSelectedModelChange).toHaveBeenCalledWith('gpt-6-luna');
		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});

	it.each(['free', 'go', 'budget', 'pro', 'enterprise', undefined])(
		'selects every model and resets reasoning on tier %s',
		async (tier) => {
			const onSelectedModelChange = vi.fn();
			const onSelectedReasoningEffortChange = vi.fn();
			renderComposer({
				modelCatalog,
				selectedModel: 'model-one',
				selectedReasoningEffort: 'medium',
				usage: tier === undefined ? undefined : { tier, exhausted: false, resetsAt: null },
				onSelectedModelChange,
				onSelectedReasoningEffortChange
			});

			await click(document.querySelector<HTMLButtonElement>('[aria-label="Select model"]'));
			await click(findButton('Model Two'));

			expect(onSelectedModelChange).toHaveBeenCalledWith('model-two');
			expect(onSelectedReasoningEffortChange).toHaveBeenCalledWith('high');
		}
	);

	it('keeps the selected model when the subscription tier loads and changes', async () => {
		const onSelectedModelChange = vi.fn();

		const { props, rerender, textarea } = renderComposer({
			modelCatalog,
			selectedModel: 'model-two',
			selectedReasoningEffort: 'high',
			prompt: 'Hello',
			onSelectedModelChange
		});

		await act(async () => {
			rerender({ ...props, usage: { tier: 'free', exhausted: false, resetsAt: null } });
		});
		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).toHaveBeenCalledOnce();
		await act(async () => {
			rerender({ ...props, usage: { tier: 'pro', exhausted: false, resetsAt: null } });
		});
		expect(document.querySelector('[aria-label="Select model"]')?.textContent).toContain(
			'Model Two'
		);
		expect(onSelectedModelChange).not.toHaveBeenCalled();
	});
});

describe('PromptComposer Fast mode', () => {
	it.each([
		{ tier: 'free', usage: { tier: 'free', exhausted: false, resetsAt: null } },
		{ tier: 'paid', usage: { tier: 'paid', exhausted: false, resetsAt: null } },
		{ tier: 'loading', usage: undefined }
	])('offers and toggles Fast for a supported model on $tier', async ({ usage }) => {
		const onFastModeChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			usage,
			onFastModeChange
		});

		await click(
			document.querySelector<HTMLButtonElement>(
				'[aria-label="Select reasoning effort and Fast mode"]'
			)
		);
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		await click(toggle);
		expect(onFastModeChange).toHaveBeenCalledWith(true);
	});

	it('keeps Fast on when the subscription tier loads and changes', async () => {
		const onFastModeChange = vi.fn();

		const { props, rerender } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			fastMode: true,
			onFastModeChange
		});

		await act(async () => {
			rerender({ ...props, usage: { tier: 'free', exhausted: false, resetsAt: null } });
		});
		await act(async () => {
			rerender({ ...props, usage: { tier: 'pro', exhausted: false, resetsAt: null } });
		});

		expect(onFastModeChange).not.toHaveBeenCalledWith(false);
	});

	it('turns Fast off only when the model does not support it', async () => {
		const onFastModeChange = vi.fn();
		renderComposer({
			modelCatalog,
			selectedModel: 'model-two',
			selectedReasoningEffort: 'high',
			fastMode: true,
			usage: { tier: 'pro', exhausted: false, resetsAt: null },
			onFastModeChange
		});

		expect(onFastModeChange).toHaveBeenCalledWith(false);
		expect(document.querySelector('[role="switch"]')).toBeNull();
	});

	it('blocks submit when the free usage quota is exhausted even with Fast off', async () => {
		const { textarea, props } = renderComposer({
			modelCatalog,
			selectedModel: 'model-one',
			selectedReasoningEffort: 'medium',
			prompt: 'Hello',
			usage: { tier: 'free', exhausted: true, resetsAt: null }
		});

		await pressKey(textarea, { key: 'Enter' });
		expect(props.onSubmit).not.toHaveBeenCalled();
	});
});

describe('PromptComposer agent questions', () => {
	it('drops the answer draft and toggles question options', async () => {
		const onSelectedQuestionOptionIdChange = vi.fn();

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
			onSelectedQuestionOptionIdChange
		});

		expect(textarea.value).toBe('');
		expect(textarea.getAttribute('placeholder')).toBe('Add detail, or type a custom answer');
		expect(
			document.querySelector<HTMLButtonElement>('[aria-label="Submit answer"]')?.disabled
		).toBe(true);

		await click(findButton('Option A'));
		expect(onSelectedQuestionOptionIdChange).toHaveBeenCalledWith('option-a');
		expect(
			document.querySelector<HTMLButtonElement>('[aria-label="Submit answer"]')?.disabled
		).toBe(false);
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
