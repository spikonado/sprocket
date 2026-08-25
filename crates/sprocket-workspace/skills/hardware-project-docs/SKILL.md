---
name: hardware-project-docs
description: 'Guide on producing the following docs for a hardware project: rendered schematic sheet, pin maps, BOM, and design notes.'
---

This skill is not an electronics-design course.
Circuit facts should come from current datasheets and/or supplier descriptions, not from memory.
Check with `scrape_url` / `web_search`.

## The doc set

All documents should stay in sync. Always.

Should be created as `$artifacts` and project files.

1. **BOM** - Markdown
2. **Pin map (per MCU, if using any)** - Markdown
3. **Schematic sheet** - React artifact
4. **Assembly notes** - Markdown

One schematic change means checking all four. Net names are the glue: the same
name appears on the sheet, in the pin map, and in the notes.

## Creating the BOM

All the parts should be listed in a tabular format along with their datasheet (if any), quantity, price, links to buy, and any relevant notes on why the part is needed.
Ask which parts the user has (or wants) before conducting your own research.
Don't directly use an IC or similar. It's recommended to use its breakout board or similar instead.
Prefer going with boards which have headers pre-soldered, unless asked otherwise.
Research the web for the parts you need for the project, look for the cheapest options which will fit the project's requirements well. Don't make price the sole factor while researching parts, their quality and ease of use also matters.
Try to find parts from local suppliers that are from the user's state/country. Ex. if the user lives in India, don't immediately go to US stores like Adafruit, Sparkfun, Digikey, etc to find parts.
Before deciding to go with a particular supplier, always read online reviews for that supplier from other buyers to ensure the store isn't fraudulent.
Always go through relevant supplier descriptions, datasheet, and other specs before deciding on a part.

## Creating the pin map

Should be a markdown table.
One row per net; gotcha rows for input-only and boot-strapping pins of the specific MCU.
Net names should be consistent across them.

## Creating the schematic

The artifact is a React component (App) whose output is a single <svg viewBox="0 0 1500 720"> element containing all the schematic geometry.
Start from the below sample schematic. It's a verified, collision-checked artifact that implements every convention below; copy its structure and scale it.

```jsx
function App() {
	const W = 1500,
		H = 720;
	const C = {
		wire: '#46525f',
		sig: '#2e86e0',
		pwr: '#e5484d',
		gnd: '#30a46c',
		box: '#1c1e21',
		mech: '#8b95a1',
		stby: '#8e5cd0',
		pin: '#edf1f5', // pin names on dark boxes
		pinOn: '#5f6b78' // pin names on the light sheet background
	};

	const dots = [];
	for (let gx = 25; gx < W; gx += 25)
		for (let gy = 25; gy < H; gy += 25)
			dots.push(<circle key={`${gx}-${gy}`} cx={gx} cy={gy} r={0.8} fill="#e6ebf1" />);

	const Txt = ({ x, y, size = 12, color = C.box, bold = false, anchor, mono = true, children }) => (
		<text
			x={x}
			y={y}
			fontSize={size}
			fill={color}
			textAnchor={anchor}
			fontWeight={bold ? 'bold' : 'normal'}
			fontFamily={mono ? 'Consolas, Menlo, monospace' : 'Inter, Arial, sans-serif'}
		>
			{children}
		</text>
	);

	const Box = ({ x, y, w, h, fill, edge }) => (
		<rect x={x} y={y} width={w} height={h} fill={fill} stroke={edge} strokeWidth={1.8} rx={7} />
	);

	const Zone = ({ x, y, dark, title, sub }) => (
		<g>
			<Txt x={x} y={y} size={14} color={dark ? '#eef1f4' : C.box} bold anchor="middle" mono={false}>
				{title}
			</Txt>
			{sub && (
				<Txt
					x={x}
					y={y + 16}
					size={11}
					color={dark ? '#cdd7e0' : '#5b6570'}
					anchor="middle"
					mono={false}
				>
					{sub}
				</Txt>
			)}
		</g>
	);

	// Pin name inside the box, net name on the stub outside.
	const Pin = ({ x, y, side, pinName, net, color = C.sig }) => {
		const sx = side === 'R' ? x + 20 : x - 20;
		const tx = side === 'R' ? sx + 5 : sx - 5;
		return (
			<g>
				{pinName && (
					<Txt
						x={side === 'R' ? x - 6 : x + 6}
						y={y + 4}
						size={10}
						color={C.pin}
						anchor={side === 'R' ? 'end' : 'start'}
					>
						{pinName}
					</Txt>
				)}
				<line x1={x} y1={y} x2={sx} y2={y} stroke={C.wire} strokeWidth={1.6} />
				<Txt
					x={side === 'R' ? tx : tx}
					y={y + 4}
					color={color}
					bold
					anchor={side === 'R' ? 'start' : 'end'}
				>
					{net}
				</Txt>
			</g>
		);
	};

	const Gnd = ({ x, y, dir }) =>
		dir === 'D' ? (
			<g stroke={C.gnd} strokeWidth={2}>
				<line x1={x} y1={y} x2={x} y2={y + 8} strokeWidth={1.6} />
				<line x1={x - 8} y1={y + 8} x2={x + 8} y2={y + 8} />
				<line x1={x - 5} y1={y + 12} x2={x + 5} y2={y + 12} />
				<line x1={x - 2} y1={y + 16} x2={x + 2} y2={y + 16} />
			</g>
		) : (
			<g stroke={C.gnd} strokeWidth={2}>
				<line x1={x} y1={y} x2={x - 6} y2={y} strokeWidth={1.6} />
				<line x1={x - 6} y1={y - 8} x2={x - 6} y2={y + 8} />
				<line x1={x - 10} y1={y - 5} x2={x - 10} y2={y + 5} />
				<line x1={x - 14} y1={y - 2} x2={x - 14} y2={y + 2} />
			</g>
		);

	const Wire = (x1, y1, x2, y2, color = C.wire, w = 1.6) => (
		<line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={w} strokeLinecap="round" />
	);

	// real-hardware colours
	const F = {
		power: '#e0483f',
		powerEdge: '#a83228', // red LiPo pack
		buck: '#2a6db0',
		buckEdge: '#1a4d80', // blue buck PCB
		mcu: '#23272c',
		mcuEdge: '#4a5058', // black dev kit
		drv: '#4d7f4a',
		drvEdge: '#35592f', // green driver breakout
		motor: '#d3d8dc',
		motorEdge: '#8f979e', // silver gearmotor
		enc: '#20419a',
		encEdge: '#152c6b', // blue encoder PCB
		legend: '#ffffff'
	};

	const mcu = { x: 480, y: 210, w: 300, h: 380 };
	const mcuRight = [
		['GPIO25', 'M1_PWM'],
		['GPIO26', 'M1_IN1'],
		['GPIO27', 'M1_IN2'],
		['GPIO14', 'M2_PWM'],
		['GPIO12', 'M2_IN1'],
		['GPIO13', 'M2_IN2'],
		['GPIO4', 'STBY']
	];
	const encPins = [
		['G34', 'E1A'],
		['G35', 'E1B'],
		['G32', 'E2A'],
		['G33', 'E2B']
	];

	const Driver = ({ x, y, name, mA, mB }) => {
		const leftPins = [
			['VM', 'VM', C.pwr],
			['VCC', '+5V', C.pwr],
			['GND', null],
			['STBY', 'STBY', C.stby],
			['PWMA', mA + '_PWM'],
			['AIN1', mA + '_IN1'],
			['AIN2', mA + '_IN2'],
			['PWMB', mB + '_PWM'],
			['BIN1', mB + '_IN1'],
			['BIN2', mB + '_IN2']
		];
		const outs = [
			['AO1', y + 70],
			['AO2', y + 110],
			['BO1', y + 250],
			['BO2', y + 290]
		];
		return (
			<g>
				<Box x={x} y={y} w={250} h={330} fill={F.drv} edge={F.drvEdge} />
				<Zone x={x + 125} y={y + 22} dark title={name} sub="dual H-bridge" />
				{leftPins.map((p, i) => {
					const py = y + 50 + i * 29;
					return !p[1] ? (
						<g key={p[0]}>
							<Txt x={x + 6} y={py + 4} size={10} color={C.pin} anchor="start">
								GND
							</Txt>
							{Wire(x, py, x - 20, py)}
							<Gnd x={x - 20} y={py} dir="L" />
						</g>
					) : (
						<Pin key={p[0]} x={x} y={py} side="L" pinName={p[0]} net={p[1]} color={p[2] || C.sig} />
					);
				})}
				{outs.map((o) => (
					<g key={o[0]}>
						<Txt x={x + 244} y={o[1] + 4} size={10} color={C.pin} anchor="end">
							{o[0]}
						</Txt>
						{Wire(x + 250, o[1], x + 272, o[1])}
					</g>
				))}
			</g>
		);
	};
	const d1 = { x: 950, ao1: 210, ao2: 250, bo1: 390, bo2: 430 };

	// Each motor draws exactly its own two wires from its driver channel.
	// pinA height equals the M+ terminal height (straight run); pinB drops
	// with one jog, clear of the encoder box below.
	const Motor = ({ cx, cy, name, enc, drv, pinA, pinB }) => {
		const t1y = cy - 10,
			t2y = cy + 10,
			tx = cx - 24;
		const eb = { x: cx - 60, y: cy + 42, w: 120, h: 84 };
		const lane = drv.x + 272;
		return (
			<g>
				{Wire(lane, pinA, tx, pinA)}
				{Wire(lane, pinB, tx - 28, pinB)}
				{Wire(tx - 28, pinB, tx - 28, t2y)}
				{Wire(tx - 28, t2y, tx, t2y)}
				<circle cx={tx} cy={t1y} r={2.5} fill={C.wire} />
				<circle cx={tx} cy={t2y} r={2.5} fill={C.wire} />
				<Txt x={tx - 6} y={t1y + 3} size={9} color={C.pinOn} anchor="end">
					M+
				</Txt>
				<Txt x={tx - 6} y={t2y + 3} size={9} color={C.pinOn} anchor="end">
					M−
				</Txt>
				<circle cx={cx} cy={cy} r={24} fill={F.motor} stroke={F.motorEdge} strokeWidth={2} />
				<Txt x={cx} y={cy + 6} size={18} bold anchor="middle">
					M
				</Txt>
				<Txt x={cx} y={cy - 32} size={13} bold anchor="middle" mono={false}>
					{name}
				</Txt>
				<line
					x1={cx}
					y1={cy + 24}
					x2={cx}
					y2={eb.y}
					stroke={C.mech}
					strokeWidth={1.5}
					strokeDasharray="5 4"
				/>
				<rect
					x={eb.x}
					y={eb.y}
					width={eb.w}
					height={eb.h}
					fill={F.enc}
					stroke={F.encEdge}
					strokeWidth={1.6}
					rx={7}
				/>
				<Zone x={eb.x + eb.w / 2} y={eb.y + 18} dark title={enc} />
				<Pin x={eb.x} y={eb.y + 48} side="L" pinName="VCC" net="+5V" color={C.pwr} />
				<Txt x={eb.x + 6} y={eb.y + 68} size={10} color={C.pin} anchor="start">
					GND
				</Txt>
				{Wire(eb.x, eb.y + 64, eb.x - 20, eb.y + 64)}
				<Gnd x={eb.x - 20} y={eb.y + 64} dir="L" />
				<Pin x={eb.x} y={eb.y + 80} side="L" pinName="A" net={name + 'A'} />
				<Pin x={eb.x + eb.w} y={eb.y + 80} side="R" pinName="B" net={name + 'B'} />
			</g>
		);
	};

	return (
		<div
			style={{
				fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
				background: '#f1f4f8',
				minHeight: '100vh',
				color: C.box
			}}
		>
			<header style={{ padding: '18px 28px 6px' }}>
				<h1 style={{ margin: '0 0 4px', fontSize: 20 }}>
					Sample — 2× DC Gearmotor with Quadrature Encoders
				</h1>
				<p style={{ margin: 0, color: '#555', fontSize: 13 }}>
					Pin names inside components; nets with matching labels are connected.
				</p>
			</header>
			<div
				style={{
					background: '#fafcfd',
					margin: '14px 28px 28px',
					border: '1px solid #dde3ea',
					borderRadius: 10,
					overflowX: 'auto',
					boxShadow: '0 1px 4px rgba(30,40,60,.08)'
				}}
			>
				<svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 1100, display: 'block' }}>
					{dots}

					{/* power entry */}
					<Box x={60} y={150} w={160} h={90} fill={F.power} edge={F.powerEdge} />
					<Zone x={140} y={172} dark title="BT1" sub="3S LiPo 11.1 V" />
					{Wire(220, 172, 265, 172, C.pwr)}
					<circle cx={268} cy={172} r={2.5} fill={C.wire} />
					<circle cx={300} cy={172} r={2.5} fill={C.wire} />
					{Wire(268, 172, 296, 158)}
					{Wire(300, 172, 330, 172, C.pwr)}
					<Txt x={284} y={150} size={11} color="#39424c" anchor="middle">
						S1
					</Txt>
					{Wire(300, 172, 420, 172, C.pwr)}
					<Pin x={420} y={172} side="R" net="VM (11.1 V)" color={C.pwr} />
					{Wire(220, 218, 250, 218)}
					<Gnd x={250} y={218} dir="D" />

					{/* buck */}
					<Box x={60} y={380} w={210} h={110} fill={F.buck} edge={F.buckEdge} />
					<Zone x={165} y={402} dark title="U4 · LM2596 BUCK" sub="11.1 V → 5.0 V" />
					<Pin x={60} y={430} side="L" pinName="VIN" net="VM" color={C.pwr} />
					<Txt x={66} y={469} size={10} color={C.pin} anchor="start">
						GND
					</Txt>
					<Gnd x={60} y={465} dir="L" />
					<Pin x={270} y={430} side="R" pinName="VOUT" net="+5V" color={C.pwr} />

					{/* legend */}
					<Box x={60} y={560} w={330} h={120} fill={F.legend} edge="#dde3ea" />
					<Zone x={225} y={582} title="LEGEND" />
					{Wire(80, 600, 120, 600, C.pwr, 2.5)}
					<Txt x={130} y={604} size={11} mono={false}>
						power rail
					</Txt>
					{Wire(80, 625, 120, 625, C.sig, 2.5)}
					<Txt x={130} y={629} size={11} mono={false}>
						signal net
					</Txt>
					<Gnd x={95} y={650} dir="D" />
					<Txt x={130} y={657} size={11} mono={false}>
						common ground
					</Txt>

					{/* MCU */}
					<Box x={mcu.x} y={mcu.y} w={mcu.w} h={mcu.h} fill={F.mcu} edge={F.mcuEdge} />
					<Zone
						x={mcu.x + mcu.w / 2}
						y={mcu.y + 22}
						dark
						title="U1 · ESP32 DEVKIT"
						sub="3.3 V logic"
					/>
					<Pin x={mcu.x} y={300} side="L" pinName="5V" net="+5V" color={C.pwr} />
					<Txt x={mcu.x + 6} y={354} size={10} color={C.pin} anchor="start">
						GND
					</Txt>
					<Gnd x={mcu.x} y={350} dir="L" />
					{mcuRight.map((p, i) => (
						<Pin
							key={p[1]}
							x={mcu.x + mcu.w}
							y={250 + i * 34}
							side="R"
							pinName={p[0]}
							net={p[1]}
							color={p[1] === 'STBY' ? C.stby : C.sig}
						/>
					))}
					{/* encoder inputs — lower left edge of the same U1 symbol */}
					<Txt x={mcu.x + 10} y={470} size={10} color="#aeb6c0" anchor="start" mono={false}>
						ENCODER INPUTS · PCNT
					</Txt>
					{encPins.map((p, i) => (
						<Pin key={p[0]} x={mcu.x} y={500 + i * 26} side="L" pinName={p[0]} net={p[1]} />
					))}

					{/* driver + motors */}
					<Driver x={950} y={140} name="U2 · TB6612FNG" mA="M1" mB="M2" />
					<Motor cx={1360} cy={220} name="M1" enc="ENC1" drv={d1} pinA={d1.ao1} pinB={d1.ao2} />
					<Motor cx={1360} cy={400} name="M2" enc="ENC2" drv={d1} pinA={d1.bo1} pinB={d1.bo2} />
				</svg>
			</div>
		</div>
	);
}
```

### Schematic sheet conventions

These are what make the sheet read like a CAD schematic rather than a diagram.

- **Pin names inside, net names outside.** Inside each component box, small text at the pin edge carries the component's own pin name (`GPIO25`, `PWMA`, `VIN`); the wire stub outside carries only the net name (`M1_PWM`, `VM`). Never annotate the same fact twice.
- **Label-based wiring.** Connect blocks with matched net labels on short stubs; the only long routed wires are tight physical runs (driver → motor terminals). Power rails are labeled taps (`VM`, `+5V`), never drawn end-to-end. Ground is a ground symbol, one per pin, all common.
- **Real-hardware fills.** Components take the colour of the physical part.
- **Two label colours.** Near-white (`#edf1f5`) for pin names on dark boxes; dark slate (`#5f6b78`) for labels on the light sheet background. A single "bright" colour fails one of the two.
- **Zone the sheet** left-to-right in signal order (e.g. power entry → regulation → MCU → drivers → actuators), generous gutters, dotted grid, small legend, soft page background. No title blocks, no rotated text for pin groups. If a pin group would be cramped on its edge, the box is too small; grow the box and give the group an internal section caption.
- **Sheet height fits content.** After a layout change, re-check that the last pin sits inside its box and labels clear neighbouring boxes. The two bugs this catches (pin overflow, label collision) are invisible without running the numbers.

### Verifying geometry

Don't eyeball coordinates:

- Model every wire segment and component box in a quick script and check for wire-enters-box collisions, label overlap, and pins outside their box.
- If a browser is available, render a screenshot and inspect it. Fix and re-check until zero collisions.
- Completion criterion: the collision script reports zero, not "looks right".

## Creating the assembly notes

Include the following, if needed:

- Tips related to power
- Wiring tips
- Uploading code

## Final response to the user

In your response don't include the nitty-gritty details of how you made the artifacts, etc.
Tell the user more about the project and design decisions.
Tell the user about what files and artifacts you wrote, and how they can view the artifacts (right sidebar in the Sprocket UI).
