import { expect, it } from 'vitest';
import { createProjectDefault, snoozePresets } from './inbox';

it('chooses a single filtered project or the most recent eligible project without inventing a default', () => {
	expect(createProjectDefault(['a', 'b', 'c'], ['a'], ['b'])).toBe('a');
	expect(createProjectDefault(['a', 'b', 'c'], ['a', 'c'], ['b', 'c', 'a'])).toBe('c');
	expect(createProjectDefault(['a', 'b'], [], [])).toBeNull();
	expect(createProjectDefault(['a'], ['missing'], ['a'])).toBeNull();
});

it('uses future local-time snooze presets around midnight and the weekend', () => {
	const now = new Date(2026, 8, 13, 23, 50);
	const presets = snoozePresets(now);
	expect(presets.every((preset) => preset.until > now.getTime())).toBe(true);
	expect(presets.some((preset) => preset.label === 'This evening')).toBe(false);
	expect(new Date(presets.find((preset) => preset.label === 'Tomorrow')!.until).getHours()).toBe(9);
});
