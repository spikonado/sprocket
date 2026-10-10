import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ConversationNotices from './conversation-notices';
import { PromptComposerView } from './prompt-composer';

const usageLimit =
	"Your ChatGPT subscription's usage limit for connected apps has been reached. Try again after the limit resets, or switch to another provider.";

function notices(props: Partial<ComponentProps<typeof ConversationNotices>> = {}) {
	return (
		<ConversationNotices
			error={null}
			runError={null}
			onCancelAutoResume={vi.fn()}
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
	exhausted = false,
	props: Partial<ComponentProps<typeof PromptComposerView>> = {}
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
			{...props}
		/>
	);
}

describe('Conversation notices', () => {
	it('shows background history loading and clears the notice after syncing', () => {
		const view = render(composer(notices({ syncing: true })));
		expect(screen.getByRole('status').textContent).toContain(
			'Conversation history is still loading. You can send a prompt while it loads.'
		);
		view.rerender(composer(notices({ syncing: true, reconnecting: true })));
		expect(screen.getAllByRole('status')).toHaveLength(1);
		expect(screen.getByRole('status').textContent).toContain('Reconnecting');
		view.rerender(composer(notices()));
		expect(screen.queryByRole('status')).toBeNull();
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

	it('shows the next local retry time and a cancel action instead of the usage-limit errors', () => {
		const usageLimitRetryAt = Date.parse('2026-07-18T15:30:00Z');
		const cancelAutoResume = vi.fn();
		render(
			composer(
				notices({
					error: usageLimit,
					runError: usageLimit,
					usageLimitRetryAt,
					onCancelAutoResume: cancelAutoResume
				})
			)
		);

		const group = screen.getByRole('group', { name: 'Message composer' });
		const status = within(group).getByRole('status');
		expect(status.textContent).toContain('Waiting for usage limit reset');
		expect(status.textContent).toContain('Next retry:');
		expect(status.textContent).toContain(
			'You can retry manually, send a new message, or switch providers.'
		);
		const time = within(status).getByText(new Date(usageLimitRetryAt).toLocaleString());
		expect(time.tagName).toBe('TIME');
		expect(time.getAttribute('datetime')).toBe(new Date(usageLimitRetryAt).toISOString());
		expect(within(group).queryByRole('alert')).toBeNull();

		const cancelButton = within(status).getByRole('button', { name: 'Cancel auto-resume' });
		expect(cancelButton).toHaveProperty('disabled', false);
		fireEvent.click(cancelButton);
		expect(cancelAutoResume).toHaveBeenCalledOnce();
	});

	it('disables cancel auto-resume while cancellation is pending', () => {
		const cancelAutoResume = vi.fn();
		render(
			notices({
				usageLimitRetryAt: Date.now(),
				cancellingAutoResume: true,
				onCancelAutoResume: cancelAutoResume
			})
		);

		const cancelButton = screen.getByRole('button', { name: 'Cancelling…' });
		expect(cancelButton).toHaveProperty('disabled', true);
		fireEvent.click(cancelButton);
		expect(cancelAutoResume).not.toHaveBeenCalled();
	});

	it('restores the generic run error when waiting clears', () => {
		const view = render(notices({ runError: usageLimit, usageLimitRetryAt: Date.now() }));
		expect(screen.getByRole('status').textContent).toContain('Waiting for usage limit reset');
		expect(screen.queryByRole('alert')).toBeNull();

		view.rerender(notices({ runError: usageLimit }));
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Cancel auto-resume' })).toBeNull();
		expect(screen.getByRole('alert').textContent).toContain("Run couldn't continue");
		expect(screen.getByRole('alert').textContent).toContain(usageLimit);
	});

	it.each(['Could not send request.', 'Could not cancel auto-resume.'])(
		'keeps a distinct failure visible while waiting: %s',
		(error) => {
			render(notices({ error, runError: usageLimit, usageLimitRetryAt: Date.now() }));
			expect(screen.getByRole('status').textContent).toContain('Waiting for usage limit reset');
			expect(screen.getAllByRole('alert')).toHaveLength(1);
			expect(screen.getByRole('alert').textContent).toContain(error);
		}
	);

	it('keeps the composer input usable while waiting', () => {
		const onPromptChange = vi.fn();
		render(
			composer(notices({ runError: usageLimit, usageLimitRetryAt: Date.now() }), false, {
				onPromptChange
			})
		);

		const group = screen.getByRole('group', { name: 'Message composer' });
		const input = within(group).getByRole('combobox');
		expect(input).toHaveProperty('disabled', false);
		input.focus();
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: 'Try another provider' } });
		expect(onPromptChange).toHaveBeenCalledWith('Try another provider');
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
