import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { closeConvex } from 'convex-svelte';
import PromptComposer from './prompt-composer.svelte';
import PromptComposerTestHarness from './prompt-composer-test-harness.svelte';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	document.body.replaceChildren();
	await closeConvex();
});

function renderComposer(overrides: Partial<ComponentProps<typeof PromptComposer>> = {}) {
	const onAttachFiles = vi.fn();
	const props = $state({
		attachments: [],
		onAttachFiles,
		onRemoveAttachment: vi.fn(),
		canSend: true,
		isSubmitting: false,
		isStarting: false,
		isRunning: false,
		elapsedLabel: null,
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
		...overrides
	} satisfies ComponentProps<typeof PromptComposer>);
	const component = mount(PromptComposerTestHarness, {
		target: document.body,
		props: { composerProps: props }
	});
	cleanup = () => unmount(component);
	flushSync();
	const composer = document.querySelector<HTMLElement>('[aria-label="Message composer"]');
	if (!composer) throw new Error('Message composer was not rendered');
	return { composer, onAttachFiles, props };
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
	target.dispatchEvent(event);
	flushSync();
	return event;
}

describe('PromptComposer file drag and drop', () => {
	it('shows a drop target and attaches dropped files', () => {
		const { composer, onAttachFiles } = renderComposer();
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
		expect(onAttachFiles).toHaveBeenCalledWith([file]);
		expect(document.querySelector('[role="status"]')).toBeNull();
	});

	it('clears the drop target and rejects files when attachments become disabled', () => {
		const { composer, onAttachFiles, props } = renderComposer();
		const transfer = dataTransfer(['Files'], [new File(['data'], 'notes.txt')]);

		dispatchDrag(composer, 'dragenter', transfer);
		expect(document.querySelector('[role="status"]')).not.toBeNull();
		props.isRunning = true;
		flushSync();
		expect(document.querySelector('[role="status"]')).toBeNull();

		dispatchDrag(composer, 'dragover', transfer);
		expect(transfer.dropEffect).toBe('none');
		dispatchDrag(composer, 'drop', transfer);
		expect(onAttachFiles).not.toHaveBeenCalled();
	});

	it('leaves text drags to the browser', () => {
		const { composer, onAttachFiles } = renderComposer();
		const transfer = dataTransfer(['text/plain'], [], 'move');

		const dragEnter = dispatchDrag(composer, 'dragenter', transfer);
		const dragOver = dispatchDrag(composer, 'dragover', transfer);
		const drop = dispatchDrag(composer, 'drop', transfer);

		expect(dragEnter.defaultPrevented).toBe(false);
		expect(dragOver.defaultPrevented).toBe(false);
		expect(drop.defaultPrevented).toBe(false);
		expect(transfer.dropEffect).toBe('move');
		expect(onAttachFiles).not.toHaveBeenCalled();
		expect(document.querySelector('[role="status"]')).toBeNull();
	});
});
