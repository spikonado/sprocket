import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsVersionControl from './settings-version-control';

it.each([
	['Add Sprocket as a co-author on agent commits', true, api.uiPreferences.setCoAuthorCommits],
	['Pull the latest code automatically', false, api.uiPreferences.setAutoPullCheckouts]
] as const)('flips %s from its default', async (name, enabledByDefault, setPreference) => {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, {});
	client.registerMutation(setPreference, null);
	const mutation = vi.spyOn(client, 'mutation');

	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsVersionControl />
			</ConvexTestProvider>
		);
	});

	const toggle = screen.getByRole('switch', { name });

	expect(toggle.getAttribute('aria-checked')).toBe(String(enabledByDefault));
	await act(async () => fireEvent.click(toggle));
	expect(getFunctionName(mutation.mock.calls[0]![0])).toBe(getFunctionName(setPreference));
	expect(mutation.mock.calls[0]![1]).toEqual({ enabled: !enabledByDefault });
});
