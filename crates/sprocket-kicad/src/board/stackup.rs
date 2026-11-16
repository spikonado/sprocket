//! Board thickness and colors from the stackup, as KiCad's STEP export and 3D viewer read it.

use serde::Serialize;

use crate::outline::Outline;
use crate::scene::BoardMeta;
use crate::sexpr::Expr;

/// Lengths in KiCad's internal units, nm, so sums round exactly as KiCad's do.
type Nm = i64;

const DEFAULT_BOARD_THICKNESS: Nm = 1_600_000;
const DEFAULT_COPPER_THICKNESS: Nm = 35_000;
const DEFAULT_MASK_THICKNESS: Nm = 10_000;
/// `STEP_PCB_MODEL`'s `BOARD_THICKNESS_MIN_MM`.
const MIN_BODY_THICKNESS: Nm = 10_000;
/// KiCad's `NotSpecifiedPrm()`, the color of items without one.
const NOT_SPECIFIED: &str = "Not specified";
/// Older files stored `#RRGGBB` colors without their opacity.
const FIRST_COLOR_ALPHA: i64 = 20210824;
const DEFAULT_SOLDERMASK_OPACITY: f64 = 0.83;

type Rgba = [f64; 4];

/// The colors of `EDA_3D_VIEWER`'s default theme.
const THEME_BOARD: Rgba = [0.2, 0.17, 0.09, 0.9];
const THEME_COPPER: Rgba = [0.7, 0.61, 0.0, 1.0];
const THEME_SILK: Rgba = [0.9, 0.9, 0.9, 1.0];
const THEME_MASK: Rgba = [0.08, 0.2, 0.14, DEFAULT_SOLDERMASK_OPACITY];

type ColorTable = [(&'static str, [u8; 3], f64)];

/// `BOARD_ADAPTER`'s `g_SilkColors`, `g_MaskColors`, `g_BoardColors` and `g_FinishColors`.
const SILK_COLORS: &ColorTable = &[
    (NOT_SPECIFIED, [245, 245, 245], 1.0),
    ("Green", [20, 51, 36], 1.0),
    ("Red", [181, 19, 21], 1.0),
    ("Blue", [2, 59, 162], 1.0),
    ("Black", [11, 11, 11], 1.0),
    ("White", [245, 245, 245], 1.0),
    ("Purple", [32, 2, 53], 1.0),
    ("Yellow", [194, 195, 0], 1.0),
];
const MASK_COLORS: &ColorTable = &[
    (NOT_SPECIFIED, [20, 51, 36], DEFAULT_SOLDERMASK_OPACITY),
    ("Green", [20, 51, 36], DEFAULT_SOLDERMASK_OPACITY),
    ("Light Green", [91, 168, 12], DEFAULT_SOLDERMASK_OPACITY),
    ("Saturated Green", [13, 104, 11], DEFAULT_SOLDERMASK_OPACITY),
    ("Red", [181, 19, 21], DEFAULT_SOLDERMASK_OPACITY),
    ("Light Red", [210, 40, 14], DEFAULT_SOLDERMASK_OPACITY),
    ("Red/Orange", [239, 53, 41], DEFAULT_SOLDERMASK_OPACITY),
    ("Blue", [2, 59, 162], DEFAULT_SOLDERMASK_OPACITY),
    ("Light Blue 1", [54, 79, 116], DEFAULT_SOLDERMASK_OPACITY),
    ("Light Blue 2", [61, 85, 130], DEFAULT_SOLDERMASK_OPACITY),
    ("Green/Blue", [21, 70, 80], DEFAULT_SOLDERMASK_OPACITY),
    ("Black", [11, 11, 11], DEFAULT_SOLDERMASK_OPACITY),
    ("White", [245, 245, 245], DEFAULT_SOLDERMASK_OPACITY),
    ("Purple", [32, 2, 53], DEFAULT_SOLDERMASK_OPACITY),
    ("Light Purple", [119, 31, 91], DEFAULT_SOLDERMASK_OPACITY),
    ("Yellow", [194, 195, 0], DEFAULT_SOLDERMASK_OPACITY),
];
const BOARD_COLORS: &ColorTable = &[
    ("FR4 natural, dark", [51, 43, 22], 0.83),
    ("FR4 natural", [109, 116, 75], 0.83),
    ("PTFE natural", [252, 252, 250], 0.90),
    ("Polyimide", [205, 130, 0], 0.68),
    ("Phenolic natural", [92, 17, 6], 0.90),
    ("Brown 1", [146, 99, 47], 0.83),
    ("Brown 2", [160, 123, 54], 0.83),
    ("Brown 3", [146, 99, 47], 0.83),
    ("Aluminum", [213, 213, 213], 1.0),
];
const FINISH_COPPER: [u8; 3] = [184, 115, 50];
const FINISH_GOLD: [u8; 3] = [178, 156, 0];
const FINISH_SILVER: [u8; 3] = [213, 213, 213];
const FINISH_TIN: [u8; 3] = [160, 160, 160];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Copper {
    Front,
    Inner,
    Back,
}

#[derive(Debug, PartialEq)]
enum Item {
    Copper {
        layer: Copper,
        thickness: Nm,
    },
    /// `thickness` sums the sublayers; `color` is the first sublayer's.
    Dielectric {
        prepreg: bool,
        thickness: Nm,
        color: String,
    },
    Mask {
        front: bool,
        color: String,
    },
    Silk {
        front: bool,
        color: String,
    },
}

#[derive(Default)]
pub(super) struct Stackup {
    version: i64,
    general_thickness: Option<Nm>,
    layers: Vec<String>,
    items: Option<Vec<Item>>,
    finish: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Colors {
    pub body: Rgba,
    pub mask_front: Rgba,
    pub mask_back: Rgba,
    pub silk_front: Rgba,
    pub silk_back: Rgba,
    pub finish: Rgba,
}

impl Stackup {
    pub fn version(&mut self, version: i64) {
        self.version = version;
    }

    pub fn general(&mut self, general: Expr) {
        self.general_thickness = general.number_value("thickness").map(nm);
    }

    pub fn layers(&mut self, layers: Expr) {
        self.layers = layers
            .args()
            .filter_map(|layer| layer.text_arg(0))
            .map(Into::into)
            .collect();
    }

    /// Reads `(setup (stackup …))` like `PCB_IO_KICAD_SEXPR_PARSER::parseBoardStackup`.
    pub fn setup(&mut self, setup: Expr) {
        let Some(stackup) = setup.child("stackup") else {
            return;
        };
        self.finish = stackup.value("copper_finish").unwrap_or_default().into();
        let items = stackup
            .children_named("layer")
            .filter_map(|layer| {
                let name = layer.text_arg(0)?;
                let color = || {
                    layer
                        .args()
                        .take_while(|arg| arg.atom() != Some("addsublayer"))
                        .find(|arg| arg.head() == Some("color"))
                        .and_then(|color| color.text_arg(0))
                        .map_or_else(|| NOT_SPECIFIED.to_owned(), Into::into)
                };
                let mut thicknesses = layer
                    .children_named("thickness")
                    .filter_map(|thickness| thickness.number_arg(0))
                    .map(nm);
                Some(match &*name {
                    "F.SilkS" | "B.SilkS" => Item::Silk {
                        front: name.starts_with('F'),
                        color: color(),
                    },
                    "F.Mask" | "B.Mask" => Item::Mask {
                        front: name.starts_with('F'),
                        color: color(),
                    },
                    "F.Paste" | "B.Paste" => return None,
                    _ if name.ends_with(".Cu") => Item::Copper {
                        layer: copper_layer(&name),
                        thickness: thicknesses.next().unwrap_or(DEFAULT_COPPER_THICKNESS),
                    },
                    _ => Item::Dielectric {
                        prepreg: layer.value("type").as_deref() == Some("prepreg"),
                        thickness: thicknesses.sum(),
                        color: color(),
                    },
                })
            })
            .collect();
        self.items = Some(items);
    }

    pub fn board(self, outlines: Vec<Outline>) -> BoardMeta {
        let items = match &self.items {
            Some(items) => items,
            None => &self.default_items(),
        };
        let (front_z, front) = copper_z(items, Copper::Front);
        let (back_z, back) = copper_z(items, Copper::Back);
        let top = front_z.min(front_z + front);
        let bottom = back_z.max(back_z + back);
        let mut body = top - bottom;
        if body < MIN_BODY_THICKNESS {
            body = items
                .iter()
                .map(|item| match item {
                    Item::Dielectric { thickness, .. }
                    | Item::Copper {
                        layer: Copper::Inner,
                        thickness,
                    } => *thickness,
                    _ => 0,
                })
                .sum();
            if body < MIN_BODY_THICKNESS {
                body = DEFAULT_BOARD_THICKNESS;
            }
        }
        BoardMeta {
            outlines,
            body: mm(body),
            copper: [mm(front), mm(-back)],
            colors: self.colors(items),
        }
    }

    /// `BOARD_STACKUP::BuildDefaultStackupList` for the board's enabled layers.
    fn default_items(&self) -> Vec<Item> {
        let enabled = |name: &str| self.layers.iter().any(|layer| layer == name);
        let mut copper: Vec<Copper> = self
            .layers
            .iter()
            .filter(|name| name.ends_with(".Cu"))
            .map(|name| copper_layer(name))
            .collect();
        copper.sort_by_key(|layer| *layer as u8);
        let count = copper.len() as Nm;
        let masks = ["F.Mask", "B.Mask"]
            .into_iter()
            .filter(|name| enabled(name));
        let dielectric = (self.general_thickness.unwrap_or(DEFAULT_BOARD_THICKNESS)
            - DEFAULT_COPPER_THICKNESS * count
            - DEFAULT_MASK_THICKNESS * masks.count() as Nm)
            / (count - 1).max(1);

        let unspecified = || NOT_SPECIFIED.to_owned();
        let mut items = Vec::new();
        if enabled("F.SilkS") {
            items.push(Item::Silk {
                front: true,
                color: unspecified(),
            });
        }
        if enabled("F.Mask") {
            items.push(Item::Mask {
                front: true,
                color: unspecified(),
            });
        }
        for (index, &layer) in copper.iter().enumerate() {
            items.push(Item::Copper {
                layer,
                thickness: DEFAULT_COPPER_THICKNESS,
            });
            if layer == Copper::Back {
                break;
            }
            items.push(Item::Dielectric {
                prepreg: index % 2 == 1,
                thickness: dielectric,
                color: unspecified(),
            });
        }
        if enabled("B.Mask") {
            items.push(Item::Mask {
                front: false,
                color: unspecified(),
            });
        }
        if enabled("B.SilkS") {
            items.push(Item::Silk {
                front: false,
                color: unspecified(),
            });
        }
        items
    }

    /// `BOARD_ADAPTER::GetLayerColors` with the default theme and stackup colors on.
    fn colors(&self, items: &[Item]) -> Colors {
        let mut colors = Colors {
            body: THEME_BOARD,
            mask_front: THEME_MASK,
            mask_back: THEME_MASK,
            silk_front: THEME_SILK,
            silk_back: THEME_SILK,
            finish: THEME_COPPER,
        };
        let find = |name: &str, table: &ColorTable, mask: bool| {
            if name.starts_with('#') {
                let color = hex_color(name);
                if self.version < FIRST_COLOR_ALPHA {
                    let alpha = if mask {
                        DEFAULT_SOLDERMASK_OPACITY
                    } else {
                        1.0
                    };
                    // The parser stores the color through 8-bit channels.
                    return [
                        color[0],
                        color[1],
                        color[2],
                        (alpha * 255.0).round() / 255.0,
                    ];
                }
                return color;
            }
            table
                .iter()
                .find(|(known, ..)| *known == name)
                .map_or([0.0, 0.0, 0.0, 1.0], |&(_, rgb, alpha)| rgba(rgb, alpha))
        };
        let mut body: Rgba = [0.0; 4];
        for item in items {
            match item {
                Item::Silk { front, color } => {
                    let side = if *front {
                        &mut colors.silk_front
                    } else {
                        &mut colors.silk_back
                    };
                    *side = find(color, SILK_COLORS, false);
                }
                Item::Mask { front, color } => {
                    let side = if *front {
                        &mut colors.mask_front
                    } else {
                        &mut colors.mask_back
                    };
                    *side = find(color, MASK_COLORS, true);
                }
                Item::Dielectric { color, .. } => {
                    let layer = find(color, BOARD_COLORS, false);
                    if body == [0.0; 4] {
                        body = layer;
                    } else {
                        let keep = 1.0 - layer[3];
                        for channel in 0..3 {
                            body[channel] = layer[channel] * (1.0 - keep) + body[channel] * keep;
                        }
                    }
                    body[3] += (1.0 - body[3]) * layer[3] / 2.0;
                }
                Item::Copper { .. } => {}
            }
        }
        if body != [0.0; 4] {
            colors.body = body;
        }
        let finish = self.finish.as_str();
        let finish_color = if finish.ends_with("OSP") {
            Some(FINISH_COPPER)
        } else if finish.ends_with("IG") || finish.ends_with("gold") {
            Some(FINISH_GOLD)
        } else if finish.starts_with("HAL")
            || finish.starts_with("HASL")
            || finish.ends_with("tin")
            || finish.ends_with("nickel")
        {
            Some(FINISH_TIN)
        } else if finish.ends_with("silver") {
            Some(FINISH_SILVER)
        } else {
            None
        };
        if let Some(rgb) = finish_color {
            colors.finish = rgba(rgb, 1.0);
        }
        colors
    }
}

/// `STEP_PCB_MODEL::getCopperLayerZPlacement`: walks the stackup from the bottom and returns
/// the copper's z and its signed thickness.
fn copper_z(items: &[Item], target: Copper) -> (Nm, Nm) {
    let mut z = 0;
    let mut thickness = 0;
    let mut was_prepreg = false;
    for item in items.iter().rev() {
        match *item {
            Item::Copper {
                layer,
                thickness: copper,
            } => {
                if target == Copper::Back {
                    thickness = -copper;
                    break;
                }
                if was_prepreg && layer != Copper::Front {
                    z += copper;
                    thickness = -copper;
                } else {
                    thickness = copper;
                }
                if layer == target {
                    break;
                }
                if !was_prepreg && layer != Copper::Back {
                    z += copper;
                }
            }
            Item::Dielectric {
                prepreg,
                thickness: dielectric,
                ..
            } => {
                was_prepreg = prepreg;
                thickness = dielectric;
                z += dielectric;
            }
            Item::Mask { .. } | Item::Silk { .. } => {}
        }
    }
    (z, thickness)
}

fn copper_layer(name: &str) -> Copper {
    match name {
        "F.Cu" => Copper::Front,
        "B.Cu" => Copper::Back,
        _ => Copper::Inner,
    }
}

/// `COLOR4D::SetFromHexString`: `#RRGGBB` or `#RRGGBBAA`.
fn hex_color(text: &str) -> Rgba {
    let digits = text.trim()[1..]
        .split(|c: char| !c.is_ascii_hexdigit())
        .next()
        .unwrap_or_default();
    let Ok(value) = u64::from_str_radix(&digits[..digits.len().min(16)], 16) else {
        return [0.0, 0.0, 0.0, 1.0];
    };
    let byte = |shift: u32| ((value >> shift) & 0xff) as f64 / 255.0;
    if text.trim().len() >= 9 {
        [byte(24), byte(16), byte(8), byte(0)]
    } else {
        [byte(16), byte(8), byte(0), 1.0]
    }
}

fn rgba(rgb: [u8; 3], alpha: f64) -> Rgba {
    [
        f64::from(rgb[0]) / 255.0,
        f64::from(rgb[1]) / 255.0,
        f64::from(rgb[2]) / 255.0,
        alpha,
    ]
}

fn nm(mm: f64) -> Nm {
    (mm * 1e6).round() as Nm
}

fn mm(nm: Nm) -> f64 {
    nm as f64 / 1e6
}
