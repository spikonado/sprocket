import { CircleAlert, Cpu, ExternalLink, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createStore, useStore } from '$lib/store';
import { layoutWiring, wrapRows, type WireRoute, type WiringLayout } from '$lib/wiring/layout';
import type { Point } from '$lib/wiring/route';
import {
	analyzeWiring,
	parseWiring,
	wiringGeometry,
	WIRE_COLORS,
	type PartGeometry,
	type ResolvedWire,
	type WiringIssue,
	type WiringPart,
	type WiringSpec
} from '@convex/lib/wiring';

const NO_WIRES_DONE: ReadonlySet<string> = new Set();

const doneWires = createStore<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

export default function WiringView({ source }: { source: string }) {
	const parsed = useMemo(() => parseWiring(source), [source]);

	if ('error' in parsed) {
		return (
			<div className="my-3">
				<Issues issues={[{ level: 'error', message: parsed.error }]} />
			</div>
		);
	}

	return <WiringDiagram source={source} spec={parsed.spec} />;
}

type Step = number | 'all';

function WiringDiagram({ source, spec }: { source: string; spec: WiringSpec }) {
	const [step, setStep] = useState<Step>(0);
	const [focus, setFocus] = useState<string | null>(null);
	const [hover, setHover] = useState<string | null>(null);
	const done = useStore(doneWires).get(source) ?? NO_WIRES_DONE;
	const frameRef = useRef<HTMLDivElement | null>(null);
	const [frameWidth, setFrameWidth] = useState(0);

	useLayoutEffect(() => {
		const frame = frameRef.current;

		if (!frame) return;

		const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
		observer.observe(frame);

		return () => observer.disconnect();
	}, []);

	const geometry = useMemo(() => wiringGeometry(spec), [spec]);
	const { wires, issues } = useMemo(() => analyzeWiring(spec, geometry), [spec, geometry]);
	const maxRowWidth = frameWidth > 0 ? Math.min(Math.max(frameWidth / 0.75, 480), 1600) : 1200;
	const rowsKey = wrapRows(spec, geometry, maxRowWidth).join(',');

	const layout = useMemo(
		() => layoutWiring(spec, geometry, wires, rowsKey.split(',').map(Number)),
		[spec, geometry, wires, rowsKey]
	);

	const overlapping = [...layout.routes.values()].filter((route) => route.overlaps).length;

	const allIssues: WiringIssue[] =
		overlapping > 0
			? [
					...issues,
					{
						level: 'warning',
						message: `${overlapping} wires had no free path, so they're drawn as dashed straight lines. Use the checklist for those.`
					}
				]
			: issues;

	const scale = frameWidth > 0 ? Math.min(frameWidth / layout.width, 1.25) : 1;

	const touchesFocus = (wire: ResolvedWire) =>
		[wire.from, wire.to].some((end) => end.type === 'pin' && end.part.id === focus);

	const isCurrent = (wire: ResolvedWire) =>
		focus ? touchesFocus(wire) : step === 'all' || wire.step === step;

	const shownKeys = new Set(
		wires
			.filter((wire) => (focus ? touchesFocus(wire) : step === 'all' || wire.step <= step))
			.map((wire) => wire.key)
	);

	for (const key of shownKeys) {
		for (const joined of layout.routes.get(key)?.joins ?? []) shownKeys.add(joined);
	}

	const shown = wires.filter((wire) => shownKeys.has(wire.key));

	const rows = shown.filter(isCurrent);
	const hovered = wires.find((wire) => wire.key === hover);
	const focusedPart = spec.parts.find((part) => part.id === focus);
	const currentStep = step === 'all' ? undefined : spec.steps[step];

	const caption = hovered
		? `${hovered.from.label} → ${hovered.to.label}${hovered.why ? ` · ${hovered.why}` : ''}`
		: focusedPart
			? `Showing every wire on ${focusedPart.name}. Click it again to go back to the steps.`
			: (currentStep?.note ?? (step === 'all' ? 'Every wire in the build.' : ''));

	const toggleDone = (key: string) =>
		doneWires.update((current) => {
			const next = new Set(current.get(source));

			if (!next.delete(key)) next.add(key);

			return new Map(current).set(source, next);
		});

	const stepButton = (value: Step, label: string) => (
		<button
			key={label}
			type="button"
			className={`rounded-md border px-2.5 py-1 text-xs transition ${
				step === value && !focus
					? 'border-primary bg-primary text-primary-foreground'
					: 'text-foreground hover:bg-muted'
			}`}
			onClick={() => {
				setFocus(null);
				setStep(value);
			}}
		>
			{label}
		</button>
	);

	return (
		<div className="text-foreground my-3 flex flex-col gap-3 text-sm">
			{spec.title ? <h3 className="text-base font-medium">{spec.title}</h3> : null}
			<Issues issues={allIssues} />
			<div className="flex flex-wrap gap-1.5">
				{spec.steps.map((item, index) => stepButton(index, `${index + 1}. ${item.title}`))}
				{stepButton('all', 'Show all')}
			</div>
			<p className="text-muted-foreground min-h-5 text-[13px]">{caption}</p>
			<div ref={frameRef} className="bg-muted/40 overflow-hidden rounded-lg border">
				<div style={{ height: layout.height * scale }}>
					<div
						className="relative origin-top-left"
						style={{
							width: layout.width,
							height: layout.height,
							transform: `scale(${scale})`
						}}
					>
						{spec.parts.map((part) => (
							<PartView
								key={part.id}
								part={part}
								geometry={geometry.get(part.id)}
								position={layout.positions.get(part.id)}
								focused={focus === part.id}
								onClick={() => setFocus((current) => (current === part.id ? null : part.id))}
							/>
						))}
						<WireLayer
							spec={spec}
							geometry={geometry}
							layout={layout}
							wires={shown}
							isCurrent={isCurrent}
							hover={hover}
							onHover={setHover}
						/>
					</div>
				</div>
			</div>
			<div className="flex flex-col gap-0.5">
				<p className="text-muted-foreground text-xs">
					{rows.filter((wire) => done.has(wire.key)).length} of {rows.length} wires done
				</p>
				{rows.map((wire) => (
					<label
						key={wire.key}
						className={`flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 ${
							hover === wire.key ? 'bg-accent' : ''
						} ${done.has(wire.key) ? 'opacity-50' : ''}`}
						onMouseEnter={() => setHover(wire.key)}
						onMouseLeave={() => setHover(null)}
					>
						<input
							type="checkbox"
							className="mt-1"
							checked={done.has(wire.key)}
							onChange={() => toggleDone(wire.key)}
						/>
						<span
							className="mt-2 h-1.5 w-6 shrink-0 rounded-full border"
							style={{ background: wire.color }}
						/>
						<span className="flex min-w-0 flex-wrap gap-x-4">
							<span className={`font-mono text-[13px] ${done.has(wire.key) ? 'line-through' : ''}`}>
								{wire.from.label} → {wire.to.label}
							</span>
							{wire.why ? <span className="text-muted-foreground">{wire.why}</span> : null}
						</span>
					</label>
				))}
			</div>
			<PartsList parts={spec.parts} />
		</div>
	);
}

function Issues({ issues }: { issues: WiringIssue[] }) {
	if (issues.length === 0) return null;

	return (
		<ul className="flex flex-col gap-1">
			{issues.map((issue) => {
				const Icon = issue.level === 'error' ? CircleAlert : TriangleAlert;

				return (
					<li
						key={issue.message}
						className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] ${
							issue.level === 'error'
								? 'border-destructive/40 text-destructive'
								: 'border-amber-500/40 text-amber-800 dark:text-amber-200'
						}`}
					>
						<Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{issue.message}
					</li>
				);
			})}
		</ul>
	);
}

function PartView({
	part,
	geometry,
	position,
	focused,
	onClick
}: {
	part: WiringPart;
	geometry?: PartGeometry;
	position?: Point;
	focused: boolean;
	onClick: () => void;
}) {
	if (!geometry || !position) return null;

	return (
		<div
			className={`bg-card absolute cursor-pointer rounded-lg border shadow-xs ${
				focused ? 'outline-primary outline-2 outline-offset-4' : ''
			}`}
			role="button"
			tabIndex={0}
			aria-label={`Show only the wires on ${part.name}`}
			aria-pressed={focused}
			style={{
				left: position.x,
				top: position.y,
				width: geometry.width,
				height: geometry.height
			}}
			onClick={onClick}
			onKeyDown={(event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;

				event.preventDefault();
				onClick();
			}}
			title={`${part.name}: click to show only its wires`}
		>
			<div className="truncate px-3 pt-3 text-center text-[13px] font-medium">{part.name}</div>
			{geometry.pins.map((pin) => (
				<span
					key={`${pin.x}:${pin.name}`}
					className="text-muted-foreground absolute font-mono text-[11px] leading-none"
					style={{
						top: pin.y - 5,
						...(pin.x === 0 ? { left: 10 } : { right: 10 })
					}}
				>
					{pin.name}
				</span>
			))}
		</div>
	);
}

const CORNER_RADIUS = 5;

function routePath(points: Point[]) {
	const [first, ...rest] = points;
	let d = `M${first.x} ${first.y}`;

	rest.forEach((point, index) => {
		const after = rest[index + 1];
		const before = points[index];

		if (!after) {
			d += ` L${point.x} ${point.y}`;

			return;
		}

		const radius = Math.min(
			CORNER_RADIUS,
			Math.hypot(point.x - before.x, point.y - before.y) / 2,
			Math.hypot(after.x - point.x, after.y - point.y) / 2
		);

		const toward = (target: Point) => {
			const length = Math.hypot(target.x - point.x, target.y - point.y) || 1;

			return {
				x: point.x + ((target.x - point.x) / length) * radius,
				y: point.y + ((target.y - point.y) / length) * radius
			};
		};

		const start = toward(before);
		const end = toward(after);
		d += ` L${start.x} ${start.y} Q${point.x} ${point.y} ${end.x} ${end.y}`;
	});

	return d;
}

function WireLayer({
	spec,
	geometry,
	layout,
	wires,
	isCurrent,
	hover,
	onHover
}: {
	spec: WiringSpec;
	geometry: ReadonlyMap<string, PartGeometry>;
	layout: WiringLayout;
	wires: ResolvedWire[];
	isCurrent: (wire: ResolvedWire) => boolean;
	hover: string | null;
	onHover: (key: string | null) => void;
}) {
	const boxPins = [...layout.positions].flatMap(([id, position]) => {
		const size = geometry.get(id);

		return size?.pins.map((pin) => ({ x: position.x + pin.x, y: position.y + pin.y })) ?? [];
	});

	const ordered = wires
		.flatMap((wire) => {
			const route = layout.routes.get(wire.key);

			return route ? [{ wire, route, current: isCurrent(wire) }] : [];
		})
		.toSorted(
			(a, b) =>
				Number(a.current) - Number(b.current) ||
				Number(a.wire.key === hover) - Number(b.wire.key === hover)
		);

	return (
		<svg
			className="pointer-events-none absolute inset-0 overflow-visible"
			width={layout.width}
			height={layout.height}
		>
			{layout.rails.map(({ rail: index, segments, labels }) => {
				const rail = spec.rails[index];
				const color = rail.volts === 0 ? WIRE_COLORS.black : WIRE_COLORS.red;

				return (
					<g key={rail.id}>
						{(
							[
								['var(--muted-foreground)', 5],
								[color, 3]
							] as const
						).map(([stroke, width]) =>
							segments.map(([a, b]) => (
								<line
									key={`${stroke}:${a.x}:${a.y}:${b.x}:${b.y}`}
									x1={a.x}
									y1={a.y}
									x2={b.x}
									y2={b.y}
									stroke={stroke}
									strokeWidth={width}
									strokeLinecap="round"
								/>
							))
						)}
						{labels.map((label) => (
							<text
								key={label.y}
								x={label.x}
								y={label.y}
								fontSize={11}
								dominantBaseline="central"
								fill="var(--muted-foreground)"
							>
								{rail.id} {rail.volts === 0 ? '(ground)' : `(${rail.volts} V)`}
							</text>
						))}
					</g>
				);
			})}
			{boxPins.map((point) => (
				<circle
					key={`${point.x}:${point.y}`}
					cx={point.x}
					cy={point.y}
					r={4}
					fill="var(--muted-foreground)"
				/>
			))}
			{ordered.map(({ wire, route, current }) => (
				<Wire
					key={wire.key}
					wire={wire}
					route={route}
					current={current}
					hover={hover}
					onHover={onHover}
				/>
			))}
		</svg>
	);
}

function Wire({
	wire,
	route,
	current,
	hover,
	onHover
}: {
	wire: ResolvedWire;
	route: WireRoute;
	current: boolean;
	hover: string | null;
	onHover: (key: string | null) => void;
}) {
	const d = routePath(route.points);
	const opacity = !current ? 0.15 : hover && hover !== wire.key ? 0.35 : 1;
	const width = hover === wire.key ? 6 : 3.5;
	const dash = route.overlaps ? '8 6' : undefined;
	const ends = [route.points[0], route.points.at(-1) ?? route.points[0]];

	return (
		<g opacity={opacity}>
			<path
				d={d}
				fill="none"
				stroke="var(--muted-foreground)"
				strokeWidth={width + 2}
				strokeDasharray={dash}
				strokeLinejoin="round"
			/>
			<path
				d={d}
				fill="none"
				stroke={wire.color}
				strokeWidth={width}
				strokeDasharray={dash}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{ends.map((point) => (
				<circle
					key={`${point.x}:${point.y}`}
					cx={point.x}
					cy={point.y}
					r={4}
					fill={wire.color}
					stroke="var(--muted-foreground)"
				/>
			))}
			<path
				d={d}
				fill="none"
				stroke="transparent"
				strokeWidth={10}
				className="cursor-pointer"
				style={{ pointerEvents: 'stroke' }}
				onMouseEnter={() => onHover(wire.key)}
				onMouseLeave={() => onHover(null)}
			/>
		</g>
	);
}

function PartsList({ parts }: { parts: WiringPart[] }) {
	return (
		<div className="flex flex-col gap-2">
			<h4 className="text-muted-foreground text-xs font-medium">Parts</h4>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
				{parts.map((part) => (
					<div key={part.id} className="flex items-center gap-3 rounded-lg border p-2">
						{part.photo ? (
							<img
								src={part.photo}
								alt={part.name}
								referrerPolicy="no-referrer"
								className="size-14 shrink-0 rounded-md border bg-white object-contain"
							/>
						) : (
							<div className="bg-muted flex size-14 shrink-0 items-center justify-center rounded-md border">
								<Cpu className="text-muted-foreground size-5" aria-hidden="true" />
							</div>
						)}
						<div className="flex min-w-0 flex-col gap-1">
							<span className="truncate">{part.name}</span>
							{part.link ? (
								<a
									href={part.link}
									target="_blank"
									rel="noopener noreferrer"
									className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
								>
									Where to buy
									<ExternalLink className="size-3" aria-hidden="true" />
								</a>
							) : null}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
