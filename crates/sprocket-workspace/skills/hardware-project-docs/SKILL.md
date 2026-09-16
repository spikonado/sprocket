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

The artifact is a React component `App` that returns one `<svg>` containing all schematic geometry and styles. The sample uses `viewBox="0 0 1500 800"`; adjust the dimensions to fit the content.
Start from the sample below. Preserve its plain white, grid-free sheet and component styling, adapt the circuit to the project's parts, then verify the geometry before delivery.

```jsx
function App() {
	const W = 1500,
		H = 800;
	const C = {
		wire: '#46525f',
		sig: '#2e86e0',
		pwr: '#e5484d',
		gnd: '#30a46c',
		box: '#1c1e21',
		stby: '#8e5cd0',
		pin: '#edf1f5',
		pinOn: '#5f6b78'
	};
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
	const Zone = ({ x, y, dark, title, sub, subOffset = 16 }) => (
		<g>
			<Txt x={x} y={y} size={14} color={dark ? '#eef1f4' : C.box} bold anchor="middle" mono={false}>
				{title}
			</Txt>
			{sub && (
				<Txt
					x={x}
					y={y + subOffset}
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
				<Txt x={tx} y={y + 4} color={color} bold anchor={side === 'R' ? 'start' : 'end'}>
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
	const F = {
		batt: '#e0483f',
		battEdge: '#a83228',
		buck: '#2a6db0',
		buckEdge: '#1a4d80',
		mcu: '#23272c',
		mcuEdge: '#4a5058',
		cam: '#3d4650',
		camEdge: '#5a6470',
		drv: '#4d7f4a',
		drvEdge: '#35592f',
		motor: '#d3d8dc',
		motorEdge: '#8f979e',
		legend: '#ffffff'
	};
	const mcuRight = [
		['GPIO12', 'L_IN1'],
		['GPIO13', 'L_IN2'],
		['GPIO14', 'L_PWM'],
		['GPIO15', 'R_IN1'],
		['GPIO2', 'R_IN2'],
		['GPIO16', 'R_PWM']
	];
	const drvIn = [
		['VCC', '3V3', C.pwr],
		['STBY', '3V3', C.stby],
		['AIN1', 'L_IN1'],
		['AIN2', 'L_IN2'],
		['PWMA', 'L_PWM'],
		['BIN1', 'R_IN1'],
		['BIN2', 'R_IN2'],
		['PWMB', 'R_PWM']
	];
	const motorPairs = [
		{ channel: 'A', side: 'LEFT', cy: 220, names: ['MFL · front left', 'MRL · rear left'] },
		{ channel: 'B', side: 'RIGHT', cy: 400, names: ['MFR · front right', 'MRR · rear right'] }
	];
	const Motor = ({ cx, cy, name }) => (
		<g>
			<Txt x={cx} y={cy - 62} size={11} bold anchor="middle" mono={false}>
				{name}
			</Txt>
			<circle cx={cx} cy={cy} r={24} fill={F.motor} stroke={F.motorEdge} strokeWidth={2} />
			<Txt x={cx} y={cy + 6} size={18} bold anchor="middle">
				M
			</Txt>
			<circle cx={cx} cy={cy - 24} r={2.5} fill={C.wire} />
			<circle cx={cx} cy={cy + 24} r={2.5} fill={C.wire} />
			<Txt x={cx - 8} y={cy - 30} size={9} color={C.pinOn} anchor="end">
				M+
			</Txt>
			<Txt x={cx - 8} y={cy + 38} size={9} color={C.pinOn} anchor="end">
				M−
			</Txt>
		</g>
	);
	const MotorPair = ({ channel, side, cy, names }) => {
		const top = cy - 50,
			bottom = cy + 50,
			pin2 = cy - 10;
		return (
			<g>
				<Txt x={1380} y={cy - 90} size={12} bold anchor="middle" mono={false}>
					{side} · CHANNEL {channel}
				</Txt>
				<Txt x={1194} y={top + 4} size={10} color={C.pin} anchor="end">
					{channel}O1
				</Txt>
				<Txt x={1194} y={pin2 + 4} size={10} color={C.pin} anchor="end">
					{channel}O2
				</Txt>
				{Wire(1200, top, 1440, top)}
				{Wire(1200, pin2, 1240, pin2)}
				{Wire(1240, pin2, 1240, bottom)}
				{Wire(1240, bottom, 1440, bottom)}
				{[1320, 1440].map((cx, i) => (
					<g key={names[i]}>
						{Wire(cx, top, cx, cy - 24)}
						{Wire(cx, bottom, cx, cy + 24)}
						<Motor cx={cx} cy={cy} name={names[i]} />
					</g>
				))}
				<circle cx={1320} cy={top} r={3} fill={C.wire} />
				<circle cx={1320} cy={bottom} r={3} fill={C.wire} />
				<Txt x={1380} y={cy + 70} size={11} color={C.pinOn} anchor="middle" mono={false}>
					BO gearmotors · parallel
				</Txt>
			</g>
		);
	};

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={`0 0 ${W} ${H}`}
			width="100%"
			style={{ display: 'block', background: '#fff' }}
		>
			<style>{`html, body { margin: 0; background: #fff; }`}</style>
			<Box x={60} y={150} w={160} h={90} fill={F.batt} edge={F.battEdge} />
			<Zone x={140} y={172} dark title="BT1 · 2× 18650" sub="7.4 V · built-in switch S1" />
			<Txt x={66} y={182} size={10} color={C.pin} anchor="start">
				B−
			</Txt>
			{Wire(60, 178, 40, 178)}
			<Gnd x={40} y={178} dir="L" />
			<Txt x={66} y={224} size={10} color={C.pin} anchor="start">
				B+ (switched)
			</Txt>
			{Wire(220, 220, 265, 220, C.pwr)}
			<circle cx={268} cy={220} r={2.5} fill={C.wire} />
			<circle cx={302} cy={220} r={2.5} fill={C.wire} />
			{Wire(268, 220, 296, 208)}
			{Wire(302, 220, 345, 220, C.pwr)}
			<Txt x={285} y={202} size={11} color="#39424c" anchor="middle">
				S1
			</Txt>
			{Wire(345, 220, 370, 220, C.pwr)}
			<Txt x={375} y={224} size={12} color={C.pwr} bold anchor="start">
				VBAT
			</Txt>

			<Box x={60} y={330} w={210} h={110} fill={F.buck} edge={F.buckEdge} />
			<Zone
				x={165}
				y={352}
				dark
				title="U3 · LM2596 BUCK"
				sub="7.4 V → 5.05 V · SET BEFORE USE"
				subOffset={28}
			/>
			<Pin x={60} y={355} side="L" pinName="VIN" net="VBAT" color={C.pwr} />
			<Txt x={66} y={416} size={10} color={C.pin} anchor="start">
				GND
			</Txt>
			<Gnd x={60} y={412} dir="L" />
			<Pin x={270} y={355} side="R" pinName="VOUT" net="+5V" color={C.pwr} />
			<Txt x={264} y={416} size={10} color={C.pin} anchor="end">
				GND
			</Txt>
			<g transform="rotate(180 270 412)">
				<Gnd x={270} y={412} dir="R" />
			</g>

			<Box x={470} y={100} w={300} h={470} fill={F.mcu} edge={F.mcuEdge} />
			<Zone x={620} y={122} dark title="U1 · ESP32-CAM-MB" sub="3.3 V logic · Wi-Fi + OV2640" />
			<Pin x={470} y={150} side="L" pinName="5V" net="+5V" color={C.pwr} />
			<Txt x={476} y={200} size={10} color={C.pin} anchor="start">
				GND
			</Txt>
			<Gnd x={470} y={196} dir="L" />
			<Pin x={470} y={234} side="L" pinName="3V3" net="3V3" color={C.pwr} />
			<Txt x={476} y={276} size={10} color={C.pin} anchor="start">
				GPIO4
			</Txt>
			{Wire(470, 272, 432, 272)}
			<Txt x={427} y={276} size={12} color={C.sig} bold anchor="end">
				HEADLIGHT*
			</Txt>
			<rect
				x={560}
				y={370}
				width={180}
				height={150}
				fill={F.cam}
				stroke={F.camEdge}
				strokeWidth={1.4}
				strokeDasharray="6 4"
				rx={7}
			/>
			<Zone x={650} y={392} dark title="OV2640 CAMERA" sub="internal FPC" />
			<circle cx={650} cy={452} r={26} fill="#11151a" stroke={F.camEdge} strokeWidth={2} />
			<circle cx={650} cy={452} r={11} fill="#1d2836" stroke="#2e4a66" strokeWidth={1.5} />
			<Txt x={650} y={502} size={10} color="#aeb6c0" anchor="middle" mono={false}>
				on-board — no wiring
			</Txt>
			<Txt x={620} y={345} size={10} color="#aeb6c0" anchor="middle" mono={false}>
				MOTOR OUTPUTS · LEDC 20 kHz
			</Txt>
			{mcuRight.map((p, i) => (
				<Pin key={p[1]} x={770} y={150 + i * 34} side="R" pinName={p[0]} net={p[1]} />
			))}

			<Box x={950} y={100} w={250} h={360} fill={F.drv} edge={F.drvEdge} />
			<Zone x={1075} y={122} dark title="U2 · TB6612FNG" sub="dual H-bridge · STBY tied high" />
			{drvIn.map((p, i) => (
				<Pin
					key={p[0]}
					x={950}
					y={150 + i * 27}
					side="L"
					pinName={p[0]}
					net={p[1]}
					color={p[2] || C.sig}
				/>
			))}
			<Pin x={950} y={366} side="L" pinName="VM" net="VBAT" color={C.pwr} />
			<Txt x={956} y={427} size={10} color={C.pin} anchor="start">
				GND
			</Txt>
			<Gnd x={950} y={423} dir="L" />
			{motorPairs.map((pair) => (
				<MotorPair key={pair.channel} {...pair} />
			))}

			<Box x={60} y={560} w={330} h={120} fill={F.legend} edge="#dde3ea" />
			<Zone x={225} y={582} title="LEGEND" />
			{Wire(80, 600, 120, 600, C.pwr, 2.5)}
			<Txt x={130} y={604} size={11} mono={false}>
				power rail (label taps: VBAT, +5V)
			</Txt>
			{Wire(80, 625, 120, 625, C.sig, 2.5)}
			<Txt x={130} y={629} size={11} mono={false}>
				signal net (label taps)
			</Txt>
			<Gnd x={95} y={650} dir="D" />
			<Txt x={130} y={657} size={11} mono={false}>
				common ground — battery, buck, both boards
			</Txt>
			<Txt x={60} y={700} size={11} color="#5b6570" mono={false}>
				* HEADLIGHT = GPIO4 flash LED on the ESP32-CAM, toggled from the web UI.
			</Txt>
			<Txt x={60} y={718} size={11} color="#5b6570" mono={false}>
				R_PWM (GPIO16) is PSRAM-CS on this board — firmware streams from DRAM. See pin map.
			</Txt>
		</svg>
	);
}
```

### Schematic sheet conventions

These are what make the sheet read like a CAD schematic rather than a diagram.

- **Pin names inside, net names outside.** Inside each component box, small text at the pin edge carries the component's own pin name (`GPIO12`, `PWMA`, `VIN`); the wire stub outside carries only the net name (`L_PWM`, `VBAT`). Never annotate the same fact twice.
- **Label-based wiring.** Connect blocks with matched net labels on short stubs; the only long routed wires are tight physical runs (driver → motor terminals). Power rails are labeled taps (`VBAT`, `+5V`, `3V3`), never drawn end-to-end. Ground is a ground symbol, one per pin, all common.
- **Real-hardware fills.** Components take the colour of the physical part.
- **Two label colours.** Near-white (`#edf1f5`) for pin names on dark boxes; dark slate (`#5f6b78`) for labels on the light sheet background. A single "bright" colour fails one of the two.
- **Zone the sheet** left-to-right in signal order (e.g. power entry → regulation → MCU → drivers → actuators), with generous gutters, a small legend, and a plain white, grid-free background. No title blocks, no rotated text for pin groups. If a pin group would be cramped on its edge, the box is too small; grow the box and give the group an internal section caption.
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
