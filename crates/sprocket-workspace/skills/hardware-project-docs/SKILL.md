---
name: hardware-project-docs
description: 'Guide on producing the following docs for a hardware project: rendered schematic sheet, pin maps, BOM, and design notes.'
---

This skill is not an electronics-design course.
Circuit facts should come from current datasheets and/or supplier descriptions, not from memory.
Check with `scrape_url` / `web_search`.

## The doc set

All documents should stay in sync. Always.

Should be created as `$artifacts` and project files.

1. **BOM** - Markdown
2. **Pin map (per MCU, if using any)** - Markdown
3. **Schematic sheet** — React artifact
4. **Assembly notes** - Markdown

One schematic change means checking all four. Net names are the glue: the same
name appears on the sheet, in the pin map, and in the notes.

## Creating the BOM

All the parts should be listed in a tabular format along with their datasheet (if any), quantity, price, links to buy, and any relevant notes on why the part is needed.
Ask which parts the user has (or wants) before conducting your own research.
Don't directly use an IC or similar. It's recommended to use its breakout board or similar instead.
Prefer going with boards which have headers pre-soldered, unless asked otherwise.
Research the web for the parts you need for the project, look for the cheapest options which will fit the project's requirements well. Don't make price the sole factor while researching parts, their quality and ease of use also matters.
Always go through relevant supplier descriptions, datasheet, and other specs before deciding on a part.

## Creating the Pin Map

Should be a markdown table.
One row per net; gotcha rows for input-only and boot-strapping pins of the specific MCU.
Net names should be consistent across them.

## Creating the Schematic

The artifact is a React component (App) whose output is a single <svg viewBox="0 0 1500 1010"> element containing all the schematic geometry.
Start from [`sample-schematic.jsx`](sample-schematic.jsx). It's a verified, collision-checked artifact that implements every convention below; copy its structure and scale it.

### Schematic sheet conventions

These are what make the sheet read like a CAD schematic rather than a diagram.

- **Pin names inside, net names outside.** Inside each component box, small text at the pin edge carries the component's own pin name (`GPIO25`, `PWMA`, `VIN`); the wire stub outside carries only the net name (`M1_PWM`, `VM`). Never annotate the same fact twice.
- **Label-based wiring.** Connect blocks with matched net labels on short stubs; the only long routed wires are tight physical runs (driver → motor terminals). Power rails are labeled taps (`VM`, `+5V`), never drawn end-to-end. Ground is a ground symbol, one per pin, all common.
- **Real-hardware fills.** Components take the colour of the physical part.
- **Two label colours.** Near-white (`#edf1f5`) for pin names on dark boxes; dark slate (`#5f6b78`) for labels on the light sheet background. A single "bright" colour fails one of the two.
- **Zone the sheet** left-to-right in signal order (e.g. power entry → regulation → MCU → drivers → actuators), generous gutters, dotted grid, small legend, soft page background. No title blocks, no rotated text for pin groups — a pin group too cramped on its edge means the box is too small; grow the box and give the group an internal section caption.
- **Sheet height fits content.** After a layout change, re-check that the last pin sits inside its box and labels clear neighbouring boxes. The two bugs this catches (pin overflow, label collision) are invisible without running the numbers.

### Verifying Geometry

Don't eyeball coordinates:

- Model every wire segment and component box in a quick script and check for wire-enters-box collisions, label overlap, and pins outside their box.
- If a browser is available, render a screenshot and inspect it. Fix and re-check until zero collisions.
- Completion criterion: the collision script reports zero, not "looks right".

## Creating the Assembly Notes

Include the following, if needed:

- Tips related to power
- Wiring tips
- Uploading code

## Final Response to User

In your response don't include the nitty-gritty details of how you made the artifacts, etc.
Tell the user more about the project and design decisions.
Tell the user about what files and artifacts you wrote, and how they can view the artifacts (right sidebar in the Sprocket UI).
