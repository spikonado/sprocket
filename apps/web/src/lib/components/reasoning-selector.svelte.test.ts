import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import ReasoningSelector from './reasoning-selector.svelte';

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

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	document.body.replaceChildren();
});

function renderSelector(overrides: Partial<ComponentProps<typeof ReasoningSelector>> = {}) {
	const component = mount(ReasoningSelector, {
		target: document.body,
		props: { model, reasoningEffort: 'medium', ...overrides }
	});
	cleanup = () => unmount(component);
	flushSync();
	document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
	flushSync();
}

describe('ReasoningSelector Fast mode', () => {
	it('omits the control for models without Fast support', () => {
		renderSelector({
			model: { ...model, supportsFastMode: false },
			fastMode: true,
			fastModeAccess: 'unsupported'
		});
		expect(document.querySelector('[role="switch"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Speed');
		expect(document.body.textContent).not.toContain('Fast');
	});

	it('renders an enabled toggle when Fast mode is available', () => {
		renderSelector({ fastModeAccess: 'available' });
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		toggle?.click();
		flushSync();
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
	});

	it('renders a locked toggle when the model supports Fast but the tier does not', () => {
		renderSelector({
			fastModeAccess: 'locked',
			fastModeLockTooltip: 'Upgrade to use Fast mode'
		});
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute('aria-disabled')).toBe('true');
		expect(toggle?.getAttribute('aria-label')).toContain('Upgrade to use Fast mode');
	});
});
