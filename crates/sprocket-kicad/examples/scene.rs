use std::time::Instant;

use anyhow::{Context, Result};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(board), Some(out)) = (args.next(), args.next()) else {
        anyhow::bail!("usage: scene <board.kicad_pcb> <out.spks>");
    };
    let bytes = std::fs::read(&board).with_context(|| format!("reading {board}"))?;
    let started = Instant::now();
    let scene = sprocket_kicad::pcb_scene(&bytes)?;
    let elapsed = started.elapsed();
    std::fs::write(&out, &scene).with_context(|| format!("writing {out}"))?;
    println!(
        "{board}: {} bytes parsed and encoded into {} bytes in {:.0} ms",
        bytes.len(),
        scene.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    Ok(())
}
