---
name: designing-wiring-diagram
description: 'Use when designing the wiring diagram for a hardware project built from modules and dev boards. For PCB or KiCad schematics, use `designing-pcbs`.'
---

A wiring diagram is a `.wiring.json` artifact (`$making-artifacts-and-visuals`). Sprocket draws every part as a box with named pins, one coloured line per jumper wire, build steps, a wiring checklist, and a parts list with photos. You write only the parts and the connections.

```json
{
	"title": "One-motor robot",
	"parts": [
		{
			"id": "bat",
			"name": "2× 18650 battery pack",
			"pins": { "right": ["+", "-"] },
			"photo": "https://example.com/battery.jpg",
			"link": "https://example.com/battery"
		},
		{
			"id": "esp",
			"name": "ESP32 DevKit V1",
			"logic": 3.3,
			"pins": { "left": ["GND"], "right": ["3V3", "D12", "D13", "D14", "D27"] }
		},
		{
			"id": "drv",
			"name": "TB6612FNG motor driver",
			"logic": 3.3,
			"pins": {
				"left": ["VCC", "GND", "AIN1", "AIN2", "PWMA", "STBY"],
				"right": ["VM", "AO1", "AO2"]
			}
		},
		{ "id": "motor", "name": "Motor", "pins": { "left": ["M+", "M-"] } }
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

- Every part needs `pins`. List the used pins under `pins.left` and `pins.right` by their board labels, in board order, with the side facing the parts they connect to.
- Set `logic` to each part's I/O voltage, dev boards included, so the voltage checks cover its signals. Omit it for parts without logic I/O, such as batteries and motors.
- Order `parts` in signal order, such as power, controller, drivers, then motors and sensors. The viewer lays them out in that order, so parts that share wires end up side by side.
- Give each part from the BOM its supplier `link`, and its product image URL as `photo` when the supplier page has a direct image link.

## Wires

- Each wire is one physical jumper. `from` and `to` are `part.pin` or a rail id, and at least one of them is a pin.
- Put every connection that many parts share, such as ground, 5 V, 3.3 V or battery power, on a rail with its `volts`. Each part then gets one short wire to the rail.
- Split the build into steps in wiring order, starting with power, with at most 6 wires per step.
- Give `why` only when the reason isn't obvious, in a few words. Put advice for the whole step in its `note`.
- Leave `color` unset unless the user's kit forces one. Ground wires come out black, power red, and signals in distinct colours.

## Checks

`apply_patch` and `bind_artifact` return `wiringIssues` for a `.wiring.json` file. They come from the checker the viewer runs, which covers the file format, pin and rail names, and voltages. Routing warnings depend on the viewer's width, so only the preview shows them.

Fix each error and patch the file again. A `wiringCheckError` means the check didn't run, so the file stays unchecked until a later call returns `wiringIssues`.

The diagram is done when every wire the firmware relies on appears in a step and `wiringIssues` has no errors. Explain each remaining warning in its step's `note`, such as a mixed-voltage signal that only the lower-voltage part drives.
