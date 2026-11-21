import type { ArtifactContent, ArtifactEntry } from '$lib/chat/artifacts';
import { artifactPreviewType } from '$lib/chat/artifact-preview';
import type { Project } from '$lib/types/sprocket';
import type { WorkspaceFiles } from '../workspace-api';

export const project: Project = {
	repositoryKey: 'github.com/maker/rp2350-devboard',
	displayName: 'rp2350-devboard',
	workspacePath: '/home/maker/rp2350-devboard',
	localAttachmentAvailability: 'available'
};

const BOM = `# RP2350 Wi-Fi dev board BOM (rev A)

Distributor list prices. "1 board" and "5 boards" are what you pay after minimum order quantities, so cheap passives cost the same for both. The BOM has 40 lines. The fiducials and header holes are not placed, and the other 38 are priced at LCSC.

| Ref(s) | Qty | Part | MPN | LCSC | 1 board | 5 boards |
| --- | --- | --- | --- | --- | --- | --- |
| C1–C11, C17, C18, C22, C24, C28, C29, C31, C32 | 19 | 100 nF 0402 | CL05B104KO5NNNC | C1525 | 0.24 | 0.24 |
| C12–C14 | 3 | 4.7 µF 0402 | CL05A475MP5NRNC | C23733 | 0.57 | 0.57 |
| C15, C16 | 2 | 15 pF 0402 | CL05C150JB5NNNC | C86285 | 0.62 | 0.62 |
| C19 | 1 | 4.7 µF 25 V 0805 | CL21A475KAQNNNE | C1779 | 0.69 | 0.69 |
| C20, C21, C23, C27, C30 | 5 | 10 µF 0603 | CL10A106KP8NNNC | C19702 | 0.47 | 0.59 |
| C25, C26 | 2 | 22 µF 0805 | CL21A226MAQNNNE | C45783 | 2.19 | 2.19 |
| D1 | 1 | Orange LED 0603, charging | LTST-C191KFKT | C160478 | 0.57 | 0.57 |
| D3 | 1 | RGB LED, WS2812B-2020 | WS2812B-2020-V6 | C52917434 | 0.43 | 0.43 |
| J1 | 1 | USB-C receptacle, USB 2.0 | USB4105-GF-A | C3020560 | 1.03 | 5.15 |
| J2 | 1 | JST PH 2-pin, LiPo | S2B-PH-SM4-TB(LF)(SN) | C295747 | 1.03 | 1.03 |
| J3 | 1 | microSD socket | 1040310811 | C585350 | 0.68 | 3.42 |
| J4 | 1 | JST SH 4-pin, Qwiic | SM04B-SRSS-TB(LF)(SN) | C160404 | 1.08 | 1.08 |
| L1 | 1 | 3.3 µH, RP2350 core regulator | AOTA-B201610S3R3-101-T | C42411119 | 1.70 | 1.70 |
| L2 | 1 | 2.2 µH, buck-boost | DFE252012F-2R2M=P2 | C576403 | 0.75 | 0.75 |
| Q1 | 1 | P-FET, reverse battery | DMG2305UX-7 | C150470 | 0.51 | 2.54 |
| Q2 | 1 | N-FET, battery divider switch | DMG1012T-7 | C20512 | 0.45 | 0.45 |
| R1 | 1 | 33 Ω 0402 | RC0402FR-0733RL | C138002 | 0.27 | 0.27 |
| R2, R5, R13 | 3 | 1 kΩ 0402 | RC0402FR-071KL | C106235 | 0.17 | 0.17 |
| R3, R4 | 2 | 27 Ω 0402 | RC0402FR-0727RL | C138021 | 0.40 | 0.40 |
| R6, R12, R20, R24–R28 | 8 | 10 kΩ 0402 | RC0402FR-0710KL | C60490 | 0.16 | 0.16 |
| R7, R30, R31 | 3 | 2.2 kΩ 0402 | RC0402FR-072K2L | C114762 | 0.14 | 0.14 |
| R8, R9 | 2 | 5.1 kΩ 0402 | RC0402FR-075K1L | C105872 | 0.28 | 0.28 |
| R10 | 1 | 1.74 kΩ 0402 | RC0402FR-071K74L | C163482 | 0.20 | 0.20 |
| R11 | 1 | 2 kΩ 0402 | RC0402FR-072KL | C60488 | 0.12 | 0.12 |
| R14, R15 | 2 | 470 kΩ 0402 | RC0402FR-07470KL | C137976 | 0.13 | 0.13 |
| R16 | 1 | 100 Ω 0402 | RC0402FR-07100RL | C106232 | 0.17 | 0.17 |
| R17, R18, R22, R29 | 4 | 100 kΩ 0402 | RC0402FR-07100KL | C60491 | 0.22 | 0.22 |
| R19 | 1 | 470 Ω 0402 | RC0402FR-07470RL | C114877 | 0.17 | 0.17 |
| R23 | 1 | 150 kΩ 0402 | RC0402FR-07150KL | C93947 | 0.21 | 0.21 |
| SW1, SW2 | 2 | Tactile switch, BOOTSEL and RESET | PTS810SJM250SMTRLFS | C116501 | 1.17 | 4.64 |
| U1 | 1 | RP2350A, QFN-60 | RP2350A | C42411118 | 1.31 | 6.53 |
| U2 | 1 | 16 MB QSPI flash, SOIC-8 | W25Q128JVSIQ | C97521 | 2.28 | 11.41 |
| U3 | 1 | 8 MB QSPI PSRAM, SOIC-8 | APS6404L-3SQR-SN | C5333729 | 4.01 | 20.06 |
| U4 | 1 | USB ESD protection, SOT-23-6 | USBLC6-2SC6 | C7519 | 0.79 | 0.79 |
| U5 | 1 | Li-ion charger with power path | BQ24074RGTR | C54313 | 2.14 | 10.70 |
| U6 | 1 | 3.3 V buck-boost, VSON-10 | TPS63001DRCR | C28060 | 1.64 | 8.19 |
| U7 | 1 | Raspberry Pi RM2 radio | RMC20452T | C49451547 | 6.61 | 33.03 |
| Y1 | 1 | 12 MHz crystal, 3225 | ABM8-272-T3 | C20625731 | 2.00 | 2.00 |
| FID1–FID3 | 3 | Fiducial, copper only | | | Not placed | |
| J5, J6 | 2 | 1×14 header holes, 2.54 mm | | | Not placed | |

All 38 placed lines are in stock. Parts come to **$37.60** for one board and **$122.01** for five.

## Board cost

PCBWay instant quote: standard build, ENIG, turnkey assembly on the top side. Shipping is not included. PCBWay makes at least 5 bare PCBs, so one board means 5 PCBs with 1 assembled.

| | 1 board | 5 boards |
| --- | --- | --- |
| PCB, 5 bare boards | $156.77 | $156.77 |
| Turnkey assembly | $88.00 | $88.00 |
| Parts | $37.60 | $122.01 |
| **Total** | **$282.37** | **$366.78** ($73.36 each) |

The PCB price is $32.20 for the base build, $29.84 for ENIG and $94.73 for resin-filled, capped vias. 82 vias sit in or touch SMD pads, so the vias have to be filled. With tented vias the PCB would be $62.04. The 5/5 mil tracks and 0.2 mm holes add nothing.

Assembly is PCBWay's $88 minimum at both quantities: 82 SMD parts on 38 lines, no through-hole joints.

## Notes for the order

- **C25, C26**: Digi-Key lists CL21A226MAQNNNE as discontinued. LCSC still stocks it. Any 22 µF 0805 X5R rated 25 V fits.
- **L1**: stock is thin. Any 2016 (0806) 3.3 µH molded inductor rated 1 A or more with DCR of 150 mΩ or less is a drop-in substitute.
- **J5, J6, FID1–FID3**: do not place.
`;

const ASSEMBLY = `# Assembly and bring-up: RP2350 Wi-Fi dev board rev A

No board has been built yet. Every check so far is ERC, DRC and datasheet review.

## Ordering from PCBWay

Upload \`fab/rp2350-devboard-gerbers.zip\`, \`fab/rp2350-devboard-bom-pcbway.csv\` and \`fab/rp2350-devboard-centroid.csv\`.

| Setting | Value |
| --- | --- |
| Layers | 4 |
| Size | 28 × 78.54 mm |
| Thickness | 1.6 mm, PCBWay standard stackup |
| Copper | 1 oz outer, 0.5 oz or 1 oz inner |
| Min track / spacing | 5 mil (0.127 mm) |
| Min hole | 0.2 mm for the thermal vias under U1, U5 and U6, 0.3 mm elsewhere |
| Surface finish | ENIG, for the 0.4 mm QFN and the RM2 castellations |
| Via process | All vias filled with resin and capped (IPC-4761 Type VII) |
| Assembly | Turnkey, top side only, with stencil |

The via process is required. 82 vias sit in or touch SMD pads, and open barrels would wick solder away from the joints. The Gerbers can't carry this, so select it on the order form and repeat it in the order remarks.

Check PCBWay's rotation preview against the pin 1 marks, especially U1, U5, U6, U7 and D3. Don't place J5, J6 or FID1–FID3.

## Part notes

- U1, U5 and U6 have exposed pads with thermal vias. Ask for windowed paste on the pads, as in the paste layer.
- U7 (RM2) is a castellated module. Nothing may sit beside the antenna end at the top edge.
- J1's four shell tabs carry the plug's load. Solder them fully.
- J2 pin 1 is GND and pin 2 is battery +. Check the cell's wiring before you plug it in.

## Bring-up

1. Inspect U1, U5 and U6 for bridges, and J1's contacts under magnification.
2. With no battery, power from a USB supply limited to 100 mA. Idle current should be a few tens of mA.
3. Measure 3.3 V on J5 pin 2 and about 4.4 V on VSYS at C20. The orange charge LED stays off with no battery.
4. Hold BOOTSEL and plug into a computer. The \`RP2350\` drive appears.
5. Copy \`firmware/build/devboard.uf2\` to the drive. The RGB LED blinks once a second and the serial port prints the battery voltage.
6. Plug in a LiPo. The charge LED lights while charging.
7. Unplug USB. The board keeps running from the cell.

## Known issues

- **VBAT neck**: the battery current from U5's BAT pins passes through 0.15 mm of track, then 0.4 mm on In2. That is too narrow for 1.5 A.
- **Long QSPI and SD routes**: QSPI_SD3 is 65.5 mm with 8 vias against 9.3 mm direct. SD_CLK is 87 mm and SD_D3 98 mm. Check signal quality before raising the QSPI or SD clock.
- **USB D+ stub**: D+ from J1 A6 loops 18 mm under the receptacle, which leaves an 18 mm stub in one plug orientation.
- **No WL_GPIO0 LED**: \`Pin("LED")\` on stock \`pico2_w\` firmware lights nothing. Use the WS2812B on GPIO22.
- **Back-feed**: 5 V fed into J6 pin 2 while a USB host is plugged in pushes current back into the host.
- **Reversed cell with USB**: Q1 only blocks a reversed cell when USB is unplugged.
`;

const kicadFiles = {
	'hardware/rp2350-devboard.kicad_pro': () => import('./kicad/rp2350-devboard.kicad_pro?raw'),
	'hardware/rp2350-devboard.kicad_sch': () => import('./kicad/rp2350-devboard.kicad_sch?raw'),
	'hardware/io.kicad_sch': () => import('./kicad/io.kicad_sch?raw'),
	'hardware/mcu.kicad_sch': () => import('./kicad/mcu.kicad_sch?raw'),
	'hardware/memory.kicad_sch': () => import('./kicad/memory.kicad_sch?raw'),
	'hardware/power.kicad_sch': () => import('./kicad/power.kicad_sch?raw'),
	'hardware/wireless.kicad_sch': () => import('./kicad/wireless.kicad_sch?raw')
};

const textFiles = {
	'README.md': `# rp2350-devboard

A 28 × 78.54 mm, 4-layer RP2350A board with Wi-Fi and Bluetooth, a LiPo charger and microSD, laid out for PCBWay turnkey assembly. Every fitted part is on the top side.

| Block | Part |
| --- | --- |
| MCU | RP2350A (U1), 16 MB flash (U2), 8 MB PSRAM on GPIO8 (U3) |
| Radio | Raspberry Pi RM2 (U7), wired like the Pico 2 W |
| Power | USB-C (J1), BQ24074 charger with power path (U5), TPS63001 3.3 V buck-boost (U6) |
| Battery | JST PH 2-pin (J2), reverse-battery FET (Q1), VBAT/2 on GPIO28 |
| I/O | microSD on GPIO9–15, Qwiic on GPIO4/5, WS2812B on GPIO22, 2×14 header holes |

- \`hardware/\`: KiCad project (5 sheets) and BOM
- \`firmware/\`: pico-sdk bring-up firmware
- \`docs/\`: assembly and bring-up notes

One assembled board costs $282.37 from PCBWay, or $73.36 each for five.
`,
	'hardware/bom.md': BOM,
	'docs/assembly.md': ASSEMBLY,
	'firmware/CMakeLists.txt': `cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD rp2350_devboard)
set(PICO_BOARD_HEADER_DIRS \${CMAKE_CURRENT_LIST_DIR}/boards)

include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(devboard C CXX ASM)
pico_sdk_init()

add_executable(devboard src/main.c src/battery.c)
pico_generate_pio_header(devboard \${CMAKE_CURRENT_LIST_DIR}/src/ws2812.pio)
target_link_libraries(devboard pico_stdlib pico_cyw43_arch_none hardware_adc hardware_pio)
pico_enable_stdio_usb(devboard 1)
pico_add_extra_outputs(devboard)
`,
	'firmware/boards/rp2350_devboard.h': `// Based on pico2_w.h. RM2 WL_GPIO0 is not connected, so there is no
// CYW43 LED. GPIO29 is only WL_CLK, so there is no VSYS sense.

#ifndef _BOARDS_RP2350_DEVBOARD_H
#define _BOARDS_RP2350_DEVBOARD_H

pico_board_cmake_set(PICO_PLATFORM, rp2350)
pico_board_cmake_set(PICO_CYW43_SUPPORTED, 1)

#define PICO_RP2350A 1

#define PICO_DEFAULT_UART 0
#define PICO_DEFAULT_UART_TX_PIN 0
#define PICO_DEFAULT_UART_RX_PIN 1

#define PICO_DEFAULT_I2C 0
#define PICO_DEFAULT_I2C_SDA_PIN 4
#define PICO_DEFAULT_I2C_SCL_PIN 5

#define PICO_DEFAULT_WS2812_PIN 22

#define DEVBOARD_PSRAM_CS_PIN 8
#define DEVBOARD_SD_DET_PIN 9
#define DEVBOARD_VBAT_PIN 28
#define DEVBOARD_VBAT_ADC_INPUT 2

#define PICO_BOOT_STAGE2_CHOOSE_W25Q080 1
#define PICO_FLASH_SPI_CLKDIV 2
pico_board_cmake_set_default(PICO_FLASH_SIZE_BYTES, (16 * 1024 * 1024))
#define PICO_FLASH_SIZE_BYTES (16 * 1024 * 1024)

#define CYW43_WL_GPIO_COUNT 3
#define CYW43_WL_GPIO_SMPS_PIN 1
#define CYW43_WL_GPIO_VBUS_PIN 2
#define CYW43_PIN_WL_DYNAMIC 0
#define CYW43_DEFAULT_PIN_WL_REG_ON 23u
#define CYW43_DEFAULT_PIN_WL_DATA_OUT 24u
#define CYW43_DEFAULT_PIN_WL_DATA_IN 24u
#define CYW43_DEFAULT_PIN_WL_HOST_WAKE 24u
#define CYW43_DEFAULT_PIN_WL_CLOCK 29u
#define CYW43_DEFAULT_PIN_WL_CS 25u

pico_board_cmake_set_default(PICO_RP2350_A2_SUPPORTED, 1)
#define PICO_RP2350_A2_SUPPORTED 1

#endif
`,
	'firmware/src/main.c': `#include <stdio.h>
#include "battery.h"
#include "hardware/pio.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "ws2812.pio.h"

// The PIO shifts out the top 24 bits in GRB order.
#define GREEN 0x10000000u

int main(void) {
	stdio_init_all();
	battery_init();

	if (cyw43_arch_init()) {
		printf("RM2 did not start\\n");
		return 1;
	}

	const uint offset = pio_add_program(pio0, &ws2812_program);
	ws2812_program_init(pio0, 0, offset, PICO_DEFAULT_WS2812_PIN, 800000, false);

	bool led = false;

	while (true) {
		const uint32_t millivolts = battery_millivolts();
		const bool usb = cyw43_arch_gpio_get(CYW43_WL_GPIO_VBUS_PIN);

		printf("VBAT %lu mV, USB %s%s\\n", millivolts, usb ? "on" : "off",
		       battery_low(millivolts) ? ", low" : "");
		led = !led;
		pio_sm_put_blocking(pio0, 0, led ? GREEN : 0);
		sleep_ms(1000);
	}
}
`,
	'firmware/src/ws2812.pio': `; From pico-examples pio/ws2812.
.program ws2812
.side_set 1

.define public T1 3
.define public T2 3
.define public T3 4

.wrap_target
bitloop:
    out x, 1       side 0 [T3 - 1]
    jmp !x do_zero side 1 [T1 - 1]
do_one:
    jmp  bitloop   side 1 [T2 - 1]
do_zero:
    nop            side 0 [T2 - 1]
.wrap

% c-sdk {
#include "hardware/clocks.h"

static inline void ws2812_program_init(PIO pio, uint sm, uint offset, uint pin, float freq, bool rgbw) {
    pio_gpio_init(pio, pin);
    pio_sm_set_consecutive_pindirs(pio, sm, pin, 1, true);

    pio_sm_config c = ws2812_program_get_default_config(offset);
    sm_config_set_sideset_pins(&c, pin);
    sm_config_set_out_shift(&c, false, true, rgbw ? 32 : 24);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);

    int cycles_per_bit = ws2812_T1 + ws2812_T2 + ws2812_T3;
    float div = clock_get_hz(clk_sys) / (freq * cycles_per_bit);
    sm_config_set_clkdiv(&c, div);

    pio_sm_init(pio, sm, offset, &c);
    pio_sm_set_enabled(pio, sm, true);
}
%}
`,
	'firmware/src/battery.h': `#pragma once
#include <stdbool.h>
#include <stdint.h>

void battery_init(void);
uint32_t battery_millivolts(void);
bool battery_low(uint32_t millivolts);
`,
	'firmware/src/battery.c': `#include "battery.h"
#include "hardware/adc.h"
#include "pico/stdlib.h"

// U6 holds 3V3 down to a 3.0 V cell. Flag low with some margin above that.
#define LOW_MILLIVOLTS 3300

void battery_init(void) {
	adc_init();
	// Turns the digital input off, which RP2350 erratum E9 needs on a 235 kΩ source.
	adc_gpio_init(DEVBOARD_VBAT_PIN);
}

// R14 and R15 halve the cell voltage. Q2 connects them while 3V3 is up.
uint32_t battery_millivolts(void) {
	adc_select_input(DEVBOARD_VBAT_ADC_INPUT);

	return 2u * adc_read() * 3300u / 4096u;
}

bool battery_low(uint32_t millivolts) {
	return millivolts < LOW_MILLIVOLTS;
}
`
};

export const workspaceFiles: WorkspaceFiles = {
	...Object.fromEntries(Object.entries(textFiles).map(([path, text]) => [path, async () => text])),
	...Object.fromEntries(
		Object.entries(kicadFiles).map(([path, load]) => [path, async () => (await load()).default])
	)
};

export const artifacts: ArtifactEntry[] = [
	{ key: 'bom', title: 'rp2350-devboard-bom.md' },
	{ key: 'bring-up', title: 'rp2350-devboard-bring-up.md' }
].map((artifact) => ({ ...artifact, artifactType: artifactPreviewType(artifact.title) }));

export const artifactContents = new Map<string, ArtifactContent>([
	['bom', { status: 'ready', content: BOM, sourcePath: 'hardware/bom.md' }],
	['bring-up', { status: 'ready', content: ASSEMBLY, sourcePath: 'docs/assembly.md' }]
]);
