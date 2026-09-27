import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsSidebar from './settings-sidebar';

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
	document.body.replaceChildren();
});

it('keeps settings navigation and theme controls without an inbox close button', async () => {
	const onBack = vi.fn();
	const onNavigate = vi.fn();
	const onThemeChange = vi.fn();
	act(() => {
		root.render(
			<SettingsSidebar
				activePage="account"
				theme="dark"
				onBack={onBack}
				onNavigate={onNavigate}
				onThemeChange={onThemeChange}
			/>
		);
	});

	expect(document.querySelector('[aria-label="Close sidebar"]')).toBeNull();
	act(() => {
		document.querySelector<HTMLButtonElement>('[aria-label="Switch to light mode"]')!.click();
	});
	expect(onThemeChange).toHaveBeenCalledWith('light');
	act(() => {
		document
			.querySelector<HTMLButtonElement>('nav[aria-label="Settings"] button[aria-current="page"]')!
			.click();
	});
	expect(onNavigate).toHaveBeenCalledWith('account');
	act(() => {
		document.querySelector<HTMLButtonElement>('aside button')!.click();
	});
	expect(onBack).toHaveBeenCalledOnce();
});
