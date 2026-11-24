import { prompt, say, think, tool, work } from '../rows';
import type { DemoThread } from '../types';

const SCHEMATIC = 'hardware/rp2350-devboard.kicad_sch';
const BOARD = 'hardware/rp2350-devboard.kicad_pcb';

const ERC = `kicad-cli sch erc --format json --severity-all --exit-code-violations -o /tmp/erc.json ${SCHEMATIC}`;

const DRC = `kicad-cli pcb drc --format json --severity-all --schematic-parity --exit-code-violations -o /tmp/drc.json ${BOARD}`;

const FIRMWARE_BUILD = 'cmake -S firmware -B firmware/build && cmake --build firmware/build';

const boardBuild: DemoThread = {
	id: 'board-build',
	title: 'Build the RP2350 dev board',
	model: 'opus-5.5',
	effort: 'high',
	minutesAgo: 1,
	steps: [
		prompt(
			'Design an RP2350 dev board with Wi-Fi, USB-C, LiPo charging, 8 MB PSRAM and microSD. Lay it out for PCBWay turnkey assembly and get me a quote for 1 and 5 boards.'
		),
		work(
			think(
				'Planning the board',
				'RP2350A with 16 MB flash and an APS6404L on QSPI CS1. A Raspberry Pi RM2 wired like the Pico 2 W gives Wi-Fi without RF layout. A BQ24074 charger with power path feeds a TPS63001 buck-boost, so 3V3 holds down to a 3.0 V cell. Four layers, every part on the top side so PCBWay assembles one side only.'
			),
			tool('read_skill', '$designing-pcbs'),
			tool('read_skill', '$selecting-hardware-parts'),
			tool(
				'lookup_parts',
				'RP2350A, RMC20452T, W25Q128JVSIQ, APS6404L-3SQR-SN, BQ24074RGTR, TPS63001DRCR, USB4105-GF-A'
			),
			tool(
				'apply_patch',
				'hardware/rp2350-devboard.kicad_sch\nhardware/mcu.kicad_sch\nhardware/memory.kicad_sch\nhardware/power.kicad_sch\nhardware/wireless.kicad_sch\nhardware/io.kicad_sch'
			),
			tool('exec_cmd', ERC),
			think(
				'Placing the parts',
				'28 × 78.54 mm with 2×14 header holes. USB-C and the charger at one end, the RM2 antenna clear of copper at the other, and the RP2350 in the middle with its decoupling caps on the pins.'
			),
			tool('apply_patch', BOARD),
			tool('exec_cmd', DRC),
			think(
				'Reading the reports',
				"ERC: 0 errors, 0 warnings. DRC: 0 errors, 0 unconnected items, and the board matches the schematic. The only note is R7: its silk line touched U3's pin-1 mark and was trimmed, so it no longer matches its library footprint."
			)
		),
		say('The schematic and layout are done, and ERC and DRC are both clean. Pricing the BOM next.'),
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
				'5 PCBs at 28 × 78.54 mm, 4 layers, ENIG: $156.77, including resin-filled, capped vias for the vias in the fine-pitch pads. Assembly is the $88.00 minimum for one board and for five, since there are 82 SMD parts and no through-hole joints. The $29 new-customer promo would apply too. Quote without it.'
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

kicad:hardware/rp2350-devboard.kicad_pro`)
	]
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
	steps: [
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
			tool('apply_patch', 'firmware/CMakeLists.txt\nfirmware/src/main.c\nfirmware/src/ws2812.pio'),
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
	]
};

const firmwareBoard: DemoThread = {
	id: 'firmware-board',
	parentId: 'firmware',
	title: 'Board header for pico-sdk',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 49,
	steps: [
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
	]
};

const firmwareBattery: DemoThread = {
	id: 'firmware-battery',
	parentId: 'firmware',
	title: 'Battery voltage on GPIO28',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 50,
	steps: [
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
	]
};

const usbPort: DemoThread = {
	id: 'usb-port',
	title: 'Check the USB-C port',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	settled: true,
	minutesAgo: 60 * 26,
	steps: [
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
	]
};

const batteryPick: DemoThread = {
	id: 'battery-pick',
	title: 'Pick a battery for J2',
	model: 'sonnet-5.5',
	effort: 'high',
	settled: true,
	minutesAgo: 60 * 50,
	steps: [
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
	]
};

export const DEFAULT_THREAD_ID = boardBuild.id;

export const threads: DemoThread[] = [
	boardBuild,
	firmware,
	firmwareBoard,
	firmwareBattery,
	usbPort,
	batteryPick
];
