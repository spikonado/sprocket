//! Board outlines from Edge.Cuts, after KiCad's `BuildBoardPolygonOutlines`.

use std::collections::HashMap;

use serde::Serialize;

use crate::geometry::{Bounds, Point, point};

/// KiCad's `DEFAULT_CHAINING_EPSILON_MM`: open pieces whose ends are this close join.
const CHAINING_EPSILON: f64 = 0.01;
/// Points closer than this are the same vertex.
const SAME_POINT: f64 = 1e-9;

#[derive(Default)]
pub struct EdgeCuts {
    rings: Vec<Vec<Point>>,
    pieces: Vec<Vec<Point>>,
}

/// One outer outline and its holes, in mm, as flat `[x0, y0, x1, y1, …]` rings. Outer rings
/// have a positive shoelace area over (x, y) and holes a negative one.
#[derive(Debug, PartialEq, Serialize)]
pub struct Outline {
    pub outer: Vec<f64>,
    pub holes: Vec<Vec<f64>>,
}

impl EdgeCuts {
    pub fn closed(&mut self, ring: Vec<Point>) {
        self.rings.push(ring);
    }

    pub fn open(&mut self, piece: Vec<Point>) {
        if piece.len() >= 2 && piece.iter().all(|p| p.x.is_finite() && p.y.is_finite()) {
            self.pieces.push(piece);
        }
    }

    pub fn outlines(mut self, fallback: Bounds) -> Vec<Outline> {
        let chained = chain(&self.pieces);
        self.rings.extend(chained);
        let rings: Vec<Vec<Point>> = self.rings.into_iter().filter_map(clean_ring).collect();
        if rings.is_empty() {
            return rectangle(fallback).into_iter().collect();
        }
        nest(&rings)
    }
}

/// Joins open pieces end to end like KiCad's `doConvertOutlineToPolygon`: each chain grows
/// forward and then backward from a seed and closes when its ends meet. Chains that don't
/// close are dropped.
fn chain(pieces: &[Vec<Point>]) -> Vec<Vec<Point>> {
    let cell = |p: Point| {
        (
            (p.x / CHAINING_EPSILON).floor() as i64,
            (p.y / CHAINING_EPSILON).floor() as i64,
        )
    };
    let mut grid: HashMap<(i64, i64), Vec<(usize, bool)>> = HashMap::new();
    for (index, piece) in pieces.iter().enumerate() {
        for (at_end, p) in [(false, piece[0]), (true, piece[piece.len() - 1])] {
            grid.entry(cell(p)).or_default().push((index, at_end));
        }
    }
    let mut used = vec![false; pieces.len()];
    let nearest = |p: Point, used: &[bool]| {
        let (cx, cy) = cell(p);
        let mut best: Option<(f64, usize, bool)> = None;
        for x in cx - 1..=cx + 1 {
            for y in cy - 1..=cy + 1 {
                for &(index, at_end) in grid.get(&(x, y)).into_iter().flatten() {
                    if used[index] {
                        continue;
                    }
                    let piece = &pieces[index];
                    let end = if at_end {
                        piece[piece.len() - 1]
                    } else {
                        piece[0]
                    };
                    let distance = (end - p).length();
                    if distance <= CHAINING_EPSILON
                        && best.is_none_or(|(nearest, ..)| distance < nearest)
                    {
                        best = Some((distance, index, at_end));
                    }
                }
            }
        }
        best.map(|(_, index, at_end)| (index, at_end))
    };

    let mut rings = Vec::new();
    for seed in 0..pieces.len() {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        let mut chain = pieces[seed].clone();
        let mut count = 1;
        for forward in [true, false] {
            if !forward {
                chain.reverse();
            }
            while let Some((index, at_end)) = nearest(chain[chain.len() - 1], &used) {
                used[index] = true;
                count += 1;
                let piece = &pieces[index];
                if at_end {
                    append(&mut chain, piece.iter().rev());
                } else {
                    append(&mut chain, piece.iter());
                }
            }
            if (count > 1 || !forward)
                && (chain[chain.len() - 1] - chain[0]).length() <= CHAINING_EPSILON
            {
                rings.push(chain);
                break;
            }
        }
    }
    rings
}

fn append<'p>(chain: &mut Vec<Point>, piece: impl Iterator<Item = &'p Point>) {
    for &p in piece {
        if (p - chain[chain.len() - 1]).length() > SAME_POINT {
            chain.push(p);
        }
    }
}

fn clean_ring(ring: Vec<Point>) -> Option<Vec<Point>> {
    let mut out: Vec<Point> = Vec::with_capacity(ring.len());
    for p in ring {
        if !(p.x.is_finite() && p.y.is_finite()) {
            return None;
        }
        if out
            .last()
            .is_none_or(|&last| (p - last).length() > SAME_POINT)
        {
            out.push(p);
        }
    }
    while out.len() > 1 && (out[out.len() - 1] - out[0]).length() <= SAME_POINT {
        out.pop();
    }
    (out.len() >= 3 && signed_area(&out) != 0.0).then_some(out)
}

/// Rings inside an even number of others are outlines; the rest are holes of the ring one
/// level up, as KiCad's `buildContourHierarchy` decides.
fn nest(rings: &[Vec<Point>]) -> Vec<Outline> {
    let boxes: Vec<Bounds> = rings
        .iter()
        .map(|ring| {
            let mut bounds = Bounds::EMPTY;
            for &p in ring {
                bounds.include(p, 0.0);
            }
            bounds
        })
        .collect();
    let parents: Vec<Vec<usize>> = (0..rings.len())
        .map(|inner| {
            let p = rings[inner][0];
            (0..rings.len())
                .filter(|&outer| {
                    let b = &boxes[outer];
                    outer != inner
                        && (b.min.x..=b.max.x).contains(&p.x)
                        && (b.min.y..=b.max.y).contains(&p.y)
                        && contains(&rings[outer], p)
                })
                .collect()
        })
        .collect();

    // Largest first, so a board's main outline leads.
    let mut outers: Vec<usize> = (0..rings.len())
        .filter(|&index| parents[index].len().is_multiple_of(2))
        .collect();
    outers.sort_by(|&a, &b| {
        signed_area(&rings[b])
            .abs()
            .total_cmp(&signed_area(&rings[a]).abs())
    });
    let mut outline_of = vec![None; rings.len()];
    let mut outlines = Vec::with_capacity(outers.len());
    for index in outers {
        outline_of[index] = Some(outlines.len());
        outlines.push(Outline {
            outer: flatten(&rings[index], true),
            holes: Vec::new(),
        });
    }
    for (index, ring) in rings.iter().enumerate() {
        let depth = parents[index].len();
        if depth.is_multiple_of(2) {
            continue;
        }
        let parent = parents[index]
            .iter()
            .find(|&&parent| parents[parent].len() == depth - 1)
            .and_then(|&parent| outline_of[parent]);
        if let Some(parent) = parent {
            outlines[parent].holes.push(flatten(ring, false));
        }
    }
    outlines
}

fn rectangle(bounds: Bounds) -> Option<Outline> {
    if bounds.is_empty() {
        return None;
    }
    let (mut min, mut max) = (bounds.min, bounds.max);
    // KiCad inflates a box without area by 1 mm.
    if max.x - min.x == 0.0 || max.y - min.y == 0.0 {
        min = min - point(1.0, 1.0);
        max = max + point(1.0, 1.0);
    }
    let ring = [min, point(max.x, min.y), max, point(min.x, max.y)];
    Some(Outline {
        outer: flatten(&ring, true),
        holes: Vec::new(),
    })
}

/// Even-odd ray casting.
fn contains(ring: &[Point], p: Point) -> bool {
    let mut inside = false;
    let mut previous = ring[ring.len() - 1];
    for &current in ring {
        if (current.y > p.y) != (previous.y > p.y)
            && p.x
                < previous.x
                    + (p.y - previous.y) * (current.x - previous.x) / (current.y - previous.y)
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

fn signed_area(ring: &[Point]) -> f64 {
    // Translate before multiplying so tiny rings retain their area far from the origin.
    let origin = ring[0];
    let mut previous = ring[ring.len() - 1] - origin;
    let mut twice = 0.0;
    for &p in ring {
        let current = p - origin;
        twice += previous.x * current.y - current.x * previous.y;
        previous = current;
    }
    twice / 2.0
}

fn flatten(ring: &[Point], positive: bool) -> Vec<f64> {
    let mut flat: Vec<f64> = ring.iter().flat_map(|p| [p.x, p.y]).collect();
    if (signed_area(ring) > 0.0) != positive {
        flat.as_chunks_mut::<2>().0.reverse();
    }
    flat
}

#[cfg(test)]
mod tests;
