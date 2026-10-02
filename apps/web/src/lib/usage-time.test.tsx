import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUsageTime } from './usage-time';

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

async function advance(milliseconds: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
}

it('refreshes on the minute tick and stops after unmount', async () => {
	const hook = renderHook(() => useUsageTime());
	const initial = hook.result.current;

	await advance(30_000);
	expect(hook.result.current).toBe(initial);

	await advance(30_000);
	const afterMinute = hook.result.current;
	expect(afterMinute).toBeGreaterThan(initial);

	hook.unmount();
	await advance(120_000);
	expect(hook.result.current).toBe(afterMinute);
});
