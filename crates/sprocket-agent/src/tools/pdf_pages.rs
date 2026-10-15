use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;

use anyhow::anyhow;
use lopdf::{Object, ObjectId};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::hosted_parse::{HostedParseContext, ParsedPage};
use super::parse_file::{LocalConversionFailed, run_cancellable_blocking};

/// Hosted OCR bills per page, so scanned pages beyond this stay unextracted.
const MAX_OCR_PAGES: usize = 20;
/// Mirrors pdf-inspector's per-stream bound against decompression bombs.
const MAX_STREAM_DECOMPRESSED_BYTES: usize = 8 * 1024 * 1024;
const MAX_PAGE_TREE_DEPTH: usize = 64;
const INHERITED_PAGE_KEYS: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
/// Document navigation, which can reference dropped pages and never renders.
const CATALOG_NAVIGATION: [&[u8]; 6] = [
    b"Outlines",
    b"Dests",
    b"Names",
    b"OpenAction",
    b"StructTreeRoot",
    b"Threads",
];

/// Converts text pages locally and sends only scanned pages to hosted OCR.
/// Fails with [`LocalConversionFailed`] only before contacting the hosted
/// parser, because each tool job gets a single hosted parse request.
pub(super) async fn pdf_markdown(
    bytes: Vec<u8>,
    hosted: Option<&HostedParseContext<'_>>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<String> {
    let build_ocr_input = hosted.is_some();
    let local =
        run_cancellable_blocking(cancellation, move || local_pdf(&bytes, build_ocr_input)).await?;
    let (pdf, ocr_input) = match local {
        LocalPdf::Complete(markdown) => return Ok(markdown),
        LocalPdf::Scanned { pdf, ocr_input } => (pdf, ocr_input),
    };
    let ocr = match (hosted, ocr_input) {
        (Some(hosted), Some(Ok(input))) => recognize(hosted, input, cancellation).await,
        (_, Some(Err(error))) => Err(error),
        _ => Err(anyhow!("hosted OCR is unavailable")),
    };
    match ocr {
        Err(error) if error.is::<WorkspaceOperationCancelled>() || cancellation.is_cancelled() => {
            Err(error)
        }
        ocr => Ok(pdf.assemble(ocr.map_err(|error| format!("{error:#}")))),
    }
}

enum LocalPdf {
    Complete(String),
    Scanned {
        pdf: ScannedPdf,
        ocr_input: Option<anyhow::Result<Vec<u8>>>,
    },
}

fn local_pdf(bytes: &[u8], build_ocr_input: bool) -> anyhow::Result<LocalPdf> {
    let (flagged, page_count) = match anydoc::to_markdown_bytes(bytes, anydoc::Format::Pdf) {
        Ok(markdown) => return Ok(LocalPdf::Complete(markdown)),
        Err(anydoc::ConvertError::NeedsOcr { pages, page_count }) => (pages, page_count),
        Err(error) => return Err(LocalConversionFailed(error.to_string()).into()),
    };
    let extracted = pdf_inspector::extract_pages_markdown_mem(bytes, None)
        .map_err(|error| LocalConversionFailed(error.to_string()))?
        .pages;
    let pdf = ScannedPdf::new(page_count, extracted, flagged);
    if pdf.scanned.is_empty() {
        return Ok(LocalPdf::Complete(pdf.assemble(Ok(Vec::new()))));
    }
    let ocr_input = build_ocr_input.then(|| sub_pdf(bytes, pdf.ocr_batch()));
    Ok(LocalPdf::Scanned { pdf, ocr_input })
}

async fn recognize(
    hosted: &HostedParseContext<'_>,
    input: Vec<u8>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Vec<ParsedPage>> {
    let file = run_cancellable_blocking(cancellation, move || {
        let mut file = tempfile::Builder::new()
            .prefix("sprocket-ocr-")
            .suffix(".pdf")
            .tempfile()?;
        file.write_all(&input)?;
        Ok(file)
    })
    .await?;
    super::hosted_parse::parse_pages(
        hosted,
        file.path(),
        Path::new("scanned-pages.pdf"),
        cancellation,
    )
    .await
}

fn load_pdf(bytes: &[u8]) -> anyhow::Result<lopdf::Document> {
    let options = lopdf::LoadOptions::with_max_decompressed_size(MAX_STREAM_DECOMPRESSED_BYTES);
    lopdf::Document::load_mem_with_options(bytes, options)
        .map_err(|error| anyhow!("failed to load the PDF for OCR: {error}"))
}

/// Keeps only `pages` (1-indexed, ascending) under a single flat page tree.
fn sub_pdf(bytes: &[u8], pages: &[u32]) -> anyhow::Result<Vec<u8>> {
    let mut document = load_pdf(bytes)?;
    let numbered = document.get_pages();
    let kept = pages
        .iter()
        .map(|page| {
            numbered
                .get(page)
                .copied()
                .ok_or_else(|| anyhow!("page {page} is missing from the PDF"))
        })
        .collect::<anyhow::Result<Vec<ObjectId>>>()?;
    let tree = document.catalog()?.get(b"Pages")?.as_reference()?;
    for &id in &kept {
        let inherited = inherited_attributes(&document, id)?;
        let page = document.get_dictionary_mut(id)?;
        for (key, value) in inherited {
            page.set(key, value);
        }
        page.set("Parent", tree);
    }
    // Links and form fields can still reference dropped pages.
    // Nulling those keeps the dropped pages' content out of the upload.
    for (_, id) in numbered {
        if !kept.contains(&id) {
            document.objects.insert(id, Object::Null);
        }
    }
    let root = document.get_dictionary_mut(tree)?;
    root.set(
        "Kids",
        kept.iter().copied().map(Object::from).collect::<Vec<_>>(),
    );
    root.set("Count", kept.len() as i64);
    root.remove(b"Parent");
    let catalog = document.catalog_mut()?;
    for key in CATALOG_NAVIGATION {
        catalog.remove(key);
    }
    document.trailer.remove(b"Info");
    document.prune_objects();
    ensure_intact(&mut document)?;
    let mut output = Vec::new();
    document
        .save_to(&mut output)
        .map_err(|error| anyhow!("failed to write the scanned pages for OCR: {error}"))?;
    let written = load_pdf(&output)?.get_pages().len();
    anyhow::ensure!(
        written == pages.len(),
        "the OCR PDF has {written} of {} scanned pages",
        pages.len()
    );
    Ok(output)
}

/// Lenient loading skips unreadable objects, so a kept page could reference
/// content that never loaded and render incomplete.
fn ensure_intact(document: &mut lopdf::Document) -> anyhow::Result<()> {
    let missing = document
        .traverse_objects(|_| {})
        .into_iter()
        .filter(|id| !document.objects.contains_key(id))
        .count();
    anyhow::ensure!(
        missing == 0,
        "the PDF is damaged: {missing} objects the scanned pages use could not be read"
    );
    Ok(())
}

/// Page attributes the page inherits from its tree, which a flat tree drops.
fn inherited_attributes(
    document: &lopdf::Document,
    page: ObjectId,
) -> anyhow::Result<Vec<(&'static [u8], Object)>> {
    let dictionary = document.get_dictionary(page)?;
    let mut missing: Vec<&'static [u8]> = INHERITED_PAGE_KEYS
        .into_iter()
        .filter(|key| !dictionary.has(key))
        .collect();
    let mut inherited = Vec::new();
    let mut parent = dictionary
        .get(b"Parent")
        .and_then(Object::as_reference)
        .ok();
    for _ in 0..MAX_PAGE_TREE_DEPTH {
        let Some(id) = parent.filter(|_| !missing.is_empty()) else {
            break;
        };
        let node = document.get_dictionary(id)?;
        missing.retain(|key| match node.get(key) {
            Ok(value) => {
                inherited.push((*key, value.clone()));
                false
            }
            Err(_) => true,
        });
        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    Ok(inherited)
}

struct ScannedPdf {
    /// Local markdown by page; empty for scanned pages.
    pages: Vec<String>,
    /// 1-indexed, ascending.
    scanned: Vec<u32>,
}

impl ScannedPdf {
    fn new(
        page_count: u32,
        extracted: Vec<pdf_inspector::PageMarkdown>,
        flagged: Vec<u32>,
    ) -> Self {
        let mut pages = vec![String::new(); page_count as usize];
        let mut scanned: BTreeSet<u32> = flagged.into_iter().collect();
        for page in extracted {
            if page.needs_ocr {
                scanned.insert(page.page + 1);
            } else if let Some(slot) = pages.get_mut(page.page as usize) {
                *slot = page.markdown;
            }
        }
        scanned.retain(|page| (1..=page_count).contains(page));
        Self {
            pages,
            scanned: scanned.into_iter().collect(),
        }
    }

    fn ocr_batch(&self) -> &[u32] {
        &self.scanned[..self.scanned.len().min(MAX_OCR_PAGES)]
    }

    /// `ocr` holds the hosted pages of the [`Self::ocr_batch`] sub-PDF.
    fn assemble(&self, ocr: Result<Vec<ParsedPage>, String>) -> String {
        let batch = self.ocr_batch();
        let mut recognized = BTreeMap::new();
        for parsed in ocr.as_deref().unwrap_or_default() {
            if parsed.markdown.trim().is_empty() {
                continue;
            }
            let original = (parsed.page_number as usize)
                .checked_sub(1)
                .and_then(|index| batch.get(index));
            if let Some(&original) = original {
                recognized
                    .entry(original)
                    .or_insert(parsed.markdown.as_str());
            }
        }
        let unrecognized: Vec<u32> = batch
            .iter()
            .copied()
            .filter(|page| !recognized.contains_key(page))
            .collect();
        let capped = &self.scanned[batch.len()..];
        let mut blocks = Vec::new();
        if !unrecognized.is_empty() {
            let reason = match &ocr {
                Ok(_) => "missing from the OCR result".to_string(),
                Err(error) => format!("OCR failed: {error}"),
            };
            blocks.push(self.incomplete_note(&unrecognized, &reason));
        }
        if !capped.is_empty() {
            let reason = format!("only the first {MAX_OCR_PAGES} scanned pages are OCRed");
            blocks.push(self.incomplete_note(capped, &reason));
        }
        let missing: BTreeSet<u32> = unrecognized
            .into_iter()
            .chain(capped.iter().copied())
            .collect();
        let mut page = 1;
        while page as usize <= self.pages.len() {
            if missing.contains(&page) {
                let mut last = page;
                while missing.contains(&(last + 1)) {
                    last += 1;
                }
                let run: Vec<u32> = (page..=last).collect();
                blocks.push(format!("[{} not extracted: scanned]", pages_label(&run)));
                page = last + 1;
                continue;
            }
            let text = recognized
                .get(&page)
                .copied()
                .unwrap_or(self.pages[page as usize - 1].as_str())
                .trim();
            if !text.is_empty() {
                blocks.push(text.to_string());
            }
            page += 1;
        }
        let mut markdown = blocks.join("\n\n");
        markdown.push('\n');
        markdown
    }

    fn incomplete_note(&self, missing: &[u32], reason: &str) -> String {
        let (verb, past) = if missing.len() == 1 {
            ("is", "was")
        } else {
            ("are", "were")
        };
        format!(
            "> Incomplete: {} of {} {verb} scanned and {past} not extracted ({reason}).",
            pages_label(missing),
            self.pages.len(),
        )
    }
}

fn pages_label(pages: &[u32]) -> String {
    let noun = if pages.len() == 1 { "page" } else { "pages" };
    format!("{noun} {}", page_ranges(pages))
}

/// Formats ascending pages compactly, e.g. `2, 5-7, 12`.
fn page_ranges(pages: &[u32]) -> String {
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < pages.len() {
        let start = pages[index];
        while index + 1 < pages.len() && pages[index + 1] == pages[index] + 1 {
            index += 1;
        }
        let end = pages[index];
        ranges.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
        index += 1;
    }
    ranges.join(", ")
}

#[cfg(test)]
mod tests;
