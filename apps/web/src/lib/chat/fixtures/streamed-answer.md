## Picking a buck converter for the ESP32-S3 board

You asked for a **3.3 V rail** that can supply the ESP32-S3 Wi-Fi bursts (about _500 mA peak_) from a 2S Li-ion pack. Here's what I checked, in order:

1. Input range: a 2S pack sits between `6.0 V` and `8.4 V`, so the converter needs at least ~12 V absolute max for margin.
2. Output current: 1 A continuous covers the radio bursts plus the IMU and the servo driver logic.
3. Package: it has to be hand-solderable, so no 0.4 mm BGA parts.
4. Stock: at least 1,000 units at [LCSC](https://www.lcsc.com) or [Mouser](https://www.mouser.com).

### Shortlist

| Part     | Vin max | Iout |             Fsw | Package   | Price (1k) |
| -------- | ------: | ---: | --------------: | --------- | ---------: |
| TPS62933 |    30 V |  3 A | 200 kHz–2.2 MHz | SOT-583   |      $0.62 |
| AP63203  |    32 V |  2 A |         1.1 MHz | TSOT-26   |      $0.41 |
| MP2315S  |    24 V |  3 A |         500 kHz | TSOT-23-8 |      $0.38 |
| SY8089   |   5.5 V |  2 A |           1 MHz | SOT-23-5  |      $0.07 |

The SY8089 is out: its 5.5 V input limit is below the pack voltage. The **AP63203** is the simplest fit because its output is fixed at 3.3 V, so there's no feedback divider to get wrong.

### Inductor and capacitor sizing

The ripple current for a buck converter is

$$\Delta I_L = \frac{V_{out}\,(V_{in} - V_{out})}{V_{in}\, f_{sw}\, L}$$

With $V_{in} = 8.4\,\text{V}$, $V_{out} = 3.3\,\text{V}$, $f_{sw} = 1.1\,\text{MHz}$ and $L = 4.7\,\mu\text{H}$, that's about 0.39 A, roughly 20% of the 2 A rating, which is the usual target.

> **Note:** the datasheet recommends a 22 µF X7R output capacitor. Ceramic capacitors lose a lot of capacitance under DC bias, so a 10 V-rated 0805 part may only give ~9 µF at 3.3 V. Use 1206 or two 0805 parts in parallel.

### Netlist change

I updated the power section of `esp32-board.kicad_sch`. The relevant part of the generated netlist:

```kicad
(comp (ref U3)
  (value AP63203WU-7)
  (footprint Package_TO_SOT_SMD:TSOT-23-6)
  (fields (field (name LCSC) C2071056)))
(net (code 12) (name +3V3)
  (node (ref U3) (pin 3))
  (node (ref C14) (pin 1))
  (node (ref U1) (pin 2)))
```

And the firmware side now checks brown-out before starting Wi-Fi:

```rust
use esp_idf_svc::hal::adc::{AdcChannelDriver, AdcDriver};

const PACK_MIN_MV: u32 = 6_200;

fn pack_ok(adc: &mut AdcDriver<'_>, ch: &mut AdcChannelDriver<'_, Gpio4>) -> anyhow::Result<bool> {
    // The divider is 100k / 27k, so scale the reading back up.
    let raw = adc.read(ch)? as u32;
    let millivolts = raw * (100 + 27) / 27;
    log::info!("pack at {millivolts} mV");
    Ok(millivolts >= PACK_MIN_MV)
}
```

```ts
export async function fetchStock(part: string): Promise<number> {
	const response = await fetch(`https://api.example.com/parts/${encodeURIComponent(part)}`);
	if (!response.ok) throw new Error(`stock lookup failed: ${response.status}`);
	const { stock } = (await response.json()) as { stock: number };
	return stock;
}
```

### What's left

- [x] Swap U3 to the AP63203 and re-run ERC
- [x] Add the 2×22 µF output capacitors
- [ ] Re-route the switch node so the loop area stays under ~20 mm²
- [ ] Order 5 boards from JLCPCB once you've reviewed the layout

A few things worth a look before you order:

- The **EN pin** is tied straight to Vin. If you want a soft power switch later, route it to a test pad now.
- `C14` sits 6 mm from the IC. The datasheet layout puts it within _2 mm_ of `VIN` and `GND`; move it closer.
- The thermal pad on the TSOT-26 is ~~required~~ not present, so there's nothing to stitch.

See artifact:board-render-3 for the updated 3D render and [the datasheet](https://www.diodes.com/assets/Datasheets/AP63200-AP63201-AP63203-AP63205.pdf), page 14, for the layout guide.

Footnote-style detail: efficiency at 500 mA is about 88%[^1], so the regulator dissipates roughly $P = I^2 R$-style losses near 0.22 W, fine for TSOT-26 without extra copper.

[^1]: Read off figure 7 at Vin = 8 V.
