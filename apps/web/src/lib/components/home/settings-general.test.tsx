import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsGeneral from './settings-general';

const preferences: Doc<'uiPreferences'> = {
	// SAFETY: this fixture id is only used by the in-memory Convex client.
	_id: 'preferences-test' as Id<'uiPreferences'>,
	_creationTime: 1,
	userId: 'user-test',
	theme: 'light'
};

async function mount(client: ConvexTestClient) {
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsGeneral />
			</ConvexTestProvider>
		);
	});
}

function toggle() {
	return screen.getByRole('switch', { name: 'Automatically name threads' });
}

it.each([null, preferences])(
	'defaults to enabled for missing preferences or field: %j',
	async (data) => {
		const client = new ConvexTestClient();
		client.registerQuery(api.uiPreferences.getMine, data);
		await mount(client);
		expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
		expect(toggle().getAttribute('aria-checked')).toBe('true');
		expect(toggle()).toHaveProperty('disabled', false);
	}
);

it('reflects saved preferences and remote changes', async () => {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, { ...preferences, automaticThreadTitles: false });
	await mount(client);
	expect(toggle().getAttribute('aria-checked')).toBe('false');
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, {
			...preferences,
			automaticThreadTitles: true
		});
	});
	expect(toggle().getAttribute('aria-checked')).toBe('true');
});

it.each([true, false])(
	'saves the opposite of %s and blocks repeat clicks while saving',
	async (enabled) => {
		const client = new ConvexTestClient();
		const save = Promise.withResolvers<null>();
		client.registerQuery(api.uiPreferences.getMine, {
			...preferences,
			automaticThreadTitles: enabled
		});
		client.registerMutation(api.uiPreferences.setAutomaticThreadTitles, save.promise);
		const mutation = vi.spyOn(client, 'mutation');
		await mount(client);
		fireEvent.click(toggle());
		expect(toggle().getAttribute('aria-checked')).toBe(String(!enabled));
		expect(toggle()).toHaveProperty('disabled', true);
		fireEvent.click(toggle());
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(getFunctionName(mutation.mock.calls[0]![0])).toBe(
			'uiPreferences:setAutomaticThreadTitles'
		);
		expect(mutation.mock.calls[0]![1]).toEqual({ enabled: !enabled });
		await act(async () => {
			client.registerQuery(api.uiPreferences.getMine, {
				...preferences,
				automaticThreadTitles: !enabled
			});
			save.resolve(null);
		});
		expect(toggle()).toHaveProperty('disabled', false);
		expect(toggle().getAttribute('aria-checked')).toBe(String(!enabled));
	}
);

it('restores the saved preference after a failed save and allows retrying', async () => {
	const client = new ConvexTestClient();
	const save = Promise.withResolvers<null>();
	client.registerQuery(api.uiPreferences.getMine, preferences);
	client.registerMutation(api.uiPreferences.setAutomaticThreadTitles, save.promise);
	const mutation = vi.spyOn(client, 'mutation');
	await mount(client);
	fireEvent.click(toggle());
	await act(async () => {
		save.reject(new Error('Unavailable'));
	});
	expect(screen.getByRole('alert').textContent).toBe("Couldn't save your preference. Try again.");
	expect(toggle().getAttribute('aria-checked')).toBe('true');
	expect(toggle()).toHaveProperty('disabled', false);
	const retry = Promise.withResolvers<null>();
	client.registerMutation(api.uiPreferences.setAutomaticThreadTitles, retry.promise);
	fireEvent.click(toggle());
	expect(screen.queryByRole('alert')).toBeNull();
	expect(mutation).toHaveBeenCalledTimes(2);
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, {
			...preferences,
			automaticThreadTitles: false
		});
		retry.resolve(null);
	});
	expect(toggle().getAttribute('aria-checked')).toBe('false');
	expect(toggle()).toHaveProperty('disabled', false);
});

it('waits for preferences to load before allowing changes', async () => {
	const client = new ConvexTestClient();
	await mount(client);
	expect(screen.getByRole('status').textContent).toBe('Loading preferences...');
	expect(toggle()).toHaveProperty('disabled', true);
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, {
			...preferences,
			automaticThreadTitles: false
		});
	});
	expect(screen.queryByRole('status')).toBeNull();
	expect(toggle().getAttribute('aria-checked')).toBe('false');
	expect(toggle()).toHaveProperty('disabled', false);
});

it('shows a preference load error inline', async () => {
	const client = new ConvexTestClient();
	vi.spyOn(client, 'watchQuery').mockImplementation(() => ({
		onUpdate: () => () => {},
		localQueryResult: () => {
			throw new Error('Unavailable');
		},
		journal: () => undefined
	}));
	await mount(client);
	await waitFor(() => {
		expect(screen.getByRole('alert').textContent).toBe("Couldn't load your preferences right now.");
	});
	expect(toggle()).toHaveProperty('disabled', true);
});
