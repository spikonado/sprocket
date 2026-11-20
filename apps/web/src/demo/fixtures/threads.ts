import type { AgentQuestionAnswer } from '@convex/lib/agentQuestions';
import { prompt, recordRun, say, think, tool, work, type Step } from './rows';
import type { DemoThread } from './types';

const SCHEMATIC = 'hardware/rp2350-devboard.kicad_sch';
const BOARD = 'hardware/rp2350-devboard.kicad_pcb';

const ERC = `kicad-cli sch erc --format json --severity-all --exit-code-violations -o /tmp/erc.json ${SCHEMATIC}`;

const DRC = `kicad-cli pcb drc --format json --severity-all --schematic-parity --exit-code-violations -o /tmp/drc.json ${BOARD}`;

const THERMAL_PADS = `python3 scratch/thermal_vias.py ${BOARD} U1 U4 U5 --net GND`;

const FIRMWARE_BUILD = 'cmake -S firmware -B firmware/build && cmake --build firmware/build';

const orderPack: DemoThread = {
	id: 'order-pack',
	title: 'Price the board and get a PCBWay quote',
	model: 'opus-5.5',
	effort: 'medium',
	minutesAgo: 12,
	runs: [
		recordRun('run-order-pack-1', [
			prompt(
				'The RP2350 board in hardware/ is routed. Check ERC and DRC, price the BOM for 1 and 5 boards, get a PCBWay turnkey quote, and write up how to order and bring it up.'
			),
			work(
				think(
					'Planning the checks',
					'Run ERC and DRC first so the quote is for a board that is ready to order. Then price the same 37 BOM lines that the fab files use.'
				),
				tool('read_skill', '$designing-pcbs'),
				tool('exec_cmd', ERC),
				tool('exec_cmd', DRC),
				think(
					'Reading the reports',
					'ERC: 0 errors, 0 warnings. DRC: 0 errors, 0 warnings, 0 unconnected items, and the board matches the schematic. DRC does not check heat, so look at the power parts by hand.'
				),
				tool('exec_cmd', THERMAL_PADS),
				think(
					'Checking the thermal pads',
					"U1's center pad has 5 vias to ground. U4, the BQ24074, has none, and the nearest GND via is 2.55 mm away. Charging a low cell it can dissipate about 0.9 W, so it will reach its thermal limit and cut the charge current."
				)
			),
			say(
				"ERC and DRC are both clean. DRC can't see one problem: the BQ24074's thermal pad has no vias. Pricing the BOM next."
			),
			work(
				tool(
					'exec_cmd',
					`kicad-cli sch export bom --fields "Reference,Value,MPN,LCSC,\${QUANTITY}" --group-by Value,MPN -o /tmp/bom.csv ${SCHEMATIC}`
				),
				tool(
					'lookup_parts',
					'SC1509-A4, SC1169, W25Q128JVPIQ, APS6404L-3SQR-SN, BQ24074RGTR, TLV75733PDBVR, USBLC6-2SC6, USB4105-GF-A, DM3AT-SF-PEJM5, ABM8-272-T3, WS2812B-2020-V6, AOTA-B201610S3R3-101-T'
				),
				tool(
					'lookup_parts',
					'GRM188R61E106MA73D, GRM155R61C105KA12D, GRM155R60J475ME47D, GRM155R71C104KA88D, GRM1555C1H150JA01D, GRM155R60J106ME15D, S2B-PH-SM4-TB, SM04B-SRSS-TB, SM03B-SRSS-TB, PTS810 SJM 250 SMTR LFS, 150060GS75000, 150060AS75000, 61301211121'
				),
				think(
					'Filling the gaps',
					'LCSC has no listing for the Würth LEDs or the 61301211121 headers, so price D2, D3, D4, J6 and J7 at Digi-Key. Everything else is LCSC, bought up to each minimum order quantity.'
				),
				tool(
					'scrape_url',
					'https://www.digikey.com/en/products/detail/w%C3%BCrth-elektronik/61301211121/4846844'
				),
				tool('apply_patch', 'hardware/bom.md'),
				tool('bind_artifact', 'hardware/bom.md'),
				tool('apply_patch', 'docs/bring-up.md'),
				tool('bind_artifact', 'docs/bring-up.md')
			),
			say(`The BOM and bring-up notes are written. All 37 lines are in stock. Parts come to $39.73 for one board and $131.16 for five. The RM2 ($6.61), PSRAM ($4.01) and flash ($3.29) are about a third of that.

artifact:bom

artifact:bring-up

Getting the PCBWay quote now.`),
			work(
				tool('read_skill', '$agent-browser'),
				tool('exec_cmd', 'agent-browser open https://www.pcbway.com/orderonline.aspx'),
				tool('exec_cmd', 'agent-browser snapshot -i'),
				think(
					'Reading the quote',
					'5 PCBs at 76.2 × 25.4 mm, 4 layers, ENIG: $62.04, of which $29.84 is ENIG. The 5/5 mil tracks and 0.25 mm holes add nothing. Turnkey assembly is $88.00 for one board and $88.50 for five. The $29 new-customer promo would cover one board but not five, because J6 and J7 give 120 through-hole joints, over its 100-joint limit. Quote without it. X-ray has no field in the instant quote.'
				),
				tool('apply_patch', 'hardware/bom.md')
			),
			say(`PCBWay quoted the board. Shipping and X-ray on U1 and U7 aren't in the instant quote.

| | 1 board | 5 boards |
| --- | --- | --- |
| PCB (5 bare boards, ENIG) | $62.04 | $62.04 |
| Turnkey assembly | $88.00 | $88.50 |
| Parts | $39.73 | $131.16 |
| **Total** | **$189.77** | **$281.70** |

Add vias under U4's thermal pad before you order, or the charger will throttle.

kicad:hardware/rp2350-devboard.kicad_pro`)
		])
	]
};

type ThermalPlan = { change: string; tools: Step; reply: string };

const THERMAL_VIAS: ThermalPlan = {
	change:
		'Put vias in the pad itself, down to the solid In1 ground plane. The board minimum is 0.25 mm drill and 0.55 mm via, which fits a 2×2 grid on the 1.6 mm pad.',
	tools: work(
		tool('apply_patch', BOARD),
		tool('exec_cmd', DRC),
		tool('exec_cmd', `kicad-cli pcb export gerbers -o fab/gerbers ${BOARD}`),
		tool('exec_cmd', 'cd fab && zip -r rp2350-devboard-gerbers.zip gerbers')
	),
	reply: `Done. U4's thermal pad now has 4 vias (0.25 mm drill, 0.55 mm via) into the In1 ground plane.

- DRC is clean again.
- \`fab/gerbers/\` and \`fab/rp2350-devboard-gerbers.zip\` are regenerated. Upload the new zip.
- The BOM, centroid file and quote don't change.`
};

const THERMAL_PLANS = new Map<string, ThermalPlan>([
	['thermal-vias', THERMAL_VIAS],
	[
		'lower-charge',
		{
			change:
				'Charge current is set by R6: 1.8 kΩ gives 494 mA, and it scales with 1/R6. 3.6 kΩ gives about 247 mA, so U4 makes roughly half the heat.',
			tools: work(
				tool('apply_patch', `${SCHEMATIC}\n${BOARD}\nhardware/bom.md`),
				tool('exec_cmd', ERC),
				tool('lookup_parts', 'RC0402FR-073K6L')
			),
			reply: `Done. R6 is now 3.6 kΩ (RC0402FR-073K6L), which sets the charge current to about 247 mA.

- Only the value changed, so the copper and Gerbers stay the same.
- A flat cell takes about twice as long to charge.
- The BOM line for R6 is updated. Nothing else in the quote moves.`
		}
	],
	[
		'leave-it',
		{
			change:
				'The BQ24074 protects itself: when it gets hot it cuts the charge current. That makes charging slower, not unsafe. Write it down so nobody is surprised.',
			tools: work(tool('apply_patch', 'docs/bring-up.md\nREADME.md')),
			reply:
				'Left the layout as it is. `docs/bring-up.md` now says that U4 throttles when warm, so a flat cell charges slower than the 494 mA setting suggests. If that matters later, the via fix is a layout-only change for rev B.'
		}
	]
]);

function thermalContinuation(answer: AgentQuestionAnswer): Step[] {
	if (answer.optionId === undefined) {
		return [
			work(
				think(
					'Reading your answer',
					`You wrote: "${answer.text}". I will plan the change around it.`
				)
			),
			say(
				`Got it: "${answer.text}". I'll make that change, rerun ERC and DRC, and regenerate the fab files if the copper moves.`
			)
		];
	}

	const plan = THERMAL_PLANS.get(answer.optionId);
	const chosen = plan ?? THERMAL_VIAS;

	return [
		work(
			think(
				'Applying the choice',
				plan
					? chosen.change
					: `You left it to me. The board isn't ordered yet, so new Gerbers cost nothing, and vias fix the cause instead of working around it. ${chosen.change}`
			)
		),
		chosen.tools,
		say(plan ? chosen.reply : `I added thermal vias.\n\n${chosen.reply}`)
	];
}

const chargerThermal: DemoThread = {
	id: 'charger-thermal',
	title: "Fix the charger's thermal pad",
	model: 'sonnet-5.5',
	effort: 'high',
	minutesAgo: 3,
	runs: [
		recordRun('run-charger-thermal-1', [
			prompt('U4 has no thermal vias. What are my options before I order?'),
			work(
				tool('exec_cmd', THERMAL_PADS),
				tool('parse_file', 'https://www.ti.com/lit/gpn/bq24074'),
				think(
					'Weighing the options',
					'The pad has no vias and the nearest GND via is 2.55 mm away. About 0.9 W while charging a low cell. R6 = 1.8 kΩ sets 494 mA. The USB input is held to 500 mA either way, so a lower charge current only trades charge time for heat.'
				),
				tool('ask_question', 'How should we deal with the heat in U4?')
			),
			say(`U4 (BQ24074) has no vias under its thermal pad, so its heat has nowhere to go but the top copper. There are three ways to handle it.

| Option | Change | Effect |
| --- | --- | --- |
| Add thermal vias | 4 vias from the pad to the In1 ground plane | Fixes the cause. Needs a DRC rerun and new Gerbers. |
| Lower the charge current | R6 from 1.8 kΩ to 3.6 kΩ, about 247 mA | About half the heat. Charging takes twice as long. No layout change. |
| Leave it | Document it | The charger cuts its own current when hot. Charging is slower but safe. |

Which one should I do?`)
		])
	],
	question: {
		questionId: 'thermal-question',
		question: 'How should we deal with the heat in U4?',
		options: [
			{ id: 'thermal-vias', label: 'Add thermal vias under U4' },
			{ id: 'lower-charge', label: 'Lower the charge current to about 247 mA' },
			{ id: 'leave-it', label: 'Leave it and document the throttling' }
		],
		continueWith: thermalContinuation
	}
};

const BOARD_TASK =
	"Write firmware/boards/rp2350_devboard.h from pico-sdk's pico2_w.h. Flash is 16 MB. The RM2 is wired like the Pico 2 W on GPIO23/24/25/29, but RM2 GPIO1 and GPIO2 are not connected, so drop the SMPS pin, the VBUS sense on WL_GPIO2 and the VSYS sense on GPIO29. Add defines for PSRAM CS (GPIO8), the WS2812B (GPIO9) and VBAT (GPIO28).";

const BATTERY_TASK =
	'Write firmware/src/battery.{h,c}: read VBAT/2 on GPIO28 (ADC2) through the R13/R14 100 kΩ divider, return millivolts, and flag a low battery below 3.4 V, where firmware should stop Wi-Fi and SD writes.';

const firmware: DemoThread = {
	id: 'firmware',
	title: 'Bring-up firmware with pico-sdk',
	model: 'gpt-6.2-sol',
	effort: 'high',
	minutesAgo: 47,
	runs: [
		recordRun('run-firmware-1', [
			prompt(
				'Write bring-up firmware with pico-sdk: blink the LED on the RM2 and print the battery voltage over USB. Split the work up so it goes faster.'
			),
			work(
				think(
					'Splitting the firmware work',
					'The board header and the battery reader touch different files and can be checked on their own. I will hand each to a subagent and write `main.c` and `CMakeLists.txt` myself.'
				),
				tool('spawn_subagent', BOARD_TASK),
				tool('spawn_subagent', BATTERY_TASK),
				tool('apply_patch', 'firmware/CMakeLists.txt\nfirmware/src/main.c'),
				tool('poll_subagent', 'firmware-board'),
				tool('poll_subagent', 'firmware-battery'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(`The firmware builds against pico-sdk and writes \`firmware/build/devboard.uf2\`.

| Part | Files | Done by |
| --- | --- | --- |
| Board header from \`pico2_w.h\` | \`boards/rp2350_devboard.h\` | Subagent |
| Battery voltage on GPIO28 | \`battery.h\`, \`battery.c\` | Subagent |
| LED blink and serial log | \`main.c\`, \`CMakeLists.txt\` | Me |

Three limits of the board that the firmware works around:

- **No USB detect.** No GPIO sees VBUS or the charger status, so \`battery_low\` goes by voltage only.
- **No battery fitted.** On USB alone, GPIO28 reads a false 3.6 to 4.2 V while the charger looks for a cell.
- **Near the cutoff.** With the cell below about 3.5 V, 3V3 is out of regulation. ADC_AVDD is on 3V3, so readings there run a little high.

It hasn't run on hardware yet. No board has been built.`)
		])
	]
};

const firmwareBoard: DemoThread = {
	id: 'firmware-board',
	parentId: 'firmware',
	title: 'Board header for pico-sdk',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 49,
	runs: [
		recordRun('run-firmware-board-1', [
			prompt(BOARD_TASK),
			work(
				tool(
					'scrape_url',
					'https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/boards/include/boards/pico2_w.h'
				),
				think(
					'Comparing with the Pico 2 W',
					'`pico2_w.h` sets 4 MB of flash, `CYW43_WL_GPIO_SMPS_PIN 1`, `CYW43_WL_GPIO_VBUS_PIN 2`, `CYW43_USES_VSYS_PIN` and `PICO_VSYS_PIN 29`. Here GPIO29 is only the RM2 clock and WL_GPIO1 and WL_GPIO2 are not connected. Keep the GPIO23/24/25/29 pins and the LED on WL_GPIO0.'
				),
				tool('apply_patch', 'firmware/boards/rp2350_devboard.h'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(
				"`boards/rp2350_devboard.h` is in. It keeps the Pico 2 W's RM2 pins and the LED on WL_GPIO0, sets 16 MB of flash, and drops the SMPS, VBUS and VSYS defines. It adds `DEVBOARD_PSRAM_CS_PIN` (8), `PICO_DEFAULT_WS2812_PIN` (9) and `DEVBOARD_VBAT_PIN` (28). I2C0 stays on GPIO4/5, which is the Qwiic port."
			)
		])
	]
};

const firmwareBattery: DemoThread = {
	id: 'firmware-battery',
	parentId: 'firmware',
	title: 'Battery voltage on GPIO28',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 50,
	runs: [
		recordRun('run-firmware-battery-1', [
			prompt(BATTERY_TASK),
			work(
				tool('parse_file', 'https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf'),
				think(
					'Reading the ADC notes',
					'Erratum E9: a pad with its digital input enabled leaks current, which skews a high-impedance source. The divider looks like 50 kΩ from GPIO28. `adc_gpio_init(28)` turns the input buffer off.'
				),
				tool('apply_patch', 'firmware/src/battery.h\nfirmware/src/battery.c'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(
				"`battery_millivolts` reads ADC2 and doubles it for the R13/R14 divider. `battery_init` calls `adc_gpio_init(28)` so erratum E9 can't skew the reading. `battery_low` is true below 3.4 V. The divider draws about 21 µA from the cell all the time, and firmware can't switch it off."
			)
		])
	]
};

const psram: DemoThread = {
	id: 'psram',
	title: 'Enable the 8 MB PSRAM',
	model: 'kimi-k3.1-pro',
	effort: 'high',
	minutesAgo: 1,
	runs: [],
	liveRun: [
		prompt('Bring up the 8 MB PSRAM on GPIO8 and add a read/write test at boot.'),
		work(
			think(
				'Planning the PSRAM setup',
				'The APS6404L sits on QSPI chip select 1, which is GPIO8. GPIO8 resets with a pull-down, and R19 (2.2 kΩ) holds CS high against it. Turn the pad pull-down off before switching GPIO8 to XIP_CS1, then set up the QMI M1 window and put the chip in quad mode.'
			),
			tool('parse_file', 'https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf'),
			tool(
				'parse_file',
				'https://cdn-shop.adafruit.com/product-files/6130/APM_PSRAM_E3_QSPI+%28APS6404L-3SQR+KGD_PKG%29+v2.7.pdf'
			),
			tool(
				'apply_patch',
				'firmware/src/psram.h\nfirmware/src/psram.c\nfirmware/src/main.c\nfirmware/CMakeLists.txt'
			),
			tool('exec_cmd', FIRMWARE_BUILD),
			think(
				'Checking the chip select',
				'R19 was 10 kΩ in the first schematic. Against the GPIO8 pull-down, CS could sit at 2.58 V, under the 2.9 V the PSRAM needs to stay deselected. 2.2 kΩ fixes that in hardware, so firmware only has to drop the pull-down before the QMI drives the pin.'
			),
			tool('exec_cmd', 'grep -n "psram" firmware/build/devboard.map | head')
		),
		say(`The PSRAM is mapped at \`0x11000000\`.

- \`psram_init()\` turns off GPIO8's pull-down, switches it to XIP_CS1, and sets up the QMI M1 window for the APS6404L in quad mode.
- \`main.c\` writes a pattern over all 8 MB at boot, reads it back, and prints the result.

It builds. It hasn't run on hardware, since no board has been built.`)
	]
};

const usbPort: DemoThread = {
	id: 'usb-port',
	title: 'Check the USB-C port',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	settled: true,
	minutesAgo: 60 * 26,
	runs: [
		recordRun('run-usb-port-1', [
			prompt('Is the USB-C port wired right, and is it protected?'),
			work(
				tool('exec_cmd', `kicad-cli sch export netlist -o /tmp/devboard.net ${SCHEMATIC}`),
				tool('exec_cmd', 'grep -B2 -A8 "USBLC6\\|USB4105" /tmp/devboard.net'),
				tool('parse_file', 'https://www.st.com/resource/en/datasheet/cd00050750.pdf')
			),
			say(`Yes for normal use. U6 (USBLC6-2SC6) clamps D+ and D−, with 27 Ω series resistors toward the RP2350. Each CC pin has its own 5.1 kΩ to ground, so USB-C chargers will supply 5 V. The pair is 0.22 mm with a 0.15 mm gap over solid ground, about 90.7 Ω differential, and D+ and D− match within 0.05 mm. That is plenty for full speed USB.

Two limits:

- VBUS on J6.1 is tied straight to the connector, so 5 V fed into that pin back-feeds a connected host.
- U6 breaks down at 6 V, so the port is not 28 V tolerant even though the BQ24074 input is.`)
		])
	]
};

const batteryPick: DemoThread = {
	id: 'battery-pick',
	title: 'Pick a battery for J2',
	model: 'sonnet-5.5',
	effort: 'high',
	settled: true,
	minutesAgo: 60 * 50,
	runs: [
		recordRun('run-battery-pick-1', [
			prompt('What LiPo should I plug into J2?'),
			work(
				tool('parse_file', 'https://www.ti.com/lit/gpn/bq24074'),
				tool('exec_cmd', 'cat scratch/jst-polarity.md'),
				tool('web_search', 'protected 1S LiPo JST PH 2.0 plug 1000 mAh (10 results)')
			),
			say(`A single-cell LiPo with its own protection circuit, 500 mAh or larger, on a JST PH 2.0 plug.

- **Protection:** the board has none, and the BQ24074 has no low-battery cutoff.
- **500 mAh or more:** R6 sets the charge current to 494 mA, which stays under 1C from 500 mAh up.
- **Polarity:** J2 pin 1 is +, marked on the silkscreen. Many third-party cells have red and black swapped, so check before you plug one in.

The battery divider on GPIO28 draws about 21 µA all the time, about 15 mAh a month, so unplug the cell for long storage.`)
		])
	]
};

export const DEFAULT_THREAD_ID = orderPack.id;

export const threads: DemoThread[] = [
	orderPack,
	chargerThermal,
	firmware,
	firmwareBoard,
	firmwareBattery,
	psram,
	usbPort,
	batteryPick
];
