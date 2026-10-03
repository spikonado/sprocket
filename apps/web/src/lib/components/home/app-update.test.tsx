import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { UpdateState } from '$lib/updates';
import AppUpdate from './app-update';

afterEach(() => vi.unstubAllGlobals());

it('installs a package update on the first click and prevents another request while busy', async () => {
	const available: UpdateState = {
		method: 'package',
		status: 'available',
		currentVersion: '1.0.0',
		version: '1.1.0',
		error: null
	};

	const installation = Promise.withResolvers<Response>();

	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json(available))
		.mockReturnValueOnce(installation.promise);

	vi.stubGlobal('fetch', fetcher);
	render(<AppUpdate />);

	const button = await screen.findByRole('button', { name: 'Update available' });

	fireEvent.click(button);
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		expect.stringContaining('/api/update/install'),
		expect.objectContaining({ method: 'POST' })
	);
	expect(button.hasAttribute('disabled')).toBe(true);
	fireEvent.click(button);
	expect(fetcher).toHaveBeenCalledTimes(2);

	await act(async () => installation.resolve(Response.json({ ...available, status: 'installed' })));
	expect(screen.getByRole('button', { name: 'Update installed' })).toBeTruthy();
	expect(screen.getByText(/stop Sprocket in your terminal and launch it again/)).toBeTruthy();
});
