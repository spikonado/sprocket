use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;

use anyhow::anyhow;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::hosted_parse::HostedParseContext;
use super::parse_file::{LocalConversionFailed, run_cancellable_blocking};

/// Hosted OCR bills per page, so scanned pages beyond this stay unextracted.
const MAX_OCR_PAGES: usize = 20;
const PAGE_MARKER_PREFIX: &str = "<!-- page ";
const PAGE_MARKER_SUFFIX: &str = " -->";

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
        return Ok(LocalPdf::Complete(pdf.assemble(Ok(String::new()))));
    }
    let ocr_input = build_ocr_input.then(|| sub_pdf(bytes, pdf.ocr_batch()));
    Ok(LocalPdf::Scanned { pdf, ocr_input })
}

async fn recognize(
    hosted: &HostedParseContext<'_>,
    input: Vec<u8>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<String> {
    let file = run_cancellable_blocking(cancellation, move || {
        let mut file = tempfile::Builder::new()
            .prefix("sprocket-ocr-")
            .suffix(".pdf")
            .tempfile()?;
        file.write_all(&input)?;
        Ok(file)
    })
    .await?;
    super::hosted_parse::parse(
        hosted,
        file.path(),
        Path::new("scanned-pages.pdf"),
        cancellation,
    )
    .await
}

/// Keeps only `pages` (1-indexed), in document order.
fn sub_pdf(bytes: &[u8], pages: &[u32]) -> anyhow::Result<Vec<u8>> {
    let mut document = lopdf::Document::load_mem(bytes)
        .map_err(|error| anyhow!("failed to load the PDF for OCR: {error}"))?;
    let keep: BTreeSet<u32> = pages.iter().copied().collect();
    let removed: Vec<u32> = document
        .get_pages()
        .into_keys()
        .filter(|page| !keep.contains(page))
        .collect();
    document.delete_pages(&removed);
    document.prune_objects();
    let mut output = Vec::new();
    document
        .save_to(&mut output)
        .map_err(|error| anyhow!("failed to write the scanned pages for OCR: {error}"))?;
    Ok(output)
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

    /// `ocr` is the hosted markdown for [`Self::ocr_batch`], with page markers.
    fn assemble(&self, ocr: Result<String, String>) -> String {
        let batch = self.ocr_batch();
        let recognized: BTreeMap<u32, String> = match &ocr {
            Ok(markdown) => batch
                .iter()
                .copied()
                .zip(split_page_markers(markdown, batch.len()))
                .collect(),
            Err(_) => BTreeMap::new(),
        };
        let missing: Vec<u32> = self
            .scanned
            .iter()
            .copied()
            .filter(|page| !recognized.contains_key(page))
            .collect();
        let mut blocks = Vec::new();
        if !missing.is_empty() {
            let reason = match &ocr {
                Ok(_) => format!("only the first {MAX_OCR_PAGES} scanned pages are OCRed"),
                Err(error) => format!("OCR failed: {error}"),
            };
            let (verb, past) = if missing.len() == 1 {
                ("is", "was")
            } else {
                ("are", "were")
            };
            blocks.push(format!(
                "> Incomplete: {} of {} {verb} scanned and {past} not extracted ({reason}).",
                pages_label(&missing),
                self.pages.len(),
            ));
        }
        let missing: BTreeSet<u32> = missing.into_iter().collect();
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
                .unwrap_or(&self.pages[page as usize - 1])
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
}

/// Splits markdown that uses Firecrawl's `<!-- page N -->` markers into
/// `page_count` pages. Firecrawl omits a marker when content flows across a
/// page break, which leaves that content on the earlier page.
fn split_page_markers(markdown: &str, page_count: usize) -> Vec<String> {
    let mut pages = vec![String::new(); page_count];
    if page_count == 0 {
        return pages;
    }
    let mut current = 0;
    let mut rest = markdown;
    while let Some((start, end, next)) = next_page_marker(rest, current, page_count) {
        pages[current] = page_text(&rest[..start]);
        current = next;
        rest = &rest[end..];
    }
    pages[current] = page_text(rest);
    pages
}

/// Returns the marker's byte range and the 0-indexed page it starts.
fn next_page_marker(
    text: &str,
    current: usize,
    page_count: usize,
) -> Option<(usize, usize, usize)> {
    let mut offset = 0;
    while let Some(found) = text[offset..].find(PAGE_MARKER_PREFIX) {
        let start = offset + found;
        let digits_start = start + PAGE_MARKER_PREFIX.len();
        let digits_end = digits_start
            + text[digits_start..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
        let page = text[digits_start..digits_end].parse::<usize>().ok();
        if let Some(page) = page.filter(|page| *page > current + 1 && *page <= page_count) {
            if text[digits_end..].starts_with(PAGE_MARKER_SUFFIX) {
                return Some((start, digits_end + PAGE_MARKER_SUFFIX.len(), page - 1));
            }
        }
        offset = digits_start;
    }
    None
}

fn page_text(segment: &str) -> String {
    let segment = segment.trim();
    segment
        .strip_suffix("---")
        .unwrap_or(segment)
        .trim()
        .to_string()
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
