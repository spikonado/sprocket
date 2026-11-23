import type { AgentQuestionAnswer } from '@convex/lib/agentQuestions';
import dashboardScreenshot from './dashboard-screenshot.webp?url';
import { prompt, recordRun, say, think, tool, work, type Step } from './rows';
import type { DemoThread } from './types';

const SCHEMATIC = 'hardware/rp2350-devboard.kicad_sch';
const BOARD = 'hardware/rp2350-devboard.kicad_pcb';

const ERC = `kicad-cli sch erc --format json --severity-all --exit-code-violations -o /tmp/erc.json ${SCHEMATIC}`;

const DRC = `kicad-cli pcb drc --format json --severity-all --schematic-parity --exit-code-violations -o /tmp/drc.json ${BOARD}`;

const VIAS_IN_PADS = `python3 scratch/vias_in_pads.py ${BOARD} --smd-only`;

const REGENERATE_FAB = [
	tool('exec_cmd', DRC),
	tool('exec_cmd', `kicad-cli pcb export gerbers -o fab/gerbers ${BOARD}`),
	tool('exec_cmd', 'cd fab && zip -r rp2350-devboard-gerbers.zip gerbers'),
	tool('apply_patch', 'hardware/bom.md\ndocs/assembly.md')
];

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
					'Run ERC and DRC first so the quote is for a board that is ready to order. Then price the same 38 placed BOM lines that the fab files use.'
				),
				tool('read_skill', '$designing-pcbs'),
				tool('exec_cmd', ERC),
				tool('exec_cmd', DRC),
				think(
					'Reading the reports',
					"ERC: 0 errors, 0 warnings. DRC: 0 errors, 0 unconnected items, and the board matches the schematic. The only note is R7: its silk line touched U3's pin-1 mark and was trimmed, so it no longer matches its library footprint. DRC doesn't price the via process, so check for vias in pads by hand."
				),
				tool('exec_cmd', VIAS_IN_PADS),
				think(
					'Checking the vias',
					'82 vias sit in or touch SMD pads, on the decoupling caps, U1, U2, U3 and J1. Open barrels there would wick solder away from the joints, so the order needs resin-filled, capped vias.'
				)
			),
			say(
				"ERC and DRC are both clean. DRC can't see one cost: 82 vias sit in or touch SMD pads, so PCBWay has to fill and cap them. Pricing the BOM next."
			),
			work(
				tool(
					'exec_cmd',
					`kicad-cli sch export bom --fields "Reference,Value,MPN,LCSC,\${QUANTITY}" --group-by Value,MPN -o /tmp/bom.csv ${SCHEMATIC}`
				),
				tool(
					'lookup_parts',
					'RP2350A, RMC20452T, W25Q128JVSIQ, APS6404L-3SQR-SN, BQ24074RGTR, TPS63001DRCR, USBLC6-2SC6, USB4105-GF-A, 1040310811, ABM8-272-T3, WS2812B-2020-V6, AOTA-B201610S3R3-101-T, DFE252012F-2R2M=P2'
				),
				tool(
					'lookup_parts',
					'CL05B104KO5NNNC, CL05A475MP5NRNC, CL05C150JB5NNNC, CL21A475KAQNNNE, CL10A106KP8NNNC, CL21A226MAQNNNE, LTST-C191KFKT, DMG2305UX-7, DMG1012T-7, S2B-PH-SM4-TB(LF)(SN), SM04B-SRSS-TB(LF)(SN), PTS810SJM250SMTRLFS'
				),
				think(
					'Checking stock',
					"All 38 placed lines are in stock at LCSC, bought up to each minimum order quantity. Digi-Key lists C25 and C26's CL21A226MAQNNNE as discontinued, but LCSC still has it. L1 is thin, so note a substitute."
				),
				tool('apply_patch', 'hardware/bom.md'),
				tool('bind_artifact', 'hardware/bom.md'),
				tool('apply_patch', 'docs/assembly.md'),
				tool('bind_artifact', 'docs/assembly.md')
			),
			say(`The BOM and assembly notes are written. All 38 placed lines are in stock. Parts come to $37.60 for one board and $122.01 for five. The RM2 ($6.61), PSRAM ($4.01) and flash ($2.28) are about a third of that.

artifact:bom

artifact:bring-up

Getting the PCBWay quote now.`),
			work(
				tool('read_skill', '$agent-browser'),
				tool('exec_cmd', 'agent-browser open https://www.pcbway.com/orderonline.aspx'),
				tool('exec_cmd', 'agent-browser snapshot -i'),
				think(
					'Reading the quote',
					'5 PCBs at 28 × 78.54 mm, 4 layers, ENIG: $156.77. That is $32.20 base, $29.84 ENIG and $94.73 for resin-filled, capped vias. Tented it would be $62.04. Assembly is the $88.00 minimum for one board and for five, since there are 82 SMD parts and no through-hole joints. The $29 new-customer promo would apply too. Quote without it.'
				),
				tool('apply_patch', 'hardware/bom.md')
			),
			say(`PCBWay quoted the board. Shipping isn't included.

| | 1 board | 5 boards |
| --- | --- | --- |
| PCB (5 bare boards, ENIG) | $156.77 | $156.77 |
| Turnkey assembly | $88.00 | $88.00 |
| Parts | $37.60 | $122.01 |
| **Total** | **$282.37** | **$366.78** |

$94.73 of the PCB price is the filled vias. Moving the 82 vias off their pads would bring the PCB down to $62.04.

kicad:hardware/rp2350-devboard.kicad_pro`)
		])
	]
};

type ViaPlan = { change: string; tools: Step; reply: string };

const MOVE_VIAS: ViaPlan = {
	change:
		'Move each in-pad via beside its pad on a short track, keeping the 0.6/0.3 mm via size. The tight spots are the decoupling caps around U1 and J1. The 0.2 mm thermal vias in the U1, U5 and U6 exposed pads stay, since the paste is windowed there.',
	tools: work(tool('apply_patch', BOARD), tool('exec_cmd', VIAS_IN_PADS), ...REGENERATE_FAB),
	reply: `Done. None of the signal vias touch an SMD pad now, so the board can be ordered with tented vias.

- DRC is clean again.
- \`fab/gerbers/\` and \`fab/rp2350-devboard-gerbers.zip\` are regenerated. Upload the new zip.
- The PCB drops to $62.04, so one board is $187.64 and five are $272.05 ($54.41 each).
- \`docs/assembly.md\` now asks for tented vias.`
};

const VIA_PLANS = new Map<string, ViaPlan>([
	['move-vias', MOVE_VIAS],
	[
		'move-and-reroute',
		{
			change: `${MOVE_VIAS.change} Then fix the review's four major findings: QSPI_SD3 straight to U2 pin 7, SD_CLK and SD_D3 down the right side with the other SD lines, VBAT from U5's BAT pins at full width, and D+ joined at J1's A6 and B6.`,
			tools: work(
				tool('apply_patch', BOARD),
				tool('exec_cmd', VIAS_IN_PADS),
				tool('exec_cmd', `python3 scratch/net_lengths.py ${BOARD}`),
				...REGENERATE_FAB
			),
			reply: `Done. The vias are off the pads and the four major review findings are rerouted.

- QSPI_SD3 no longer loops out to the left edge, and SD_CLK and SD_D3 follow the other SD lines down the right side.
- VBAT leaves U5's BAT pins at 0.4 mm on F.Cu, with no 0.15 mm neck.
- D+ joins A6 and B6 at J1, so there is no stub in either plug orientation.
- DRC is clean, and \`fab/\` is regenerated. The PCB drops to $62.04, so five boards are $272.05.`
		}
	],
	[
		'keep-filled',
		{
			change:
				"Filled, capped vias are a standard PCBWay process, and the fab notes already ask for them. The $94.73 is per order, so it doesn't grow with five boards.",
			tools: work(tool('apply_patch', 'docs/assembly.md')),
			reply:
				'Left the layout as it is. `docs/assembly.md` already asks for resin-filled, capped vias, and I added the line for the order remarks. Moving the vias off the pads is a layout-only change for rev B.'
		}
	]
]);

function viaContinuation(answer: AgentQuestionAnswer): Step[] {
	if (answer.optionId === undefined) {
		return [
			work(
				think(
					'Reading your answer',
					`You wrote: "${answer.text}". I will plan the change around it.`
				)
			),
			say(
				`Got it: "${answer.text}". I'll make that change, rerun DRC, and regenerate the fab files if the copper moves.`
			)
		];
	}

	const plan = VIA_PLANS.get(answer.optionId);
	const chosen = plan ?? MOVE_VIAS;

	return [
		work(
			think(
				'Applying the choice',
				plan
					? chosen.change
					: `You left it to me. The board isn't ordered yet, and the filled vias are about a quarter of the five-board cost. ${chosen.change}`
			)
		),
		chosen.tools,
		say(plan ? chosen.reply : `I moved the vias off the pads.\n\n${chosen.reply}`)
	];
}

const viaCost: DemoThread = {
	id: 'via-cost',
	title: 'Cut the filled-via cost',
	model: 'sonnet-5.5',
	effort: 'high',
	minutesAgo: 3,
	runs: [
		recordRun('run-via-cost-1', [
			prompt('Filled vias are $94.73 of the PCB price. What are my options before I order?'),
			work(
				tool('exec_cmd', VIAS_IN_PADS),
				tool('exec_cmd', 'cat review/findings.json'),
				think(
					'Weighing the options',
					"82 vias touch SMD pads. Tented vias bring the PCB from $156.77 to $62.04, so five boards drop from $366.78 to $272.05. PCBWay's via-in-pad option prices the same as filling every via, so it saves nothing. The review also lists four major routing findings, and a layout pass could fix those at the same time."
				),
				tool('ask_question', 'How should we handle the vias in pads?')
			),
			say(`82 vias sit in or touch SMD pads, so PCBWay has to fill and cap every via. There are three ways to handle it.

| Option | Change | Effect |
| --- | --- | --- |
| Move the vias | Each in-pad via moves beside its pad | PCB $62.04, five boards $272.05. Needs DRC and new Gerbers. |
| Move them and reroute | Also fix QSPI_SD3, SD_CLK and SD_D3, the VBAT neck and the USB D+ loop | Same saving, and fixes the review's four major findings. More layout work. |
| Keep filled vias | Order as is | Five boards stay at $366.78. No layout change. |

Which one should I do?`)
		])
	],
	question: {
		questionId: 'via-question',
		question: 'How should we handle the vias in pads?',
		options: [
			{ id: 'move-vias', label: 'Move the vias off the pads' },
			{ id: 'move-and-reroute', label: 'Move them and fix the major routing findings' },
			{ id: 'keep-filled', label: 'Keep filled, capped vias' }
		],
		continueWith: viaContinuation
	}
};

const BOARD_TASK =
	"Write firmware/boards/rp2350_devboard.h from pico-sdk's pico2_w.h. Flash is 16 MB. The RM2 is wired like the Pico 2 W on GPIO23/24/25/29, with WL_GPIO1 on U6's PS/SYNC and WL_GPIO2 sensing VBUS, but WL_GPIO0 has no LED and GPIO29 has no VSYS sense. Add defines for PSRAM CS (GPIO8), microSD card detect (GPIO9), the WS2812B (GPIO22) and VBAT (GPIO28).";

const BATTERY_TASK =
	'Write firmware/src/battery.{h,c}: read VBAT/2 on GPIO28 (ADC2) through the R14/R15 470 kΩ divider, return millivolts, and flag a low battery below 3.3 V.';

const firmware: DemoThread = {
	id: 'firmware',
	title: 'Bring-up firmware with pico-sdk',
	model: 'gpt-6.2-sol',
	effort: 'high',
	minutesAgo: 47,
	runs: [
		recordRun('run-firmware-1', [
			prompt(
				'Write bring-up firmware with pico-sdk: blink the RGB LED and print the battery voltage over USB. Split the work up so it goes faster.'
			),
			work(
				think(
					'Splitting the firmware work',
					'The board header and the battery reader touch different files and can be checked on their own. I will hand each to a subagent and write `main.c`, the WS2812 PIO program and `CMakeLists.txt` myself.'
				),
				tool('spawn_subagent', BOARD_TASK),
				tool('spawn_subagent', BATTERY_TASK),
				tool(
					'apply_patch',
					'firmware/CMakeLists.txt\nfirmware/src/main.c\nfirmware/src/ws2812.pio'
				),
				tool('poll_subagent', 'firmware-board'),
				tool('poll_subagent', 'firmware-battery'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(`The firmware builds against pico-sdk and writes \`firmware/build/devboard.uf2\`.

| Part | Files | Done by |
| --- | --- | --- |
| Board header from \`pico2_w.h\` | \`boards/rp2350_devboard.h\` | Subagent |
| Battery voltage on GPIO28 | \`battery.h\`, \`battery.c\` | Subagent |
| RGB blink and serial log | \`main.c\`, \`ws2812.pio\`, \`CMakeLists.txt\` | Me |

Three things about the board that shape the firmware:

- **No RM2 LED.** WL_GPIO0 is not connected, so the blink drives the WS2812B on GPIO22.
- **No battery fitted.** GPIO28 still reads a voltage while the charger looks for a cell, so the log also prints USB state from WL_GPIO2.
- **Divider drain.** R14 and R15 draw about 4.5 µA from the cell all the time, and firmware can't switch them off.

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
					"`pico2_w.h` sets 4 MB of flash, `CYW43_WL_GPIO_LED_PIN 0`, `CYW43_WL_GPIO_SMPS_PIN 1`, `CYW43_WL_GPIO_VBUS_PIN 2`, `CYW43_USES_VSYS_PIN` and `PICO_VSYS_PIN 29`. Here WL_GPIO1 drives U6's PS/SYNC like the Pico 2 W's SMPS pin, and WL_GPIO2 sees VBUS through R22/R23. WL_GPIO0 is unconnected and GPIO29 is only WL_CLK."
				),
				tool('apply_patch', 'firmware/boards/rp2350_devboard.h'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(
				'`boards/rp2350_devboard.h` is in. It keeps the RM2 pins, the SMPS pin on WL_GPIO1 and VBUS sense on WL_GPIO2, sets 16 MB of flash, and drops the LED and VSYS defines. It adds `DEVBOARD_PSRAM_CS_PIN` (8), `DEVBOARD_SD_DET_PIN` (9), `PICO_DEFAULT_WS2812_PIN` (22) and `DEVBOARD_VBAT_PIN` (28). I2C0 stays on GPIO4/5, which is the Qwiic port.'
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
					'Erratum E9: a pad with its digital input enabled leaks current, which skews a high-impedance source. The R14/R15 divider looks like 235 kΩ from GPIO28. `adc_gpio_init(28)` turns the input buffer off.'
				),
				tool('apply_patch', 'firmware/src/battery.h\nfirmware/src/battery.c'),
				tool('exec_cmd', FIRMWARE_BUILD)
			),
			say(
				"`battery_millivolts` reads ADC2 and doubles it for the R14/R15 divider. `battery_init` calls `adc_gpio_init(28)` so erratum E9 can't skew the reading. `battery_low` is true below 3.3 V, which leaves margin above the 3.0 V cell where U6 still holds 3V3. Q2 only connects the divider while 3V3 is up, so readings are valid whenever firmware runs."
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
				'The APS6404L (U3) sits on QSPI chip select 1, which is GPIO8. GPIO8 resets with a pull-down, and R7 (2.2 kΩ) holds CE# high against it. Switch GPIO8 to XIP_CS1, then set up the QMI M1 window and put the chip in quad mode.'
			),
			tool('parse_file', 'https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf'),
			tool('parse_file', 'https://www.pjrc.com/store/APS6404L_3SQR.pdf'),
			tool(
				'apply_patch',
				'firmware/src/psram.h\nfirmware/src/psram.c\nfirmware/src/main.c\nfirmware/CMakeLists.txt'
			),
			tool('exec_cmd', FIRMWARE_BUILD),
			think(
				'Checking the errata',
				"Erratum RP2350-E14: the bootrom's `connect_internal_flash()` sets up the pads for GPIO0 instead of GPIO8. Clear GPIO8's pad isolation after that call, or CS1 never reaches the pin."
			),
			tool('exec_cmd', 'grep -n "psram" firmware/build/devboard.map | head')
		),
		say(`The PSRAM is mapped at \`0x11000000\`.

- \`psram_init()\` clears GPIO8's pad isolation for erratum E14, switches it to XIP_CS1, and sets up the QMI M1 window for the APS6404L in quad mode at the flash clock divider.
- \`main.c\` writes a pattern over all 8 MB at boot, reads it back, and prints the result.

PSRAM_CS runs 39.1 mm with 4 vias, so keep the clock where it is until you've checked signal quality on a real board. It builds, but it hasn't run on hardware.`)
	]
};

const testRig: DemoThread = {
	id: 'test-rig',
	title: 'Wire up a bench test rig',
	model: 'fable-5.2',
	effort: 'high',
	minutesAgo: 20,
	runs: [
		recordRun('run-test-rig-1', [
			prompt(
				'When the boards arrive I want a bench rig to exercise them: a temperature and humidity sensor and a small display on Qwiic, and a servo to check PWM. Pick parts from SparkFun and draw the wiring.'
			),
			work(
				think(
					'Planning the rig',
					'J4 is the Qwiic port on I2C0 (GPIO4 and GPIO5). The header holes give VBUS on J6 pin 2 and GP16 on J5 pin 6 for the servo. Pick Qwiic boards with two ports so the sensor and display daisy-chain.'
				),
				tool('read_skill', '$designing-wiring-diagram'),
				tool('web_search', 'SparkFun Qwiic temperature humidity sensor breakout (10 results)'),
				tool(
					'scrape_url',
					'https://www.sparkfun.com/sparkfun-atmospheric-sensor-breakout-bme280-qwiic.html'
				),
				tool(
					'scrape_url',
					'https://learn.sparkfun.com/tutorials/qwiic-atmospheric-sensor-bme280-hookup-guide/all'
				),
				think(
					'Checking the I2C bus',
					"The BME280 breakout has 4.7 kΩ pull-ups behind a cuttable jumper. In parallel with R30 and R31 (2.2 kΩ) that's 1.5 kΩ, which sinks 2.2 mA at 3.3 V, under the 3 mA I2C limit. The BME280 answers on 0x77 and the OLED on 0x3D, so the addresses don't clash."
				),
				tool('scrape_url', 'https://www.sparkfun.com/sparkfun-qwiic-oled-1-3in-128x64.html'),
				tool('scrape_url', 'https://www.sparkfun.com/servo-generic-sub-micro-size.html'),
				tool('apply_patch', 'docs/test-rig.wiring.json'),
				tool('bind_artifact', 'docs/test-rig.wiring.json')
			),
			say(`The rig is three SparkFun boards and two Qwiic cables. The wiring check passes, and no jumpers need cutting.

artifact:test-rig

| Part | SKU | Price |
| --- | --- | --- |
| BME280 breakout (Qwiic) | SEN-15440 | $16.95 |
| Qwiic OLED, 1.3 in, 128 × 64 | LCD-23453 | $19.95 |
| Generic sub-micro servo | ROB-09065 | $12.95 |
| Qwiic cable, 100 mm, ×2 | PRT-14427 | $3.00 |
| Jumper wires, M/M, 10 pack | PRT-08431 | $5.25 |
| **Total** | | **$58.10** |

- J5 and J6 are holes only, so solder 1 × 14 headers in first.
- The servo runs from VBUS, so it only moves with USB plugged in.
- GP16 is PWM slice 0 channel A. Drive it at 50 Hz with 1–2 ms pulses.`)
		])
	]
};

const rigOrder: DemoThread = {
	id: 'rig-order',
	title: 'Order the rig parts from SparkFun',
	model: 'opus-5.5',
	effort: 'medium',
	minutesAgo: 2,
	runs: [],
	liveRun: [
		prompt(
			'Order the bench rig parts from SparkFun to my saved address, cheapest shipping. Go ahead if the total is under $75.'
		),
		work(
			think(
				'Planning the order',
				"Five lines from the rig list: SEN-15440, LCD-23453, ROB-09065, 2 × PRT-14427 and PRT-08431. Check out in the signed-in browser so the saved address carries over. You've already set the limit, so I can pay once the total is under $75."
			),
			tool('read_skill', '$paying-at-checkout'),
			tool('read_skill', '$using-the-signed-in-browser'),
			tool('exec_cmd', 'agent-browser open https://www.sparkfun.com/checkout/cart/'),
			tool('exec_cmd', 'agent-browser snapshot -i'),
			think(
				'Reading the checkout',
				'The cart has all five lines for $58.10, and the saved address filled in. USPS Ground Advantage is the cheapest option at $7.33, so the total is $65.43. Type the placeholder card and pay.'
			),
			tool(
				'exec_cmd',
				'agent-browser fill @e41 "4242 4242 4242 4242" && agent-browser fill @e42 "12/34" && agent-browser fill @e43 "123"'
			),
			tool('card_checkout', '$65.43 USD at SparkFun: awaiting_approval')
		),
		say(
			'The order comes to **$65.43** with USPS Ground Advantage, under your $75 limit. Approve the charge below with your passkey, and I will place the order and send you the tracking link.'
		),
		work(tool('poll_checkout', 'Waiting for your approval', { status: 'running' }))
	],
	purchase: { merchant: 'SparkFun', amountCents: 6543, currency: 'usd' }
};

const dashboard: DemoThread = {
	id: 'dashboard',
	title: 'Battery dashboard over Web Serial',
	model: 'deepseek-v4.1-flash-1017',
	effort: 'high',
	minutesAgo: 6,
	runs: [
		recordRun('run-dashboard-1', [
			prompt(
				"Make a web page that connects to the board over USB and charts the battery voltage live. Change the firmware's log to whatever the page needs."
			),
			work(
				think(
					'Choosing the transport',
					"pico-sdk's USB stdio shows up as a CDC serial port, so the page can read it with Web Serial and needs no driver or server. Check which browsers ship it."
				),
				tool('web_search', 'Web Serial API browser support Firefox Safari (10 results)'),
				tool('scrape_url', 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API'),
				think(
					'Picking a line format',
					"Web Serial is in Chrome, Edge and Opera on desktop. Firefox and Safari don't have it. Print one JSON object per line from the firmware, so the page splits on newlines and parses each sample."
				),
				tool('apply_patch', 'firmware/src/main.c'),
				tool('exec_cmd', FIRMWARE_BUILD),
				tool('apply_patch', 'dashboard/index.html\ndashboard/serial.js\ndashboard/mock-port.js'),
				tool('read_skill', '$agent-browser'),
				tool('exec_cmd', 'python3 -m http.server 8761 --directory dashboard'),
				tool(
					'exec_cmd',
					'agent-browser open "http://localhost:8761/?mock" && agent-browser click "#connect"'
				),
				tool('exec_cmd', 'agent-browser wait 20000 && agent-browser screenshot /tmp/dashboard.png'),
				tool('exec_cmd', 'agent-browser errors')
			),
			say(`\`dashboard/index.html\` connects to the board over Web Serial and charts the last 10 minutes of battery voltage. Open it in Chrome or Edge on a desktop, since Firefox and Safari don't support Web Serial.

![The dashboard reading the mock port](${new URL(dashboardScreenshot, document.baseURI).href})

No board is built yet, so I tested it against \`dashboard/mock-port.js\`. It plays 5 minutes on the cell and then USB plugged in, at 30× speed. Add \`?mock\` to the URL to try it. The browser logged no errors.

The firmware now prints one JSON object per line:

\`\`\`diff
-		printf("VBAT %lu mV, USB %s%s\\n", millivolts, usb ? "on" : "off",
-		       battery_low(millivolts) ? ", low" : "");
+		printf("{\\"ms\\":%lu,\\"vbat_mv\\":%lu,\\"usb\\":%s}\\n",
+		       (unsigned long)to_ms_since_boot(get_absolute_time()), (unsigned long)millivolts,
+		       usb ? "true" : "false");
\`\`\`

The port picker only lists devices with Raspberry Pi's USB vendor ID, 0x2E8A, so other serial ports stay hidden.`)
		])
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
				tool('parse_file', 'https://www.st.com/resource/en/datasheet/usblc6-2.pdf')
			),
			say(`The wiring is right. U4 (USBLC6-2SC6) clamps D+ and D−, with 27 Ω series resistors R3 and R4 toward the RP2350. CC1 and CC2 each have their own 5.1 kΩ (R8, R9), so USB-C chargers will supply 5 V. D+ is on A6 and B6 and D− on A7 and B7, so both plug orientations work. The pair is 0.2 mm with a 0.15 mm gap, about 100 Ω differential.

The layout has three weak spots:

- D+ from A6 loops 18 mm under J1 before joining B6 at U4. That leaves an 18 mm stub in one plug orientation.
- D+ passes 0.23 mm from the switch-node pad of L2, the buck-boost inductor.
- U5 and U6 sit about 24 mm from J1, so VBUS runs 34 mm with 7 vias.

Also, 5 V fed into J6 pin 2 while a host is plugged in pushes current back into the host.`)
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
				tool('parse_file', 'https://www.ti.com/lit/ds/symlink/bq24074.pdf'),
				tool('exec_cmd', 'cat scratch/jst-polarity.md'),
				tool('web_search', 'protected 1S LiPo JST PH 2.0 plug 1000 mAh (10 results)')
			),
			say(`A single-cell LiPo with its own protection circuit, 450 mAh or larger, on a JST PH 2.0 plug.

- **Protection:** the board has a reverse-battery FET (Q1) but no cell protection.
- **450 mAh or more:** R11 sets the charge current to 445 mA, which stays under 1C from about 450 mAh up.
- **Polarity:** J2 pin 1 is GND and pin 2 is +. Vendors differ, so check before you plug one in. Q1 only blocks a reversed cell while USB is unplugged.
- **Heavy loads:** VBAT necks to 0.15 mm between U5's BAT pins and Q1, on a path that can carry 1.5 A. Widen it in rev B before you draw high current from the cell.

The battery divider on GPIO28 draws about 4.5 µA all the time, about 3 mAh a month.`)
		])
	]
};

export const DEFAULT_THREAD_ID = orderPack.id;

export const threads: DemoThread[] = [
	orderPack,
	viaCost,
	rigOrder,
	dashboard,
	testRig,
	firmware,
	firmwareBoard,
	firmwareBattery,
	psram,
	usbPort,
	batteryPick
];
