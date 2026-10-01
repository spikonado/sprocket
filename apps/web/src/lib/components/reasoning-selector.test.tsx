import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from '@testing-library/react';
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

function renderSelector(overrides: Partial<SelectorProps> = {}) {
	return render(<ReasoningSelector model={model} reasoningEffort="medium" {...overrides} />);
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
			fastModeAvailable: false
		});
		expect(document.querySelector('button')).toBeNull();
		expect(document.body.textContent).not.toContain('None');
	});

	it('shows only speed controls when reasoning has no user control', () => {
		renderSelector({
			model: providerManagedModel,
			reasoningEffort: 'none',
			fastModeAvailable: true
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
			fastModeAvailable: false
		});
		openSelector();
		expect(document.querySelector('[role="switch"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Speed');
		expect(document.body.textContent).not.toContain('Fast');
	});

	it('renders an enabled toggle when Fast mode is available', () => {
		const onFastModeChange = vi.fn();
		const { rerender } = renderSelector({ fastModeAvailable: true, onFastModeChange });
		openSelector();
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		act(() => {
			toggle?.click();
		});
		expect(onFastModeChange).toHaveBeenCalledWith(true);
		rerender(
			<ReasoningSelector
				model={model}
				reasoningEffort="medium"
				fastModeAvailable
				fastMode
				onFastModeChange={onFastModeChange}
			/>
		);
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
	});
});
