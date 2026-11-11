import { z } from 'zod';

const WIRE_COLOR_NAMES = [
	'red',
	'black',
	'blue',
	'green',
	'yellow',
	'orange',
	'white',
	'purple',
	'brown',
	'gray'
] as const;

type WireColor = (typeof WIRE_COLOR_NAMES)[number];

export const WIRE_COLORS = {
	red: '#e5484d',
	black: '#1f2328',
	blue: '#3b82f6',
	green: '#22a559',
	yellow: '#eab308',
	orange: '#f97316',
	white: '#f4f4f5',
	purple: '#8b5cf6',
	brown: '#92400e',
	gray: '#8b8d98'
} satisfies Record<WireColor, string>;

const SIGNAL_COLORS: WireColor[] = [
	'blue',
	'green',
	'yellow',
	'orange',
	'purple',
	'white',
	'brown'
];

export const MAX_WIRES_PER_STEP = 6;

const id = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, digits, - and _');

const partSchema = z.object({
	id,
	name: z.string(),
	wokwi: z.string().optional(),
	wokwiAttrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	pins: z
		.object({ left: z.array(z.string()).default([]), right: z.array(z.string()).default([]) })
		.optional(),
	logic: z.number().positive().optional(),
	photo: z.url().optional(),
	link: z.url().optional()
});

const wiringSchema = z.object({
	title: z.string().optional(),
	parts: z.array(partSchema).min(1),
	rails: z.array(z.object({ id, volts: z.number().min(0) })).default([]),
	steps: z
		.array(
			z.object({
				title: z.string(),
				note: z.string().optional(),
				wires: z
					.array(
						z.object({
							from: z.string(),
							to: z.string(),
							color: z.enum(WIRE_COLOR_NAMES).optional(),
							why: z.string().optional()
						})
					)
					.min(1)
			})
		)
		.min(1)
});

export type WiringSpec = z.infer<typeof wiringSchema>;

export type WiringPart = z.infer<typeof partSchema>;

export type WiringRail = WiringSpec['rails'][number];

export function parseWiring(source: string): { spec: WiringSpec } | { error: string } {
	let json: unknown;

	try {
		json = JSON.parse(source);
	} catch (error) {
		return { error: `Not valid JSON. ${String(error)}` };
	}

	const result = wiringSchema.safeParse(json);

	if (result.success) return { spec: result.data };

	return { error: z.prettifyError(result.error) };
}

export type PinRole = 'ground' | 'power' | 'signal';

export type PartPin = { name: string; x: number; y: number; role: PinRole; volts?: number };

export type PartGeometry = { width: number; height: number; pins: PartPin[] };

const GROUND_NAME = /^(GND|VSS|V-|-|0V)$/i;
const POWER_NAME = /^(VCC|VDD|VIN|VM|VS|VBAT|V\+|\+|\d+(\.\d+)?V|\dV\d)$/i;

export function baseName(pin: string) {
	return pin.replace(/\.\d+$/, '');
}

function voltsFromName(name: string) {
	const plain = /^(\d+(?:\.\d+)?)V$/i.exec(name);

	if (plain) return Number(plain[1]);

	const split = /^(\d)V(\d)$/i.exec(name);

	return split ? Number(`${split[1]}.${split[2]}`) : undefined;
}

export function pinRole(name: string): Pick<PartPin, 'role' | 'volts'> {
	const base = baseName(name);

	if (GROUND_NAME.test(base)) return { role: 'ground' };

	if (POWER_NAME.test(base)) return { role: 'power', volts: voltsFromName(base) };

	return { role: 'signal' };
}

export const BOX_WIDTH = 180;
export const BOX_HEADER = 44;
export const BOX_PITCH = 26;

export function boxGeometry(pins: { left: string[]; right: string[] }): PartGeometry {
	const rows = Math.max(pins.left.length, pins.right.length, 1);

	const side = (names: string[], x: number) =>
		names.map((name, index) => ({
			name,
			x,
			y: BOX_HEADER + index * BOX_PITCH + BOX_PITCH / 2,
			...pinRole(name)
		}));

	return {
		width: BOX_WIDTH,
		height: BOX_HEADER + rows * BOX_PITCH + 12,
		pins: [...side(pins.left, 0), ...side(pins.right, BOX_WIDTH)]
	};
}

const WOKWI_LOGIC = new Map([
	['arduino-uno', 5],
	['arduino-nano', 5],
	['arduino-mega', 5],
	['franzininho', 5],
	['esp32-devkit-v1', 3.3],
	['nano-rp2040-connect', 3.3]
]);

function partLogic(part: WiringPart) {
	return part.logic ?? (part.wokwi ? WOKWI_LOGIC.get(part.wokwi) : undefined);
}

export type Endpoint =
	| { type: 'pin'; part: WiringPart; pin: PartPin; label: string }
	| { type: 'rail'; rail: WiringRail; label: string };

export type ResolvedWire = {
	key: string;
	step: number;
	from: Endpoint;
	to: Endpoint;
	color: string;
	why?: string;
};

export type WiringIssue = { level: 'error' | 'warning'; message: string };

function findPin(pins: PartPin[], name: string) {
	const lower = name.toLowerCase();

	return (
		pins.find((pin) => pin.name === name) ??
		pins.find((pin) => pin.name.toLowerCase() === lower) ??
		pins.find((pin) => pin.name.toLowerCase().startsWith(`${lower}.`))
	);
}

function endpointKey(endpoint: Endpoint) {
	return endpoint.type === 'rail'
		? `rail:${endpoint.rail.id}`
		: `${endpoint.part.id}.${baseName(endpoint.pin.name)}`;
}

function endpointRole(endpoint: Endpoint): PinRole {
	if (endpoint.type === 'pin') return endpoint.pin.role;

	return endpoint.rail.volts === 0 ? 'ground' : 'power';
}

function endpointVolts(endpoint: Endpoint) {
	if (endpoint.type === 'rail') return endpoint.rail.volts;

	return endpoint.pin.role === 'ground' ? 0 : endpoint.pin.volts;
}

export function analyzeWiring(spec: WiringSpec, geometry: ReadonlyMap<string, PartGeometry>) {
	const issues: WiringIssue[] = [];
	const wires: ResolvedWire[] = [];
	const parts = new Map(spec.parts.map((part) => [part.id, part]));
	const rails = new Map(spec.rails.map((rail) => [rail.id, rail]));
	let signalIndex = 0;

	for (const part of spec.parts) {
		if (!geometry.has(part.id)) {
			issues.push({
				level: 'error',
				message: `${part.name} has no pins to draw. Give it a known "wokwi" type or a "pins" list.`
			});
		}
	}

	const resolve = (reference: string, stepTitle: string): Endpoint | undefined => {
		const dot = reference.indexOf('.');

		if (dot === -1) {
			const rail = rails.get(reference);

			if (rail) return { type: 'rail', rail, label: `${rail.id} rail` };

			issues.push({
				level: 'error',
				message: `Step "${stepTitle}": "${reference}" is not a rail. Use "part.pin" or a rail id.`
			});

			return;
		}

		const part = parts.get(reference.slice(0, dot));
		const pinName = reference.slice(dot + 1);

		if (!part) {
			issues.push({
				level: 'error',
				message: `Step "${stepTitle}": no part has the id "${reference.slice(0, dot)}".`
			});

			return;
		}

		const pins = geometry.get(part.id)?.pins;

		if (!pins) return;

		const pin = findPin(pins, pinName);

		if (pin) return { type: 'pin', part, pin, label: `${part.name} ${baseName(pin.name)}` };

		issues.push({
			level: 'error',
			message: `Step "${stepTitle}": ${part.name} has no pin "${pinName}". Its pins are ${pins.map((p) => p.name).join(', ')}.`
		});
	};

	spec.steps.forEach((step, stepIndex) => {
		if (step.wires.length > MAX_WIRES_PER_STEP) {
			issues.push({
				level: 'warning',
				message: `Step "${step.title}" adds ${step.wires.length} wires. Split it so each step adds ${MAX_WIRES_PER_STEP} or fewer.`
			});
		}

		step.wires.forEach((wire, wireIndex) => {
			const from = resolve(wire.from, step.title);
			const to = resolve(wire.to, step.title);

			if (!from || !to) return;

			const roles = [endpointRole(from), endpointRole(to)];

			const color =
				wire.color ??
				(roles.includes('ground')
					? 'black'
					: roles.includes('power')
						? 'red'
						: SIGNAL_COLORS[signalIndex++ % SIGNAL_COLORS.length]);

			wires.push({
				key: `${stepIndex}-${wireIndex}`,
				step: stepIndex,
				from,
				to,
				color: WIRE_COLORS[color],
				why: wire.why
			});
		});
	});

	issues.push(...checkNets(wires));

	return { wires, issues };
}

function checkNets(wires: ResolvedWire[]): WiringIssue[] {
	const parent = new Map<string, string>();

	const find = (key: string): string => {
		const next = parent.get(key) ?? key;

		if (next === key) return key;

		const root = find(next);
		parent.set(key, root);

		return root;
	};

	const members = new Map<string, Endpoint>();

	for (const wire of wires) {
		const a = endpointKey(wire.from);
		const b = endpointKey(wire.to);
		members.set(a, wire.from);
		members.set(b, wire.to);
		parent.set(find(a), find(b));
	}

	const nets = new Map<string, Endpoint[]>();

	for (const [key, endpoint] of members) {
		const root = find(key);
		nets.set(root, [...(nets.get(root) ?? []), endpoint]);
	}

	const issues: WiringIssue[] = [];
	const error = (message: string) => issues.push({ level: 'error', message });

	for (const net of nets.values()) {
		const sources = net.flatMap((endpoint) => {
			const volts = endpointVolts(endpoint);

			return volts === undefined ? [] : [{ endpoint, volts }];
		});

		const ground = sources.find((source) => source.volts === 0);

		const supplies = sources
			.filter((source) => source.volts > 0)
			.toSorted((a, b) => b.volts - a.volts);

		const highest = supplies[0];

		if (ground && highest) {
			error(
				`${highest.endpoint.label} is wired to ${ground.endpoint.label}. That shorts power to ground.`
			);

			continue;
		}

		const other = supplies.find((source) => source.volts !== highest?.volts);

		if (highest && other) {
			error(
				`${highest.endpoint.label} (${highest.volts} V) is wired to ${other.endpoint.label} (${other.volts} V). Two different voltages on one wire can damage both parts.`
			);

			continue;
		}

		const signals = net.flatMap((endpoint) => {
			if (endpoint.type !== 'pin' || endpoint.pin.role !== 'signal') return [];

			const logic = partLogic(endpoint.part);

			return logic === undefined ? [] : [{ endpoint, logic }];
		});

		if (highest) {
			for (const { endpoint, logic } of signals) {
				if (highest.volts > logic + 0.5) {
					error(
						`${endpoint.label} is a ${logic} V pin, but ${highest.endpoint.label} puts ${highest.volts} V on it.`
					);
				}
			}

			continue;
		}

		const levels = signals.map((signal) => signal.logic);
		const low = signals.find((signal) => signal.logic === Math.min(...levels));
		const high = signals.find((signal) => signal.logic === Math.max(...levels));

		if (low && high && high.logic > low.logic + 0.5) {
			issues.push({
				level: 'warning',
				message: `${high.endpoint.label} uses ${high.logic} V logic and ${low.endpoint.label} uses ${low.logic} V. If ${high.endpoint.label} sends a signal on this wire, put a level shifter or voltage divider in it.`
			});
		}
	}

	return issues;
}

export type Point = { x: number; y: number };

export function pinDirection(pin: PartPin, geometry: PartGeometry): Point {
	const edges: [number, Point][] = [
		[pin.x, { x: -1, y: 0 }],
		[geometry.width - pin.x, { x: 1, y: 0 }],
		[pin.y, { x: 0, y: -1 }],
		[geometry.height - pin.y, { x: 0, y: 1 }]
	];

	return edges.reduce((best, edge) => (edge[0] < best[0] ? edge : best))[1];
}

const MARGIN = 60;
const GAP_X = 160;
const ROW_GAP = 130;
const RAIL_CLEARANCE = 70;
const RAIL_PITCH = 22;

export type WiringLayout = {
	width: number;
	height: number;
	positions: Map<string, Point>;
	rowOf: Map<string, number>;
	railBands: number[];
};

export function railY(layout: WiringLayout, railIndex: number, row: number) {
	return (layout.railBands[row] ?? 0) + railIndex * RAIL_PITCH;
}

/** Each row of parts gets its own copy of every rail below it, like the rails along a breadboard, so rail wires stay short. */
export function layoutWiring(
	spec: WiringSpec,
	geometry: ReadonlyMap<string, PartGeometry>,
	maxRowWidth: number
): WiringLayout {
	const rows: { ids: string[]; width: number; height: number }[] = [];

	for (const part of spec.parts) {
		const size = geometry.get(part.id);

		if (!size) continue;

		const row = rows.at(-1);

		if (row && row.width + GAP_X + size.width <= maxRowWidth) {
			row.ids.push(part.id);
			row.width += GAP_X + size.width;
			row.height = Math.max(row.height, size.height);
		} else {
			rows.push({ ids: [part.id], width: size.width, height: size.height });
		}
	}

	const width = Math.max(0, ...rows.map((row) => row.width)) + MARGIN * 2;
	const positions = new Map<string, Point>();
	const rowOf = new Map<string, number>();
	const railBands: number[] = [];

	const railSpan =
		spec.rails.length > 0 ? RAIL_CLEARANCE + (spec.rails.length - 1) * RAIL_PITCH : 0;

	const rowGap = Math.max(ROW_GAP, railSpan + RAIL_CLEARANCE);
	let y = MARGIN;
	let bottom = MARGIN;

	rows.forEach((row, index) => {
		let x = (width - row.width) / 2;

		for (const partId of row.ids) {
			const size = geometry.get(partId)!;
			positions.set(partId, { x, y: y + (row.height - size.height) / 2 });
			rowOf.set(partId, index);
			x += size.width + GAP_X;
		}

		bottom = y + row.height;
		railBands.push(bottom + RAIL_CLEARANCE);
		y = bottom + rowGap;
	});

	return { width, height: bottom + railSpan + MARGIN, positions, rowOf, railBands };
}
