import type { AgentQuestionAnswer } from '@convex/lib/agentQuestions';
import { prompt, recordRun, say, think, tool, work, type Step } from './rows';
import type { DemoThread } from './types';

const ERC =
	'kicad-cli sch erc --format json --severity-all -o /tmp/erc.json hardware/air-sensor.kicad_sch';

const sensorBoard: DemoThread = {
	id: 'sensor-board',
	title: 'Clean up ERC and price the BOM',
	model: 'opus-5.5',
	effort: 'medium',
	minutesAgo: 12,
	runs: [
		recordRun('run-sensor-board-1', [
			prompt(
				'The ESP32-S3 + Si7021 board in hardware/ came from an open source design. Get ERC clean, then price a BOM for 10 boards from LCSC and write up how to assemble them.'
			),
			work(
				think(
					'Planning the board review',
					'Start with ERC so I know what the schematic actually gets wrong, then export the BOM from the same file so the pricing matches the parts on the sheet.'
				),
				tool('read_skill', '$designing-pcbs'),
				tool('exec_cmd', ERC),
				tool(
					'exec_cmd',
					"jq -r '.sheets[].violations[] | .type' /tmp/erc.json | sort | uniq -c | sort -rn"
				),
				think(
					'Reading the ERC report',
					'43 findings. The 2 errors are `power_pin_not_driven` on +5V and GND: nothing marks those nets as driven because VBUS on the USB-C symbol is passive. 20 wire stubs overhang their labels, U1 has 10 hidden GND pins typed `power_in`, and 9 embedded symbols are older than the stock library copies.'
				),
				tool('apply_patch', 'hardware/air-sensor.kicad_sch'),
				tool('exec_cmd', ERC),
				tool(
					'apply_patch',
					'hardware/air-sensor.kicad_sch\nhardware/sym-lib-table\nhardware/lib/ESP32-S3-WROOM-1-N8R8.kicad_sym'
				),
				tool('exec_cmd', `${ERC} --exit-code-violations`)
			),
			say(
				'ERC is down from 2 errors and 41 warnings to 0. Next I am exporting the BOM and pricing it.'
			),
			work(
				tool(
					'exec_cmd',
					'kicad-cli sch export bom --fields "Reference,Value,Footprint,${QUANTITY}" --group-by Value,Footprint -o hardware/bom.csv hardware/air-sensor.kicad_sch'
				),
				tool(
					'lookup_parts',
					'ESP32-S3-WROOM-1-N8R8, SI7021-A20-GM1R, LM1117DTX-3.3/NOPB, USBLC6-2SC6, USB4105-GF-A, BM04B-SRSS-TB(LF)(SN), CLMVC-FKA-CL1D1L71BB7C3C3, B3U-1000P-B, B3F-3152, ESD9B3.3ST5G'
				),
				tool(
					'lookup_parts',
					'CL05B104KO5NNNC, CL21A226MAQNNNE, CL10A106KP8NNNC, CL10A105KB8NNNC, KT-0603R, 1N5817, GZ2012D601TF, 0402WGF5101TCE, 0402WGF1001TCE, 0402WGF2201TCE, 0402WGF1002TCE'
				),
				think(
					'Checking the parts with no stock',
					'D7 (Cree CLMVC RGB LED) shows 0 at both LCSC and JLCPCB. B3U-1000P-B is also at 0, but B3U-1000P has 63,930 and the same body. Look for a PLCC4 3.2×2.8 RGB LED that drops onto the same footprint.'
				),
				tool('web_search', 'RGB LED PLCC4 3.2x2.8mm common anode in stock LCSC (10 results)'),
				tool('scrape_url', 'https://www.lcsc.com/product-detail/C5187905.html'),
				tool('lookup_parts', 'B3U-1000P, 19-237/R6GHBHC-A04/2T, XL-3216RGBC'),
				tool('apply_patch', 'hardware/bom.md'),
				tool('bind_artifact', 'hardware/bom.md'),
				tool('apply_patch', 'docs/assembly.md'),
				tool('bind_artifact', 'docs/assembly.md')
			),
			say(`ERC is clean and the BOM is priced for 10 boards.

| ERC check | Before | After | Fix |
| --- | --- | --- | --- |
| \`power_pin_not_driven\` (error) | 2 | 0 | PWR_FLAG on +5V and GND |
| \`unconnected_wire_endpoint\` | 20 | 0 | Trimmed the wire stubs back to their labels |
| \`wired_implicit_power\` | 10 | 0 | U1's hidden GND pins are now passive, as in KiCad's stock symbol |
| \`lib_symbol_mismatch\` | 9 | 0 | Refreshed \`C_Small\` and the USB-C symbol from the stock library |
| Library and footprint links | 2 | 0 | Project library for U1, stock \`RF_Module:ESP32-S3-WROOM-1\` footprint |

kicad:hardware/air-sensor.kicad_pro

Parts come to **$16.12 a board**, $161.17 for ten, at LCSC's 10-piece prices. Two lines need a decision from you: D7 has no stock anywhere, and the in-stock RGB LEDs need a smaller footprint. U4 has only 379 in stock, which covers this batch but not a production run. The full list is in [hardware/bom.md](hardware/bom.md).

| Part | Ref | LCSC | Unit | Stock |
| --- | --- | --- | --- | --- |
| ESP32-S3-WROOM-1-N8R8 | U1 | C2913201 | $4.46 | 2,180 |
| SI7021-A20-GM1R | U4 | C132603 | $7.71 | 379 |
| LM1117DTX-3.3/NOPB | U3 | C73181 | $0.85 | 13,517 |
| USB4105-GF-A | J1 | C3020560 | $0.84 | 10,069 |
| USBLC6-2SC6 | U2 | C7519 | $0.16 | 32,225 |
| CLMVC-FKA-CL1D1L71BB7C3C3 | D7 | C5187905 | $0.17 | **0** |
| 17 more lines: passives, headers, switches | | | $1.95 | In stock |

artifact:bom

artifact:assembly`)
		])
	]
};

type BatteryPlan = { change: string; lookup: string; reply: string };

const AA_LITHIUM: BatteryPlan = {
	change:
		'Two L91 cells run from 3.6 V down to about 2.0 V, below what the ESP32-S3 accepts. That needs a buck-boost in place of U3. The TPS63802 has 11 µA quiescent draw and handles 2 A Wi-Fi peaks.',
	lookup: 'TPS63802DLAR, XFL4020-471MEC, Keystone 2462',
	reply: `Done. The node now runs from two Energizer L91 AA cells.

- **U3** is a TPS63802 buck-boost (C2870937) with a 0.47 µH inductor, so the 3.3 V rail holds while the cells fall to 2.0 V.
- **BT1** is a Keystone 2462 2×AA holder.
- \`firmware/src/power.cpp\` now cuts off at 2.1 V on the pack instead of 3.0 V.

L91 cells are rated to −40 °C and keep most of their capacity in the cold, so this should last about **200 days**. There is nothing to charge. Swap the cells each autumn.`
};

const BATTERY_PLANS = new Map<string, BatteryPlan>([
	[
		'li-ion-18650',
		{
			change:
				'A Li-ion cell sits at 3.0–4.2 V, so U3 has to stay, but the LM1117 burns 5 mA on its own. Swap it for an ME6211 (40 µA) and add a divider on GPIO4 to read the cell.',
			lookup: 'ME6211C33M5G-N, S2B-PH-K-S(LF)(SN), 0402WGF1003TCE',
			reply: `Done. The node now runs from a protected 18650.

- **U3** is an ME6211C33 (C82942) in place of the LM1117. Its 40 µA quiescent draw was the real battery killer, not the radio.
- **J5** is a JST-PH 2-pin battery connector. R11/R12 (1 MΩ each) divide the cell onto GPIO4.
- \`firmware/src/power.cpp\` skips the reading and sleeps 4× longer below 3.3 V.

At 0.55 mA average that is about **180 days at −10 °C**. The cell must not be charged below 0 °C, so charge it indoors.`
		}
	],
	['aa-lithium', AA_LITHIUM],
	[
		'lifepo4-18650',
		{
			change:
				'LiFePO4 sits at 3.2–3.4 V for most of its discharge, inside the ESP32-S3 range. U3 can be bypassed with a 0 Ω link so the regulator costs nothing.',
			lookup: 'IFR18650-1500, Keystone 1042, 0603WAF0000T5E',
			reply: `Done. The node now runs straight from a LiFePO4 18650.

- **U3** is bypassed by R13 (0 Ω). USB still powers the board through D3 for flashing.
- **BT1** is a Keystone 1042 18650 holder.
- \`firmware/src/power.cpp\` cuts off at 2.9 V, where LiFePO4 is nearly empty.

A 1,500 mAh cell gives about **110 days**, so plan one recharge mid-winter. It is the safest chemistry of the three outdoors.`
		}
	]
]);

function batteryContinuation(answer: AgentQuestionAnswer): Step[] {
	if (answer.optionId === undefined) {
		return [
			work(
				think(
					'Reading your answer',
					`You wrote: "${answer.text}". I will plan the power stage around it.`
				)
			),
			say(
				`Got it: "${answer.text}". I will size the regulator and the battery cutoff around that and rerun ERC before I change anything else.`
			)
		];
	}

	const plan = BATTERY_PLANS.get(answer.optionId);
	const chosen = plan ?? AA_LITHIUM;

	return [
		work(
			think(
				'Applying the battery choice',
				plan
					? chosen.change
					: `You left it to me. Outdoors over a winter, the deciding factors are cold capacity and not needing a charger. Two lithium AA cells win on both. ${chosen.change}`
			),
			tool('lookup_parts', chosen.lookup),
			tool('apply_patch', 'hardware/air-sensor.kicad_sch\nfirmware/src/power.cpp'),
			tool('exec_cmd', `${ERC} --exit-code-violations`),
			tool('exec_cmd', 'pio run -d firmware -e esp32s3')
		),
		say(plan ? chosen.reply : `I went with two lithium AA cells.\n\n${chosen.reply}`)
	];
}

const batteryChoice: DemoThread = {
	id: 'battery-choice',
	title: 'Battery for the outdoor node',
	model: 'sonnet-5.5',
	effort: 'high',
	minutesAgo: 3,
	runs: [
		recordRun('run-battery-choice-1', [
			prompt(
				'The node will live outside on a balcony. Pick a battery that lasts a winter with a reading every 5 minutes.'
			),
			work(
				think(
					'Estimating the power budget',
					'Each wake: about 1.4 s of Wi-Fi and MQTT at ~120 mA, plus the Si7021 conversion. Between wakes, the S3 deep sleeps at ~8 µA, but U3 (LM1117) draws 5 mA quiescent all the time, which dominates everything.'
				),
				tool(
					'exec_cmd',
					'python3 tools/power_budget.py --interval 300 --wake-ms 1400 --wake-ma 120 --sleep-ua 8'
				),
				tool('web_search', 'Energizer L91 capacity at -20C (10 results)'),
				tool('web_search', 'LiFePO4 18650 capacity low temperature self discharge (10 results)'),
				tool('ask_question', 'Which battery should the outdoor node use?')
			),
			say(`With the LM1117 replaced, the node averages about **0.55 mA**, or 13 mAh a day. Left as it is, the regulator alone would drain any of these in under a month.

| Option | Capacity | Cold behaviour | Regulator change | Winter runtime |
| --- | --- | --- | --- | --- |
| 18650 Li-ion | 3,000 mAh | −20 % at −10 °C, no charging below 0 °C | Low-Iq LDO | ~180 days |
| 2× AA lithium (L91) | 3,000 mAh | Rated to −40 °C | Buck-boost | ~200 days |
| LiFePO4 18650 | 1,500 mAh | Good, flat 3.2 V | None, bypass U3 | ~110 days |

Which one should I design for?`)
		])
	],
	question: {
		questionId: 'battery-question',
		question: 'Which battery should the outdoor node use?',
		options: [
			{ id: 'li-ion-18650', label: '18650 Li-ion, rechargeable' },
			{ id: 'aa-lithium', label: '2× AA lithium (Energizer L91)' },
			{ id: 'lifepo4-18650', label: 'LiFePO4 18650, no regulator' }
		],
		continueWith: batteryContinuation
	}
};

const SI7021_TASK =
	'Write the Si7021 driver in firmware/src/si7021.{h,cpp}: I2C on GPIO8/9 at 100 kHz, humidity then the cached temperature, CRC-8 check on every read. Add a native unit test for the CRC and the conversions.';

const POWER_TASK =
	'Write firmware/src/power.{h,cpp}: deep sleep with a timer wake, battery voltage on GPIO4 through the 1:2 divider, and a low-battery path that skips Wi-Fi. Keep the wake time under 1.5 s.';

const firmware: DemoThread = {
	id: 'firmware',
	title: 'Sensor firmware with deep sleep',
	model: 'gpt-6.2-sol',
	effort: 'high',
	minutesAgo: 47,
	runs: [
		recordRun('run-firmware-1', [
			prompt(
				'Write the firmware: read the Si7021 every 5 minutes, deep sleep in between, publish over MQTT. Split the work up so it goes faster.'
			),
			work(
				think(
					'Splitting the firmware work',
					'The sensor driver and the sleep/power path touch different files and can be tested on their own. I will hand each to a subagent and write `main.cpp` and the MQTT publish path myself.'
				),
				tool('spawn_subagent', SI7021_TASK),
				tool('spawn_subagent', POWER_TASK),
				tool(
					'apply_patch',
					'firmware/platformio.ini\nfirmware/src/main.cpp\nfirmware/src/publish.cpp\nfirmware/src/publish.h'
				),
				tool('poll_subagent', 'firmware-si7021'),
				tool('poll_subagent', 'firmware-power'),
				tool('exec_cmd', 'pio run -d firmware -e esp32s3'),
				tool('exec_cmd', 'pio test -d firmware -e native')
			),
			say(`The firmware builds and the native tests pass.

| Part | Files | Done by |
| --- | --- | --- |
| Si7021 driver with CRC check | \`si7021.h\`, \`si7021.cpp\`, \`test/test_si7021\` | Subagent |
| Deep sleep and battery check | \`power.h\`, \`power.cpp\` | Subagent |
| Wake, read, publish, sleep | \`main.cpp\`, \`publish.cpp\` | Me |

- **Wake time:** 1.31 s from timer wake to deep sleep on a cached Wi-Fi channel and BSSID.
- **Flash:** 812 KB of 3 MB, so OTA fits with two app slots.
- **Tests:** 9 passed in \`pio test -e native\`, covering the CRC and both conversions at the datasheet's example values.

Next step is flashing a board once the first batch is assembled.`)
		])
	]
};

const firmwareSi7021: DemoThread = {
	id: 'firmware-si7021',
	parentId: 'firmware',
	title: 'Si7021 driver',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 49,
	runs: [
		recordRun('run-firmware-si7021-1', [
			prompt(SI7021_TASK),
			work(
				tool('scrape_url', 'https://www.silabs.com/documents/public/data-sheets/Si7021-A20.pdf'),
				think(
					'Reading the datasheet',
					'Measure RH with 0xF5 (no hold), wait ≥ 23 ms, read 3 bytes with the CRC. Temperature from the same conversion is 0xE0, no CRC. CRC-8 polynomial is 0x31, init 0x00.'
				),
				tool(
					'apply_patch',
					'firmware/src/si7021.h\nfirmware/src/si7021.cpp\nfirmware/test/test_si7021/test_si7021.cpp'
				),
				tool('exec_cmd', 'pio test -d firmware -e native -f test_si7021')
			),
			say(
				'The driver is in `si7021.cpp`. It reads humidity with the no-hold command, reuses that conversion for temperature, and returns nothing on a CRC mismatch. 9 native tests pass, including the datasheet example of 0x7C80 → 54.8 % RH.'
			)
		])
	]
};

const firmwarePower: DemoThread = {
	id: 'firmware-power',
	parentId: 'firmware',
	title: 'Deep sleep and battery check',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 50,
	runs: [
		recordRun('run-firmware-power-1', [
			prompt(POWER_TASK),
			work(
				tool('apply_patch', 'firmware/src/power.h\nfirmware/src/power.cpp'),
				tool('exec_cmd', 'pio run -d firmware -e esp32s3'),
				think(
					'Checking the wake budget',
					'Most of the wake is Wi-Fi association. Caching the channel and BSSID in RTC memory skips the scan and saves ~600 ms.'
				),
				tool('apply_patch', 'firmware/src/power.cpp')
			),
			say(
				'`power::sleepFor` arms the RTC timer and enters deep sleep. `power::batteryMillivolts` reads GPIO4 through the divider with the calibrated ADC. Below 3.0 V the node skips Wi-Fi and sleeps 4× longer. Wi-Fi channel and BSSID are cached in RTC memory, which brings the wake down to about 1.3 s.'
			)
		])
	]
};

const otaUpdates: DemoThread = {
	id: 'ota-updates',
	title: 'OTA updates with rollback',
	model: 'kimi-k3.1-pro',
	effort: 'high',
	minutesAgo: 1,
	runs: [],
	liveRun: [
		prompt(
			'Add OTA updates over Wi-Fi. If a new build cannot read the sensor after boot, roll back to the previous one.'
		),
		work(
			think(
				'Planning the OTA path',
				'ESP-IDF already supports rollback: mark the new app as pending verify, then confirm it only after the first good Si7021 reading. If the board resets before that, the bootloader falls back to the old slot.'
			),
			tool('exec_cmd', 'grep -n "partitions\\|board_build" firmware/platformio.ini'),
			tool('apply_patch', 'firmware/partitions.csv\nfirmware/platformio.ini'),
			tool('apply_patch', 'firmware/src/ota.h\nfirmware/src/ota.cpp\nfirmware/src/main.cpp'),
			tool('exec_cmd', 'pio run -d firmware -e esp32s3'),
			think(
				'Checking the image size',
				'Two 1.5 MB app slots fit in the 8 MB flash with room for NVS and a coredump partition. The build is 861 KB with the HTTPS client, so there is headroom.'
			),
			tool('exec_cmd', 'pio test -d firmware -e native')
		),
		say(`OTA is in, with rollback.

- **Partitions:** two 1.5 MB app slots plus NVS and coredump, in \`firmware/partitions.csv\`.
- **Update check:** on every 12th wake (once an hour), the node fetches \`manifest.json\` over HTTPS and compares versions.
- **Rollback:** a new image boots as *pending verify*. \`ota::confirm()\` runs only after the first good Si7021 reading. Any reset before that boots the previous slot.

The build is 861 KB and all 9 native tests still pass.`)
	]
};

const usbEsd: DemoThread = {
	id: 'usb-esd',
	title: 'Check USB-C ESD protection',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	settled: true,
	minutesAgo: 60 * 26,
	runs: [
		recordRun('run-usb-esd-1', [
			prompt('Is the USB-C port protected well enough for a board people plug in outdoors?'),
			work(
				tool('parse_file', 'https://www.st.com/resource/en/datasheet/usblc6-2.pdf'),
				tool(
					'exec_cmd',
					'kicad-cli sch export netlist -o /tmp/air-sensor.net hardware/air-sensor.kicad_sch'
				),
				tool('exec_cmd', 'grep -A6 "USBLC6" /tmp/air-sensor.net')
			),
			say(
				'Yes. U2 (USBLC6-2SC6) clamps D+ and D− and is rated to ±15 kV air discharge under IEC 61000-4-2, and VBUS goes through its supply pin. D4–D6 cover the buttons and header lines. The one gap is CC1/CC2, which only have the 5.1 kΩ pull-downs. That is fine for a sink-only device.'
			)
		])
	]
};

const enclosure: DemoThread = {
	id: 'enclosure',
	title: 'Pick an IP65 enclosure',
	model: 'sonnet-5.5',
	effort: 'high',
	settled: true,
	minutesAgo: 60 * 50,
	runs: [
		recordRun('run-enclosure-1', [
			prompt('Find an IP65 enclosure that fits the board and lets air reach the sensor.'),
			work(
				tool('web_search', 'IP65 enclosure 80x60mm with membrane vent (10 results)'),
				tool('scrape_url', 'https://www.hammfg.com/electronics/small-case/plastic/1554'),
				tool('lookup_parts', '1554B2GYCL, 1554VENT')
			),
			say(
				'Hammond **1554B2GYCL** (85 × 60 × 40 mm, IP66) fits the board with 6 mm to spare on each side. Add a **1554VENT** membrane vent on the bottom face so humidity reaches U4 without letting water in. Mount the board with U4 nearest the vent.'
			)
		])
	]
};

export const DEFAULT_THREAD_ID = sensorBoard.id;

export const threads: DemoThread[] = [
	sensorBoard,
	batteryChoice,
	firmware,
	firmwareSi7021,
	firmwarePower,
	otaUpdates,
	usbEsd,
	enclosure
];
