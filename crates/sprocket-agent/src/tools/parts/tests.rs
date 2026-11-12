use serde_json::{from_value, json};

use super::*;

fn codes(matches: &[PartMatch]) -> Vec<&str> {
    matches.iter().map(|m| m.code.as_str()).collect()
}

#[test]
fn schema_matches_the_documented_input() {
    assert_eq!(
        parameters(),
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "LookupPartsArgs",
            "type": "object",
            "properties": {
                "parts": {
                    "type": "array",
                    "items": { "$ref": "#/$defs/PartQuery" },
                    "minItems": 1
                }
            },
            "required": ["parts"],
            "additionalProperties": false,
            "$defs": {
                "PartQuery": {
                    "type": "object",
                    "properties": {
                        "part": {
                            "description": "MPN or JLCPCB/LCSC code like `C2864583`.",
                            "type": "string",
                            "minLength": 1
                        },
                        "quantity": {
                            "type": "integer",
                            "format": "uint32",
                            "minimum": 1,
                            "default": 1
                        }
                    },
                    "required": ["part"],
                    "additionalProperties": false
                }
            }
        })
    );
}

#[test]
fn jlcpcb_keeps_exact_stocked_rows() {
    let response: JlcpcbResponse = from_value(json!({
        "code": 200,
        "data": { "componentPageInfo": { "list": [
            { "componentCode": "C8734", "componentModelEn": "STM32F103C8T6", "stockCount": 209170, "lcscGoodsUrl": "https://www.lcsc.com/product-detail/microcontrollers-mcu-mpu-soc_stmicroelectronics-stm32f103c8t6_C8734.html" },
            { "componentCode": "C2969777", "componentModelEn": "STM32F103C8T6TR", "stockCount": 103, "lcscGoodsUrl": "https://www.lcsc.com/product-detail/microcontrollers-mcu-mpu-soc_stmicroelectronics-stm32f103c8t6tr_C2969777.html" },
            { "componentCode": "C9900024335", "componentModelEn": "STM32F103C8T6", "stockCount": 0, "lcscGoodsUrl": null }
        ] } }
    }))
    .unwrap();
    let rows = jlcpcb_matches(response, "stm32f103 c8t6");
    assert_eq!(
        rows.iter()
            .map(|row| row.component_code.as_str())
            .collect::<Vec<_>>(),
        ["C8734"]
    );
}

#[test]
fn merged_matches_take_lcsc_details_and_price_each_source() {
    let jlcpcb: Vec<JlcpcbRow> = from_value(json!([{
        "componentCode": "C2864583",
        "componentModelEn": "TPS55288RPMR-JLC",
        "componentBrandEn": "Texas Instruments",
        "componentSpecificationEn": "VQFN-26-HR(3.5x4)",
        "describe": "Buck-Boost DC-DC Converters ROHS",
        "stockCount": 4156,
        "componentPrices": [
            { "startNumber": 100, "productPrice": 1.7453 },
            { "startNumber": 1, "productPrice": 2.0937 },
            { "startNumber": 10, "productPrice": 1.9399 }
        ],
        "componentLibraryType": "expand",
        "preferredComponentFlag": false,
        "minPurchaseNum": 1,
        "leastPatchNumber": 0,
        "dataManualUrl": "https://www.lcsc.com/datasheet/lcsc_datasheet_2302212330_Texas-Instruments-TPS55288RPMR_C2864583.pdf"
    }]))
    .unwrap();
    let lcsc: Vec<LcscProduct> = from_value(json!([{
        "productCode": "C2864583",
        "productModel": "TPS55288RPMR",
        "brandNameEn": "TI",
        "encapStandard": "VQFN-26-HR(3.5x4)",
        "productDescEn": "Buck-Boost Switching Regulator IC Adjustable 0.8V~22V 1 Output 16A VQFN-26-HR(3.5x4)",
        "stockNumber": 4156,
        "productPriceList": [
            { "ladder": 1, "usdPrice": 2.1142 },
            { "ladder": 10, "usdPrice": 1.9589 },
            { "ladder": 100, "usdPrice": 1.7624 }
        ],
        "minBuyNumber": 1,
        "split": 1,
        "pdfUrl": "https://datasheet.lcsc.com/datasheet/pdf/982ef8166c8345c92707cf197d8b422e.pdf?productCode=C2864583"
    }]))
    .unwrap();
    assert_eq!(
        json!(merge(jlcpcb, lcsc, 50)),
        json!([{
            "code": "C2864583",
            "mpn": "TPS55288RPMR",
            "manufacturer": "TI",
            "package": "VQFN-26-HR(3.5x4)",
            "description": "Buck-Boost Switching Regulator IC Adjustable 0.8V~22V 1 Output 16A VQFN-26-HR(3.5x4)",
            "datasheet": "https://datasheet.lcsc.com/datasheet/pdf/982ef8166c8345c92707cf197d8b422e.pdf?productCode=C2864583",
            "jlcpcb": {
                "stock": 4156,
                "price": 1.9399,
                "priceBreaks": [
                    { "quantity": 1, "price": 2.0937 },
                    { "quantity": 10, "price": 1.9399 },
                    { "quantity": 100, "price": 1.7453 }
                ],
                "library": "extended"
            },
            "lcsc": {
                "stock": 4156,
                "price": 1.9589,
                "priceBreaks": [
                    { "quantity": 1, "price": 2.1142 },
                    { "quantity": 10, "price": 1.9589 },
                    { "quantity": 100, "price": 1.7624 }
                ]
            }
        }])
    );
}

#[test]
fn matches_rank_preferred_basic_extended_then_stock() {
    let jlcpcb: Vec<JlcpcbRow> = from_value(json!([
        { "componentCode": "C5296727", "componentModelEn": "LM358", "stockCount": 202085, "componentLibraryType": "expand", "preferredComponentFlag": false },
        { "componentCode": "C5252902", "componentModelEn": "LM358", "stockCount": 341956, "componentLibraryType": "expand", "preferredComponentFlag": false },
        { "componentCode": "C28323", "componentModelEn": "CL21B105KBFNNNE", "stockCount": 3992278, "componentLibraryType": "base", "preferredComponentFlag": false, "leastPatchNumber": 20 },
        { "componentCode": "C8734", "componentModelEn": "STM32F103C8T6", "stockCount": 209170, "componentLibraryType": "expand", "preferredComponentFlag": true }
    ]))
    .unwrap();
    let lcsc: Vec<LcscProduct> = from_value(json!([
        { "productCode": "C369938", "productModel": "LM358", "stockNumber": 3840 },
        { "productCode": "C2829430", "productModel": "LM358", "stockNumber": 7515 },
        { "productCode": "C5252902", "productModel": "LM358", "stockNumber": 341950 }
    ]))
    .unwrap();
    let matches = merge(jlcpcb, lcsc, 1);
    assert_eq!(
        codes(&matches),
        ["C8734", "C28323", "C5252902", "C5296727", "C2829430"]
    );
    assert_eq!(matches[1].jlcpcb.as_ref().unwrap().assembly_min, Some(20));
}

#[test]
fn unit_price_uses_the_highest_break_at_or_below_the_quantity() {
    let breaks = || {
        vec![
            PriceBreak {
                quantity: 100,
                price: 0.0230,
            },
            PriceBreak {
                quantity: 10,
                price: 0.0307,
            },
            PriceBreak {
                quantity: 300,
                price: 0.0197,
            },
        ]
    };
    for (quantity, expected) in [(1, 0.0307), (100, 0.0230), (299, 0.0230), (5000, 0.0197)] {
        assert_eq!(
            priced(breaks(), quantity).0,
            Some(expected),
            "quantity {quantity}"
        );
    }
    assert_eq!(
        priced(breaks(), 1)
            .1
            .iter()
            .map(|b| b.quantity)
            .collect::<Vec<_>>(),
        [10, 100, 300]
    );
}
