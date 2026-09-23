import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import SettingsSidebar from './settings-sidebar.svelte';

let component: ReturnType<typeof mount>;

afterEach(async () => {
	if (component) await unmount(component);
	document.body.replaceChildren();
});

it('keeps settings navigation and theme controls without an inbox close button', async () => {
	const onBack = vi.fn();
	const onNavigate = vi.fn();
	const onThemeChange = vi.fn();
	component = mount(SettingsSidebar, {
		target: document.body,
		props: { activePage: 'account', theme: 'dark', onBack, onNavigate, onThemeChange }
	});
	flushSync();
	await tick();

	expect(document.querySelector('[aria-label="Close sidebar"]')).toBeNull();
	document.querySelector<HTMLButtonElement>('[aria-label="Switch to light mode"]')!.click();
	expect(onThemeChange).toHaveBeenCalledWith('light');
	document
		.querySelector<HTMLButtonElement>('nav[aria-label="Settings"] button[aria-current="page"]')!
		.click();
	expect(onNavigate).toHaveBeenCalledWith('account');
	document.querySelector<HTMLButtonElement>('aside button')!.click();
	expect(onBack).toHaveBeenCalledOnce();
});
