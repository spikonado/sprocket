import type { ArtifactContent, ArtifactEntry } from '$lib/chat/artifacts';
import { artifactPreviewType } from '$lib/chat/artifact-preview';
import type { Project } from '$lib/types/sprocket';
import type { WorkspaceFiles } from '../workspace-api';

export const project: Project = {
	repositoryKey: 'github.com/maker/esp32-air-sensor',
	displayName: 'esp32-air-sensor',
	workspacePath: '/home/maker/esp32-air-sensor',
	localAttachmentAvailability: 'available'
};

export const BOM = `# ESP32-S3 Air Sensor BOM (rev A)

Unit prices are LCSC at quantity 10. "JLC" marks parts priced from JLCPCB where LCSC had no stock. Mounting holes and PWR_FLAGs are skipped.

| Ref(s) | Qty | Part | MPN | LCSC | Unit (USD) | Stock |
| --- | --- | --- | --- | --- | --- | --- |
| C1, C4, C7 | 3 | 100 nF 16 V X7R 0402 | CL05B104KO5NNNC | C1525 | 0.0024 | 3,862,200 |
| C2, C3, C5 | 3 | 22 µF 25 V X5R 0805 | CL21A226MAQNNNE | C45783 | 0.1975 JLC | 3,650,101 JLC |
| C6 | 1 | 10 µF 10 V X5R 0603 | CL10A106KP8NNNC | C19702 | 0.0170 | 1,240,440 |
| C8 | 1 | 1 µF 50 V X5R 0603 | CL10A105KB8NNNC | C15849 | 0.0095 JLC | 12,165,673 JLC |
| D2 | 1 | Red LED 0603 | KT-0603R | C2286 | 0.0077 | 6,248,900 |
| D3 | 1 | 1N5817 Schottky, DO-41 | 1N5817 | C315569 | 0.0367 | 7,780 |
| D4, D5, D6 | 3 | ESD diode 3.3 V, SOD-923 | ESD9B3.3ST5G | C96512 | 0.0445 | 93,500 |
| D7 | 1 | RGB LED PLCC4 3.2×2.8 mm | CLMVC-FKA-CL1D1L71BB7C3C3 | C5187905 | 0.1687 | **0** |
| FB1 | 1 | Ferrite bead 600 Ω, 0805 | GZ2012D601TF | C1017 | 0.0200 JLC | 336,403 JLC |
| J1 | 1 | USB-C receptacle, 16 pin | USB4105-GF-A | C3020560 | 0.8366 | 10,069 |
| J2 | 1 | 2×3 header 2.54 mm, SMD | 2.54-2*3P | C192301 | 0.0445 | 10,790 |
| J3 | 1 | 2×5 header 2.54 mm, through-hole | PZ254V-12-10P | C492422 | 0.0667 | 127,110 |
| J4 | 1 | JST SH 4 pin, vertical | BM04B-SRSS-TB(LF)(SN) | C160390 | 0.3541 | 1,825 |
| R1, R2 | 2 | 5.1 kΩ 1% 0402 | 0402WGF5101TCE | C25905 | 0.0014 | 1,152,100 |
| R3 | 1 | 1 kΩ 1% 0402 | 0402WGF1001TCE | C11702 | 0.0013 | 17,112,600 |
| R4, R5 | 2 | 2.2 kΩ 1% 0402 | 0402WGF2201TCE | C25879 | 0.0012 | 1,090,900 |
| R6, R7, R10 | 3 | 10 kΩ 1% 0402 | 0402WGF1002TCE | C25744 | 0.0015 | 14,349,600 |
| SW2, SW3 | 2 | Tactile switch, SMD | B3U-1000P | C231329 | 0.1894 | 63,930 |
| SW4 | 1 | Tactile switch, right angle | B3F-3152 | C231320 | 0.2663 | 6,525 |
| U1 | 1 | ESP32-S3-WROOM-1, 8 MB / 8 MB | ESP32-S3-WROOM-1-N8R8 | C2913201 | 4.4553 | 2,180 |
| U2 | 1 | USB ESD protection, SOT-23-6 | USBLC6-2SC6 | C7519 | 0.1585 | 32,225 |
| U3 | 1 | 3.3 V 800 mA LDO, TO-252 | LM1117DTX-3.3/NOPB | C73181 | 0.8469 | 13,517 |
| U4 | 1 | Si7021 humidity sensor, DFN-6 | SI7021-A20-GM1R | C132603 | 7.7058 | 379 |

Parts for one board come to **$16.12**, or $161.17 for ten.

## Open items

- **D7** is out of stock at LCSC and JLCPCB. The in-stock RGB LEDs need a different footprint.
- **SW2, SW3**: the exact \`B3U-1000P-B\` has no stock, so this uses \`B3U-1000P\`. Check it against the footprint.
- **J2**: confirm the SMD header's orientation against the vertical footprint.
`;

export const ASSEMBLY = `# Assembly: ESP32-S3 Air Sensor rev A

Hand assembly for a batch of ten. Allow about 40 minutes per board.

## Tools

- Hot air station or reflow plate, and a fine-tip iron
- Solder paste (SAC305) and a stencil for the top side
- Flux, tweezers, 10× loupe
- USB-C cable and a 3.3 V USB-serial adapter for J3

## Order of work

1. **Paste and place the fine-pitch parts first:** U4 (Si7021, DFN-6), U2 (USBLC6) and J1 (USB-C). Check U4's pin 1 mark against the silkscreen.
2. **Place the passives:** C1–C8, R1–R10, FB1 and D2–D6. Keep the 22 µF parts (C2, C3, C5) for last because they shade their neighbours under hot air.
3. **Reflow** at the SAC305 profile, peak 245 °C. Let the board cool before you move it.
4. **Place U1** (ESP32-S3-WROOM-1). Tack two corner pads, check alignment, then drag-solder the castellations. Don't heat the shield can for long.
5. **Hand-solder U3** (LM1117, TO-252). Tin the tab pad first.
6. **Through-hole parts:** J3, SW4 and D3.
7. **Inspect** each board under the loupe for bridges on U1, J1 and U4.

## Bring-up

1. Power from USB-C without U1's boot strap. 3V3 should read 3.28–3.32 V.
2. Hold SW2 (BOOT), tap SW3 (RESET), then flash with \`pio run -e esp32s3 -t upload\`.
3. Open the serial monitor. A healthy board prints the Si7021 serial number and a first reading within 2 s.
4. Breathe on U4. Relative humidity should climb by 10 % or more.

## Known issues

- D7 is unpopulated until a replacement RGB LED is chosen. See the BOM.
`;

const kicadFiles = {
	'hardware/air-sensor.kicad_pro': () => import('./kicad/air-sensor.kicad_pro?raw'),
	'hardware/air-sensor.kicad_sch': () => import('./kicad/air-sensor.kicad_sch?raw'),
	'hardware/LICENSE': () => import('./kicad/LICENSE?raw')
};

const textFiles = {
	'README.md': `# esp32-air-sensor

An outdoor air sensor built around the ESP32-S3 and the Si7021 humidity and temperature sensor.

- \`hardware/\`: KiCad schematic and BOM
- \`firmware/\`: PlatformIO project
- \`docs/\`: assembly and bring-up notes

The schematic is adapted from [Mahfuz-Sarker136/ESP32-S3-Custom-Hardware-Development-Board-with-Integrated-Si7021-Sensor](https://github.com/Mahfuz-Sarker136/ESP32-S3-Custom-Hardware-Development-Board-with-Integrated-Si7021-Sensor) under the MIT license. See \`hardware/LICENSE\`.
`,
	'hardware/bom.md': BOM,
	'docs/assembly.md': ASSEMBLY,
	'firmware/platformio.ini': `[env:esp32s3]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
monitor_speed = 115200
build_flags = -DSENSOR_INTERVAL_S=300
lib_deps =
	knolleary/PubSubClient@^2.8

[env:native]
platform = native
test_framework = unity
`,
	'firmware/src/main.cpp': `#include <Arduino.h>
#include "power.h"
#include "publish.h"
#include "si7021.h"

Si7021 sensor(Wire);

void setup() {
	Serial.begin(115200);
	Wire.begin(8, 9);

	if (!power::batteryOk()) power::sleepFor(SENSOR_INTERVAL_S * 4);

	const auto reading = sensor.read();

	if (reading) publish::reading(*reading, power::batteryMillivolts());
	power::sleepFor(SENSOR_INTERVAL_S);
}

void loop() {}
`,
	'firmware/src/si7021.h': `#pragma once
#include <Wire.h>
#include <optional>

struct Reading {
	float humidity;
	float temperature;
};

class Si7021 {
public:
	explicit Si7021(TwoWire &wire) : wire_(wire) {}
	std::optional<Reading> read();

private:
	std::optional<uint16_t> measure(uint8_t command);
	TwoWire &wire_;
};
`,
	'firmware/src/si7021.cpp': `#include "si7021.h"

namespace {
constexpr uint8_t ADDRESS = 0x40;
constexpr uint8_t MEASURE_RH = 0xF5;
constexpr uint8_t READ_TEMP = 0xE0;

uint8_t crc8(uint16_t value) {
	uint8_t crc = 0;
	for (uint8_t byte : {uint8_t(value >> 8), uint8_t(value)}) {
		crc ^= byte;
		for (int bit = 0; bit < 8; bit++) crc = crc & 0x80 ? (crc << 1) ^ 0x31 : crc << 1;
	}
	return crc;
}
} // namespace

std::optional<uint16_t> Si7021::measure(uint8_t command) {
	wire_.beginTransmission(ADDRESS);
	wire_.write(command);
	if (wire_.endTransmission() != 0) return std::nullopt;
	delay(23);
	if (wire_.requestFrom(ADDRESS, uint8_t(3)) != 3) return std::nullopt;
	const uint16_t raw = wire_.read() << 8 | wire_.read();
	if (crc8(raw) != wire_.read()) return std::nullopt;
	return raw;
}

std::optional<Reading> Si7021::read() {
	const auto humidity = measure(MEASURE_RH);
	if (!humidity) return std::nullopt;
	wire_.beginTransmission(ADDRESS);
	wire_.write(READ_TEMP);
	wire_.endTransmission();
	wire_.requestFrom(ADDRESS, uint8_t(2));
	const uint16_t temperature = wire_.read() << 8 | wire_.read();
	return Reading{125.0f * *humidity / 65536 - 6, 175.72f * temperature / 65536 - 46.85f};
}
`,
	'firmware/src/power.cpp': `#include "power.h"
#include <esp_sleep.h>

namespace power {
constexpr int BATTERY_PIN = 4;
constexpr int CUTOFF_MV = 3000;

int batteryMillivolts() {
	return analogReadMilliVolts(BATTERY_PIN) * 2;
}

bool batteryOk() {
	return batteryMillivolts() > CUTOFF_MV;
}

void sleepFor(uint32_t seconds) {
	esp_sleep_enable_timer_wakeup(uint64_t(seconds) * 1'000'000);
	esp_deep_sleep_start();
}
} // namespace power
`,
	'firmware/src/power.h': `#pragma once
#include <Arduino.h>

namespace power {
int batteryMillivolts();
bool batteryOk();
[[noreturn]] void sleepFor(uint32_t seconds);
} // namespace power
`,
	'firmware/src/publish.h': `#pragma once
#include "si7021.h"

namespace publish {
bool reading(const Reading &reading, int batteryMillivolts);
} // namespace publish
`
};

export const workspaceFiles: WorkspaceFiles = {
	...Object.fromEntries(Object.entries(textFiles).map(([path, text]) => [path, async () => text])),
	...Object.fromEntries(
		Object.entries(kicadFiles).map(([path, load]) => [path, async () => (await load()).default])
	)
};

export const artifacts: ArtifactEntry[] = [
	{ key: 'bom', title: 'air-sensor-bom.md' },
	{ key: 'assembly', title: 'air-sensor-assembly.md' }
].map((artifact) => ({ ...artifact, artifactType: artifactPreviewType(artifact.title) }));

export const artifactContents = new Map<string, ArtifactContent>([
	['bom', { status: 'ready', content: BOM, sourcePath: 'hardware/bom.md' }],
	['assembly', { status: 'ready', content: ASSEMBLY, sourcePath: 'docs/assembly.md' }]
]);
