use lopdf::{Dictionary, Document, Stream, dictionary};

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

fn parsed(page_number: u32, markdown: &str) -> ParsedPage {
    ParsedPage {
        page_number,
        markdown: markdown.into(),
    }
}

fn media_box(size: i64) -> Object {
    Object::Array([0, 0, size, size].map(Object::Integer).to_vec())
}

/// Pages sit in groups of ten and inherit MediaBox, Resources, and Rotate
/// from the root, except page 57, which sets its own MediaBox.
fn pdf(page_count: usize) -> Vec<u8> {
    let mut document = Document::with_version("1.4");
    let root = document.new_object_id();
    let resources = document.add_object(dictionary! { "ProcSet" => vec![Object::from("PDF")] });
    let mut groups = Vec::new();
    for first in (0..page_count).step_by(10) {
        let group = document.new_object_id();
        let mut kids = Vec::new();
        for index in first..(first + 10).min(page_count) {
            let text = format!("BT (Page {}) Tj ET", index + 1);
            let contents = document.add_object(Stream::new(Dictionary::new(), text.into_bytes()));
            let mut page = dictionary! {
                "Type" => "Page",
                "Parent" => group,
                "Contents" => contents,
            };
            if index + 1 == 57 {
                page.set("MediaBox", media_box(100));
            }
            kids.push(Object::from(document.add_object(page)));
        }
        let count = kids.len() as i64;
        let node =
            dictionary! { "Type" => "Pages", "Parent" => root, "Kids" => kids, "Count" => count };
        document.objects.insert(group, node.into());
        groups.push(Object::from(group));
    }
    let tree = dictionary! {
        "Type" => "Pages",
        "Kids" => groups,
        "Count" => page_count as i64,
        "MediaBox" => media_box(200),
        "Resources" => resources,
        "Rotate" => Object::Integer(90),
    };
    document.objects.insert(root, tree.into());
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => root });
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn page_ranges_are_compact() {
    assert_eq!(page_ranges(&[2, 5, 6, 7, 12]), "2, 5-7, 12");
    assert_eq!(page_ranges(&(40..=90).collect::<Vec<u32>>()), "40-90");
    assert_eq!(pages_label(&[3]), "page 3");
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
    let ocr = vec![parsed(2, "Scan B"), parsed(1, "Scan A")];
    assert_eq!(
        pdf.assemble(Ok(ocr)),
        "Intro\n\nScan A\n\nMiddle\n\nScan B\n\nOutro\n"
    );
}

#[test]
fn pages_missing_from_the_ocr_result_are_named() {
    let pdf = scanned(&["Intro", "", "", ""], vec![2, 3, 4]);
    let ocr = vec![
        parsed(0, "bogus"),
        parsed(1, "Scan 2"),
        parsed(3, "Scan 4"),
        parsed(9, "bogus"),
    ];
    assert_eq!(
        pdf.assemble(Ok(ocr)),
        "> Incomplete: page 3 of 4 is scanned and was not extracted (missing from the OCR result).\n\nIntro\n\nScan 2\n\n[page 3 not extracted: scanned]\n\nScan 4\n"
    );
}

#[test]
fn scanned_pages_beyond_the_cap_are_named_as_missing() {
    let mut pages = vec!["Intro"];
    pages.resize(26, "");
    let pdf = scanned(&pages, (2..=26).collect());
    assert_eq!(pdf.ocr_batch(), (2..=21).collect::<Vec<u32>>());
    let ocr = (1..=20)
        .map(|page| parsed(page, &format!("Scan {}", page + 1)))
        .collect();
    let markdown = pdf.assemble(Ok(ocr));
    assert!(
        markdown.starts_with("> Incomplete: pages 22-26 of 26 are scanned and were not extracted (only the first 20 scanned pages are OCRed).\n\nIntro\n\nScan 2\n\nScan 3\n"),
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
fn sub_pdf_keeps_requested_pages_with_their_inherited_attributes() {
    let bytes = sub_pdf(&pdf(120), &[2, 57, 119]).unwrap();
    let document = load_pdf(&bytes).unwrap();
    let tree = document
        .catalog()
        .unwrap()
        .get(b"Pages")
        .unwrap()
        .as_reference()
        .unwrap();
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    assert_eq!(pages.len(), 3);
    for (id, (number, size)) in pages.into_iter().zip([(2, 200), (57, 100), (119, 200)]) {
        let content = String::from_utf8(document.get_page_content(id)).unwrap();
        assert!(content.contains(&format!("(Page {number})")), "{content}");
        let page = document.get_dictionary(id).unwrap();
        assert_eq!(page.get(b"Parent").unwrap().as_reference().unwrap(), tree);
        assert_eq!(page.get(b"MediaBox").unwrap(), &media_box(size));
        assert_eq!(page.get(b"Rotate").unwrap(), &Object::Integer(90));
        assert!(page.get(b"Resources").is_ok());
    }
    // Catalog, tree, shared resources, and a page plus contents per kept page.
    assert!(document.objects.len() <= 9, "{}", document.objects.len());
}

#[test]
fn sub_pdf_rejects_pages_the_pdf_does_not_have() {
    assert!(sub_pdf(&pdf(3), &[4]).is_err());
}
