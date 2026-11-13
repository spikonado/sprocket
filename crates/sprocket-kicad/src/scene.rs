use std::collections::HashMap;

use earcut::Earcut;
use serde::{Serialize, Serializer};

use crate::geometry::{Bounds, Point, clip_ring};

const MAGIC: &[u8; 4] = b"SPKS";
const FORMAT_VERSION: u32 = 1;
pub const HOLES_LAYER: &str = "Holes";
const EDGE_LAYER: &str = "Edge.Cuts";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Footprint,
    Pad,
    Track,
    Arc,
    Via,
    Zone,
    Text,
    Shape,
    Dimension,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub parent: Option<u32>,
    pub layer: Option<String>,
    pub net: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<[f64; 3]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    kind: ItemKind,
    #[serde(flatten)]
    info: ItemInfo,
    #[serde(rename = "bbox", serialize_with = "serialize_bounds")]
    bounds: Bounds,
}

/// Where primitives go: the item they belong to and the layer they draw on.
#[derive(Clone, Copy, Debug)]
pub struct Pen {
    pub item: u32,
    pub layer: usize,
}

#[derive(Default)]
struct Layer {
    name: String,
    segments: Vec<u8>,
    circles: Vec<u8>,
    triangles: Vec<u8>,
    bounds: Bounds,
}

#[derive(Default)]
pub struct Scene {
    layers: Vec<Layer>,
    layer_ids: HashMap<String, usize>,
    user_names: HashMap<String, String>,
    items: Vec<Item>,
    nets: Vec<String>,
    net_ids: HashMap<String, u32>,
    earcut: Earcut<f64>,
    flat: Vec<[f64; 2]>,
    hole_starts: Vec<u32>,
    indices: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta<'a> {
    kind: &'static str,
    #[serde(serialize_with = "serialize_bounds")]
    bounds: Bounds,
    layers: Vec<LayerMeta<'a>>,
    items: &'a [Item],
    nets: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerMeta<'a> {
    name: &'a str,
    user_name: Option<&'a str>,
    kind: LayerKind,
    side: Option<Side>,
    segments: usize,
    circles: usize,
    triangle_vertices: usize,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum LayerKind {
    Copper,
    Silk,
    Mask,
    Paste,
    Fab,
    Courtyard,
    Edge,
    Adhesive,
    User,
    Holes,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Side {
    Front,
    Back,
    Inner,
}

const SEGMENT_BYTES: usize = 24;
const CIRCLE_BYTES: usize = 20;
const VERTEX_BYTES: usize = 12;

impl Scene {
    pub fn new() -> Scene {
        let mut scene = Scene::default();
        scene.net("");
        scene
    }

    pub fn layer(&mut self, name: &str) -> usize {
        if let Some(&id) = self.layer_ids.get(name) {
            return id;
        }
        let id = self.layers.len();
        self.layers.push(Layer {
            name: name.to_owned(),
            ..Layer::default()
        });
        self.layer_ids.insert(name.to_owned(), id);
        id
    }

    pub fn set_user_name(&mut self, layer: &str, user_name: &str) {
        if layer != user_name {
            self.user_names
                .insert(layer.to_owned(), user_name.to_owned());
        }
    }

    pub fn net(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.net_ids.get(name) {
            return id;
        }
        let id = self.nets.len() as u32;
        self.nets.push(name.to_owned());
        self.net_ids.insert(name.to_owned(), id);
        id
    }

    pub fn add_item(&mut self, kind: ItemKind, info: ItemInfo) -> u32 {
        let id = self.items.len() as u32;
        self.items.push(Item {
            kind,
            info,
            bounds: Bounds::EMPTY,
        });
        id
    }

    /// Grows an item's box without drawing, for items such as unfilled zones.
    pub fn include(&mut self, item: u32, p: Point) {
        self.items[item as usize].bounds.include(p, 0.0);
    }

    /// Adds a child's box to its parent's, as pads do for their footprint.
    pub fn merge_bounds(&mut self, parent: u32, child: u32) {
        let child = self.items[child as usize].bounds;
        self.items[parent as usize].bounds.merge(&child);
    }

    fn touch(&mut self, pen: Pen, p: Point, margin: f64) {
        self.items[pen.item as usize].bounds.include(p, margin);
        self.layers[pen.layer].bounds.include(p, margin);
    }

    pub fn segment(&mut self, pen: Pen, a: Point, b: Point, width: f64) {
        if !(width > 0.0) {
            return;
        }
        self.touch(pen, a, width / 2.0);
        self.touch(pen, b, width / 2.0);
        let out = &mut self.layers[pen.layer].segments;
        for value in [a.x, a.y, b.x, b.y, width] {
            out.extend_from_slice(&(value as f32).to_le_bytes());
        }
        out.extend_from_slice(&pen.item.to_le_bytes());
    }

    /// A filled disc when `stroke` is 0, otherwise a ring centered on `radius`.
    pub fn circle(&mut self, pen: Pen, center: Point, radius: f64, stroke: f64) {
        if !(radius > 0.0) {
            return;
        }
        self.touch(pen, center, radius + stroke / 2.0);
        let out = &mut self.layers[pen.layer].circles;
        for value in [center.x, center.y, radius, stroke] {
            out.extend_from_slice(&(value as f32).to_le_bytes());
        }
        out.extend_from_slice(&pen.item.to_le_bytes());
    }

    pub fn polyline(&mut self, pen: Pen, points: &[Point], width: f64, closed: bool) {
        if let [dot] = points {
            self.segment(pen, *dot, *dot, width);
        }
        for pair in points.windows(2) {
            self.segment(pen, pair[0], pair[1], width);
        }
        if closed && points.len() > 2 {
            self.segment(pen, points[points.len() - 1], points[0], width);
        }
    }

    /// Triangulates a filled polygon with optional holes.
    pub fn polygon(&mut self, pen: Pen, outline: &[Point], holes: &[Vec<Point>]) {
        if outline.len() < 3 {
            return;
        }
        for &p in outline {
            self.touch(pen, p, 0.0);
        }
        if holes.is_empty() {
            self.split_polygon(pen, outline, 0);
        } else {
            self.triangulate(pen, outline, holes);
        }
    }

    /// Earcut slows down sharply on zone fills with 100k+ vertices, so large rings are cut
    /// in half at the median vertex until each piece is small. Clipping a ring against a
    /// half-plane keeps one ring, joining its separate parts along the cut line.
    fn split_polygon(&mut self, pen: Pen, ring: &[Point], depth: u32) {
        const MAX_PIECE_VERTICES: usize = 1024;
        if ring.len() <= MAX_PIECE_VERTICES || depth >= 24 {
            self.triangulate(pen, ring, &[]);
            return;
        }
        let mut bounds = Bounds::EMPTY;
        for &p in ring {
            bounds.include(p, 0.0);
        }
        let vertical = bounds.max.x - bounds.min.x >= bounds.max.y - bounds.min.y;
        let coordinate = |p: &Point| if vertical { p.x } else { p.y };
        let mut values: Vec<f64> = ring.iter().map(coordinate).collect();
        let middle = values.len() / 2;
        let cut = *values.select_nth_unstable_by(middle, f64::total_cmp).1;
        for keep_below in [true, false] {
            let piece = clip_ring(ring, vertical, cut, keep_below);
            if piece.len() >= ring.len() {
                self.triangulate(pen, &piece, &[]);
            } else if piece.len() >= 3 {
                self.split_polygon(pen, &piece, depth + 1);
            }
        }
    }

    fn triangulate(&mut self, pen: Pen, outline: &[Point], holes: &[Vec<Point>]) {
        self.flat.clear();
        self.hole_starts.clear();
        self.flat.extend(outline.iter().map(|p| [p.x, p.y]));
        for hole in holes.iter().filter(|hole| hole.len() >= 3) {
            self.hole_starts.push(self.flat.len() as u32);
            self.flat.extend(hole.iter().map(|p| [p.x, p.y]));
        }
        self.earcut
            .earcut_slice(&self.flat, &self.hole_starts, &mut self.indices);
        let layer = &mut self.layers[pen.layer];
        for &index in &self.indices {
            let [x, y] = self.flat[index as usize];
            layer.triangles.extend_from_slice(&(x as f32).to_le_bytes());
            layer.triangles.extend_from_slice(&(y as f32).to_le_bytes());
            layer.triangles.extend_from_slice(&pen.item.to_le_bytes());
        }
    }

    pub fn encode(self) -> Vec<u8> {
        let mut order: Vec<usize> = (0..self.layers.len())
            .filter(|&id| {
                let layer = &self.layers[id];
                !(layer.segments.is_empty()
                    && layer.circles.is_empty()
                    && layer.triangles.is_empty())
            })
            .collect();
        order.sort_by_key(|&id| layer_rank(&self.layers[id].name));

        let mut all = Bounds::EMPTY;
        for id in &order {
            all.merge(&self.layers[*id].bounds);
        }
        let bounds = self
            .layer_ids
            .get(EDGE_LAYER)
            .map(|&id| self.layers[id].bounds)
            .filter(|bounds| !bounds.is_empty())
            .unwrap_or(all);

        let layers = order
            .iter()
            .map(|&id| {
                let layer = &self.layers[id];
                let (kind, side) = classify(&layer.name);
                LayerMeta {
                    name: &layer.name,
                    user_name: self.user_names.get(&layer.name).map(String::as_str),
                    kind,
                    side,
                    segments: layer.segments.len() / SEGMENT_BYTES,
                    circles: layer.circles.len() / CIRCLE_BYTES,
                    triangle_vertices: layer.triangles.len() / VERTEX_BYTES,
                }
            })
            .collect();
        let meta = serde_json::to_vec(&Meta {
            kind: "pcb",
            bounds,
            layers,
            items: &self.items,
            nets: &self.nets,
        })
        .expect("scene meta serializes");

        let padding = meta.len().next_multiple_of(4) - meta.len();
        let buffers: usize = order
            .iter()
            .map(|&id| {
                let layer = &self.layers[id];
                layer.segments.len() + layer.circles.len() + layer.triangles.len()
            })
            .sum();
        let mut out = Vec::with_capacity(12 + meta.len() + padding + buffers);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        out.extend_from_slice(&meta);
        out.resize(out.len() + padding, 0);
        for &id in &order {
            let layer = &self.layers[id];
            out.extend_from_slice(&layer.segments);
            out.extend_from_slice(&layer.circles);
            out.extend_from_slice(&layer.triangles);
        }
        out
    }
}

/// Writes `[minX, minY, maxX, maxY]` rounded to 0.1 µm, or zeros when empty.
fn serialize_bounds<S: Serializer>(bounds: &Bounds, serializer: S) -> Result<S::Ok, S::Error> {
    let corners = if bounds.is_empty() {
        [0.0; 4]
    } else {
        [bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y]
            .map(|value| (value * 1e4).round() / 1e4)
    };
    corners.serialize(serializer)
}

fn classify(name: &str) -> (LayerKind, Option<Side>) {
    if name == HOLES_LAYER {
        return (LayerKind::Holes, None);
    }
    if name == EDGE_LAYER {
        return (LayerKind::Edge, None);
    }
    let Some((prefix, suffix)) = name.split_once('.') else {
        return (LayerKind::User, None);
    };
    let side = match prefix {
        "F" => Side::Front,
        "B" => Side::Back,
        _ if suffix == "Cu" && prefix.starts_with("In") => Side::Inner,
        _ => return (LayerKind::User, None),
    };
    let kind = match suffix {
        "Cu" => LayerKind::Copper,
        "SilkS" => LayerKind::Silk,
        "Mask" => LayerKind::Mask,
        "Paste" => LayerKind::Paste,
        "Fab" => LayerKind::Fab,
        "CrtYd" => LayerKind::Courtyard,
        "Adhes" => LayerKind::Adhesive,
        _ => return (LayerKind::User, None),
    };
    (kind, Some(side))
}

/// Bottom-to-top order for the front view.
fn layer_rank(name: &str) -> (u32, u32) {
    const BACK: [&str; 6] = [
        "B.CrtYd", "B.Fab", "B.Adhes", "B.SilkS", "B.Paste", "B.Mask",
    ];
    const FRONT: [&str; 6] = [
        "F.Mask", "F.Paste", "F.SilkS", "F.Adhes", "F.Fab", "F.CrtYd",
    ];
    const USER: [&str; 6] = [
        "Edge.Cuts",
        "Margin",
        "Dwgs.User",
        "Cmts.User",
        "Eco1.User",
        "Eco2.User",
    ];
    if let Some(rank) = BACK.iter().position(|&layer| layer == name) {
        return (0, rank as u32);
    }
    if name == "B.Cu" {
        return (1, 0);
    }
    if let Some(number) = inner_copper_number(name) {
        return (2, u32::MAX - number);
    }
    if name == "F.Cu" {
        return (3, 0);
    }
    if let Some(rank) = FRONT.iter().position(|&layer| layer == name) {
        return (4, rank as u32);
    }
    if let Some(rank) = USER.iter().position(|&layer| layer == name) {
        return (5, rank as u32);
    }
    if name == HOLES_LAYER {
        return (7, 0);
    }
    let user_number = name
        .strip_prefix("User.")
        .and_then(|number| number.parse().ok())
        .unwrap_or(u32::MAX);
    (6, user_number)
}

pub fn inner_copper_number(name: &str) -> Option<u32> {
    name.strip_prefix("In")?.strip_suffix(".Cu")?.parse().ok()
}

#[cfg(test)]
mod tests;
