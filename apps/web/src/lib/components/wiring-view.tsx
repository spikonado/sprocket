import '@wokwi/elements';
import type { ElementPin } from '@wokwi/elements';
import { CircleAlert, Cpu, ExternalLink, TriangleAlert } from 'lucide-react';
import { createElement, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createStore, useStore } from '$lib/store';
import {
	analyzeWiring,
	baseName,
	boxGeometry,
	layoutWiring,
	parseWiring,
	pinDirection,
	railY,
	WIRE_COLORS,
	type Endpoint,
	type PartGeometry,
	type PartPin,
	type Point,
	type ResolvedWire,
	type WiringIssue,
	type WiringLayout,
	type WiringPart,
	type WiringSpec
} from '$lib/wiring/wiring';

const WOKWI_SCALE = 1.6;
const RAIL_STUB = 30;
const NO_WIRES_DONE: ReadonlySet<string> = new Set();

const doneWires = createStore<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

type WokwiElement = HTMLElement & { pinInfo?: ElementPin[]; updateComplete?: Promise<unknown> };

function wokwiTag(part: WiringPart) {
	const tag = part.wokwi && `wokwi-${part.wokwi}`;

	return tag && customElements.get(tag) ? tag : undefined;
}

function measureKey(part: WiringPart) {
	return `${part.id}:${part.wokwi}:${JSON.stringify(part.wokwiAttrs ?? {})}`;
}

function wokwiGeometry(element: WokwiElement): PartGeometry {
	return {
		width: element.offsetWidth * WOKWI_SCALE,
		height: element.offsetHeight * WOKWI_SCALE,
		pins: (element.pinInfo ?? []).map((pin) => {
			const power = pin.signals.find((signal) => signal.type === 'power');

			return {
				name: pin.name,
				x: pin.x * WOKWI_SCALE,
				y: pin.y * WOKWI_SCALE,
				...(power?.signal === 'GND'
					? { role: 'ground' as const }
					: power
						? { role: 'power' as const, volts: power.voltage }
						: { role: 'signal' as const })
			};
		})
	};
}

export default function WiringView({ source }: { source: string }) {
	const parsed = useMemo(() => parseWiring(source), [source]);

	if ('error' in parsed) {
		return (
			<div className="my-3">
				<Issues
					issues={[{ level: 'error', message: `This wiring file can't be read. ${parsed.error}` }]}
				/>
			</div>
		);
	}

	return <WiringDiagram source={source} spec={parsed.spec} />;
}

type Step = number | 'all';

function WiringDiagram({ source, spec }: { source: string; spec: WiringSpec }) {
	const [measured, setMeasured] = useState<ReadonlyMap<string, PartGeometry>>(new Map());
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

	const geometry = useMemo(() => {
		const map = new Map<string, PartGeometry>();

		for (const part of spec.parts) {
			const size = wokwiTag(part)
				? measured.get(measureKey(part))
				: part.pins && boxGeometry(part.pins);

			if (size) map.set(part.id, size);
		}

		return map;
	}, [spec, measured]);

	const ready = spec.parts.every((part) => !wokwiTag(part) || measured.has(measureKey(part)));
	const { wires, issues } = useMemo(() => analyzeWiring(spec, geometry), [spec, geometry]);
	const maxRowWidth = frameWidth > 0 ? Math.min(Math.max(frameWidth / 0.75, 480), 1600) : 1200;

	const layout = useMemo(
		() => layoutWiring(spec, geometry, maxRowWidth),
		[spec, geometry, maxRowWidth]
	);

	const scale = frameWidth > 0 ? Math.min(frameWidth / layout.width, 1.25) : 1;

	const touchesFocus = (wire: ResolvedWire) =>
		[wire.from, wire.to].some((end) => end.type === 'pin' && end.part.id === focus);

	const isCurrent = (wire: ResolvedWire) =>
		focus ? touchesFocus(wire) : step === 'all' || wire.step === step;

	const shown = wires.filter((wire) =>
		focus ? touchesFocus(wire) : step === 'all' || wire.step <= step
	);

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
			{ready ? <Issues issues={issues} /> : null}
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
							transform: `scale(${scale})`,
							visibility: ready ? 'visible' : 'hidden'
						}}
					>
						{spec.parts.map((part) => (
							<PartView
								key={measureKey(part)}
								part={part}
								geometry={geometry.get(part.id)}
								position={layout.positions.get(part.id)}
								focused={focus === part.id}
								onMeasure={(size) =>
									setMeasured((current) => new Map(current).set(measureKey(part), size))
								}
								onClick={() => setFocus((current) => (current === part.id ? null : part.id))}
							/>
						))}
						<WireLayer
							spec={spec}
							layout={layout}
							geometry={geometry}
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
	onMeasure,
	onClick
}: {
	part: WiringPart;
	geometry?: PartGeometry;
	position?: Point;
	focused: boolean;
	onMeasure: (geometry: PartGeometry) => void;
	onClick: () => void;
}) {
	const tag = wokwiTag(part);
	const elementRef = useRef<WokwiElement | null>(null);
	const onMeasureRef = useRef(onMeasure);
	onMeasureRef.current = onMeasure;

	useLayoutEffect(() => {
		const element = elementRef.current;

		if (!tag || !element) return;

		let active = true;
		void Promise.resolve(element.updateComplete).then(() => {
			if (active) onMeasureRef.current(wokwiGeometry(element));
		});

		return () => {
			active = false;
		};
	}, [tag]);

	if (!tag && !geometry) return null;

	const ring = focused ? 'outline-primary outline-2 outline-offset-4' : '';

	return (
		<div
			className="absolute cursor-pointer"
			role="button"
			tabIndex={0}
			aria-label={`Show only the wires on ${part.name}`}
			aria-pressed={focused}
			style={{
				left: position?.x ?? 0,
				top: position?.y ?? 0,
				width: geometry?.width,
				height: geometry?.height
			}}
			onClick={onClick}
			onKeyDown={(event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;

				event.preventDefault();
				onClick();
			}}
			title={`${part.name}: click to show only its wires`}
		>
			{tag ? (
				<>
					<div className="text-muted-foreground absolute -top-6 right-0 left-0 truncate text-center text-xs font-medium">
						{part.name}
					</div>
					<div
						className={`w-max origin-top-left rounded-sm ${ring}`}
						style={{ transform: `scale(${WOKWI_SCALE})` }}
					>
						{createElement(tag, {
							ref: elementRef,
							style: { display: 'block' },
							...part.wokwiAttrs
						})}
					</div>
				</>
			) : (
				<BoxPart part={part} geometry={geometry!} className={ring} />
			)}
		</div>
	);
}

function BoxPart({
	part,
	geometry,
	className
}: {
	part: WiringPart;
	geometry: PartGeometry;
	className: string;
}) {
	return (
		<div className={`bg-card relative h-full w-full rounded-lg border shadow-xs ${className}`}>
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

type Anchor = { point: Point; direction: Point; row: number };

function wirePath(a: Anchor, b: Anchor, bounds: { width: number; height: number }) {
	const reach = Math.max(50, Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y) * 0.3);
	const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

	// A Bézier curve stays inside its control points, so clamping them keeps the wire on the canvas.
	const control = ({ point, direction }: Anchor) =>
		`${clamp(point.x + direction.x * reach, bounds.width)} ${clamp(point.y + direction.y * reach, bounds.height)}`;

	return `M${a.point.x} ${a.point.y} C${control(a)} ${control(b)} ${b.point.x} ${b.point.y}`;
}

function WireLayer({
	spec,
	layout,
	geometry,
	wires,
	isCurrent,
	hover,
	onHover
}: {
	spec: WiringSpec;
	layout: WiringLayout;
	geometry: ReadonlyMap<string, PartGeometry>;
	wires: ResolvedWire[];
	isCurrent: (wire: ResolvedWire) => boolean;
	hover: string | null;
	onHover: (key: string | null) => void;
}) {
	const pinAnchor = (part: WiringPart, pin: PartPin): Anchor | undefined => {
		const position = layout.positions.get(part.id);
		const size = geometry.get(part.id);

		if (!position || !size) return;

		return {
			point: { x: position.x + pin.x, y: position.y + pin.y },
			direction: pinDirection(pin, size),
			row: layout.rowOf.get(part.id) ?? 0
		};
	};

	const anchor = (end: Endpoint, other?: Anchor): Anchor | undefined => {
		if (end.type === 'pin') return pinAnchor(end.part, end.pin);

		const row = other?.row ?? 0;
		const y = railY(layout, spec.rails.indexOf(end.rail), row);
		const x = other ? other.point.x + other.direction.x * RAIL_STUB : layout.width / 2;

		return { point: { x, y }, direction: { x: 0, y: -1 }, row };
	};

	const boxPins = spec.parts.flatMap((part) =>
		part.pins && !wokwiTag(part)
			? (geometry.get(part.id)?.pins ?? []).flatMap((pin) => pinAnchor(part, pin) ?? [])
			: []
	);

	return (
		<svg
			className="pointer-events-none absolute inset-0 overflow-visible"
			width={layout.width}
			height={layout.height}
		>
			{spec.rails.map((rail, index) => {
				const x = 16 + index * 8;
				const color = rail.volts === 0 ? WIRE_COLORS.black : WIRE_COLORS.red;
				const ys = layout.railBands.map((_, row) => railY(layout, index, row));

				const segments = [
					...ys.map((y) => [x, y, layout.width - 16, y]),
					[x, ys[0], x, ys.at(-1) ?? ys[0]]
				];

				return (
					<g key={rail.id}>
						{(
							[
								['var(--muted-foreground)', 5],
								[color, 3]
							] as const
						).map(([stroke, width]) =>
							segments.map(([x1, y1, x2, y2]) => (
								<line
									key={`${stroke}:${x1}:${y1}:${x2}:${y2}`}
									x1={x1}
									y1={y1}
									x2={x2}
									y2={y2}
									stroke={stroke}
									strokeWidth={width}
									strokeLinecap="round"
								/>
							))
						)}
						{ys.map((y) => (
							<text
								key={y}
								x={layout.width - 20}
								y={y - 5}
								fontSize={11}
								textAnchor="end"
								fill="var(--muted-foreground)"
							>
								{rail.id} {rail.volts === 0 ? '(ground)' : `(${rail.volts} V)`}
							</text>
						))}
					</g>
				);
			})}
			{boxPins.map(({ point }) => (
				<circle
					key={`${point.x}:${point.y}`}
					cx={point.x}
					cy={point.y}
					r={4}
					fill="var(--muted-foreground)"
				/>
			))}
			{wires.map((wire) => {
				const fromPin = wire.from.type === 'pin' ? anchor(wire.from) : undefined;
				const toPin = wire.to.type === 'pin' ? anchor(wire.to) : undefined;
				const a = fromPin ?? anchor(wire.from, toPin);
				const b = toPin ?? anchor(wire.to, fromPin);

				if (!a || !b) return null;

				const d = wirePath(a, b, layout);
				const current = isCurrent(wire);
				const opacity = !current ? 0.15 : hover && hover !== wire.key ? 0.35 : 1;
				const width = hover === wire.key ? 7 : 4.5;

				return (
					<g key={wire.key} opacity={opacity}>
						<path d={d} fill="none" stroke="var(--muted-foreground)" strokeWidth={width + 2} />
						<path d={d} fill="none" stroke={wire.color} strokeWidth={width} strokeLinecap="round" />
						{[a, b].map(({ point }) => (
							<circle
								key={`${point.x}:${point.y}`}
								cx={point.x}
								cy={point.y}
								r={4.5}
								fill={wire.color}
								stroke="var(--muted-foreground)"
							/>
						))}
						{current
							? (
									[
										[wire.from, a],
										[wire.to, b]
									] as const
								).map(([end, at]) =>
									end.type === 'pin' && wokwiTag(end.part) ? (
										<PinLabel key={end.label} anchor={at} text={baseName(end.pin.name)} />
									) : null
								)
							: null}
						<path
							d={d}
							fill="none"
							stroke="transparent"
							strokeWidth={16}
							className="cursor-pointer"
							style={{ pointerEvents: 'stroke' }}
							onMouseEnter={() => onHover(wire.key)}
							onMouseLeave={() => onHover(null)}
						/>
					</g>
				);
			})}
		</svg>
	);
}

function PinLabel({ anchor, text }: { anchor: Anchor; text: string }) {
	const { point, direction } = anchor;
	const x = point.x + direction.x * 12 + (direction.x === 0 ? 10 : 0);
	const y = point.y + direction.y * 14 + (direction.y === 0 ? -8 : direction.y > 0 ? 8 : 0);

	return (
		<text
			x={x}
			y={y}
			fontSize={12}
			fontFamily="var(--font-mono)"
			fontWeight={600}
			textAnchor={direction.x < 0 ? 'end' : 'start'}
			fill="var(--foreground)"
			stroke="var(--background)"
			strokeWidth={3}
			paintOrder="stroke"
		>
			{text}
		</text>
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
