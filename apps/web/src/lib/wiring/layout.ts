import {
	DOWN,
	LEFT,
	RIGHT,
	routeGrid,
	SIDE_VECTORS,
	UP,
	type Connection,
	type Point,
	type Terminal
} from './route';
import {
	baseName,
	type Endpoint,
	type PartGeometry,
	type PartPin,
	type ResolvedWire,
	type WiringSpec
} from './wiring';

export const GRID = 10;
const PART_GAP = 6 * GRID;
const LANES_ABOVE_RAILS = 5 * GRID;
const LANES_BELOW_RAILS = 4 * GRID;
const MARGIN = 4 * GRID;
const SLACK_LANES = 2;
const RAIL_PITCH = 2 * GRID;
const RAIL_LABEL_WIDTH = 9 * GRID;
const LABEL_ROOM = 5 * GRID;
const STUB_ROOM = 2 * GRID;
const NAME_BAND = 2 * GRID;
const SPREADS = [1, 1.5, 2.25];

const snapUp = (value: number) => Math.ceil(value / GRID - 1e-6) * GRID;
const snapDown = (value: number) => Math.floor(value / GRID + 1e-6) * GRID;

export function pinSide(pin: PartPin, geometry: PartGeometry) {
	const distances = [geometry.width - pin.x, geometry.height - pin.y, pin.x, pin.y];

	return distances.indexOf(Math.min(...distances));
}

/** The clear space kept around a part, indexed by side. Only the part's own pin leads and labels use it. */
export function partInsets(geometry: PartGeometry) {
	const room = geometry.pinNamesInside ? STUB_ROOM : LABEL_ROOM;
	const used = new Set(geometry.pins.map((pin) => pinSide(pin, geometry)));
	const nameBand = geometry.pinNamesInside ? 0 : NAME_BAND;
	const sides = SIDE_VECTORS.map((_, side) => (used.has(side) ? room : GRID));
	const top = sides[UP];
	sides[UP] = top + nameBand;

	return { sides, nameY: -(top + nameBand / 2) };
}

const outerWidth = (geometry: PartGeometry) => {
	const { sides } = partInsets(geometry);

	return sides[LEFT] + snapUp(geometry.width) + sides[RIGHT];
};

export function wrapRows(
	spec: WiringSpec,
	geometry: ReadonlyMap<string, PartGeometry>,
	maxRowWidth: number
) {
	const rows: { count: number; width: number }[] = [];

	for (const part of spec.parts) {
		const size = geometry.get(part.id);

		if (!size) continue;

		const width = outerWidth(size);
		const row = rows.at(-1);

		if (row && row.width + PART_GAP + width <= maxRowWidth) {
			row.count += 1;
			row.width += PART_GAP + width;
		} else {
			rows.push({ count: 1, width });
		}
	}

	return rows.map((row) => row.count);
}

export type RailLine = { rail: number; segments: [Point, Point][]; labels: Point[] };

export type PinLabel = { text: string; at: Point; side: number };

export type WireRoute = { points: Point[]; labels: PinLabel[]; overlaps: boolean };

export type WiringLayout = {
	width: number;
	height: number;
	positions: Map<string, Point>;
	rails: RailLine[];
	routes: Map<string, WireRoute>;
};

type Part = { id: string; geometry: PartGeometry; sides: number[] };

type PlacedPart = Part & { position: Point };

type PinEnd = { terminal: Terminal; point: Point; label?: PinLabel };

/**
 * Parts sit in rows, with a copy of every rail under each row, joined on the left like breadboard
 * rails. Gaps grow with the wires that leave through them. If a wire still finds no free path, the
 * whole layout spreads out and is routed again.
 */
export function layoutWiring(
	spec: WiringSpec,
	geometry: ReadonlyMap<string, PartGeometry>,
	wires: ResolvedWire[],
	rowCounts: number[]
): WiringLayout {
	const parts = spec.parts.flatMap((part): Part[] => {
		const size = geometry.get(part.id);

		return size ? [{ id: part.id, geometry: size, sides: partInsets(size).sides }] : [];
	});

	let next = 0;

	const rows = rowCounts.map((count) => {
		next += count;

		return parts.slice(next - count, next);
	});

	const rowOf = new Map(rows.flatMap((row, index) => row.map((part) => [part.id, index])));
	const wiredPins = new Map<string, Set<string>>();

	for (const wire of wires) {
		for (const end of [wire.from, wire.to]) {
			const size = end.type === 'pin' ? geometry.get(end.part.id) : undefined;

			if (end.type !== 'pin' || !size) continue;

			const side = `${end.part.id}:${pinSide(end.pin, size)}`;
			wiredPins.set(side, (wiredPins.get(side) ?? new Set()).add(end.pin.name));
		}
	}

	const wiredOn = (part: Part | undefined, side: number) =>
		part ? (wiredPins.get(`${part.id}:${side}`)?.size ?? 0) : 0;

	const wireRows = wires.map((wire) =>
		[wire.from, wire.to].flatMap((end) =>
			end.type === 'pin' ? (rowOf.get(end.part.id) ?? []) : []
		)
	);

	const touching = (row: number) => wireRows.filter((ends) => ends.includes(row)).length;

	const crossing = (row: number) =>
		wireRows.filter((ends) => Math.min(...ends) <= row && Math.max(...ends) > row).length;

	const lanes = (count: number) => (count + SLACK_LANES) * GRID;

	const attempt = (spread: number) => {
		const room = (minimum: number, needed: number) => snapUp(Math.max(minimum, needed) * spread);

		const gaps = rows.map((row) =>
			[undefined, ...row].map((part, index) => {
				const after = row[index];
				const minimum = part && after ? PART_GAP : MARGIN;

				return room(minimum, lanes(wiredOn(part, RIGHT) + wiredOn(after, LEFT)));
			})
		);

		const rowWidth = (row: Part[], index: number) =>
			row.reduce((sum, part) => sum + outerWidth(part.geometry), 0) +
			gaps[index].reduce((sum, gap) => sum + gap, 0);

		const railCount = spec.rails.length;
		const contentWidth = Math.max(0, ...rows.map(rowWidth));
		const contentLeft = (railCount + 1) * GRID;
		const railEnd = contentLeft + contentWidth;
		const placed: PlacedPart[] = [];
		const bands: number[] = [];
		let y = room(MARGIN, 0);

		rows.forEach((row, rowIndex) => {
			const height = Math.max(...row.map((part) => snapUp(part.geometry.height)));
			const offsets = row.map((part) => snapDown((height - part.geometry.height) / 2));
			const top = Math.max(...row.map((part, index) => y + part.sides[UP] - offsets[index]));
			let x = contentLeft + snapDown((contentWidth - rowWidth(row, rowIndex)) / 2);
			let bottom = y;

			row.forEach((part, index) => {
				const position = {
					x: x + gaps[rowIndex][index] + part.sides[LEFT],
					y: top + offsets[index]
				};

				placed.push({ ...part, position });
				x = position.x + snapUp(part.geometry.width) + part.sides[RIGHT];
				bottom = Math.max(bottom, position.y + snapUp(part.geometry.height) + part.sides[DOWN]);
			});

			const above = room(LANES_ABOVE_RAILS, lanes(Math.ceil(touching(rowIndex) / 2)));
			const below = room(LANES_BELOW_RAILS, lanes(crossing(rowIndex)));

			if (railCount > 0) {
				bands.push(bottom + above);
				y = bottom + above + (railCount - 1) * RAIL_PITCH + below;
			} else {
				y = bottom + above + below;
			}
		});

		const layout = { placed, bands, railEnd, width: railEnd + RAIL_LABEL_WIDTH, height: y };

		return { layout, routes: routeLayout(spec, wires, layout) };
	};

	let result = attempt(SPREADS[0]);

	for (const spread of SPREADS.slice(1)) {
		if (![...result.routes.values()].some((route) => route.overlaps)) break;

		result = attempt(spread);
	}

	const { layout, routes } = result;

	const rails = spec.rails.map((_, rail): RailLine => {
		const ys = layout.bands.map((band) => railY(band, rail));
		const x = connectorX(rail);

		const segments: [Point, Point][] = ys.map((railRow) => [
			{ x, y: railRow },
			{ x: layout.railEnd, y: railRow }
		]);

		if (ys.length > 1)
			segments.push([
				{ x, y: ys[0] },
				{ x, y: ys.at(-1) ?? ys[0] }
			]);

		return { rail, segments, labels: ys.map((railRow) => ({ x: layout.railEnd + 6, y: railRow })) };
	});

	return {
		width: layout.width,
		height: layout.height,
		positions: new Map(layout.placed.map((part) => [part.id, part.position])),
		rails,
		routes
	};
}

const railY = (band: number, rail: number) => band + rail * RAIL_PITCH;
const connectorX = (rail: number) => (rail + 1) * GRID;

type Placement = {
	placed: PlacedPart[];
	bands: number[];
	railEnd: number;
	width: number;
	height: number;
};

function routeLayout(spec: WiringSpec, wires: ResolvedWire[], layout: Placement) {
	const { placed, bands } = layout;
	const partById = new Map(placed.map((part) => [part.id, part]));

	const keepOut = (part: PlacedPart) => ({
		iMin: Math.floor((part.position.x - part.sides[LEFT]) / GRID),
		iMax: Math.ceil((part.position.x + part.geometry.width + part.sides[RIGHT]) / GRID),
		jMin: Math.floor((part.position.y - part.sides[UP]) / GRID),
		jMax: Math.ceil((part.position.y + part.geometry.height + part.sides[DOWN]) / GRID)
	});

	const pinEnd = (end: Extract<Endpoint, { type: 'pin' }>): PinEnd | undefined => {
		const part = partById.get(end.part.id);

		if (!part) return;

		const { pin } = end;
		const { position, geometry: size } = part;
		const side = pinSide(pin, size);
		const box = keepOut(part);
		const point = { x: position.x + pin.x, y: position.y + pin.y };
		const across = Math.round((side % 2 === 0 ? point.y : point.x) / GRID);
		const out = [box.iMax, box.jMax, box.iMin, box.jMin][side];

		const edge = [
			{ x: position.x + size.width, y: point.y },
			{ x: point.x, y: position.y + size.height },
			{ x: position.x, y: point.y },
			{ x: point.x, y: position.y }
		][side];

		return {
			terminal: {
				key: `${part.id}.${pin.name}`,
				side,
				...(side % 2 === 0 ? { i: out, j: across } : { i: across, j: out })
			},
			point,
			label: size.pinNamesInside ? undefined : { text: baseName(pin.name), at: edge, side }
		};
	};

	const ends = wires.map((wire) => {
		const [first, second] = wire.from.type === 'rail' ? [wire.to, wire.from] : [wire.from, wire.to];
		const start = first.type === 'pin' ? pinEnd(first) : undefined;
		const end = second.type === 'pin' ? pinEnd(second) : undefined;

		if (!start || (second.type === 'pin' && !end)) return;

		const target: Connection['target'] = end
			? { type: 'pin', terminal: end.terminal }
			: { type: 'rail', rail: second.type === 'rail' ? spec.rails.indexOf(second.rail) : -1 };

		return { start, end, connection: { start: start.terminal, target } };
	});

	const paths = routeGrid(
		{
			columns: layout.width / GRID + 1,
			rows: layout.height / GRID + 1,
			keepOuts: placed.map(keepOut),
			railRows: spec.rails.map((_, rail) => bands.map((band) => railY(band, rail) / GRID)),
			railStart: spec.rails.map((_, rail) => connectorX(rail) / GRID),
			railEnd: layout.railEnd / GRID
		},
		ends.map((end) => end?.connection)
	);

	const fallbackPoint = (end: Endpoint) => {
		if (end.type === 'pin') return pinEnd(end)?.point;

		const rail = spec.rails.indexOf(end.rail);

		return bands.length > 0 ? { x: connectorX(rail), y: railY(bands[0], rail) } : undefined;
	};

	const routes = new Map<string, WireRoute>();

	wires.forEach((wire, index) => {
		const end = ends[index];
		const path = paths[index];

		if (end && path) {
			const cells = path.cells.map((cell) => ({ x: cell.x * GRID, y: cell.y * GRID }));
			const startPin = path.fromPin ? end.start : undefined;
			const endPin = path.toPin ? end.end : undefined;

			routes.set(wire.key, {
				points: [
					...(startPin ? [startPin.point] : []),
					...cells,
					...(endPin ? [endPin.point] : [])
				],
				labels: [startPin?.label, endPin?.label].flatMap((label) => label ?? []),
				overlaps: false
			});

			return;
		}

		const a = fallbackPoint(wire.from);
		const b = fallbackPoint(wire.to);

		if (a && b) routes.set(wire.key, { points: [a, b], labels: [], overlaps: true });
	});

	return routes;
}
