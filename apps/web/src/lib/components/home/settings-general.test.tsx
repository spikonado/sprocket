import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

const toggles = [
	{
		name: 'Automatically name threads',
		field: 'automaticThreadTitles',
		mutation: api.uiPreferences.setAutomaticThreadTitles,
		defaultEnabled: true
	},
	{
		name: 'Continue agents automatically after restarts and crashes',
		field: 'automaticAgentContinuation',
		mutation: api.uiPreferences.setAutomaticAgentContinuation,
		defaultEnabled: true
	},
	{
		name: 'Settle threads when their PRs merge',
		field: 'settleMergedThreads',
		mutation: api.uiPreferences.setSettleMergedThreads,
		defaultEnabled: false
	},
	{
		name: 'Share anonymous conversation data to help improve Sprocket for everyone',
		field: 'shareConversationContent',
		mutation: api.uiPreferences.setShareConversationContent,
		defaultEnabled: true
	}
] as const;

async function mount(client: ConvexTestClient) {
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsGeneral />
			</ConvexTestProvider>
		);
	});
}

function switchNamed(name: string) {
	return screen.getByRole('switch', { name });
}

function allSwitches() {
	return toggles.map(({ name }) => switchNamed(name));
}

function disabledStates() {
	return allSwitches().map((toggle) => toggle.hasAttribute('disabled'));
}

it.each([null, preferences])(
	'uses defaults for missing preferences or fields: %j',
	async (data) => {
		const client = new ConvexTestClient();
		client.registerQuery(api.uiPreferences.getMine, data);
		await mount(client);
		expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
		expect(allSwitches().map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(
			toggles.map(({ defaultEnabled }) => String(defaultEnabled))
		);
		expect(disabledStates()).toEqual(toggles.map(() => false));
	}
);

it('waits for preferences to load before allowing changes', async () => {
	const client = new ConvexTestClient();
	await mount(client);
	expect(screen.getByRole('status').textContent).toBe('Loading preferences...');
	expect(disabledStates()).toEqual(toggles.map(() => true));
	await act(async () => {
		client.registerQuery(api.uiPreferences.getMine, preferences);
	});
	expect(screen.queryByRole('status')).toBeNull();
	expect(disabledStates()).toEqual(toggles.map(() => false));
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
	expect(disabledStates()).toEqual(toggles.map(() => true));
});

describe.each(toggles)('$name', ({ name, field, mutation: preferenceMutation, defaultEnabled }) => {
	const toggle = () => switchNamed(name);
	const other = () => allSwitches().find((element) => element !== toggle())!;

	it('reflects saved preferences and remote changes', async () => {
		const client = new ConvexTestClient();
		client.registerQuery(api.uiPreferences.getMine, { ...preferences, [field]: false });
		await mount(client);
		expect(toggle().getAttribute('aria-checked')).toBe('false');
		expect(other().getAttribute('aria-checked')).toBe('true');
		await act(async () => {
			client.registerQuery(api.uiPreferences.getMine, { ...preferences, [field]: true });
		});
		expect(toggle().getAttribute('aria-checked')).toBe('true');
	});

	it.each([true, false])(
		'saves the opposite of %s and blocks repeat clicks while saving',
		async (enabled) => {
			const client = new ConvexTestClient();
			const save = Promise.withResolvers<null>();
			client.registerQuery(api.uiPreferences.getMine, { ...preferences, [field]: enabled });
			client.registerMutation(preferenceMutation, save.promise);
			const mutation = vi.spyOn(client, 'mutation');
			await mount(client);
			fireEvent.click(toggle());
			expect(toggle().getAttribute('aria-checked')).toBe(String(!enabled));
			expect(toggle()).toHaveProperty('disabled', true);
			expect(other()).toHaveProperty('disabled', false);
			fireEvent.click(toggle());
			expect(mutation).toHaveBeenCalledTimes(1);
			expect(getFunctionName(mutation.mock.calls[0]![0])).toBe(getFunctionName(preferenceMutation));
			expect(mutation.mock.calls[0]![1]).toEqual({ enabled: !enabled });
			await act(async () => {
				client.registerQuery(api.uiPreferences.getMine, { ...preferences, [field]: !enabled });
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
		client.registerMutation(preferenceMutation, save.promise);
		const mutation = vi.spyOn(client, 'mutation');
		await mount(client);
		fireEvent.click(toggle());
		await act(async () => {
			save.reject(new Error('Unavailable'));
		});
		expect(screen.getByRole('alert').textContent).toBe("Couldn't save your preference. Try again.");
		expect(toggle().getAttribute('aria-checked')).toBe(String(defaultEnabled));
		expect(toggle()).toHaveProperty('disabled', false);
		const retry = Promise.withResolvers<null>();
		client.registerMutation(preferenceMutation, retry.promise);
		fireEvent.click(toggle());
		expect(screen.queryByRole('alert')).toBeNull();
		expect(mutation).toHaveBeenCalledTimes(2);
		await act(async () => {
			client.registerQuery(api.uiPreferences.getMine, { ...preferences, [field]: !defaultEnabled });
			retry.resolve(null);
		});
		expect(toggle().getAttribute('aria-checked')).toBe(String(!defaultEnabled));
		expect(toggle()).toHaveProperty('disabled', false);
	});
});
