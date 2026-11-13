import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsVersionControl from './settings-version-control';

it('turns off the co-author trailer on agent commits', async () => {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, null);
	client.registerMutation(api.uiPreferences.setCoAuthorCommits, null);
	const mutation = vi.spyOn(client, 'mutation');

	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsVersionControl />
			</ConvexTestProvider>
		);
	});

	const toggle = screen.getByRole('switch', {
		name: 'Add Sprocket as a co-author on agent commits'
	});

	expect(toggle.getAttribute('aria-checked')).toBe('true');
	await act(async () => fireEvent.click(toggle));
	expect(getFunctionName(mutation.mock.calls[0]![0])).toBe(
		getFunctionName(api.uiPreferences.setCoAuthorCommits)
	);
	expect(mutation.mock.calls[0]![1]).toEqual({ enabled: false });
});
