import { describe, expect, it } from 'vitest';
import { analyzeWiring, boxGeometry, parseWiring, WIRE_COLORS } from './wiring';

function analyze(source: string) {
	const parsed = parseWiring(source);

	if ('error' in parsed) throw new Error(parsed.error);

	const geometry = new Map(
		parsed.spec.parts.flatMap((part) => (part.pins ? [[part.id, boxGeometry(part.pins)]] : []))
	);

	return analyzeWiring(parsed.spec, geometry);
}

const parts = [
	{ id: 'esp', name: 'ESP32', logic: 3.3, pins: { right: ['3V3', 'GND.1', 'G12'] } },
	{ id: 'uno', name: 'Uno', logic: 5, pins: { left: ['5V', 'GND', 'D3'] } },
	{ id: 'bat', name: 'Battery', pins: { right: ['+', '-'] } }
];

describe('analyzeWiring', () => {
	it('resolves pins and rails and colours wires by role', () => {
		const { wires, issues } = analyze(
			JSON.stringify({
				parts,
				rails: [{ id: 'GND', volts: 0 }],
				steps: [
					{
						title: 'Ground',
						wires: [
							{ from: 'esp.gnd', to: 'GND' },
							{ from: 'uno.GND', to: 'GND' }
						]
					}
				]
			})
		);

		expect(issues).toEqual([]);
		expect(wires.map((wire) => [wire.from.label, wire.to.label, wire.color])).toEqual([
			['ESP32 GND', 'GND rail', WIRE_COLORS.black],
			['Uno GND', 'GND rail', WIRE_COLORS.black]
		]);
	});

	it('reports wiring that would damage parts', () => {
		const { issues } = analyze(
			JSON.stringify({
				parts,
				rails: [{ id: 'GND', volts: 0 }],
				steps: [
					{
						title: 'Mistakes',
						wires: [
							{ from: 'uno.5V', to: 'esp.G12' },
							{ from: 'esp.3V3', to: 'GND' },
							{ from: 'uno.D3', to: 'esp.G99' },
							{ from: 'bat.+', to: 'bat.-' }
						]
					}
				]
			})
		);

		expect(issues.map((issue) => issue.message)).toEqual([
			'Step "Mistakes": ESP32 has no pin "G99". Its pins are 3V3, GND.1, G12.',
			'ESP32 G12 is a 3.3 V pin, but Uno 5V puts 5 V on it.',
			'ESP32 3V3 is wired to GND rail. That shorts power to ground.',
			'Battery + is wired to Battery -. That shorts power to ground.'
		]);
	});
});
