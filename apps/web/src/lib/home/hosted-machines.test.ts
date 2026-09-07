import { describe, expect, it } from 'vitest';
import { MACHINE_ONLINE_THRESHOLD_MS } from '$convex/lib/machineRuns';
import {
	advanceHostedEpoch,
	applyHostedAttachmentRefresh,
	beginHostedOp,
	HOSTED_NAV_DRAWER_MAX_WIDTH_PX,
	hostedComposerNotice,
	hostedMachineCapability,
	hostedMachineFromListRow,
	hostedMachineOptionLabel,
	hostedMachineSelectorOptions,
	hostedMachinesNotice,
	hostedNavUsesDrawer,
	hostedOpIsCurrent,
	isHostedMachinePresent,
	isSelectedHostedMachineReady,
	readRemoteProtocolVersion
} from '$lib/home/hosted-machines';

const now = 1_000_000;

function machine(
	overrides: Partial<ReturnType<typeof hostedMachineFromListRow>> &
		Pick<ReturnType<typeof hostedMachineFromListRow>, 'machineId' | 'friendlyName'>
) {
	return hostedMachineFromListRow({
		platform: 'linux',
		appVersion: '0.4.0',
		online: true,
		lastSeenAt: now,
		...overrides
	});
}

describe('hosted machine presence', () => {
	it('uses lastSeenAt and the local clock, not a stale query boolean', () => {
		expect(
			isHostedMachinePresent({ lastSeenAt: now - MACHINE_ONLINE_THRESHOLD_MS, online: false }, now)
		).toBe(true);
		expect(
			isHostedMachinePresent(
				{ lastSeenAt: now - MACHINE_ONLINE_THRESHOLD_MS - 1, online: true },
				now
			)
		).toBe(false);
	});

	it('falls back to the query boolean only when lastSeenAt is missing', () => {
		expect(isHostedMachinePresent({ online: true }, now)).toBe(true);
		expect(isHostedMachinePresent({ online: false }, now)).toBe(false);
	});

	it('requires remote protocol 1 while the machine is present', () => {
		expect(
			hostedMachineCapability(machine({ machineId: 'a', friendlyName: 'Workshop' }), now)
		).toBe('update-required');
		expect(
			hostedMachineCapability(
				machine({
					machineId: 'a',
					friendlyName: 'Workshop',
					remoteProtocolVersion: 1
				}),
				now
			)
		).toBe('ready');
		expect(
			hostedMachineCapability(
				machine({
					machineId: 'a',
					friendlyName: 'Workshop',
					remoteProtocolVersion: 2
				}),
				now
			)
		).toBe('update-required');
		expect(
			hostedMachineCapability(
				machine({
					machineId: 'a',
					friendlyName: 'Workshop',
					lastSeenAt: now - MACHINE_ONLINE_THRESHOLD_MS - 1,
					remoteProtocolVersion: 1
				}),
				now
			)
		).toBe('offline');
	});

	it('reads protocol version from list rows that already include it', () => {
		expect(readRemoteProtocolVersion({ remoteProtocolVersion: 1 })).toBe(1);
		expect(readRemoteProtocolVersion({})).toBeUndefined();
		expect(
			hostedMachineFromListRow({
				machineId: 'a',
				friendlyName: 'Workshop',
				platform: 'linux',
				appVersion: '0.4.0',
				online: true,
				lastSeenAt: now,
				remoteProtocolVersion: 1
			}).remoteProtocolVersion
		).toBe(1);
	});
});

describe('hosted machine selection', () => {
	it('keeps an explicit selection when that machine goes offline', () => {
		const offline = machine({
			machineId: 'workshop',
			friendlyName: 'Workshop',
			lastSeenAt: now - MACHINE_ONLINE_THRESHOLD_MS - 1,
			remoteProtocolVersion: 1
		});
		const ready = machine({
			machineId: 'laptop',
			friendlyName: 'Laptop',
			remoteProtocolVersion: 1
		});

		expect(isSelectedHostedMachineReady([ready, offline], 'workshop', now)).toBe(false);
		expect(isSelectedHostedMachineReady([ready, offline], 'laptop', now)).toBe(true);
	});

	it('labels offline and update-required machines without making them selectable', () => {
		const options = hostedMachineSelectorOptions(
			[
				machine({
					machineId: 'offline',
					friendlyName: 'Workshop',
					lastSeenAt: now - MACHINE_ONLINE_THRESHOLD_MS - 1,
					remoteProtocolVersion: 1
				}),
				machine({
					machineId: 'stale',
					friendlyName: 'Lab',
					online: true
				}),
				machine({
					machineId: 'ready',
					friendlyName: 'Laptop',
					remoteProtocolVersion: 1
				})
			],
			'gone',
			now
		);

		expect(options.map((option) => [option.id, option.selectable, option.statusLabel])).toEqual([
			['gone', false, 'Unavailable'],
			['offline', false, 'Offline'],
			['stale', false, 'Update required'],
			['ready', true, null]
		]);
		expect(hostedMachineOptionLabel(options[1]!)).toBe('Workshop (Offline)');
		expect(hostedMachineOptionLabel(options[3]!)).toBe('Laptop');
	});

	it('explains a quiet fleet and does not invent a default machine', () => {
		expect(
			hostedMachinesNotice({
				machines: [],
				selectedMachineId: null,
				now
			})
		).toMatch(/No machines are running/);
		expect(
			hostedMachinesNotice({
				machines: [
					machine({
						machineId: 'ready',
						friendlyName: 'Laptop',
						remoteProtocolVersion: 1
					})
				],
				selectedMachineId: null,
				now
			})
		).toMatch(/Choose a running machine/);
	});

	it('offers a folder picker only when a ready machine still lacks this workspace', () => {
		const ready = machine({
			machineId: 'laptop',
			friendlyName: 'Laptop',
			remoteProtocolVersion: 1
		});
		expect(
			hostedComposerNotice({
				machines: [ready],
				selectedMachineId: 'laptop',
				now,
				needsFolder: true,
				selectedMachineName: 'Laptop'
			})
		).toEqual({
			text: 'This thread can run on Laptop after you attach a matching folder.',
			offerFolderPicker: true
		});
		expect(
			hostedComposerNotice({
				machines: [ready],
				selectedMachineId: 'laptop',
				now,
				workspaceLoadError: 'Machine did not answer.',
				needsFolder: true
			})
		).toEqual({
			text: 'Machine did not answer.',
			offerFolderPicker: false
		});
	});

	it('drops attachment payloads from a previous machine selection', () => {
		expect(
			applyHostedAttachmentRefresh({
				op: beginHostedOp(1),
				currentEpoch: 1,
				selectionGeneration: 1,
				currentGeneration: 2,
				attachments: { '/old': true }
			})
		).toBeNull();
		expect(
			applyHostedAttachmentRefresh({
				op: beginHostedOp(2),
				currentEpoch: 2,
				selectionGeneration: 2,
				currentGeneration: 2,
				attachments: { '/new': true }
			})
		).toEqual({ '/new': true });
	});
});

describe('hosted selection epoch', () => {
	it('treats A→B→A as a new visit, not the original in-flight op', () => {
		let epoch = 0;
		const pendingOnA = beginHostedOp(epoch);
		epoch = advanceHostedEpoch(epoch);
		epoch = advanceHostedEpoch(epoch);

		expect(hostedOpIsCurrent(pendingOnA, epoch)).toBe(false);
		expect(
			applyHostedAttachmentRefresh({
				op: pendingOnA,
				currentEpoch: epoch,
				selectionGeneration: 4,
				currentGeneration: 4,
				attachments: { '/a': true }
			})
		).toBeNull();

		const laterVisit = beginHostedOp(epoch);
		expect(hostedOpIsCurrent(laterVisit, epoch)).toBe(true);
		expect(
			applyHostedAttachmentRefresh({
				op: laterVisit,
				currentEpoch: epoch,
				selectionGeneration: 4,
				currentGeneration: 4,
				attachments: { '/a': true }
			})
		).toEqual({ '/a': true });
	});

	it('invalidates in-flight work when the account resets onto the same machine', () => {
		let epoch = 3;
		const pending = beginHostedOp(epoch);
		epoch = advanceHostedEpoch(epoch);
		expect(hostedOpIsCurrent(pending, epoch)).toBe(false);
		expect(hostedOpIsCurrent(beginHostedOp(epoch), epoch)).toBe(true);
	});

	it('keeps overlapping refreshes on the same visit distinct via generation', () => {
		const op = beginHostedOp(5);
		expect(
			applyHostedAttachmentRefresh({
				op,
				currentEpoch: 5,
				selectionGeneration: 1,
				currentGeneration: 2,
				attachments: { '/stale': true }
			})
		).toBeNull();
	});
});

describe('hosted navigation drawer', () => {
	it('uses a drawer only for hosted viewports at or below 767px', () => {
		expect(hostedNavUsesDrawer(false, 360)).toBe(false);
		expect(hostedNavUsesDrawer(true, 360)).toBe(true);
		expect(hostedNavUsesDrawer(true, HOSTED_NAV_DRAWER_MAX_WIDTH_PX)).toBe(true);
		expect(hostedNavUsesDrawer(true, HOSTED_NAV_DRAWER_MAX_WIDTH_PX + 1)).toBe(false);
	});
});
