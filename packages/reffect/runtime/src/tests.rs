//! Pinned regressions for the runtime modules. Expected strings were captured from upstream
//! (foldkit 0.165.0 `renderToString`, Node's `JSON.stringify`); the differential suites in
//! `packages/reffect/tests` remain the oracle.

use crate::foldkit_html::{element, empty, render, text, Prop};
use crate::foldkit_json::{json_text, round_trip};
use serde_json::json;

#[test]
fn renders_attributes_children_and_root_markers_as_upstream() {
    let span = element("span", false, &[], None, &[], None, &[text("x<&>\r")]);
    let anchor = element(
        "a",
        false,
        &[],
        Some("z  b 10 2 __proto__ b"),
        &[
            ("href", Prop::Url(" \u{1}JaVa\tScript:alert(1)")),
            ("title", Prop::Text("q\"<&>\r")),
        ],
        Some("k1"),
        &[span, text("y")],
    );
    assert_eq!(
        render(&anchor, "app", "b1").unwrap(),
        "<a class=\"2 10 z b\" href=\"\" title=\"q&quot;&lt;&amp;>&#13;\" data-foldkit-app=\"app\" data-foldkit-build=\"b1\" data-foldkit-key=\"20322c0efd39ce75\"><span>x&lt;&amp;&gt;&#13;</span>y</a>"
    );
}

#[test]
fn writes_booleans_and_void_elements_as_upstream() {
    let input = element(
        "input",
        true,
        &[],
        None,
        &[
            ("checked", Prop::Flag(true)),
            ("disabled", Prop::Flag(false)),
            ("value", Prop::Text("v")),
        ],
        None,
        &[],
    );
    assert_eq!(
        render(&input, "app", "b1").unwrap(),
        "<input checked=\"\" value=\"v\" data-foldkit-app=\"app\" data-foldkit-build=\"b1\">"
    );
}

#[test]
fn refuses_non_element_roots_and_nul() {
    assert_eq!(
        render(&empty(), "app", "b1").unwrap_err().0,
        "InvalidHydrationRoot"
    );
    assert_eq!(
        render(&text("t"), "app", "b1").unwrap_err().0,
        "InvalidHydrationRoot"
    );
    let nul = element("p", false, &[], None, &[], None, &[text("a\0b")]);
    assert_eq!(
        render(&nul, "app", "b1").unwrap_err().0,
        "SerializationError"
    );
}

#[test]
fn writes_json_as_javascript_does() {
    let value =
        json!([-0.0, 1e21, 5e-324, 0.1, 123456789012u64, -1.5e-7, { "é": "\u{2028}<\u{7}" }]);
    assert_eq!(
        json_text(&value),
        "[0,1e+21,5e-324,0.1,123456789012,-1.5e-7,{\"é\":\"\u{2028}<\\u0007\"}]"
    );
}

#[test]
fn round_trip_turns_negative_zero_into_zero_only() {
    let value = json!({ "z": -0.0, "n": [0.1, -2.5, "-0"] });
    let back = round_trip(&value);
    assert_eq!(back["z"].as_f64().map(f64::is_sign_negative), Some(false));
    assert_eq!(back["n"], value["n"]);
    assert_eq!(json_text(&back), json_text(&value));
}
