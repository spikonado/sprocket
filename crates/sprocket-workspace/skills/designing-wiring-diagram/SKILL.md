---
name: designing-wiring-diagram
description: 'Use when designing the wiring diagram for a hardware project built from modules and dev boards. For PCB or KiCad schematics, use `working-with-kicad`.'
---

A wiring diagram is a `.wiring.json` artifact (`$making-artifacts-and-visuals`). Sprocket draws it: real-looking boards, one coloured line per jumper wire, the build split into steps, a checklist the user ticks off while wiring, and a parts list with photos. It also flags short circuits, two voltages on one wire, and 5 V reaching a 3.3 V pin. You write only the parts and the connections.

```json
{
	"title": "Two-motor robot",
	"parts": [
		{
			"id": "bat",
			"name": "2× 18650 battery pack",
			"pins": { "right": ["+", "-"] },
			"photo": "https://example.com/battery.jpg",
			"link": "https://example.com/battery"
		},
		{ "id": "esp", "name": "ESP32 DevKit V1", "wokwi": "esp32-devkit-v1" },
		{
			"id": "drv",
			"name": "TB6612FNG motor driver",
			"logic": 3.3,
			"pins": {
				"left": ["VCC", "GND", "AIN1", "AIN2", "PWMA", "STBY"],
				"right": ["VM", "AO1", "AO2"]
			}
		},
		{ "id": "motor", "name": "Left motor", "pins": { "left": ["M+", "M-"] } }
	],
	"rails": [
		{ "id": "VBAT", "volts": 7.4 },
		{ "id": "GND", "volts": 0 }
	],
	"steps": [
		{
			"title": "Power",
			"note": "Keep the battery switched off while wiring.",
			"wires": [
				{ "from": "bat.+", "to": "VBAT", "why": "Battery feeds the motor rail" },
				{ "from": "bat.-", "to": "GND" },
				{ "from": "drv.VM", "to": "VBAT", "why": "Motor power" },
				{ "from": "drv.GND", "to": "GND" },
				{ "from": "esp.GND", "to": "GND", "why": "Shared ground" },
				{ "from": "esp.3V3", "to": "drv.VCC", "why": "Driver logic power" }
			]
		},
		{
			"title": "Control wires",
			"wires": [
				{ "from": "esp.D12", "to": "drv.AIN1", "why": "Direction" },
				{ "from": "esp.D13", "to": "drv.AIN2", "why": "Direction" },
				{ "from": "esp.D14", "to": "drv.PWMA", "why": "Speed" },
				{ "from": "esp.D27", "to": "drv.STBY", "why": "Turns the driver on" }
			]
		},
		{
			"title": "Motor",
			"note": "Swap the two motor wires if it spins backwards.",
			"wires": [
				{ "from": "drv.AO1", "to": "motor.M+" },
				{ "from": "drv.AO2", "to": "motor.M-" }
			]
		}
	]
}
```

## Parts

- Draw a part with `wokwi` when [Wokwi Elements](https://elements.wokwi.com) has it: `arduino-uno`, `arduino-nano`, `arduino-mega`, `esp32-devkit-v1`, `nano-rp2040-connect`, `franzininho`, `led`, `rgb-led`, `resistor`, `pushbutton`, `slide-switch`, `potentiometer`, `servo`, `stepper-motor`, `buzzer`, `hc-sr04`, `dht22`, `mpu6050`, `pir-motion-sensor`, `ssd1306`, `lcd1602`, `lcd2004`, `ili9341`, `neopixel`, `led-ring`, `microsd-card`, `hx711`, `ds1307`, `ir-receiver`, `ky-040`, `membrane-keypad`, `analog-joystick`, `photoresistor-sensor`, `ntc-temperature-sensor`, `7segment`, and more in the catalog. `wokwiAttrs` sets the element's attributes, such as `{ "color": "red" }` on an LED.
- Use Wokwi's pin names exactly. Read them from the `pinInfo` list in `https://unpkg.com/@wokwi/elements@1.9.2/dist/esm/<wokwi>-element.js`. A name like `GND` matches the board's first `GND.N` pin.
- Draw every other part as a box: list its pins under `pins.left` and `pins.right` in the order printed on the board, with the side facing the parts it connects to.
- Set `logic` to the part's I/O voltage when it isn't one of Wokwi's dev boards, so the voltage checks cover it.
- Order `parts` in signal order, such as power, controller, drivers, then motors and sensors. The viewer lays them out in that order, so parts that share wires end up side by side.
- Give each part from the BOM its supplier `link`, and its product image URL as `photo` when the supplier page has a direct image link.

## Wires

- Each wire is one physical jumper. `from` and `to` are `part.pin` or a rail id.
- Put every connection that many parts share, such as ground, 5 V, 3.3 V or battery power, on a rail with its `volts`. Each part then gets one short wire to the rail.
- Split the build into steps in wiring order, starting with power, with at most 6 wires per step.
- Give `why` only when the reason isn't obvious, in a few words. Put advice for the whole step in its `note`.
- Leave `color` unset unless the user's kit forces one. Ground wires come out black, power red, and signals in distinct colours.

## Checks

The viewer shows red errors for unknown parts or pins, short circuits, two voltages on one wire, and a supply above a pin's `logic` voltage. It shows amber warnings for steps over 6 wires and for signal wires between parts with different `logic` voltages. You can't see the viewer, so run the same checks yourself before you finish:

- Every `part.pin` names a pin in that part's `pins` list or Wokwi `pinInfo`.
- No wire joins ground to a supply, or two supplies of different voltage.
- No signal pin connects to a rail or supply above its part's `logic` voltage.
- A signal from a higher-voltage part to a lower-voltage part goes through a level shifter or divider. When the lower-voltage part only drives the wire, say so in the step's `note`, since the viewer still shows its amber warning.

The diagram is done when every check above holds and every wire the firmware relies on appears in a step.
