import { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RunElapsed from './run-elapsed';

afterEach(() => {
	vi.useRealTimers();
});

it('updates the elapsed label while the sibling transcript keeps its committed render', () => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
	const transcriptRender = vi.fn();
	render(
		<>
			<Profiler id="transcript" onRender={transcriptRender}>
				<div>Conversation</div>
			</Profiler>
			<span>
				Working for <RunElapsed startedAt={95_000} />
			</span>
		</>
	);
	expect(screen.getByText('Working for 5s')).toBeTruthy();
	act(() => vi.advanceTimersByTime(3_000));
	expect(screen.getByText('Working for 8s')).toBeTruthy();
	expect(transcriptRender).toHaveBeenCalledTimes(1);
});
