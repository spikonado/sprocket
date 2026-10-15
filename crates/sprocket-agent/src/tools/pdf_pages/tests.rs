use super::*;

fn scanned(pages: &[&str], scanned: Vec<u32>) -> ScannedPdf {
    ScannedPdf {
        pages: pages.iter().map(|page| page.to_string()).collect(),
        scanned,
    }
}

fn page(index: u32, markdown: &str, needs_ocr: bool) -> pdf_inspector::PageMarkdown {
    pdf_inspector::PageMarkdown {
        page: index,
        markdown: markdown.into(),
        needs_ocr,
        ocr_reason: None,
    }
}

fn with_markers(pages: &[String]) -> String {
    let mut markdown = pages[0].clone();
    for (index, page) in pages.iter().enumerate().skip(1) {
        markdown.push_str(&format!("\n\n---\n\n<!-- page {} -->\n\n{page}", index + 1));
    }
    markdown
}

fn pdf(pages: &[&str]) -> Vec<u8> {
    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", 3 + 2 * index))
        .collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        ),
    ];
    for (index, text) in pages.iter().enumerate() {
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents {} 0 R >>",
            4 + 2 * index
        ));
        let content = format!("BT ({text}) Tj ET");
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ));
    }
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}

#[test]
fn page_ranges_are_compact() {
    assert_eq!(page_ranges(&[2, 5, 6, 7, 12]), "2, 5-7, 12");
    assert_eq!(page_ranges(&(40..=90).collect::<Vec<u32>>()), "40-90");
    assert_eq!(pages_label(&[3]), "page 3");
}

#[test]
fn page_markers_split_hosted_markdown_and_keep_merged_pages_on_the_earlier_page() {
    let pages = ["one".to_string(), "two".into(), "three".into()];
    assert_eq!(split_page_markers(&with_markers(&pages), 3), pages);
    assert_eq!(
        split_page_markers("one\n\n---\n\n<!-- page 3 -->\n\nthree", 3),
        ["one", "", "three"]
    );
    assert_eq!(
        split_page_markers("one <!-- page 9 --> <!-- page x --> still one", 2),
        ["one <!-- page 9 --> <!-- page x --> still one", ""]
    );
}

#[test]
fn scanned_pages_combine_detection_with_per_page_extraction() {
    let pdf = ScannedPdf::new(
        3,
        vec![
            page(0, "Intro", false),
            page(1, "", true),
            page(2, "Outro", false),
        ],
        vec![3, 9],
    );
    assert_eq!(pdf.pages, ["Intro", "", "Outro"]);
    assert_eq!(pdf.scanned, [2, 3]);
}

#[test]
fn recognized_pages_are_merged_in_page_order() {
    let pdf = scanned(&["Intro", "", "Middle", "", "Outro"], vec![2, 4]);
    let ocr = with_markers(&["Scan A".into(), "Scan B".into()]);
    assert_eq!(
        pdf.assemble(Ok(ocr)),
        "Intro\n\nScan A\n\nMiddle\n\nScan B\n\nOutro\n"
    );
}

#[test]
fn scanned_pages_beyond_the_cap_are_named_as_missing() {
    let mut pages = vec!["Intro"];
    pages.resize(26, "");
    let pdf = scanned(&pages, (2..=26).collect());
    assert_eq!(pdf.ocr_batch(), (2..=21).collect::<Vec<u32>>());
    let recognized: Vec<String> = (2..=21).map(|page| format!("Scan {page}")).collect();
    let markdown = pdf.assemble(Ok(with_markers(&recognized)));
    assert!(
        markdown.starts_with("> Incomplete: pages 22-26 of 26 are scanned and were not extracted"),
        "{markdown}"
    );
    assert!(
        markdown.contains("Intro\n\nScan 2\n\nScan 3\n"),
        "{markdown}"
    );
    assert!(
        markdown.ends_with("Scan 21\n\n[pages 22-26 not extracted: scanned]\n"),
        "{markdown}"
    );
}

#[test]
fn failed_ocr_keeps_local_text_and_names_every_scanned_page() {
    let pdf = scanned(&["Intro", "", "Outro"], vec![2]);
    assert_eq!(
        pdf.assemble(Err("upload rejected".into())),
        "> Incomplete: page 2 of 3 is scanned and was not extracted (OCR failed: upload rejected).\n\nIntro\n\n[page 2 not extracted: scanned]\n\nOutro\n"
    );
}

#[test]
fn sub_pdf_keeps_only_requested_pages_in_order() {
    let bytes = sub_pdf(&pdf(&["Page one", "Page two", "Page three"]), &[1, 3]).unwrap();
    let document = lopdf::Document::load_mem(&bytes).unwrap();
    let contents: Vec<String> = document
        .get_pages()
        .into_values()
        .map(|page| String::from_utf8_lossy(&document.get_page_content(page)).into_owned())
        .collect();
    assert_eq!(contents.len(), 2);
    assert!(contents[0].contains("Page one"), "{contents:?}");
    assert!(contents[1].contains("Page three"), "{contents:?}");
}
