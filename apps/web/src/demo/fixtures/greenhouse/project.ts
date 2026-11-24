import { demoProject } from '../demo-project';
import { prompt, say, think, tool, work } from '../rows';
import type { DemoThread } from '../types';
import wiring from './greenhouse.wiring.json?raw';

const WIRING = 'docs/greenhouse.wiring.json';

const wire: DemoThread = {
	id: 'greenhouse-wiring',
	title: 'Wire the vent controller',
	model: 'fable-5.2',
	effort: 'high',
	minutesAgo: 4,
	steps: [
		prompt('Open my greenhouse vent when it gets hot and log soil moisture. Show me the wiring.'),
		work(
			think(
				'Planning the parts',
				'Logging over Wi-Fi needs no extra parts, so start from a Wi-Fi board. SparkFun has docs for every part, and a Thing Plus has a Qwiic port, so the air sensor plugs in without soldering. The soil probe is analog, so it needs an ADC pin, and a hobby servo can push a small vent arm.'
			),
			tool('read_skill', '$designing-wiring-diagram'),
			tool('read_skill', '$selecting-hardware-parts'),
			tool('web_search', 'SparkFun Thing Plus ESP32 Qwiic Wi-Fi (10 results)'),
			tool('scrape_url', 'https://www.sparkfun.com/sparkfun-thing-plus-esp32-c6.html'),
			tool(
				'scrape_url',
				'https://docs.sparkfun.com/SparkFun_Thing_Plus_ESP32_C6/hardware_overview/'
			),
			think(
				'Checking the board',
				'The Qwiic port is on the low-power I2C bus, IO6 and IO7, with 2.2 kΩ pull-ups. The 3.3 V regulator gives 500 mA. VUSB carries 5 V only from USB-C, which suits the servo, so the controller has to run from a USB-C supply.'
			),
			tool(
				'scrape_url',
				'https://www.sparkfun.com/sparkfun-atmospheric-sensor-breakout-bme280-qwiic.html'
			),
			tool('scrape_url', 'https://www.sparkfun.com/sparkfun-soil-moisture-sensor.html'),
			tool(
				'scrape_url',
				'https://learn.sparkfun.com/tutorials/soil-moisture-sensor-hookup-guide/all'
			),
			think(
				'Reading the soil guide',
				'The probe corrodes if it carries current all the time. The guide powers it from a GPIO only while reading, which also saves battery.'
			),
			tool('scrape_url', 'https://www.sparkfun.com/servo-generic-sub-micro-size.html'),
			tool('apply_patch', WIRING),
			tool('bind_artifact', WIRING)
		),
		say(`It's four SparkFun parts, and only the soil probe needs soldering. The wiring check passes.

| Part | SKU | Price |
| --- | --- | --- |
| Thing Plus ESP32-C6 | DEV-22924 | $19.95 |
| BME280 breakout (Qwiic) | SEN-15440 | $16.95 |
| Soil moisture sensor | SEN-13322 | $6.55 |
| Generic sub-micro servo | ROB-09065 | $12.95 |
| Qwiic cable, 100 mm | PRT-14427 | $1.50 |
| Jumper wires, M/M, 10 pack | PRT-08431 | $5.25 |
| **Total** | | **$63.15** |

- IO2 powers the soil probe only while it reads, so the pads don't corrode.
- The servo runs from VUSB, so power the controller from a USB-C supply, not the LiPo.

artifact:wiring`)
	]
};

const order: DemoThread = {
	id: 'greenhouse-order',
	title: 'Order the SparkFun parts',
	model: 'opus-5.5',
	effort: 'medium',
	minutesAgo: 6,
	working: true,
	steps: [
		prompt(
			'Order the parts from SparkFun to my saved address, cheapest shipping. Go ahead if the total is under $80.'
		),
		work(
			think(
				'Planning the order',
				"Six lines from the parts list: DEV-22924, SEN-15440, SEN-13322, ROB-09065, PRT-14427 and PRT-08431. Check out in the signed-in browser so the saved address carries over. You've set the limit, so I can pay once the total is under $80."
			),
			tool('read_skill', '$paying-at-checkout'),
			tool('read_skill', '$using-the-signed-in-browser'),
			tool('exec_cmd', 'agent-browser open https://www.sparkfun.com/checkout/cart/'),
			tool('exec_cmd', 'agent-browser snapshot -i'),
			think(
				'Reading the checkout',
				'The cart has all six lines for $63.15, and the saved address filled in. USPS Ground Advantage is the cheapest option at $7.33, so the total is $70.48.'
			),
			tool('card_checkout', '$70.48 USD at SparkFun: awaiting_approval')
		),
		say(
			'The order comes to **$70.48** with USPS Ground Advantage, under your $80 limit. Approve the charge below with your passkey, and I will place the order and send you the tracking link.'
		),
		work(tool('poll_checkout', 'Waiting for your approval', { status: 'running' }))
	],
	purchase: { merchant: 'SparkFun', amountCents: 7048, currency: 'usd' }
};

export const greenhouse = demoProject({
	name: 'greenhouse-vent',
	files: {
		'README.md': `# greenhouse-vent

Opens the greenhouse roof vent when it gets hot and logs air and soil readings. Reporting to Home Assistant over MQTT comes next.

- \`firmware/\`: PlatformIO project for the SparkFun Thing Plus ESP32-C6
- \`docs/greenhouse.wiring.json\`: wiring for the sensor, soil probe and vent servo
`,
		[WIRING]: wiring,
		'platformio.ini': `[env:thingplus-c6]
platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip
board = sparkfun_esp32c6_thing_plus
framework = arduino
monitor_speed = 115200
lib_deps =
	sparkfun/SparkFun BME280
	madhephaestus/ESP32Servo
`,
		'firmware/src/main.cpp': `#include <Arduino.h>
#include <ESP32Servo.h>
#include <SparkFunBME280.h>
#include <Wire.h>

constexpr int SOIL_POWER = 2;
constexpr int SOIL_SIGNAL = 0;
constexpr int VENT_SERVO = 5;
constexpr float OPEN_ABOVE_C = 28.0;
constexpr float CLOSE_BELOW_C = 25.0;

BME280 air;
Servo vent;
bool open = false;

int readSoil() {
	digitalWrite(SOIL_POWER, HIGH);
	delay(10);
	const int value = analogRead(SOIL_SIGNAL);
	digitalWrite(SOIL_POWER, LOW);

	return value;
}

void setup() {
	Serial.begin(115200);
	Wire.begin(6, 7);
	air.beginI2C();
	pinMode(SOIL_POWER, OUTPUT);
	vent.attach(VENT_SERVO, 1000, 2000);
	vent.write(0);
}

void loop() {
	const float celsius = air.readTempC();

	if (!open && celsius > OPEN_ABOVE_C) open = true;
	if (open && celsius < CLOSE_BELOW_C) open = false;
	vent.write(open ? 90 : 0);

	Serial.printf("%.1f C, %.0f %%RH, soil %d, vent %s\\n", celsius, air.readFloatHumidity(),
	              readSoil(), open ? "open" : "closed");
	delay(30000);
}
`
	},
	gitStatus: [{ path: WIRING, status: 'untracked' }],
	artifacts: [{ key: 'wiring', title: 'greenhouse.wiring.json', path: WIRING }],
	threads: [wire, order]
});
