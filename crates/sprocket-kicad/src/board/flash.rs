//! Which copper layers a via or plated pad draws its ring on, after KiCad's
//! `PCB_VIA::FlashLayer` and `PAD::FlashLayer`.

use std::collections::{HashMap, HashSet};

use super::Board;
use crate::geometry::{Point, segment_distance};
use crate::scene::{Part, Pen};
use crate::sexpr::Expr;

/// The side of the grid cells that index tracks, in mm.
const CELL: f64 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unconnected {
    KeepAll,
    RemoveAll,
    KeepEnds,
    EndsOnly,
}

impl Unconnected {
    /// Reads `remove_unused_layers`, `keep_end_layers` and `start_end_only` in file order, as
    /// KiCad's parser does.
    fn of(item: Expr) -> Unconnected {
        let mut mode = Unconnected::KeepAll;
        for child in item.args() {
            let on = || {
                child
                    .arg(0)
                    .and_then(Expr::atom)
                    .is_none_or(|value| matches!(value, "yes" | "true"))
            };
            match child.head() {
                Some("remove_unused_layers") if on() => mode = Unconnected::RemoveAll,
                Some("remove_unused_layers") => mode = Unconnected::KeepAll,
                Some("keep_end_layers") if on() => mode = Unconnected::KeepEnds,
                Some("keep_end_layers") => mode = Unconnected::RemoveAll,
                Some("start_end_only") if on() => mode = Unconnected::EndsOnly,
                _ => {}
            }
        }
        mode
    }
}

/// A round-ended segment, such as a track or a drill hole.
#[derive(Clone, Copy, Debug)]
pub(super) struct Capsule {
    pub a: Point,
    pub b: Point,
    pub radius: f64,
}

impl Capsule {
    fn touches(&self, other: &Capsule) -> bool {
        segment_distance(self.a, self.b, other.a, other.b) <= self.radius + other.radius
    }

    fn cells(&self) -> impl Iterator<Item = (i32, i32)> + use<> {
        let cell = |value: f64| (value / CELL).floor() as i32;
        let (x0, x1) = (
            cell(self.a.x.min(self.b.x) - self.radius),
            cell(self.a.x.max(self.b.x) + self.radius),
        );
        let (y0, y1) = (
            cell(self.a.y.min(self.b.y) - self.radius),
            cell(self.a.y.max(self.b.y) + self.radius),
        );
        (x0..=x1).flat_map(move |x| (y0..=y1).map(move |y| (x, y)))
    }
}

/// What decides the copper layers of one via or plated pad.
pub(super) struct FlashRule {
    mode: Unconnected,
    /// The copper indices of the hole's first and last layers.
    ends: (usize, usize),
    /// Layers in `zone_layer_connections`, where a zone keeps the ring.
    zone_layers: Vec<String>,
    net: u32,
    hole: Capsule,
}

impl FlashRule {
    pub(super) fn new(item: Expr, ends: (usize, usize), net: u32, hole: Capsule) -> FlashRule {
        FlashRule {
            mode: Unconnected::of(item),
            ends,
            zone_layers: item
                .child("zone_layer_connections")
                .into_iter()
                .flat_map(Expr::args)
                .filter_map(Expr::text)
                .map(Into::into)
                .collect(),
            net,
            hole,
        }
    }
}

/// Copper drawn only where a track on the same net touches its hole, and the tracks to check.
#[derive(Default)]
pub(super) struct Flashing {
    tracks: Vec<Capsule>,
    /// Track indices by copper layer, net and grid cell.
    cells: HashMap<(usize, u32, i32, i32), Vec<u32>>,
    pending: Vec<Pending>,
}

struct Pending {
    item: u32,
    layer: String,
    copper: usize,
    net: u32,
    hole: Capsule,
}

impl Board {
    pub(super) fn index_track(&mut self, copper: usize, net: u32, points: &[Point], width: f64) {
        let flashing = &mut self.flashing;
        for pair in points.windows(2) {
            let track = Capsule {
                a: pair[0],
                b: pair[1],
                radius: width / 2.0,
            };
            let id = flashing.tracks.len() as u32;
            flashing.tracks.push(track);
            let span = track.b - track.a;
            let pieces = (span.length() / CELL).ceil().max(1.0) as usize;
            let at = |step: usize| track.a + span * (step as f64 / pieces as f64);
            let cells: HashSet<(i32, i32)> = (0..pieces)
                .flat_map(|piece| {
                    Capsule {
                        a: at(piece),
                        b: at(piece + 1),
                        ..track
                    }
                    .cells()
                })
                .collect();
            for (x, y) in cells {
                flashing
                    .cells
                    .entry((copper, net, x, y))
                    .or_default()
                    .push(id);
            }
        }
    }

    /// The pen for `layer`, which flashes with copper layer `copper`, or `None` where KiCad
    /// never draws it.
    pub(super) fn flash_pen(
        &mut self,
        item: u32,
        layer: &str,
        copper: usize,
        rule: &FlashRule,
    ) -> Option<Pen> {
        let end = copper == rule.ends.0 || copper == rule.ends.1;
        let conditional = match rule.mode {
            Unconnected::KeepAll => false,
            Unconnected::EndsOnly if !end => return None,
            Unconnected::EndsOnly => false,
            Unconnected::KeepEnds => !end,
            Unconnected::RemoveAll => true,
        };
        if !conditional || rule.zone_layers.contains(&self.copper[copper]) {
            return Some(self.pen(item, layer, Part::Main));
        }
        self.flashing.pending.push(Pending {
            item,
            layer: layer.to_owned(),
            copper,
            net: rule.net,
            hole: rule.hole,
        });
        Some(Pen {
            item,
            layer: self.scene.pending_layer(layer),
        })
    }

    /// Keeps the conditional copper that a track touches and drops the rest.
    pub(super) fn flash(&mut self) {
        let flashing = std::mem::take(&mut self.flashing);
        let touched = |pending: &&Pending| {
            pending.hole.cells().any(|(x, y)| {
                flashing
                    .cells
                    .get(&(pending.copper, pending.net, x, y))
                    .is_some_and(|tracks| {
                        tracks
                            .iter()
                            .any(|&track| flashing.tracks[track as usize].touches(&pending.hole))
                    })
            })
        };
        let kept: HashSet<(u32, &str)> = flashing
            .pending
            .iter()
            .filter(touched)
            .map(|pending| (pending.item, pending.layer.as_str()))
            .collect();
        self.scene
            .flash(|item, layer| kept.contains(&(item, layer)));
    }
}
