import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSidePanelWidth } from './side-panel-width';

beforeEach(() => localStorage.clear());

it('remembers a resized width across mounts', () => {
	const first = renderHook(() => useSidePanelWidth(1440, true));
	act(() => first.result.current.setWidth(600));
	first.unmount();
	const second = renderHook(() => useSidePanelWidth(1440, true));
	expect(second.result.current.width).toBe(600);
});

it('keeps room for the conversation and restores the preference when space returns', () => {
	const { result, rerender } = renderHook(
		({ viewport, sidebar }) => useSidePanelWidth(viewport, sidebar),
		{ initialProps: { viewport: 1440, sidebar: true } }
	);

	act(() => result.current.setWidth(700));
	rerender({ viewport: 1000, sidebar: true });
	expect(result.current.width).toBe(380);
	rerender({ viewport: 1000, sidebar: false });
	expect(result.current.width).toBe(640);
	rerender({ viewport: 1440, sidebar: true });
	expect(result.current.width).toBe(700);
	rerender({ viewport: 280, sidebar: false });
	expect(result.current.width).toBe(280);
	expect(result.current.minWidth).toBe(280);
});

it('still resizes when storage is unavailable', () => {
	const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('Storage unavailable');
	});

	const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('Storage unavailable');
	});

	try {
		const { result } = renderHook(() => useSidePanelWidth(1440, true));
		act(() => result.current.setWidth(500));
		expect(result.current.width).toBe(500);
	} finally {
		getItem.mockRestore();
		setItem.mockRestore();
	}
});
