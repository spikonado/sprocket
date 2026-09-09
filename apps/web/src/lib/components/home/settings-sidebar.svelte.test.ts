import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SettingsSidebar from './settings-sidebar.svelte';

let cleanup: () => Promise<void>;

afterEach(async () => {
	await cleanup();
	document.body.replaceChildren();
});

it('places the browser page directly below Usage and navigates to it', () => {
	const onNavigate = vi.fn();
	const component = mount(SettingsSidebar, {
		target: document.body,
		props: {
			activePage: 'browser',
			theme: 'light',
			onThemeChange: vi.fn(),
			onBack: vi.fn(),
			onNavigate
		}
	});
	cleanup = () => unmount(component);
	flushSync();
	const items = [...document.querySelectorAll<HTMLButtonElement>('nav button')];
	const usage = items.findIndex((item) => item.textContent?.trim() === 'Usage');
	const browser = items[usage + 1];
	expect(browser.textContent?.trim()).toBe("Agent's Browser");
	expect(browser.getAttribute('aria-current')).toBe('page');
	browser.click();
	expect(onNavigate).toHaveBeenCalledWith('browser');
});
