export type Point = { x: number; y: number };

export const RIGHT = 0;
export const DOWN = 1;
export const LEFT = 2;
export const UP = 3;

export const SIDE_VECTORS: readonly Point[] = [
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
	{ x: 0, y: -1 }
];

/** Grid cells strictly inside the rectangle are off limits to wires. */
export type Rect = { iMin: number; iMax: number; jMin: number; jMax: number };

/** Where a pin's lead meets the grid, and the side it leaves the part on. */
export type Terminal = { key: string; i: number; j: number; side: number };

export type Connection = {
	start: Terminal;
	target: { type: 'pin'; terminal: Terminal } | { type: 'rail'; rail: number };
};

/**
 * `railRows[rail][band]` is the grid row of that rail's copy under each row of parts. A rail runs
 * from its `railStart` column to `railEnd`, and its copies are joined along the `railStart` column.
 */
export type Board = {
	columns: number;
	rows: number;
	keepOuts: Rect[];
	railRows: number[][];
	railStart: number[];
	railEnd: number;
};

/** `cells` holds the path's ends and corners. An end that isn't at a pin joins a wire of that pin. */
export type GridPath = { cells: Point[]; fromPin: boolean; toPin: boolean };

const FREE = 0;
const ALONG_X = 1;
const ALONG_Y = 2;
const CROSSED = ALONG_X | ALONG_Y;
const BUSY = 4;
const BLOCKED = 8;

const FROM_PIN = 4;
const JOIN_ALONG_X = 5;
const JOIN_ALONG_Y = 6;
const CODES = 7;

const BEND_COST = 4;
const CROSS_COST = 3;
const JOIN_COST = 2;
const ATTEMPTS = 3;

const axisBit = (side: number) => (side % 2 === 0 ? ALONG_X : ALONG_Y);

type Grid = {
	state: Uint8Array;
	owner: (string | undefined)[];
	reserved: (string | undefined)[];
	railOf: Int16Array;
	used: Uint8Array;
	wireAt: Int32Array;
	joints: Map<string, number[]>;
	claimed: boolean[];
};

/**
 * Routes wires with right-angle bends. Each grid edge carries one wire, every corner and wire end
 * owns its cell, and wires only cross straight over each other, so no two wires share a stretch, a
 * corner or a rail tap. Each pin's first cell out is kept for its own wires, so a lead never gets
 * walled in. A second wire on a pin joins that pin's first wire at a T.
 */
export function routeGrid(board: Board, connections: (Connection | undefined)[]) {
	const nx = board.columns;
	const ny = board.rows;
	const nodeCount = nx * ny;
	const node = (i: number, j: number) => j * nx + i;
	const column = (n: number) => n % nx;
	const row = (n: number) => Math.floor(n / nx);

	const neighbor = (n: number, side: number) => {
		const i = column(n) + SIDE_VECTORS[side].x;
		const j = row(n) + SIDE_VECTORS[side].y;

		return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : node(i, j);
	};

	const edgeIndex = (n: number, side: number) =>
		side < 2 ? n * 2 + side : neighbor(n, side) * 2 + side - 2;

	const terminalNode = (terminal: Terminal) => node(terminal.i, terminal.j);

	const keysOf = (index: number) => {
		const connection = connections[index];

		if (!connection) return [];

		const { start, target } = connection;

		return target.type === 'pin' ? [start.key, target.terminal.key] : [start.key];
	};

	const createGrid = (): Grid => {
		const state = new Uint8Array(nodeCount);
		const owner = Array.from<string | undefined>({ length: nodeCount });
		const reserved = Array.from<string | undefined>({ length: nodeCount });
		const railOf = new Int16Array(nodeCount).fill(-1);

		for (const rect of board.keepOuts) {
			for (let j = Math.max(rect.jMin + 1, 0); j < Math.min(rect.jMax, ny); j++) {
				for (let i = Math.max(rect.iMin + 1, 0); i < Math.min(rect.iMax, nx); i++) {
					state[node(i, j)] = BLOCKED;
				}
			}
		}

		const bands = board.railRows[0]?.length ?? 0;

		for (let band = 0; band < bands; band++) {
			const top = Math.min(...board.railRows.map((rows) => rows[band]));
			const bottom = Math.max(...board.railRows.map((rows) => rows[band]));

			for (let j = top; j <= bottom; j++) {
				for (let i = 0; i < nx; i++) {
					const n = node(i, j);

					state[n] = i > board.railEnd ? BLOCKED : state[n] | ALONG_X;
				}
			}

			board.railRows.forEach((rows, rail) => {
				for (let i = board.railStart[rail]; i <= board.railEnd; i++)
					railOf[node(i, rows[band])] = rail;
			});
		}

		if (bands > 1) {
			board.railRows.forEach((rows, rail) => {
				for (let j = rows[0]; j <= rows[bands - 1]; j++) {
					const n = node(board.railStart[rail], j);
					state[n] = rows.includes(j) ? BUSY : state[n] | ALONG_Y;
				}
			});
		}

		const claim = (terminal: Terminal) => {
			const n = terminalNode(terminal);

			if (owner[n] !== undefined) return owner[n] === terminal.key;

			if (state[n] !== FREE) return false;

			state[n] = BUSY;
			owner[n] = terminal.key;

			return true;
		};

		const claimed = connections.map(
			(connection) =>
				connection !== undefined &&
				claim(connection.start) &&
				(connection.target.type === 'rail' || claim(connection.target.terminal))
		);

		const terminals = connections.flatMap((connection) =>
			connection
				? [
						connection.start,
						...(connection.target.type === 'pin' ? [connection.target.terminal] : [])
					]
				: []
		);

		for (const terminal of terminals) {
			const n = terminalNode(terminal);

			if (owner[n] !== terminal.key) continue;

			for (const side of [(terminal.side + 1) % 4, (terminal.side + 3) % 4]) {
				const lateral = neighbor(n, side);

				if (lateral >= 0 && state[lateral] === FREE) state[lateral] = BLOCKED;
			}

			const exit = neighbor(n, terminal.side);

			if (exit >= 0 && state[exit] === FREE && reserved[exit] === undefined) {
				reserved[exit] = terminal.key;
			}
		}

		return {
			state,
			owner,
			reserved,
			railOf,
			used: new Uint8Array(nodeCount * 2),
			wireAt: new Int32Array(nodeCount).fill(-1),
			joints: new Map(),
			claimed
		};
	};

	const joinable = (grid: Grid, n: number, key: string) =>
		(grid.state[n] === ALONG_X || grid.state[n] === ALONG_Y) &&
		grid.wireAt[n] >= 0 &&
		keysOf(grid.wireAt[n]).includes(key);

	const cost = new Float64Array(nodeCount * CODES);
	const prev = new Int32Array(nodeCount * CODES);
	const closed = new Uint8Array(nodeCount * CODES);

	const search = (grid: Grid, connection: Connection) => {
		const { state, reserved, railOf, used } = grid;
		const { start, target } = connection;
		const targetKey = target.type === 'pin' ? target.terminal.key : undefined;

		const joins = (key: string) =>
			(grid.joints.get(key) ?? []).filter((n) => joinable(grid, n, key));

		const goals =
			target.type === 'pin' ? [terminalNode(target.terminal), ...joins(target.terminal.key)] : [];

		const railRows = target.type === 'rail' ? board.railRows[target.rail] : [];

		const estimate = (n: number) =>
			target.type === 'pin'
				? Math.min(
						...goals.map(
							(goal) => Math.abs(column(n) - column(goal)) + Math.abs(row(n) - row(goal))
						)
					)
				: Math.min(...railRows.map((railRow) => Math.abs(row(n) - railRow)));

		const isGoal = (n: number, side: number) => {
			if (target.type === 'rail') {
				return railOf[n] === target.rail && state[n] === ALONG_X && side % 2 === 1;
			}

			if (n === terminalNode(target.terminal)) return true;

			return joinable(grid, n, target.terminal.key) && (state[n] & axisBit(side)) === 0;
		};

		const enterable = (n: number) =>
			state[n] < BUSY &&
			state[n] !== CROSSED &&
			(reserved[n] === undefined || reserved[n] === start.key || reserved[n] === targetKey);

		cost.fill(Infinity);
		closed.fill(0);
		const heap = new MinHeap();

		const sources = [
			{ n: terminalNode(start), code: FROM_PIN },
			...joins(start.key).map((n) => ({
				n,
				code: state[n] === ALONG_X ? JOIN_ALONG_X : JOIN_ALONG_Y
			}))
		];

		for (const { n, code } of sources) {
			const initial = code === FROM_PIN ? 0 : JOIN_COST;
			cost[n * CODES + code] = initial;
			heap.push(n * CODES + code, initial + estimate(n));
		}

		while (heap.size > 0) {
			const current = heap.pop();

			if (closed[current]) continue;

			closed[current] = 1;
			const n = Math.floor(current / CODES);
			const incoming = current % CODES;

			if (incoming < FROM_PIN && isGoal(n, incoming)) return pathTo(current);

			for (let side = 0; side < 4; side++) {
				if (incoming < FROM_PIN && side === (incoming + 2) % 4) continue;

				if (incoming === JOIN_ALONG_X && side % 2 === 0) continue;

				if (incoming === JOIN_ALONG_Y && side % 2 === 1) continue;

				const m = neighbor(n, side);

				if (m < 0 || used[edgeIndex(n, side)]) continue;

				let step = 1;

				if (incoming < FROM_PIN) {
					const here = state[n];

					if (side === incoming) {
						if (here >= BUSY || here & axisBit(side)) continue;

						if (here !== FREE) step += CROSS_COST;
					} else {
						if (here !== FREE) continue;

						step += BEND_COST;
					}
				}

				if (!isGoal(m, side) && !enterable(m)) continue;

				const next = m * CODES + side;
				const total = cost[current] + step;

				if (total < cost[next]) {
					cost[next] = total;
					prev[next] = current;
					heap.push(next, total + estimate(m));
				}
			}
		}
	};

	const pathTo = (last: number) => {
		const states = [last];

		while (states[0] % CODES < FROM_PIN) states.unshift(prev[states[0]]);

		return states;
	};

	const commit = (grid: Grid, states: number[], wire: number) => {
		const { state } = grid;

		states.forEach((current, index) => {
			const n = Math.floor(current / CODES);
			const following = states[index + 1];

			if (following === undefined || index === 0) {
				state[n] = BUSY;
			} else {
				const incoming = current % CODES;
				const side = following % CODES;
				state[n] = side === incoming ? state[n] | axisBit(side) : BUSY;
				grid.wireAt[n] = wire;

				for (const key of keysOf(wire)) {
					const joints = grid.joints.get(key);

					if (joints) joints.push(n);
					else grid.joints.set(key, [n]);
				}
			}

			if (following !== undefined) grid.used[edgeIndex(n, following % CODES)] = 1;
		});
	};

	const toPath = (states: number[], connection: Connection): GridPath => {
		const cells = states.flatMap((current, index) => {
			const following = states[index + 1];
			const n = Math.floor(current / CODES);

			const isCorner =
				index === 0 || following === undefined || current % CODES !== following % CODES;

			return isCorner ? [{ x: column(n), y: row(n) }] : [];
		});

		const last = Math.floor((states.at(-1) ?? 0) / CODES);

		return {
			cells,
			fromPin: states[0] % CODES === FROM_PIN,
			toPin: connection.target.type === 'pin' && last === terminalNode(connection.target.terminal)
		};
	};

	const span = (connection: Connection | undefined) => {
		if (!connection) return 0;

		const { start, target } = connection;

		if (target.type === 'pin') {
			return Math.abs(start.i - target.terminal.i) + Math.abs(start.j - target.terminal.j);
		}

		return Math.min(...board.railRows[target.rail].map((railRow) => Math.abs(start.j - railRow)));
	};

	let order = connections
		.map((connection, index) => ({ index, span: span(connection) }))
		.toSorted((a, b) => a.span - b.span)
		.map((item) => item.index);

	let found = new Map<number, GridPath>();

	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const grid = createGrid();
		found = new Map();

		for (const index of order) {
			const connection = connections[index];

			if (!connection || !grid.claimed[index]) continue;

			const states = search(grid, connection);

			if (!states) continue;

			commit(grid, states, index);
			found.set(index, toPath(states, connection));
		}

		const failed = order.filter((index) => grid.claimed[index] && !found.has(index));

		if (failed.length === 0) break;

		order = [...failed, ...order.filter((index) => !failed.includes(index))];
	}

	return connections.map((_, index) => found.get(index));
}

class MinHeap {
	private items: number[] = [];
	private priorities: number[] = [];

	get size() {
		return this.items.length;
	}

	push(item: number, priority: number) {
		const { items, priorities } = this;
		let index = items.length;
		items.push(item);
		priorities.push(priority);

		while (index > 0) {
			const parent = (index - 1) >> 1;

			if (priorities[parent] <= priority) break;

			items[index] = items[parent];
			priorities[index] = priorities[parent];
			index = parent;
		}

		items[index] = item;
		priorities[index] = priority;
	}

	pop() {
		const { items, priorities } = this;
		const top = items[0];
		const lastItem = items.pop() ?? 0;
		const lastPriority = priorities.pop() ?? 0;

		if (items.length === 0) return top;

		let index = 0;

		for (;;) {
			const left = index * 2 + 1;

			if (left >= items.length) break;

			const child =
				left + 1 < items.length && priorities[left + 1] < priorities[left] ? left + 1 : left;

			if (priorities[child] >= lastPriority) break;

			items[index] = items[child];
			priorities[index] = priorities[child];
			index = child;
		}

		items[index] = lastItem;
		priorities[index] = lastPriority;

		return top;
	}
}
