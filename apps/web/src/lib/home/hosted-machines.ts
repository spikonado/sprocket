import { MACHINE_ONLINE_THRESHOLD_MS } from '$convex/lib/machineRuns';

export const HOSTED_REMOTE_PROTOCOL_VERSION = 1;

export type HostedMachinePresence = {
	machineId: string;
	friendlyName: string;
	platform: string;
	appVersion: string;
	lastSeenAt?: number;
	online: boolean;
	remoteProtocolVersion?: number;
};

export type HostedMachineCapability = 'ready' | 'offline' | 'update-required';

export type HostedMachineOption = {
	id: string;
	label: string;
	capability: HostedMachineCapability;
	selectable: boolean;
	statusLabel: string | null;
};

export type HostedComposerNotice = {
	text: string;
	offerFolderPicker: boolean;
};

export function readRemoteProtocolVersion(
	row: Pick<HostedMachinePresence, 'remoteProtocolVersion'>
): number | undefined {
	return row.remoteProtocolVersion;
}

export function hostedMachineFromListRow(row: {
	machineId: string;
	friendlyName: string;
	platform: string;
	appVersion: string;
	lastSeenAt?: number;
	online: boolean;
	remoteProtocolVersion?: number;
}): HostedMachinePresence {
	const presence: HostedMachinePresence = {
		machineId: row.machineId,
		friendlyName: row.friendlyName,
		platform: row.platform,
		appVersion: row.appVersion,
		online: row.online
	};
	if (row.lastSeenAt !== undefined) {
		presence.lastSeenAt = row.lastSeenAt;
	}
	const protocol = readRemoteProtocolVersion(row);
	if (protocol !== undefined) {
		presence.remoteProtocolVersion = protocol;
	}
	return presence;
}

export function isHostedMachinePresent(
	machine: Pick<HostedMachinePresence, 'lastSeenAt' | 'online'>,
	now: number
): boolean {
	if (machine.lastSeenAt !== undefined) {
		return now - machine.lastSeenAt <= MACHINE_ONLINE_THRESHOLD_MS;
	}
	return machine.online;
}

export function hostedMachineCapability(
	machine: HostedMachinePresence,
	now: number
): HostedMachineCapability {
	if (!isHostedMachinePresent(machine, now)) {
		return 'offline';
	}
	if (machine.remoteProtocolVersion !== HOSTED_REMOTE_PROTOCOL_VERSION) {
		return 'update-required';
	}
	return 'ready';
}

export function hostedMachineStatusLabel(capability: HostedMachineCapability): string | null {
	if (capability === 'offline') {
		return 'Offline';
	}
	if (capability === 'update-required') {
		return 'Update required';
	}
	return null;
}

export function hostedMachineOptionLabel(
	option: Pick<HostedMachineOption, 'label' | 'statusLabel'>
) {
	return option.statusLabel ? `${option.label} (${option.statusLabel})` : option.label;
}

export function hostedMachineOptions(
	machines: HostedMachinePresence[],
	now: number
): HostedMachineOption[] {
	return machines.map((machine) => {
		const capability = hostedMachineCapability(machine, now);
		return {
			id: machine.machineId,
			label: machine.friendlyName,
			capability,
			selectable: capability === 'ready',
			statusLabel: hostedMachineStatusLabel(capability)
		};
	});
}

export function hostedMachineSelectorOptions(
	machines: HostedMachinePresence[],
	selectedMachineId: string | null,
	now: number
): HostedMachineOption[] {
	const options = hostedMachineOptions(machines, now);
	if (selectedMachineId && !options.some((option) => option.id === selectedMachineId)) {
		options.unshift({
			id: selectedMachineId,
			label: 'Selected machine',
			capability: 'offline',
			selectable: false,
			statusLabel: 'Unavailable'
		});
	}
	return options;
}

export function selectedHostedMachine(
	machines: HostedMachinePresence[],
	selectedMachineId: string | null
): HostedMachinePresence | null {
	if (!selectedMachineId) {
		return null;
	}
	return machines.find((machine) => machine.machineId === selectedMachineId) ?? null;
}

export function isSelectedHostedMachineReady(
	machines: HostedMachinePresence[],
	selectedMachineId: string | null,
	now: number
): boolean {
	const selected = selectedHostedMachine(machines, selectedMachineId);
	return selected !== null && hostedMachineCapability(selected, now) === 'ready';
}

export function hostedMachinesNotice(args: {
	machines: HostedMachinePresence[];
	selectedMachineId: string | null;
	now: number;
}): string | null {
	if (args.machines.length === 0) {
		return 'No machines are running. Open Sprocket on a computer and sign in with this account.';
	}
	if (!args.selectedMachineId) {
		return 'Choose a running machine to attach a folder and start new work.';
	}
	const selected = selectedHostedMachine(args.machines, args.selectedMachineId);
	if (!selected) {
		return 'The selected machine is no longer available. Choose another machine to run new work.';
	}
	const capability = hostedMachineCapability(selected, args.now);
	if (capability === 'offline') {
		return `${selected.friendlyName} is offline. New work waits until it is running again. Existing threads stay readable.`;
	}
	if (capability === 'update-required') {
		return `${selected.friendlyName} needs a Sprocket update before it can run hosted work.`;
	}
	return null;
}

export function hostedComposerNotice(args: {
	machines: HostedMachinePresence[];
	selectedMachineId: string | null;
	now: number;
	machinesQueryError?: string | null;
	workspaceLoadError?: string | null;
	needsFolder?: boolean;
	selectedMachineName?: string | null;
}): HostedComposerNotice | null {
	if (args.machinesQueryError) {
		return {
			text: args.machinesQueryError,
			offerFolderPicker: false
		};
	}
	if (args.workspaceLoadError) {
		return {
			text: args.workspaceLoadError,
			offerFolderPicker: false
		};
	}
	const machinesNotice = hostedMachinesNotice(args);
	if (machinesNotice) {
		return { text: machinesNotice, offerFolderPicker: false };
	}
	if (args.needsFolder) {
		const machineName = args.selectedMachineName;
		return {
			text: machineName
				? `This thread can run on ${machineName} after you attach a matching folder.`
				: 'Attach a matching folder on the selected machine to run this thread.',
			offerFolderPicker: true
		};
	}
	return null;
}

export type HostedOp = {
	epoch: number;
};

export function beginHostedOp(epoch: number): HostedOp {
	return { epoch };
}

export function advanceHostedEpoch(epoch: number): number {
	return epoch + 1;
}

export function hostedOpIsCurrent(started: HostedOp, currentEpoch: number): boolean {
	return started.epoch === currentEpoch;
}

export const HOSTED_NAV_DRAWER_MAX_WIDTH_PX = 767;

export function hostedNavUsesDrawer(hosted: boolean, viewportWidth: number): boolean {
	return hosted && viewportWidth <= HOSTED_NAV_DRAWER_MAX_WIDTH_PX;
}

export function applyHostedAttachmentRefresh<T>(args: {
	op: HostedOp;
	currentEpoch: number;
	selectionGeneration: number;
	currentGeneration: number;
	attachments: T;
}): T | null {
	if (!hostedOpIsCurrent(args.op, args.currentEpoch)) {
		return null;
	}
	if (args.selectionGeneration !== args.currentGeneration) {
		return null;
	}
	return args.attachments;
}
