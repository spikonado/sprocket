import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ConversationNotices from './conversation-notices';
import { PromptComposerView } from './prompt-composer';

const usageLimit =
	"Your ChatGPT subscription's usage limit for connected apps has been reached. Try again after the limit resets, or switch to another provider.";

function notices(props: Partial<ComponentProps<typeof ConversationNotices>> = {}, key?: string) {
	return (
		<ConversationNotices
			key={key}
			error={null}
			runError={null}
			reconnecting={false}
			syncing={false}
			catalogError={false}
			catalogLoading={false}
			onRetryCatalog={vi.fn()}
			{...props}
		/>
	);
}

function composer(
	children: ComponentProps<typeof PromptComposerView>['notices'],
	exhausted = false
) {
	return (
		<PromptComposerView
			notices={children}
			attachments={[]}
			onAttachFiles={vi.fn()}
			onRemoveAttachment={vi.fn()}
			canSend={true}
			isSubmitting={false}
			isStarting={false}
			isRunning={false}
			runStartedAt={null}
			onSubmit={vi.fn()}
			onCancel={vi.fn()}
			usage={{ tier: 'pro', exhausted, resetsAt: null }}
			usageFailed={false}
		/>
	);
}

describe('Conversation notices', () => {
	it('shows sustained history loading and clears the notice after syncing', () => {
		vi.useFakeTimers();
		const view = render(composer(notices({ syncing: true })));

		try {
			expect(screen.queryByRole('status')).toBeNull();
			act(() => vi.advanceTimersByTime(2_000));
			expect(screen.getByRole('status').textContent).toContain(
				'Conversation history is still loading. You can send a prompt while it loads.'
			);
			view.rerender(composer(notices({ syncing: true, reconnecting: true })));
			expect(screen.getAllByRole('status')).toHaveLength(1);
			expect(screen.getByRole('status').textContent).toContain('Reconnecting');
			view.rerender(composer(notices()));
			expect(screen.queryByRole('status')).toBeNull();
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it('starts a fresh notice delay for each brief live transcript sync and selected thread', () => {
		vi.useFakeTimers();
		const view = render(composer(notices()));

		try {
			for (let update = 0; update < 4; update += 1) {
				view.rerender(composer(notices({ syncing: true })));
				act(() => vi.advanceTimersByTime(500));
				expect(screen.queryByRole('status')).toBeNull();
				view.rerender(composer(notices()));
				act(() => vi.advanceTimersByTime(2_000));
				expect(screen.queryByRole('status')).toBeNull();
			}

			view.rerender(composer(notices({ syncing: true })));
			expect(screen.queryByRole('status')).toBeNull();
			act(() => vi.advanceTimersByTime(1_999));
			expect(screen.queryByRole('status')).toBeNull();
			act(() => vi.advanceTimersByTime(1));
			expect(screen.getByRole('status').textContent).toContain(
				'Conversation history is still loading.'
			);
			view.rerender(composer(notices({ syncing: true }, 'other-thread')));
			expect(screen.queryByRole('status')).toBeNull();
			act(() => vi.advanceTimersByTime(2_000));
			expect(screen.getByRole('status').textContent).toContain(
				'Conversation history is still loading.'
			);
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it('shows run errors inside the composer using the same card as Sprocket usage limits', () => {
		const view = render(composer(notices({ runError: usageLimit })));
		const group = screen.getByRole('group', { name: 'Message composer' });
		const alert = within(group).getByRole('alert');
		expect(alert.textContent).toContain(usageLimit);
		expect(alert.textContent).toContain("Run couldn't continue");
		const cardClass = alert.className;

		view.rerender(composer(notices(), true));
		const usageAlert = within(group).getByRole('alert');
		expect(usageAlert.textContent).toContain("You're out of usage");
		expect(usageAlert.className).toBe(cardClass);
	});

	it('keeps distinct failures and reconnection status visible, then clears them on recovery', () => {
		const view = render(
			composer(
				notices({ error: 'Could not send request.', runError: usageLimit, reconnecting: true })
			)
		);

		const group = screen.getByRole('group', { name: 'Message composer' });
		expect(within(group).getAllByRole('alert')).toHaveLength(2);
		expect(within(group).getByRole('status').textContent).toContain(
			'Reconnecting to conversation history.'
		);
		expect(within(group).getByRole('combobox')).not.toBeNull();

		view.rerender(composer(notices()));
		expect(within(group).queryByRole('alert')).toBeNull();
		expect(within(group).queryByRole('status')).toBeNull();
	});

	it('deduplicates a launch failure also reported by the run', () => {
		render(composer(notices({ error: usageLimit, runError: usageLimit })));
		expect(screen.getAllByRole('alert')).toHaveLength(1);
		expect(screen.getByRole('alert').textContent).toContain(usageLimit);
	});

	it('keeps catalog recovery in the notice and disables retry while loading', () => {
		const retry = vi.fn();
		const view = render(composer(notices({ catalogError: true, onRetryCatalog: retry })));
		fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
		expect(retry).toHaveBeenCalledOnce();

		view.rerender(
			composer(notices({ catalogError: true, catalogLoading: true, onRetryCatalog: retry }))
		);
		expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveProperty('disabled', true);
	});
});
