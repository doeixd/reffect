//! Pinned regressions for the runtime modules, quick to run under `cargo test`. The HTML and
//! JSON strings were captured from upstream (foldkit 0.165.0 `renderToString`, Node's
//! `JSON.stringify`); the hub cases pin behavior the differential suites in
//! `packages/reffect/tests` check against foldkit-remote-server's `liveHub`, which stay the oracle.

use crate::foldkit_html::{element, empty, failure, render, text, Prop};
use crate::foldkit_json::{json_text, round_trip};
use crate::remote_engine::{
    lacking, page_data, page_views, read, Hub, JsObject, LiveLimits, Memory, PageRead, Subscription,
};
use serde_json::json;

fn every_row(
    _: &[crate::foldkit_eval::Value],
    rows: &[Vec<crate::foldkit_eval::Value>],
) -> Result<Vec<usize>, &'static str> {
    Ok((0..rows.len()).collect())
}
static ALL_TODOS: [crate::remote_engine::QueryDef; 1] = [crate::remote_engine::QueryDef {
    name: "AllTodos",
    entity: "Todo",
    valid: |_| true,
    fields: &["title"],
    inputs: &[],
    run: every_row,
    order: every_row,
    order_fields: &[],
    order_inputs: &[],
    cells: std::sync::Mutex::new(None),
}];

#[test]
fn a_write_rebuilds_only_its_own_tables_query_cells() {
    // #35: one global version made a write to any table rebuild every query's cells.
    let rows = json!({
        "Todo": [["t1", { "id": "t1", "title": "Write" }]],
        "User": [["u1", { "id": "u1", "name": "Ada" }]],
    });
    let memory = Memory::new(
        vec!["Todo".to_string(), "User".to_string()],
        &rows,
        &ALL_TODOS,
    );
    let permit_all = |_: &str, fields: &[String]| fields.to_vec();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let payload = json!({ "version": 4, "query": "AllTodos", "input": {}, "window": {} });
    let cells = || {
        ALL_TODOS[0]
            .cells
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, cells)| cells.clone())
            .unwrap()
    };
    runtime
        .block_on(crate::remote_engine::query(&memory, &permit_all, &payload))
        .unwrap();
    let built = cells();
    memory.write("User", "u1", vec![("name".to_string(), json!("Grace"))]);
    memory.remove("User", "u9");
    runtime
        .block_on(crate::remote_engine::query(&memory, &permit_all, &payload))
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&built, &cells()));
    memory.write("Todo", "t2", vec![("title".to_string(), json!("Read"))]);
    let answer = runtime
        .block_on(crate::remote_engine::query(&memory, &permit_all, &payload))
        .unwrap();
    assert!(!std::sync::Arc::ptr_eq(&built, &cells()));
    assert_eq!(cells().len(), 2);
    assert_eq!(answer["edges"].as_array().map(Vec::len), Some(2));
}

#[test]
fn deep_views_render_once_in_linear_time() {
    // #34: each element shares its children and the document is written once. Copying each
    // child into its parent moved the 1 MiB leaf once per ancestor, about 5 GB here.
    let leaf = "x".repeat(1 << 20);
    let started = std::time::Instant::now();
    let mut html = element("b", false, &[], None, &[], None, &[text(&leaf)]);
    for _ in 0..5_000 {
        html = element("i", false, &[], None, &[], None, &[html]);
    }
    let rendered = render(&html, "app", "b1").unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "took {:?}",
        started.elapsed()
    );
    let expected = format!(
        "<i data-foldkit-app=\"app\" data-foldkit-build=\"b1\">{}<b>{}</b>{}</i>",
        "<i>".repeat(4_999),
        leaf,
        "</i>".repeat(4_999)
    );
    assert_eq!(rendered, expected);
    assert_eq!(rendered.capacity(), rendered.len());
    // The failure check reads the same verdict without writing the document.
    assert_eq!(failure(&html, "app", "b1"), None);
    assert_eq!(
        failure(&html, "a\0", "b1").is_some(),
        render(&html, "a\0", "b1").is_err()
    );
}

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

fn hub() -> &'static Hub {
    Box::leak(Box::default())
}
fn live(
    hub: &'static Hub,
    after: f64,
    requirements: serde_json::Value,
    principal: Option<u64>,
) -> Subscription {
    hub.subscribe(
        &json!({ "version": 4, "requirements": requirements, "after": after }),
        principal,
    )
    .unwrap()
}
fn drain(subscription: &mut Subscription) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| subscription.events.try_recv().ok()).collect()
}

#[test]
fn deleted_reaches_selecting_subscribers_on_their_own_cursors() {
    let hub = hub();
    let todo = |id: &str| json!({ "entity": "Todo", "id": id, "fields": ["title"] });
    let mut from_five = live(hub, 5.0, json!([todo("t1")]), None);
    // A row required twice is selected once, so it is numbered once.
    let mut both = live(hub, 0.0, json!([todo("t1"), todo("t2"), todo("t1")]), None);
    let mut other = live(hub, 0.0, json!([todo("t9")]), None);
    hub.deleted("Todo", "t1");
    hub.deleted("Todo", "t2");
    assert_eq!(
        drain(&mut from_five),
        [json!({ "_tag": "EntityDeleted", "cursor": 6, "entity": "Todo", "id": "t1" })]
    );
    assert_eq!(
        drain(&mut both),
        [
            json!({ "_tag": "EntityDeleted", "cursor": 1, "entity": "Todo", "id": "t1" }),
            json!({ "_tag": "EntityDeleted", "cursor": 2, "entity": "Todo", "id": "t2" }),
        ]
    );
    assert!(drain(&mut other).is_empty());
    // An ended stream is unsubscribed; the others keep their cursors.
    drop(from_five);
    hub.deleted("Todo", "t1");
    assert_eq!(drain(&mut both)[0]["cursor"], json!(3));
}

#[test]
fn an_entity_holding_a_colon_selects_no_other_row() {
    // "Todo:1" + "x" and "Todo" + "1:x" share the key "Todo:1:x"; no source is named with a
    // colon, so the first selects nothing (#26).
    let hub = hub();
    let mut colon = live(
        hub,
        0.0,
        json!([{ "entity": "Todo:1", "id": "x", "fields": ["title"] }]),
        None,
    );
    hub.deleted("Todo", "1:x");
    assert!(drain(&mut colon).is_empty());
    let mut plain = live(
        hub,
        0.0,
        json!([{ "entity": "Todo", "id": "1:x", "fields": ["title"] }]),
        None,
    );
    hub.deleted("Todo", "1:x");
    assert_eq!(drain(&mut plain).len(), 1);
}

#[test]
fn changed_sends_each_subscriber_its_selected_authorized_fields() {
    let hub = hub();
    let rows =
        json!({ "Todo": [["t1", { "id": "t1", "title": "Write", "done": true, "note": "n" }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let selecting =
        |fields: serde_json::Value| json!([{ "entity": "Todo", "id": "t1", "fields": fields }]);
    let mut owner = live(hub, 0.0, selecting(json!(["title", "done"])), Some(1));
    let mut guest = live(hub, 0.0, selecting(json!(["done", "note"])), None);
    // The guest may not read `done`; the owner reads everything it selected.
    fn authorize(principal: Option<u64>, _: &str, fields: &[String]) -> Vec<String> {
        fields
            .iter()
            .filter(|field| principal.is_some() || *field != "done")
            .cloned()
            .collect()
    }
    let changed = ["done".to_string(), "title".to_string(), "note".to_string()];
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(hub.changed(&memory, authorize, "Todo", "t1", &changed));
    assert_eq!(
        drain(&mut owner),
        [
            json!({ "_tag": "EntityPatched", "cursor": 1, "entity": "Todo", "id": "t1", "values": { "done": true, "title": "Write" }, "changed": ["done", "title"] })
        ]
    );
    assert_eq!(
        drain(&mut guest),
        [
            json!({ "_tag": "EntityPatched", "cursor": 1, "entity": "Todo", "id": "t1", "values": { "note": "n" }, "changed": ["note"] })
        ]
    );
}

#[test]
fn subscribe_refuses_another_protocol_version() {
    let error = hub()
        .subscribe(&json!({ "version": 3, "requirements": [] }), None)
        .err()
        .unwrap();
    assert_eq!(error["_tag"], json!("RemoteProtocolError"));
    assert_eq!(
        error["message"],
        json!("Remote protocol version 3 is not 4")
    );
}

#[test]
fn snapshot_tells_a_fresh_subscription_the_current_rows() {
    let hub = hub();
    let rows = json!({ "Todo": [["t1", { "id": "t1", "title": "Write", "done": true }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let selecting = json!([
        { "entity": "Todo", "id": "t1", "fields": ["title", "done"] },
        { "entity": "Todo", "id": "t9", "fields": ["title"] },
    ]);
    // A guest may not read `done`.
    fn authorize(principal: Option<u64>, _: &str, fields: &[String]) -> Vec<String> {
        fields
            .iter()
            .filter(|field| principal.is_some() || *field != "done")
            .cloned()
            .collect()
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut fresh = live(hub, 0.0, selecting.clone(), None);
    runtime.block_on(hub.snapshot(&fresh, &memory, authorize));
    assert_eq!(
        drain(&mut fresh),
        [
            json!({ "_tag": "EntityPatched", "cursor": 1, "entity": "Todo", "id": "t1", "values": { "title": "Write" }, "changed": ["title"] }),
            json!({ "_tag": "EntityDeleted", "cursor": 2, "entity": "Todo", "id": "t9" }),
        ]
    );
    // A resumed stream already holds the rows: no snapshot.
    let mut resumed = live(hub, 5.0, selecting, Some(1));
    runtime.block_on(hub.snapshot(&resumed, &memory, authorize));
    assert!(drain(&mut resumed).is_empty());
}

#[test]
fn js_object_keeps_javascript_key_order() {
    let mut object: JsObject<u8> = JsObject::new();
    for (key, value) in [("b", 1), ("10", 2), ("a", 3), ("2", 4), ("b", 5)] {
        object.set(key.to_string(), value);
    }
    let keys = |object: &JsObject<u8>| {
        object
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
    };
    // Index keys first, ascending; then insertion order; a reassigned key keeps its place.
    assert_eq!(keys(&object), ["2=4", "10=2", "b=5", "a=3"]);
    // `delete` then assignment moves a named key to the end, as in JS.
    assert_eq!(object.take("b"), Some(5));
    object.set("b".to_string(), 6);
    assert_eq!(keys(&object), ["2=4", "10=2", "a=3", "b=6"]);
    assert!(object.has("10") && !object.has("c"));
}

#[test]
fn a_huge_client_windows_map_reads_in_linear_time() {
    // #17: a single Read whose windows map has 200k keys used to cost ~10^10 comparisons.
    let rows = json!({ "Todo": [["t1", { "id": "t1", "title": "Write" }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let windows: serde_json::Map<String, serde_json::Value> =
        (0..200_000).map(|i| (format!("k{i}"), json!({}))).collect();
    let payload = json!({ "version": 4, "requests": [{ "entity": "Todo", "id": "t1", "fields": ["title"], "windows": windows }] });
    let permit_all = |_: &str, fields: &[String]| fields.to_vec();
    let started = std::time::Instant::now();
    let answer = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(read(&memory, &permit_all, &payload))
        .unwrap();
    assert_eq!(answer["entities"][0]["values"], json!({ "title": "Write" }));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn a_relation_page_fails_only_where_its_window_reaches_a_non_string_ref() {
    // #26: as the memory backend's valueFor, a non-string item empties the page only when a
    // cursor search passes it or it bounds the page; elsewhere it is an item like any other.
    let rows = json!({ "Todo": [["t1", { "id": "t1", "tags": [1, 1, "Tag:a", "Tag:b"] }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let permit_all = |_: &str, fields: &[String]| fields.to_vec();
    let page = |window: serde_json::Value| {
        let payload = json!({ "version": 4, "requests": [{ "entity": "Todo", "id": "t1", "fields": ["tags"], "windows": { "tags": window } }] });
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(read(&memory, &permit_all, &payload))
            .unwrap()["entities"][0]["values"]["tags"]
            .clone()
    };
    let empty = json!({ "refs": [], "hasNext": false, "hasPrevious": false });
    // The page ends before the list does, so its last item, the number, is its end cursor.
    assert_eq!(page(json!({ "first": 1 })), empty);
    // Duplicates go first; the page's first item, a string, is its start cursor.
    assert_eq!(
        page(json!({ "last": 1 })),
        json!({ "refs": ["Tag:b"], "hasNext": false, "hasPrevious": true })
    );
    // The whole list needs no cursor at all.
    assert_eq!(
        page(json!({ "first": 5 })),
        json!({ "refs": [1, "Tag:a", "Tag:b"], "hasNext": false, "hasPrevious": false })
    );
    // A cursor search reaches the number before the match.
    assert_eq!(page(json!({ "after": "Tag:a" })), empty);
}

#[test]
fn a_stalled_subscriber_loses_events_as_a_gap_not_memory() {
    // #19: a full queue drops events but still numbers them, so the next one shows the gap.
    let hub: &'static Hub = Box::leak(Box::new(Hub::with_limits(LiveLimits {
        queue: 2,
        ..LiveLimits::default()
    })));
    let todo = json!([{ "entity": "Todo", "id": "t1", "fields": ["title"] }]);
    let mut stalled = live(hub, 0.0, todo, None);
    for _ in 0..3 {
        hub.deleted("Todo", "t1");
    }
    let cursors = |events: Vec<serde_json::Value>| {
        events
            .iter()
            .map(|event| event["cursor"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(cursors(drain(&mut stalled)), [json!(1), json!(2)]);
    hub.deleted("Todo", "t1");
    assert_eq!(cursors(drain(&mut stalled)), [json!(4)]);
}

#[test]
fn subscriptions_are_capped_in_total_and_per_principal() {
    let hub: &'static Hub = Box::leak(Box::new(Hub::with_limits(LiveLimits {
        queue: 8,
        subscriptions: 3,
        per_principal: 1,
    })));
    let todo = json!([{ "entity": "Todo", "id": "t1", "fields": ["title"] }]);
    let subscribe = |principal: Option<u64>| {
        hub.subscribe(
            &json!({ "version": 4, "requirements": todo, "after": 0 }),
            principal,
        )
    };
    let first = subscribe(Some(1)).unwrap();
    // The same principal again is over its own cap; another principal and anonymous are not.
    let refused = subscribe(Some(1)).err().unwrap();
    assert_eq!(
        refused["message"],
        json!("Too many live subscriptions for this principal")
    );
    let other = subscribe(Some(2)).unwrap();
    let anonymous = subscribe(None).unwrap();
    // Three subscriptions fill the server's cap.
    assert_eq!(
        subscribe(None).err().unwrap()["message"],
        json!("Too many live subscriptions")
    );
    // Ending one frees its place.
    drop(first);
    assert!(subscribe(Some(1)).is_ok());
    drop((other, anonymous));
}

#[test]
fn page_host_helpers_answer_as_upstream() {
    use crate::ssr_host::{
        accepts_html, classify, resolve_request_url, resolves_to_index_html, vary_with, Class,
    };
    // foldkit 0.165.0 acceptsHtml, varyWith, resolveRequestUrl, resolvesToIndexHtml, classifyRequest.
    for (accept, expected) in [
        ("text/html", true),
        ("text/html;q=0", false),
        ("*/*", true),
        ("text/*;q=0.5, text/html;q=0", false),
        ("application/json", false),
        (" TEXT/HTML ; q = 1 ", true),
        ("text/html;q=0x1", true),
        ("text/html;q=Infinity", true),
        ("", true),
    ] {
        assert_eq!(accepts_html(Some(accept)), expected, "{accept:?}");
    }
    assert!(accepts_html(None));
    assert_eq!(vary_with(None, "Accept"), "Accept");
    assert_eq!(vary_with(Some("Accept"), "accept"), "Accept");
    assert_eq!(vary_with(Some("Origin"), "Accept"), "Origin, Accept");
    assert_eq!(vary_with(Some("*"), "Accept"), "*");
    let resolve = |target: &str| {
        resolve_request_url(target, "http://reffect.test").map(|url| url.to_string())
    };
    assert_eq!(resolve("/a/../b").as_deref(), Some("http://reffect.test/b"));
    assert_eq!(resolve("//evil.example/x"), None);
    assert_eq!(resolve("http://user:pw@reffect.test/"), None);
    assert_eq!(
        resolve("http://reffect.test/x?y").as_deref(),
        Some("http://reffect.test/x?y")
    );
    assert_eq!(
        resolve("/%2e%2e/index.html").as_deref(),
        Some("http://reffect.test/index.html")
    );
    for (path, expected) in [
        ("/", true),
        ("/index.html", true),
        ("/a/index.html", false),
        ("/a/../index.html", true),
        ("/x.js", false),
        ("/page", false),
        ("/%69ndex.html", true),
    ] {
        assert_eq!(resolves_to_index_html(path), expected, "{path:?}");
    }
    assert!(matches!(classify("/app.js", None), Class::PathAsset));
    assert!(matches!(
        classify("/page", Some("script")),
        Class::DestinationAsset
    ));
    assert!(matches!(classify("/page", Some("document")), Class::Page));
    assert!(matches!(classify("/page", None), Class::Page));
}

#[test]
fn page_views_are_ready_pages_in_edge_order() {
    let exchange = json!({ "answer": {
        "edges": [{ "entity": "Todo", "id": "t2" }, { "entity": "Todo", "id": "t1" }, { "entity": "Todo", "id": "t9" }],
        "start": { "_tag": "Terminal" },
        "end": { "_tag": "Cursor", "cursor": "c" },
        "entities": [
            { "entity": "Todo", "id": "t1", "values": { "title": "a" } },
            { "entity": "Todo", "id": "t2", "values": { "title": "b" } },
        ],
    } });
    assert_eq!(
        page_views(
            &[PageRead {
                tag: "Query",
                request: json!({ "select": { "entity": "Todo", "fields": ["title"] } }),
            }],
            &[Some(0)],
            &[exchange],
            &[("todos", 0)]
        ),
        // Edge order; a missing entity is null, which typed decoding refuses.
        json!({ "todos": { "items": [{ "title": "b" }, { "title": "a" }, null], "hasNext": true, "hasPrevious": false } })
    );
}

/// The exchanges upstream's satisfy makes for a project with its owner and a post with a page of
/// its comments (foldkit-remote 0.11.0, probed 2026-10-05), and the values its projections read.
#[test]
fn page_views_assemble_relations_as_upstream() {
    let project = json!({ "_tag": "Read",
        "request": { "version": 4, "requests": [{ "entity": "Project", "id": "p1", "fields": ["name", "owner"], "relations": { "owner": { "entity": "User", "fields": ["name"] } } }] },
        "answer": { "entities": [
            { "entity": "Project", "id": "p1", "values": { "name": "Borealis", "owner": "User:u1" } },
            { "entity": "User", "id": "u1", "values": { "name": "Ada" } },
        ], "settled": [] } });
    let post = json!({ "_tag": "Read",
        "request": { "version": 4, "requests": [{ "entity": "Post", "id": "a", "fields": ["title", "comments@first=2"], "windows": { "comments@first=2": { "first": 2 } }, "relations": { "comments@first=2": { "entity": "Comment", "fields": ["body"] } } }] },
        "answer": { "entities": [
            { "entity": "Post", "id": "a", "values": { "title": "Hello", "comments@first=2": { "refs": ["Comment:c1", "Comment:c2"], "hasNext": true, "hasPrevious": false } } },
            { "entity": "Comment", "id": "c1", "values": { "body": "first" } },
            { "entity": "Comment", "id": "c2", "values": { "body": "second" } },
        ], "settled": [] } });
    let reads = [
        PageRead {
            tag: "Read",
            request: project["request"].clone(),
        },
        PageRead {
            tag: "Read",
            request: post["request"].clone(),
        },
    ];
    assert_eq!(
        page_views(
            &reads,
            &[Some(0), Some(1)],
            &[project, post],
            &[("project", 0), ("post", 1)]
        ),
        json!({
            "project": { "_tag": "Ready", "value": { "name": "Borealis", "owner": { "name": "Ada" } } },
            "post": { "_tag": "Ready", "value": { "title": "Hello", "comments": { "items": [{ "body": "first" }, { "body": "second" }], "hasNext": true, "hasPrevious": false } } },
        })
    );
}

/// Upstream's planner over a store whose project holds its owner ref but not the owner's name
/// asks for the owner alone, in schema key order (probed 2026-10-05).
#[test]
fn page_reads_follow_held_relations_as_upstream() {
    let list = json!({ "_tag": "Query", "answer": { "edges": [], "entities": [
        { "entity": "Project", "id": "p1", "values": { "name": "Borealis", "owner": "User:u1" } },
    ], "settled": [] } });
    let planned = json!({ "version": 4, "requests": [{ "entity": "Project", "id": "p1", "fields": ["name", "owner"], "relations": { "owner": { "entity": "User", "fields": ["name"] } } }] });
    let narrowed = lacking(&planned, &[list]).unwrap();
    assert_eq!(
        serde_json::to_string(&narrowed).unwrap(),
        r#"{"version":4,"requests":[{"entity":"User","id":"u1","fields":["name"]}]}"#
    );
}

#[test]
fn page_data_records_each_planned_read_with_its_answer() {
    let rows = json!({ "Todo": [["t1", { "id": "t1", "title": "Write" }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let request = json!({ "version": 4, "requests": [{ "entity": "Todo", "id": "t1", "fields": ["title"] }] });
    let reads = [PageRead {
        tag: "Read",
        request: request.clone(),
    }];
    let permit_all = |_: &str, fields: &[String]| fields.to_vec();
    let (resume, views) = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(page_data(&memory, &permit_all, &reads, &[], 7))
        .unwrap();
    assert_eq!(resume["now"], json!(7));
    assert_eq!(resume["exchanges"][0]["request"], request);
    assert_eq!(
        resume["exchanges"][0]["answer"]["entities"][0]["values"],
        json!({ "title": "Write" })
    );
    assert_eq!(views, json!({}));
}

#[test]
fn page_reads_ask_only_what_earlier_answers_lack_and_gets_settle() {
    let rows = json!({ "Todo": [["t1", { "id": "t1", "title": "Write", "done": true }]] });
    let memory = Memory::new(vec!["Todo".to_string()], &rows, &[]);
    let get = |id: &str, fields: &[&str]| PageRead {
        tag: "Read",
        request: json!({ "version": 4, "requests": [{ "entity": "Todo", "id": id, "fields": fields }] }),
    };
    let reads = [
        get("t1", &["title"]),
        get("t1", &["title", "done"]),
        get("t1", &["title"]),
        get("t9", &["title"]),
    ];
    let permit_all = |_: &str, fields: &[String]| fields.to_vec();
    let views = [("first", 0), ("both", 1), ("again", 2), ("missing", 3)];
    let (resume, views) = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(page_data(&memory, &permit_all, &reads, &views, 7))
        .unwrap();
    let requests: Vec<&serde_json::Value> = resume["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|exchange| &exchange["request"]["requests"][0])
        .collect();
    // The second read asks only for `done`; the third is answered already, so it is not made.
    assert_eq!(
        requests,
        [
            &json!({ "entity": "Todo", "id": "t1", "fields": ["title"] }),
            &json!({ "entity": "Todo", "id": "t1", "fields": ["done"] }),
            &json!({ "entity": "Todo", "id": "t9", "fields": ["title"] }),
        ]
    );
    // Each get view is its selection of everything answered; one never answered is NotFound.
    assert_eq!(
        views,
        json!({
            "first": { "_tag": "Ready", "value": { "title": "Write" } },
            "both": { "_tag": "Ready", "value": { "title": "Write", "done": true } },
            "again": { "_tag": "Ready", "value": { "title": "Write" } },
            "missing": { "_tag": "NotFound" },
        })
    );
}

/// The memory backend, counting reads; during its first read a newer title is committed and
/// signalled, as a concurrent mutation would be while a snapshot reads (#8).
struct RacingSource {
    inner: Memory,
    newer: Memory,
    hub: &'static Hub,
    reads: std::sync::atomic::AtomicUsize,
}
impl crate::remote_engine::Source for RacingSource {
    fn has_source(&self, entity: &str) -> bool {
        self.inner.has_source(entity)
    }
    fn read(
        &self,
        entity: &str,
        ids: &[String],
        fields: &[String],
        windows: &Option<JsObject<crate::remote_engine::Window>>,
    ) -> impl std::future::Future<Output = Result<Vec<crate::remote_engine::EntityRecord>, String>> + Send
    {
        let first = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
        async move {
            let old = self.inner.read(entity, ids, fields, windows).await;
            if first {
                fn permit_all(_: Option<u64>, _: &str, fields: &[String]) -> Vec<String> {
                    fields.to_vec()
                }
                let title = ["title".to_string()];
                self.hub
                    .changed(&self.newer, permit_all, "Todo", "t1", &title)
                    .await;
            }
            old
        }
    }
    fn check_query(&self, query: &str, input: &serde_json::Value) -> Result<&'static str, String> {
        self.inner.check_query(query, input)
    }
    fn page(
        &self,
        query: &str,
        input: &serde_json::Value,
        window: &crate::remote_engine::Window,
    ) -> impl std::future::Future<Output = Result<crate::remote_engine::PageIds, String>> + Send
    {
        self.inner.page(query, input, window)
    }
}

#[test]
fn snapshot_reads_rows_together_and_never_overwrites_a_newer_event() {
    let hub = hub();
    let rows = |title: &str| {
        json!({ "Todo": [
            ["t1", { "id": "t1", "title": title, "done": false }],
            ["t2", { "id": "t2", "title": "Other", "done": true }],
        ] })
    };
    let source = RacingSource {
        inner: Memory::new(vec!["Todo".to_string()], &rows("Old"), &[]),
        newer: Memory::new(vec!["Todo".to_string()], &rows("New"), &[]),
        hub,
        reads: std::sync::atomic::AtomicUsize::new(0),
    };
    let fields = json!(["title", "done"]);
    let mut fresh = live(
        hub,
        0.0,
        json!([
            { "entity": "Todo", "id": "t1", "fields": fields },
            { "entity": "Todo", "id": "t2", "fields": fields },
        ]),
        None,
    );
    fn permit_all(_: Option<u64>, _: &str, fields: &[String]) -> Vec<String> {
        fields.to_vec()
    }
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(hub.snapshot(&fresh, &source, permit_all));
    // #10: both rows read the same fields of Todo, so one read serves them.
    assert_eq!(source.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    // #8: the event's newer title arrives first, and the snapshot (read before it) does not
    // overwrite it; it still tells t1's done and all of t2.
    assert_eq!(
        drain(&mut fresh),
        [
            json!({ "_tag": "EntityPatched", "cursor": 1, "entity": "Todo", "id": "t1", "values": { "title": "New" }, "changed": ["title"] }),
            json!({ "_tag": "EntityPatched", "cursor": 2, "entity": "Todo", "id": "t1", "values": { "done": false }, "changed": ["done"] }),
            json!({ "_tag": "EntityPatched", "cursor": 3, "entity": "Todo", "id": "t2", "values": { "title": "Other", "done": true }, "changed": ["title", "done"] }),
        ]
    );
}

#[test]
fn header_values_read_as_fetch_reads_them() {
    use crate::ssr_host::header_value;
    let mut headers = axum::http::HeaderMap::new();
    headers.append("accept", axum::http::HeaderValue::from_static("*/*"));
    headers.append(
        "accept",
        axum::http::HeaderValue::from_static("text/html;q=0"),
    );
    headers.append(
        "sec-fetch-dest",
        axum::http::HeaderValue::from_bytes(&[b'x', 0xe9]).unwrap(),
    );
    // Repeats are joined, so the more specific text/html;q=0 still refuses (#28).
    assert_eq!(
        header_value(&headers, "accept").as_deref(),
        Some("*/*, text/html;q=0")
    );
    // A non-ASCII byte is Latin-1, not a missing header.
    assert_eq!(
        header_value(&headers, "sec-fetch-dest").as_deref(),
        Some("x\u{e9}")
    );
    assert_eq!(header_value(&headers, "origin"), None);
}
