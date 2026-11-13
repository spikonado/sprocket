import { describe, expect, it } from 'vitest';
import { analyzeWiring, checkWiring, parseWiring, pinRole, WIRE_COLORS } from './wiring';

function analyze(source: string) {
	const parsed = parseWiring(source);

	if ('error' in parsed) throw new Error(parsed.error);

	return analyzeWiring(parsed.spec);
}

const parts = [
	{ id: 'esp', name: 'ESP32', logic: 3.3, pins: { right: ['3V3', 'GND.1', 'G12'] } },
	{ id: 'uno', name: 'Uno', logic: 5, pins: { left: ['5V', 'GND', 'D3'] } },
	{ id: 'bat', name: 'Battery', pins: { right: ['+', '-'] } },
	{ id: 'lidar', name: 'LiDAR', logic: 3.3, pins: { left: ['VCC_5V', '5V_MOTO', 'GND_MOTO'] } }
];

describe('pinRole', () => {
	it.each([
		['VCC_5V', 'power', 5],
		['5V_MOTO', 'power', 5],
		['GND_MOTO', 'ground', undefined],
		['VCC 5V', 'power', 5],
		['5V MOTO', 'power', 5],
		['gnd\tmoto.1', 'ground', undefined],
		['PWM_MOTO', 'signal', undefined]
	])('classifies %s as %s', (name, role, volts) => {
		expect(pinRole(name)).toMatchObject({ role });
		expect(pinRole(name).volts).toBe(volts);
	});
});

describe('checkWiring', () => {
	const spec = {
		parts,
		rails: [{ id: '5V', volts: 5 }],
		steps: [{ title: 'Power', wires: [{ from: '5V', to: 'esp.G12' }] }]
	};

	it('reports the issues the viewer shows', () => {
		expect(checkWiring(JSON.stringify(spec))).toEqual([
			{ level: 'error', message: 'ESP32 G12 is a 3.3 V pin, but 5V rail puts 5 V on it.' }
		]);
	});

	it.each([
		['invalid JSON', '{'],
		['a missing pins list', JSON.stringify({ ...spec, parts: [{ id: 'esp', name: 'ESP32' }] })],
		['an invalid +5V rail id', JSON.stringify({ ...spec, rails: [{ id: '+5V', volts: 5 }] })]
	])('reports %s as an unreadable wiring file', (_, source) => {
		expect(checkWiring(source)).toEqual([
			{ level: 'error', message: expect.stringContaining("This wiring file can't be read.") }
		]);
	});
});

describe('analyzeWiring', () => {
	it('resolves pins and rails and colours wires by role', () => {
		const { wires, issues } = analyze(
			JSON.stringify({
				parts,
				rails: [
					{ id: 'GND', volts: 0 },
					{ id: '5V', volts: 5 }
				],
				steps: [
					{
						title: 'Ground',
						wires: [
							{ from: 'esp.gnd', to: 'GND' },
							{ from: 'uno.GND', to: 'GND' },
							{ from: 'lidar.GND_MOTO', to: 'GND' },
							{ from: 'lidar.VCC_5V', to: '5V' },
							{ from: 'lidar.5V_MOTO', to: '5V' }
						]
					}
				]
			})
		);

		expect(issues).toEqual([]);
		expect(wires.map((wire) => [wire.from.label, wire.to.label, wire.color])).toEqual([
			['ESP32 GND', 'GND rail', WIRE_COLORS.black],
			['Uno GND', 'GND rail', WIRE_COLORS.black],
			['LiDAR GND_MOTO', 'GND rail', WIRE_COLORS.black],
			['LiDAR VCC_5V', '5V rail', WIRE_COLORS.red],
			['LiDAR 5V_MOTO', '5V rail', WIRE_COLORS.red]
		]);
	});

	it('reports wiring that would damage parts', () => {
		const { issues } = analyze(
			JSON.stringify({
				parts,
				rails: [
					{ id: 'GND', volts: 0 },
					{ id: '5V', volts: 5 }
				],
				steps: [
					{
						title: 'Mistakes',
						wires: [
							{ from: 'uno.5V', to: 'esp.G12' },
							{ from: 'esp.3V3', to: 'GND' },
							{ from: 'uno.D3', to: 'esp.G99' },
							{ from: 'bat.+', to: 'bat.-' },
							{ from: '5V', to: 'GND' }
						]
					}
				]
			})
		);

		expect(issues.map((issue) => issue.message)).toEqual([
			'Step "Mistakes": ESP32 has no pin "G99". Its pins are 3V3, GND.1, G12.',
			'Step "Mistakes": a wire joins the 5V and GND rails. Use one rail for parts that share a supply.',
			'ESP32 G12 is a 3.3 V pin, but Uno 5V puts 5 V on it.',
			'ESP32 3V3 is wired to GND rail. That shorts power to ground.',
			'Battery + is wired to Battery -. That shorts power to ground.'
		]);
	});
});
