//! Turns KiCad board files into the binary scenes Sprocket's PCB viewer draws.

use anyhow::{Context, Result};

mod board;
mod geometry;
mod scene;
mod sexpr;
mod text;

/// Parses a `.kicad_pcb` file and encodes its drawable geometry as an `SPKS` scene.
pub fn pcb_scene(bytes: &[u8]) -> Result<Vec<u8>> {
    let text = std::str::from_utf8(bytes).context("the board file is not valid UTF-8")?;
    board::scene(text)
}
