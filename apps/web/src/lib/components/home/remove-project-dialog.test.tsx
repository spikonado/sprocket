import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import RemoveProjectDialog from './remove-project-dialog';

const project = {
	workspacePath: '/home/me/Projects/My robot/../robot/',
	displayName: 'My robot'
};

it('describes the local removal, exact path, and retained history in an accessible modal', () => {
	render(<RemoveProjectDialog project={project} onClose={vi.fn()} onRemove={vi.fn()} />);

	const dialog = screen.getByRole('dialog', { name: 'Remove project?' });
	expect(dialog.getAttribute('aria-modal')).toBe('true');
	expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
	expect(screen.getByText(project.displayName)).toBeTruthy();
	expect(screen.getByText(project.workspacePath).textContent).toBe(project.workspacePath);
	expect(screen.getByText(/from this computer’s project list/)).toBeTruthy();
	expect(screen.getByText(/files, threads, and artifacts will be retained/)).toBeTruthy();
	expect(screen.getByText(/Running agents will continue/)).toBeTruthy();
	expect(screen.getByText('Re-add this folder to restore its history.')).toBeTruthy();
});

it('cancels without removing the project', async () => {
	const user = userEvent.setup();
	const onClose = vi.fn();
	const onRemove = vi.fn();
	render(<RemoveProjectDialog project={project} onClose={onClose} onRemove={onRemove} />);

	await user.click(screen.getByRole('button', { name: 'Cancel' }));

	expect(onClose).toHaveBeenCalledTimes(1);
	expect(onRemove).not.toHaveBeenCalled();
});

it.each([project.workspacePath, 'C:\\Users\\me\\My robot\\'])(
	'submits the exact path %s and closes only after removal resolves',
	async (workspacePath) => {
		const user = userEvent.setup();
		const removal = Promise.withResolvers<void>();
		const onClose = vi.fn();
		const onRemove = vi.fn(() => removal.promise);
		render(
			<RemoveProjectDialog
				project={{ ...project, workspacePath }}
				onClose={onClose}
				onRemove={onRemove}
			/>
		);

		await user.click(screen.getByRole('button', { name: 'Remove project' }));

		expect(onRemove).toHaveBeenCalledExactlyOnceWith(workspacePath);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog')).toBeTruthy();

		await act(async () => removal.resolve());

		expect(onClose).toHaveBeenCalledTimes(1);
	}
);

it('blocks double submissions and all dismissal paths while pending', async () => {
	const removal = Promise.withResolvers<void>();
	const onClose = vi.fn();
	const onRemove = vi.fn(() => removal.promise);
	render(<RemoveProjectDialog project={project} onClose={onClose} onRemove={onRemove} />);
	const dialog = screen.getByRole('dialog');
	const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
	const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove project' });
	const backdrop = screen.getByRole('presentation');

	act(() => {
		fireEvent.click(remove);
		fireEvent.click(remove);
		fireEvent.click(cancel);
		fireEvent.click(backdrop);
		fireEvent.keyDown(window, { key: 'Escape' });
	});

	expect(cancel.disabled).toBe(true);
	expect(remove.disabled).toBe(true);
	expect(screen.getByRole('button', { name: 'Removing…' })).toBe(remove);
	expect(dialog.getAttribute('aria-busy')).toBe('true');

	fireEvent.click(remove);
	fireEvent.click(cancel);
	fireEvent.click(backdrop);
	fireEvent.keyDown(window, { key: 'Escape' });
	fireEvent.keyDown(window, { key: 'Tab' });
	expect(document.activeElement).toBe(dialog);
	expect(onRemove).toHaveBeenCalledExactlyOnceWith(project.workspacePath);
	expect(onClose).not.toHaveBeenCalled();

	await act(async () => removal.resolve());
	expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(['Cancel', 'Escape', 'backdrop'])(
	'cancels upload preparation via %s without removing the project',
	async (dismissal) => {
		const user = userEvent.setup();
		const preparation = Promise.withResolvers<void>();

		const onPrepareRemove = vi.fn<(workspacePath: string, signal: AbortSignal) => Promise<void>>(
			() => preparation.promise
		);

		const onRemove = vi.fn();
		const onClose = vi.fn();
		render(
			<RemoveProjectDialog
				project={project}
				onClose={onClose}
				onPrepareRemove={onPrepareRemove}
				onRemove={onRemove}
			/>
		);
		await user.click(screen.getByRole('button', { name: 'Remove project' }));
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false);
		expect(screen.getByRole('button', { name: 'Waiting for uploads…' })).toBeTruthy();

		if (dismissal === 'Cancel') {
			await user.click(screen.getByRole('button', { name: 'Cancel' }));
		} else if (dismissal === 'Escape') {
			await user.keyboard('{Escape}');
		} else {
			await user.click(screen.getByRole('presentation'));
		}

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onPrepareRemove.mock.calls[0]?.[1].aborted).toBe(true);
		await act(async () => preparation.resolve());
		expect(onRemove).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	}
);

it.each([
	{ error: new Error('Project list is unavailable.'), message: 'Project list is unavailable.' },
	{ error: 'unavailable', message: 'Failed to remove project. Please try again.' }
])('keeps a failure in the dialog and allows retry: $message', async ({ error, message }) => {
	const user = userEvent.setup();
	const retry = Promise.withResolvers<void>();
	const onClose = vi.fn();
	const onRemove = vi.fn().mockRejectedValueOnce(error).mockReturnValueOnce(retry.promise);
	render(<RemoveProjectDialog project={project} onClose={onClose} onRemove={onRemove} />);

	await user.click(screen.getByRole('button', { name: 'Remove project' }));

	expect((await screen.findByRole('alert')).textContent).toBe(message);
	expect(screen.getByRole('dialog')).toBeTruthy();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false);
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove project' }).disabled).toBe(
		false
	);
	expect(onClose).not.toHaveBeenCalled();

	await user.click(screen.getByRole('button', { name: 'Remove project' }));

	expect(screen.queryByRole('alert')).toBeNull();
	expect(onRemove).toHaveBeenCalledTimes(2);
	expect(onRemove).toHaveBeenNthCalledWith(1, project.workspacePath);
	expect(onRemove).toHaveBeenNthCalledWith(2, project.workspacePath);
	expect(onClose).not.toHaveBeenCalled();

	await act(async () => retry.resolve());
	expect(onClose).toHaveBeenCalledTimes(1);
});

it('focuses Cancel, traps keyboard focus, and restores focus on unmount', async () => {
	const user = userEvent.setup();
	render(<button type="button">Open removal</button>);
	const trigger = screen.getByRole('button', { name: 'Open removal' });
	await user.click(trigger);

	const { unmount } = render(
		<RemoveProjectDialog project={project} onClose={vi.fn()} onRemove={vi.fn()} />
	);

	const cancel = screen.getByRole('button', { name: 'Cancel' });
	const remove = screen.getByRole('button', { name: 'Remove project' });

	expect(document.activeElement).toBe(cancel);
	await user.tab({ shift: true });
	expect(document.activeElement).toBe(remove);
	await user.tab();
	expect(document.activeElement).toBe(cancel);
	await user.tab();
	expect(document.activeElement).toBe(remove);
	await user.tab();
	expect(document.activeElement).toBe(cancel);

	unmount();
	expect(document.activeElement).toBe(trigger);
});

it.each(['Escape', 'backdrop'])('dismisses via %s when not submitting', (dismissal) => {
	const onClose = vi.fn();
	const onRemove = vi.fn();
	render(<RemoveProjectDialog project={project} onClose={onClose} onRemove={onRemove} />);

	fireEvent.click(screen.getByRole('dialog'));
	expect(onClose).not.toHaveBeenCalled();

	if (dismissal === 'Escape') {
		fireEvent.keyDown(window, { key: 'Escape' });
	} else {
		fireEvent.click(screen.getByRole('presentation'));
	}

	expect(onClose).toHaveBeenCalledTimes(1);
	expect(onRemove).not.toHaveBeenCalled();
});
