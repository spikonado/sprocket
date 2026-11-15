use serde_json::Value;

use super::scene;

pub(super) struct Decoded {
    pub meta: Value,
    pub layers: Vec<DecodedLayer>,
}

pub(super) struct DecodedLayer {
    pub name: String,
    /// `[x1, y1, x2, y2, width]`
    pub segments: Vec<[f32; 5]>,
    /// `[cx, cy, radius, strokeWidth]`
    pub circles: Vec<[f32; 4]>,
    pub triangles: Vec<[[f32; 2]; 3]>,
}

pub(super) fn decode(src: &str) -> Decoded {
    let bytes = scene(src).unwrap();
    let word = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let float = |offset: usize| f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let meta_len = word(8) as usize;
    let meta: Value = serde_json::from_slice(&bytes[12..12 + meta_len]).unwrap();
    let mut offset = 12 + meta_len.next_multiple_of(4);
    let mut layers = Vec::new();
    for layer in meta["layers"].as_array().unwrap() {
        let count = |key: &str| layer[key].as_u64().unwrap() as usize;
        let segments = (0..count("segments"))
            .map(|index| std::array::from_fn(|field| float(offset + index * 24 + field * 4)))
            .collect();
        offset += count("segments") * 24;
        let circles = (0..count("circles"))
            .map(|index| std::array::from_fn(|field| float(offset + index * 20 + field * 4)))
            .collect();
        offset += count("circles") * 20;
        let triangles = (0..count("triangleVertices") / 3)
            .map(|index| {
                std::array::from_fn(|vertex| {
                    std::array::from_fn(|axis| float(offset + index * 36 + vertex * 12 + axis * 4))
                })
            })
            .collect();
        offset += count("triangleVertices") * 12;
        layers.push(DecodedLayer {
            name: format!(
                "{}/{}",
                layer["name"].as_str().unwrap(),
                layer["part"].as_str().unwrap()
            ),
            segments,
            circles,
            triangles,
        });
    }
    assert_eq!(offset, bytes.len());
    Decoded { meta, layers }
}

pub(super) fn close(a: f32, b: f64) -> bool {
    (f64::from(a) - b).abs() < 1e-4
}

impl Decoded {
    pub fn layer(&self, name: &str) -> &DecodedLayer {
        self.layers.iter().find(|layer| layer.name == name).unwrap()
    }
}

impl DecodedLayer {
    pub fn bounds(&self) -> [f64; 4] {
        use crate::geometry::{Bounds, point};
        let mut bounds = Bounds::EMPTY;
        for &[x1, y1, x2, y2, width] in &self.segments {
            bounds.include(point(x1.into(), y1.into()), f64::from(width) / 2.0);
            bounds.include(point(x2.into(), y2.into()), f64::from(width) / 2.0);
        }
        for &[x, y, radius, stroke] in &self.circles {
            bounds.include(point(x.into(), y.into()), f64::from(radius + stroke / 2.0));
        }
        for &[x, y] in self.triangles.iter().flatten() {
            bounds.include(point(x.into(), y.into()), 0.0);
        }
        [bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y]
    }
}

pub(super) fn covers(layer: &DecodedLayer, p: [f32; 2]) -> bool {
    layer.triangles.iter().any(|t| {
        let cross = |a: [f32; 2], b: [f32; 2]| {
            (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        };
        let sides = [cross(t[0], t[1]), cross(t[1], t[2]), cross(t[2], t[0])];
        sides.iter().all(|&s| s >= -1e-6) || sides.iter().all(|&s| s <= 1e-6)
    })
}
