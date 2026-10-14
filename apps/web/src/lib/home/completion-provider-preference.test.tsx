import { beforeEach, expect, it } from 'vitest';
import {
	readCompletionProviderPreference,
	storeCompletionProviderPreference
} from './completion-provider-preference';

beforeEach(() => localStorage.clear());

it('remembers provider choices independently for each account', () => {
	storeCompletionProviderPreference('alice', 'chatgpt');
	storeCompletionProviderPreference('bob', 'openai');
	expect(readCompletionProviderPreference('alice')).toBe('chatgpt');
	expect(readCompletionProviderPreference('bob')).toBe('openai');
	expect(readCompletionProviderPreference('new-user')).toBe('spikonado');
	expect(readCompletionProviderPreference(null)).toBe('spikonado');
	storeCompletionProviderPreference('alice', 'spikonado');
	expect(readCompletionProviderPreference('alice')).toBe('spikonado');
});
