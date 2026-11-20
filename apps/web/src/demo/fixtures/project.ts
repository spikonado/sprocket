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

Distributor list prices. "1 board" and "5 boards" are what you pay after minimum order quantities, so cheap passives cost the same for both. LCSC has no listing for D2, D3, D4, J6 and J7, so those are Digi-Key prices. Fiducials and PWR_FLAGs are skipped.

| Ref(s) | Qty | Part | MPN | Source | Unit (USD) | 1 board | 5 boards |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1, C2, C3, C5 | 4 | 10 µF 0603 | GRM188R61E106MA73D | LCSC C91606 | 0.1133 | 0.57 | 2.27 |
| C4, C23 | 2 | 1 µF 0402 | GRM155R61C105KA12D | LCSC C77006 | 0.0153 | 0.77 | 0.77 |
| C6, C7, C8, C24 | 4 | 4.7 µF 0402 | GRM155R60J475ME47D | LCSC C82453 | 0.0160 | 0.80 | 0.80 |
| C9–C19, C22, C25, C26, C28–C30 | 17 | 100 nF 0402 | GRM155R71C104KA88D | LCSC C71629 | 0.0036 | 0.36 | 0.36 |
| C20, C21 | 2 | 15 pF 0402 | GRM1555C1H150JA01D | LCSC C76950 | 0.0068 | 0.68 | 0.68 |
| C27 | 1 | 10 µF 0402 | GRM155R60J106ME15D | LCSC C412251 | 0.0584 | 0.58 | 0.58 |
| D1 | 1 | RGB LED, WS2812B-2020 | WS2812B-2020-V6 | LCSC C52917434 | 0.0852 | 0.43 | 0.43 |
| D2, D4 | 2 | Green LED 0603 | 150060GS75000 | Digi-Key | 0.1500 | 0.30 | 1.50 |
| D3 | 1 | Amber LED 0603 | 150060AS75000 | Digi-Key | 0.1500 | 0.15 | 0.75 |
| J1 | 1 | USB-C receptacle, USB 2.0 | USB4105-GF-A | LCSC C3020560 | 1.0307 | 1.03 | 5.15 |
| J2 | 1 | JST PH 2-pin, battery | S2B-PH-SM4-TB | LCSC C295747 | 0.2284 | 1.14 | 1.14 |
| J3 | 1 | JST SH 4-pin, Qwiic | SM04B-SRSS-TB | LCSC C160404 | 0.2167 | 1.08 | 1.08 |
| J4 | 1 | JST SH 3-pin, debug | SM03B-SRSS-TB | LCSC C160403 | 0.4791 | 2.40 | 2.40 |
| J5 | 1 | microSD socket | DM3AT-SF-PEJM5 | LCSC C114218 | 1.4040 | 1.40 | 7.02 |
| J6, J7 | 2 | 1×12 header 2.54 mm | 61301211121 | Digi-Key | 0.5400 | 1.08 | 4.60 |
| L1 | 1 | 3.3 µH inductor, core regulator | AOTA-B201610S3R3-101-T | LCSC C42411119 | 0.3398 | 1.70 | 1.70 |
| R1, R2 | 2 | 5.1 kΩ 1% 0402 | RC0402FR-075K1L | LCSC C105872 | 0.0028 | 0.28 | 0.28 |
| R3, R4 | 2 | 27 Ω 1% 0402 | RC0402FR-0727RL | LCSC C138021 | 0.0040 | 0.40 | 0.40 |
| R5 | 1 | 1.5 kΩ 1% 0402 | RC0402FR-071K5L | LCSC C114759 | 0.0022 | 0.22 | 0.22 |
| R6 | 1 | 1.8 kΩ 1% 0402 | RC0402FR-071K8L | LCSC C163481 | 0.0034 | 0.34 | 0.34 |
| R7, R18, R21, R24–R28 | 8 | 10 kΩ 1% 0402 | RC0402FR-0710KL | LCSC C60490 | 0.0016 | 0.16 | 0.16 |
| R8, R9, R12, R13, R14 | 5 | 100 kΩ 1% 0402 | RC0402FR-07100KL | LCSC C60491 | 0.0022 | 0.22 | 0.22 |
| R10, R11, R19, R22, R23 | 5 | 2.2 kΩ 1% 0402 | RC0402FR-072K2L | LCSC C114762 | 0.0028 | 0.28 | 0.28 |
| R15 | 1 | 33 Ω 1% 0402 | RC0402FR-0733RL | LCSC C138002 | 0.0027 | 0.27 | 0.27 |
| R16, R17 | 2 | 1 kΩ 1% 0402 | RC0402FR-071KL | LCSC C106235 | 0.0020 | 0.20 | 0.20 |
| R20, R29 | 2 | 470 Ω 1% 0402 | RC0402FR-07470RL | LCSC C114877 | 0.0017 | 0.17 | 0.17 |
| R30, R31 | 2 | 100 Ω 1% 0402 | RC0402FR-07100RL | LCSC C106232 | 0.0017 | 0.17 | 0.17 |
| SW1 | 1 | Tactile switch, BOOT | PTS810 SJM 250 SMTR LFS | LCSC C116501 | 0.6595 | 0.66 | 3.30 |
| SW2 | 1 | Tactile switch, RESET | PTS810 SJM 250 SMTR LFS | LCSC C116501 | 0.6595 | 0.66 | 3.30 |
| U1 | 1 | RP2350A, QFN-60 | SC1509-A4 | LCSC C42411118 | 1.3065 | 1.31 | 6.53 |
| U2 | 1 | 16 MB QSPI flash, WSON-8 | W25Q128JVPIQ | LCSC C190862 | 3.2869 | 3.29 | 16.43 |
| U3 | 1 | 8 MB QSPI PSRAM, SOP-8 | APS6404L-3SQR-SN | LCSC C5333729 | 4.0125 | 4.01 | 20.06 |
| U4 | 1 | Li-ion charger with power path | BQ24074RGTR | LCSC C54313 | 2.1391 | 2.14 | 10.70 |
| U5 | 1 | 3.3 V 1 A LDO, SOT-23-5 | TLV75733PDBVR | LCSC C485517 | 0.2098 | 1.05 | 1.05 |
| U6 | 1 | USB ESD protection, SOT-23-6 | USBLC6-2SC6 | LCSC C7519 | 0.1639 | 0.82 | 0.82 |
| U7 | 1 | Raspberry Pi RM2 radio | SC1169 | LCSC C49451547 | 6.6068 | 6.61 | 33.03 |
| Y1 | 1 | 12 MHz crystal, 3225 | ABM8-272-T3 | LCSC C20625731 | 0.4001 | 2.00 | 2.00 |

All 37 lines are in stock. Parts come to **$39.73** for one board and **$131.16** for five.

## Board cost

PCBWay instant quote: standard build, ENIG, turnkey assembly on the top side. Shipping is not included. PCBWay makes at least 5 bare PCBs, so one board means 5 PCBs with 1 assembled.

| | 1 board | 5 boards |
| --- | --- | --- |
| PCB, 5 bare boards | $62.04 | $62.04 |
| Turnkey assembly | $88.00 | $88.50 |
| Parts | $39.73 | $131.16 |
| **Total** | **$189.77** | **$281.70** ($56.34 each) |

The PCB price is $32.20 for the base build plus $29.84 for ENIG. The 5/5 mil tracks and 0.25 mm holes add nothing.

## Notes for the order

- **U5**: Diodes AP2112K-3.3TRG1 is an approved alternate with the same SOT-23-5 pinout.
- **Passives**: substitutes are allowed at the same value, size, voltage and dielectric.
- **U1, U7**: ask for X-ray. It has no price in the instant quote.
`;

const BRING_UP = `# Ordering and bring-up: RP2350 Wi-Fi dev board rev A

No board has been built yet. Every check so far is ERC, DRC and datasheet review.

## Ordering from PCBWay

Upload \`fab/rp2350-devboard-gerbers.zip\`, \`fab/bom-pcbway.csv\` and \`fab/centroid-top.csv\`.

| Setting | Value |
| --- | --- |
| Layers | 4, F.Cu / In1.Cu / In2.Cu / B.Cu |
| Thickness | 1.6 mm, standard stackup, 1 oz on all layers |
| Min track / spacing | 5/5 mil |
| Min hole | 0.25 mm |
| Surface finish | ENIG |
| Assembly | Turnkey, top side only |
| X-ray | Ask for it on U1 (QFN-60) and U7 (RM2, LGA pads) |

Paste this into the order notes:

> Machine placement and reflow please, no hand soldering of U1. J1 shell legs are plated through-hole: pin-in-paste or hand solder. J6 and J7 are 1x12 headers fitted on the bottom side, pins pointing down, soldered from the top. L1 is polarised: dot to pad 1, marked on silkscreen. Please quote X-ray for U1 and U7.

## When the boards arrive

1. **Inspect** J6 and J7: they belong on the bottom, pins down, 22.86 mm apart so the board fits a breadboard.
2. **Check L1.** The dot on the inductor must sit at pad 1 (+1V1). This was checked against the footprint, not a physical part.
3. **Check the battery lead** before plugging it into J2. Pin 1 is +. Many third-party cells have red and black swapped.

## First power

1. Plug in USB-C with no battery. The green power-good LED should light.
2. Measure 3V3 on J7.1 and VSYS on J6.2. On USB the charger regulates VSYS to 4.4 V.
3. Hold BOOT, tap RST and release BOOT. The RP2350 should appear as a USB drive.
4. Copy \`firmware/build/devboard.uf2\` to the drive. The green LED on the RM2 should blink once a second, and the serial port should print the battery voltage.
5. Fit a protected cell of 500 mAh or more. The amber LED shows charging.

## Known issues

- **Charger heat**: U4's thermal pad has no vias. The BQ24074 can dissipate about 0.9 W charging a low cell, so expect it to throttle the charge current.
- **USB-only power**: the charger limits USB input to 500 mA. Without a battery, Wi-Fi transmit, SD writes and the RGB LED together can brown out 3V3.
- **Low battery**: 3V3 drops out of regulation below about 3.5 V. Firmware stops Wi-Fi and SD writes near 3.4 V.
- **Back-feed**: don't feed 3V3 from J7.1 or the Qwiic port. 5 V fed into J6.1 back-feeds a connected USB host.
- **No battery protection** on the board, and no ESD protection on the Qwiic, debug or microSD lines.
- **Not verified**: DM3AT card-detect pin numbering (the pins are unused) and PTS810 pad pairing.
`;

const kicadFiles = {
	'hardware/rp2350-devboard.kicad_pro': () => import('./kicad/rp2350-devboard.kicad_pro?raw'),
	'hardware/rp2350-devboard.kicad_sch': () => import('./kicad/rp2350-devboard.kicad_sch?raw')
};

const textFiles = {
	'README.md': `# rp2350-devboard

A 76.2 × 25.4 mm, 4-layer RP2350A board with Wi-Fi and Bluetooth, laid out for PCBWay turnkey assembly. It plugs into a breadboard.

| Block | Part |
| --- | --- |
| MCU | RP2350A, 16 MB flash, 8 MB PSRAM on GPIO8 |
| Radio | Raspberry Pi RM2 (CYW43439), wired like the Pico 2 W |
| Power | USB-C, BQ24074 charger with power path, TLV75733 3.3 V LDO |
| Battery | JST PH 2-pin, VBAT/2 on GPIO28 |
| I/O | microSD, Qwiic on GPIO4/5, debug, WS2812B on GPIO9, 2×12 headers |

- \`hardware/\`: KiCad schematic and BOM
- \`firmware/\`: pico-sdk bring-up firmware
- \`docs/\`: ordering and bring-up notes

One assembled board costs $189.77 from PCBWay, or $56.34 each for five.
`,
	'hardware/bom.md': BOM,
	'docs/bring-up.md': BRING_UP,
	'firmware/CMakeLists.txt': `cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD rp2350_devboard)
set(PICO_BOARD_HEADER_DIRS \${CMAKE_CURRENT_LIST_DIR}/boards)

include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(devboard C CXX ASM)
pico_sdk_init()

add_executable(devboard src/main.c src/battery.c)
target_link_libraries(devboard pico_stdlib pico_cyw43_arch_none hardware_adc)
pico_enable_stdio_usb(devboard 1)
pico_add_extra_outputs(devboard)
`,
	'firmware/boards/rp2350_devboard.h': `// Based on pico2_w.h. RM2 GPIO1 and GPIO2 are not connected, so there is no
// SMPS mode pin, no VBUS sense and no VSYS sense on GPIO29.

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

#define PICO_DEFAULT_WS2812_PIN 9

#define DEVBOARD_PSRAM_CS_PIN 8
#define DEVBOARD_VBAT_PIN 28
#define DEVBOARD_VBAT_ADC_INPUT 2

#define PICO_BOOT_STAGE2_CHOOSE_W25Q080 1
#define PICO_FLASH_SPI_CLKDIV 2
pico_board_cmake_set_default(PICO_FLASH_SIZE_BYTES, (16 * 1024 * 1024))
#define PICO_FLASH_SIZE_BYTES (16 * 1024 * 1024)

#define CYW43_WL_GPIO_COUNT 3
#define CYW43_WL_GPIO_LED_PIN 0
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
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

int main(void) {
	stdio_init_all();
	battery_init();

	if (cyw43_arch_init()) {
		printf("RM2 did not start\\n");
		return 1;
	}

	bool led = false;

	while (true) {
		const uint32_t millivolts = battery_millivolts();

		printf("VBAT %lu mV%s\\n", millivolts, battery_low(millivolts) ? ", low" : "");
		led = !led;
		cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, led);
		sleep_ms(1000);
	}
}
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

// Below about 3.5 V the LDO is in dropout, so stop Wi-Fi and SD writes first.
#define LOW_MILLIVOLTS 3400

void battery_init(void) {
	adc_init();
	// Turns the digital input off, which RP2350 erratum E9 needs on a 50 kΩ source.
	adc_gpio_init(DEVBOARD_VBAT_PIN);
}

// R13 and R14 halve the cell voltage. ADC_AVDD is the 3V3 rail.
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
	['bring-up', { status: 'ready', content: BRING_UP, sourcePath: 'docs/bring-up.md' }]
]);
