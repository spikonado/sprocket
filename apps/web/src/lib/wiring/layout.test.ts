import { describe, expect, it } from 'vitest';
import { analyzeWiring, parseWiring, wiringGeometry } from '@convex/lib/wiring';
import { GRID, layoutWiring, wrapRows } from './layout';
import type { Point } from './route';

const spec = parseWiring(
	JSON.stringify({
		parts: [
			{ id: 'buck', name: 'Buck', pins: { left: ['IN+', 'IN-'], right: ['OUT+', 'OUT-'] } },
			{
				id: 'mcu',
				name: 'MCU',
				logic: 5,
				pins: { left: ['5V', 'GND'], right: ['D2', 'D3', 'D4'] }
			},
			{ id: 'sonar', name: 'Sonar', pins: { left: ['VCC', 'TRIG', 'ECHO', 'GND'] } },
			{ id: 'led', name: 'LED', pins: { left: ['A', 'K'] } }
		],
		rails: [
			{ id: '5V', volts: 5 },
			{ id: 'GND', volts: 0 }
		],
		steps: [
			{
				title: 'Power',
				wires: [
					{ from: 'buck.OUT+', to: '5V' },
					{ from: 'buck.OUT-', to: 'GND' },
					{ from: 'mcu.5V', to: '5V' },
					{ from: 'mcu.GND', to: 'GND' },
					{ from: 'sonar.VCC', to: '5V' },
					{ from: 'sonar.GND', to: 'GND' }
				]
			},
			{
				title: 'Signals',
				wires: [
					{ from: 'mcu.D2', to: 'sonar.TRIG' },
					{ from: 'mcu.D3', to: 'sonar.ECHO' },
					{ from: 'buck.IN+', to: 'led.A' }
				]
			},
			{
				title: 'LED',
				wires: [
					{ from: 'mcu.D4', to: 'led.A' },
					{ from: 'led.K', to: 'GND' }
				]
			}
		]
	})
);

describe('layoutWiring', () => {
	it('routes every wire on its own grid lanes, clear of every part, joining only wires drawn with it', () => {
		if ('error' in spec) throw new Error(spec.error);

		const geometry = wiringGeometry(spec.spec);
		const { wires } = analyzeWiring(spec.spec, geometry);

		for (const width of [600, 1600]) {
			const layout = layoutWiring(spec.spec, geometry, wires, wrapRows(spec.spec, geometry, width));
			const edges = new Map<string, string>();
			const corners = new Map<string, string>();

			for (const wire of wires) {
				const route = layout.routes.get(wire.key);
				expect(route?.overlaps).toBe(false);

				for (const joined of route?.joins ?? []) {
					expect(wires.find((other) => other.key === joined)?.step).toBeLessThanOrEqual(wire.step);
				}

				const points = route?.points ?? [];

				points.forEach((point, index) => {
					if (index > 0 && index < points.length - 1) claim(corners, key(point), wire.key);

					for (const edge of gridEdges(point, points[index + 1])) claim(edges, edge, wire.key);
				});

				for (const [id, position] of layout.positions) {
					const part = geometry.get(id);

					for (const point of points.slice(1, -1)) {
						const inside =
							part &&
							point.x > position.x &&
							point.x < position.x + part.width &&
							point.y > position.y &&
							point.y < position.y + part.height;

						expect(inside).toBeFalsy();
					}
				}
			}
		}
	});
});

function claim(owners: Map<string, string>, id: string, wire: string) {
	expect(owners.get(id) ?? wire).toBe(wire);
	owners.set(id, wire);
}

const key = (point: Point) => `${point.x},${point.y}`;

/** Unit grid edges along a segment. Leads from off-grid pins are skipped. */
function gridEdges(from: Point, to: Point | undefined) {
	const onGrid = (point: Point) => point.x % GRID === 0 && point.y % GRID === 0;

	if (!to || !onGrid(from) || !onGrid(to)) return [];

	const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / GRID;
	const dx = Math.sign(to.x - from.x) * GRID;
	const dy = Math.sign(to.y - from.y) * GRID;

	return Array.from({ length: steps }, (_, step) => {
		const a = { x: from.x + dx * step, y: from.y + dy * step };
		const b = { x: a.x + dx, y: a.y + dy };

		return [key(a), key(b)].toSorted().join('|');
	});
}
