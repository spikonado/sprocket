//! Turns KiCad board files into the binary scenes Sprocket's PCB viewer draws.

use anyhow::{Context, Result};

mod board;
mod geometry;
mod models;
mod outline;
mod scene;
mod sexpr;
mod text;

pub use models::ModelsBoard;

/// Parses a `.kicad_pcb` file and encodes its drawable geometry as an `SPKS` scene.
pub fn pcb_scene(bytes: &[u8]) -> Result<Vec<u8>> {
    board::scene(utf8(bytes)?)
}

/// The board reduced to what KiCad's glTF export needs to place component models, or `None`
/// when no footprint has a model. Its key matches the scene's `models` key.
pub fn pcb_models_board(bytes: &[u8]) -> Result<Option<ModelsBoard>> {
    let mut writer = models::ModelsWriter::default();
    sexpr::for_each_item(utf8(bytes)?, "kicad_pcb", |item| {
        writer.item(item);
        Ok(())
    })?;
    Ok(writer.finish())
}

fn utf8(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).context("the board file is not valid UTF-8")
}
