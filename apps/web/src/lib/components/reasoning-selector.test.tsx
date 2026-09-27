import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReasoningSelector from './reasoning-selector';

const model = {
	id: 'model-small',
	label: 'Model Small',
	provider: 'provider-one',
	supportsImages: false,
	contextWindowTokens: 100_000,
	autoHandoffTokenLimit: 80_000,
	reasoningEfforts: ['low', 'medium'],
	defaultReasoningEffort: 'medium',
	supportsFastMode: true
} as const;

const providerManagedModel = {
	...model,
	reasoningEfforts: ['none'],
	defaultReasoningEffort: 'none'
} as const;

type SelectorProps = React.ComponentProps<typeof ReasoningSelector>;

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
});

function renderSelector(overrides: Partial<SelectorProps> = {}) {
	act(() => {
		root.render(<ReasoningSelector model={model} reasoningEffort="medium" {...overrides} />);
	});
}

function rerenderSelector(overrides: Partial<SelectorProps> = {}) {
	act(() => {
		root.render(<ReasoningSelector model={model} reasoningEffort="medium" {...overrides} />);
	});
}

function openSelector() {
	const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
	if (!trigger) throw new Error('Reasoning selector trigger was not rendered');
	act(() => {
		trigger.click();
	});
}

describe('ReasoningSelector provider-managed reasoning', () => {
	it('omits the selector when reasoning has no user control and Fast mode is unsupported', () => {
		renderSelector({
			model: { ...providerManagedModel, supportsFastMode: false },
			reasoningEffort: 'none',
			fastModeAccess: 'unsupported'
		});
		expect(document.querySelector('button')).toBeNull();
		expect(document.body.textContent).not.toContain('None');
	});

	it('shows only speed controls when reasoning has no user control', () => {
		renderSelector({
			model: providerManagedModel,
			reasoningEffort: 'none',
			fastModeAccess: 'available'
		});
		openSelector();
		expect(document.body.textContent).toContain('Speed');
		expect(document.body.textContent).not.toContain('Reasoning');
		expect(document.body.textContent).not.toContain('None');
		expect(document.querySelector('[role="switch"]')).not.toBeNull();
	});
});

describe('ReasoningSelector Fast mode', () => {
	it('omits the control for models without Fast support', () => {
		renderSelector({
			model: { ...model, supportsFastMode: false },
			fastMode: true,
			fastModeAccess: 'unsupported'
		});
		openSelector();
		expect(document.querySelector('[role="switch"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Speed');
		expect(document.body.textContent).not.toContain('Fast');
	});

	it('renders an enabled toggle when Fast mode is available', () => {
		const onFastModeChange = vi.fn();
		renderSelector({ fastModeAccess: 'available', onFastModeChange });
		openSelector();
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		act(() => {
			toggle?.click();
		});
		expect(onFastModeChange).toHaveBeenCalledWith(true);
		rerenderSelector({ fastModeAccess: 'available', fastMode: true, onFastModeChange });
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
	});

	it('renders a locked toggle when the model supports Fast but the tier does not', () => {
		renderSelector({
			fastModeAccess: 'locked',
			fastModeLockTooltip: 'Upgrade to use Fast mode'
		});
		openSelector();
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-disabled')).toBe('true');
		expect(toggle?.getAttribute('aria-label')).toContain('Upgrade to use Fast mode');
	});
});
