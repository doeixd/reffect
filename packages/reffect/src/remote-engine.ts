/**
 * The native Foldkit Remote read engine (NR-001, NR-008..011): a line-for-line Rust port of
 * `foldkit-remote-server`'s `readHelper`, `splitAliases`, `groupByEntity`, `allowedFields`,
 * `windowsOf`, limit checks, and the memory backend's `valueFor`/`pageOf`, over validated JSON.
 * Upstream: foldkit-plus `packages/remote-server/src/index.ts` and `packages/remote/src`
 * (`relation.ts`, `requirement.ts`), MIT, Copyright (c) 2026 Patrick Glenn.
 */
export const remoteEngineRuntime =
  String.raw`
mod remote_engine {
    use serde_json::{json, Map, Value};
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex, RwLock};

    const PROTOCOL_VERSION: f64 = 4.0;
    const MAX_IDS_PER_ENTITY: usize = 1000;
    const MAX_DEPTH: usize = 8;
    const MAX_PAGES_PER_RELATION: usize = 4;
    const RELATION_ALIAS: char = '@';

    /// A canonical array index (below 2^32 - 1), which JS objects order first, ascending.
    fn array_index(key: &str) -> Option<u32> {
        if key == "0" { return Some(0); }
        if key.is_empty() || key.starts_with('0') || !key.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
        key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
    }

    /// A plain JS object: index keys first, ascending, then insertion order; a reassigned key
    /// keeps its position (NR-009).
    #[derive(Clone, Debug, Default)]
    pub struct JsObject<T> { entries: Vec<(String, T)> }
    impl<T: Clone> JsObject<T> {
        pub fn new() -> Self { JsObject { entries: Vec::new() } }
        pub fn get(&self, key: &str) -> Option<&T> { self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v) }
        pub fn get_mut(&mut self, key: &str) -> Option<&mut T> { self.entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v) }
        /// Moves a value out, leaving the key absent.
        pub fn take(&mut self, key: &str) -> Option<T> { let at = self.entries.iter().position(|(k, _)| k == key)?; Some(self.entries.remove(at).1) }
        pub fn has(&self, key: &str) -> bool { self.entries.iter().any(|(k, _)| k == key) }
        pub fn len(&self) -> usize { self.entries.len() }
        pub fn is_empty(&self) -> bool { self.entries.is_empty() }
        pub fn iter(&self) -> impl Iterator<Item = &(String, T)> { self.entries.iter() }
        pub fn set(&mut self, key: String, value: T) {
            if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) { entry.1 = value; return; }
            match array_index(&key) {
                Some(index) => {
                    let at = self.entries.iter().position(|(k, _)| match array_index(k) { Some(other) => other > index, None => true }).unwrap_or(self.entries.len());
                    self.entries.insert(at, (key, value));
                }
                None => self.entries.push((key, value)),
            }
        }
        /// ` +
  "`{ ...self, ...other }`" +
  String.raw`.
        pub fn spread(&self, other: &JsObject<T>) -> JsObject<T> {
            let mut out = self.clone();
            for (key, value) in other.iter() { out.set(key.clone(), value.clone()); }
            out
        }
    }

    /// Insertion-ordered map, as a JS ` +
  "`Map`" +
  String.raw`.
    #[derive(Clone, Debug)]
    struct Ordered<V> { keys: Vec<String>, values: HashMap<String, V> }
    impl<V> Ordered<V> {
        fn new() -> Self { Ordered { keys: Vec::new(), values: HashMap::new() } }
        fn get(&self, key: &str) -> Option<&V> { self.values.get(key) }
        fn get_mut(&mut self, key: &str) -> Option<&mut V> { self.values.get_mut(key) }
        fn set(&mut self, key: String, value: V) {
            if !self.values.contains_key(&key) { self.keys.push(key.clone()); }
            self.values.insert(key, value);
        }
        fn iter(&self) -> impl Iterator<Item = (&String, &V)> { self.keys.iter().map(move |key| (key, &self.values[key])) }
        /// ` +
  "`Map.prototype.delete`" +
  String.raw`: setting the key again appends it.
        fn remove(&mut self, key: &str) {
            if self.values.remove(key).is_some() { self.keys.retain(|existing| existing != key); }
        }
        fn into_values(mut self) -> Vec<V> { self.keys.iter().map(|key| self.values.remove(key).unwrap()).collect() }
    }
    /// Insertion-ordered set, as a JS ` +
  "`Set`" +
  String.raw` of strings.
    #[derive(Clone, Debug, Default)]
    struct OrderedSet { items: Vec<String>, seen: HashSet<String> }
    impl OrderedSet {
        fn add(&mut self, item: &str) { if self.seen.insert(item.to_string()) { self.items.push(item.to_string()); } }
        fn has(&self, item: &str) -> bool { self.seen.contains(item) }
    }

    #[derive(Clone, Debug, PartialEq)]
    pub struct Window { pub first: Option<f64>, pub last: Option<f64>, pub after: Option<String>, pub before: Option<String> }
    #[derive(Clone, Debug)]
    pub struct Relation { entity: String, fields: Vec<String>, windows: Option<JsObject<Window>>, relations: Option<JsObject<Relation>> }
    #[derive(Clone, Debug)]
    pub struct Requirement {
        entity: String, id: String, fields: Vec<String>,
        windows: Option<JsObject<Window>>, relations: Option<JsObject<Relation>>,
        /// The alias each field read here is answered under (` +
  "`splitAliases`" +
  String.raw`).
        renames: Option<JsObject<String>>,
    }

    // ---- Reading the validated payload (NR-008): absent and null are both undefined.
    fn number(value: &Value) -> f64 {
        match value {
            Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
            Value::String(text) => match text.as_str() { "Infinity" => f64::INFINITY, "-Infinity" => f64::NEG_INFINITY, _ => f64::NAN },
            _ => f64::NAN,
        }
    }
    fn present<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
        object.get(key).filter(|value| !value.is_null())
    }
    fn text(object: &Map<String, Value>, key: &str) -> String {
        object.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
    }
    fn texts(value: Option<&Value>) -> Vec<String> {
        value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    }
    fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
        let mut indexed = Vec::new();
        let mut named = Vec::new();
        for (key, value) in object.iter() {
            match array_index(key) { Some(index) => indexed.push((index, key, value)), None => named.push((key, value)) }
        }
        indexed.sort_by_key(|entry| entry.0);
        indexed.into_iter().map(|(_, key, value)| (key, value)).chain(named).collect()
    }
    fn record<T: Clone>(value: Option<&Value>, item: impl Fn(&Value) -> T) -> Option<JsObject<T>> {
        let object = value?.as_object()?;
        let mut out = JsObject::new();
        for (key, entry) in js_entries(object) { out.set(key.clone(), item(entry)); }
        Some(out)
    }
    fn window(value: &Value) -> Window {
        let empty = Map::new();
        let object = value.as_object().unwrap_or(&empty);
        Window {
            first: present(object, "first").map(number),
            last: present(object, "last").map(number),
            after: present(object, "after").and_then(Value::as_str).map(str::to_string),
            before: present(object, "before").and_then(Value::as_str).map(str::to_string),
        }
    }
    fn relation(value: &Value) -> Relation {
        let empty = Map::new();
        let object = value.as_object().unwrap_or(&empty);
        Relation {
            entity: text(object, "entity"),
            fields: texts(object.get("fields")),
            windows: record(present(object, "windows"), window),
            relations: record(present(object, "relations"), relation),
        }
    }
    fn requirement(value: &Value) -> Requirement {
        let empty = Map::new();
        let object = value.as_object().unwrap_or(&empty);
        let relation = relation(value);
        Requirement { entity: relation.entity, id: text(object, "id"), fields: relation.fields, windows: relation.windows, relations: relation.relations, renames: None }
    }

    // ---- stableStringify: an injective canonical text, used only to compare group keys.
    fn number_key(x: f64) -> String { if x == 0.0 { "0".to_string() } else { format!("{:?}", x) } }
    fn stable_windows(windows: &Option<JsObject<Window>>) -> String {
        let Some(windows) = windows else { return "null".to_string() };
        let mut keys: Vec<&(String, Window)> = windows.iter().collect();
        keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        keys.iter().map(|(key, w)| format!("{}:[{},{},{},{}]",
            serde_json::to_string(key).unwrap(),
            w.after.as_ref().map(|s| serde_json::to_string(s).unwrap()).unwrap_or_default(),
            w.before.as_ref().map(|s| serde_json::to_string(s).unwrap()).unwrap_or_default(),
            w.first.map(number_key).unwrap_or_default(),
            w.last.map(number_key).unwrap_or_default(),
        )).collect::<Vec<_>>().join(",")
    }
    fn stable_renames(renames: &Option<JsObject<String>>) -> String {
        let Some(renames) = renames else { return "{}".to_string() };
        let mut keys: Vec<&(String, String)> = renames.iter().collect();
        keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        keys.iter().map(|(key, value)| format!("{}:{}", serde_json::to_string(key).unwrap(), serde_json::to_string(value).unwrap())).collect::<Vec<_>>().join(",")
    }

    // ---- foldkit-remote helpers.
    fn aliased_field(name: &str) -> &str { match name.find(RELATION_ALIAS) { Some(at) => &name[..at], None => name } }
    fn ref_parts(encoded: &str) -> (String, String) {
        match encoded.find(':') { Some(at) => (encoded[..at].to_string(), encoded[at + 1..].to_string()), None => (encoded.to_string(), String::new()) }
    }
    /// ` +
  "`refsIn`" +
  String.raw`: a ref key, an array of them, or a page of them.
    fn refs_in(value: &Value) -> Vec<(String, String)> {
        let strings = |items: &Vec<Value>| items.iter().filter_map(Value::as_str).map(ref_parts).collect();
        match value {
            Value::String(text) => vec![ref_parts(text)],
            Value::Array(items) => strings(items),
            Value::Object(object) => match object.get("refs") { Some(Value::Array(items)) => strings(items), _ => Vec::new() },
            _ => Vec::new(),
        }
    }
    /// ` +
  "`target = mergeRelation(target, next)`" +
  String.raw`, in place: unseen fields appended, windows
    /// spread (a reassigned key keeps its position; an empty result is absent), relations merged.
    fn merge_into(target: &mut Relation, fields: &[String], windows: &Option<JsObject<Window>>, relations: &Option<JsObject<Relation>>) {
        for field in fields { if !target.fields.contains(field) { target.fields.push(field.clone()); } }
        if let Some(windows) = windows {
            let own = target.windows.get_or_insert_with(JsObject::new);
            for (key, window) in windows.iter() { own.set(key.clone(), window.clone()); }
        }
        if target.windows.as_ref().map(JsObject::is_empty).unwrap_or(false) { target.windows = None; }
        match (&mut target.relations, relations) {
            (_, None) => {}
            (None, Some(next)) => target.relations = Some(next.clone()),
            (Some(own), Some(next)) => {
                for (field, relation) in next.iter() {
                    match own.get_mut(field) {
                        Some(existing) => merge_into(existing, &relation.fields, &relation.windows, &relation.relations),
                        None => own.set(field.clone(), relation.clone()),
                    }
                }
            }
        }
    }

    // ---- remote-server helpers.
    fn pick_names<T: Clone>(record: &Option<JsObject<T>>, names: &[String]) -> JsObject<T> {
        let mut picked = JsObject::new();
        if let Some(record) = record { for name in names { if let Some(value) = record.get(name) { picked.set(name.clone(), value.clone()); } } }
        picked
    }
    struct Building { fields: Vec<String>, windows: JsObject<Window>, relations: JsObject<Relation>, renames: JsObject<String> }
    fn split_aliases(request: &Requirement) -> Vec<Requirement> {
        let aliases: Vec<&String> = request.fields.iter().filter(|field| field.contains(RELATION_ALIAS)).collect();
        if aliases.is_empty() { return vec![request.clone()]; }
        let plain: Vec<String> = request.fields.iter().filter(|field| !field.contains(RELATION_ALIAS)).cloned().collect();
        let mut building = vec![Building {
            fields: plain.clone(),
            windows: pick_names(&request.windows, &plain),
            relations: pick_names(&request.relations, &plain),
            renames: JsObject::new(),
        }];
        for alias in aliases {
            // An alias is a page: one that names no window asks for nothing.
            let Some(window) = request.windows.as_ref().and_then(|windows| windows.get(alias)) else { continue };
            let field = aliased_field(alias).to_string();
            let index = match building.iter().position(|candidate| !candidate.fields.contains(&field)) {
                Some(index) => index,
                None => { building.push(Building { fields: Vec::new(), windows: JsObject::new(), relations: JsObject::new(), renames: JsObject::new() }); building.len() - 1 }
            };
            let part = &mut building[index];
            part.fields.push(field.clone());
            part.windows.set(field.clone(), window.clone());
            part.renames.set(field, alias.clone());
            if let Some(relation) = request.relations.as_ref().and_then(|relations| relations.get(alias)) { part.relations.set(alias.clone(), relation.clone()); }
        }
        building.into_iter().filter(|part| !part.fields.is_empty()).map(|part| Requirement {
            entity: request.entity.clone(), id: request.id.clone(), fields: part.fields,
            windows: if part.windows.is_empty() { None } else { Some(part.windows) },
            relations: if part.relations.is_empty() { None } else { Some(part.relations) },
            renames: if part.renames.is_empty() { None } else { Some(part.renames) },
        }).collect()
    }
    struct EntityGroup { ids: Ordered<OrderedSet>, slice: Relation, renames: JsObject<String> }
    fn group_by_entity(requests: &[Requirement]) -> Vec<EntityGroup> {
        let mut grouped: Ordered<EntityGroup> = Ordered::new();
        for request in requests.iter().flat_map(split_aliases) {
            let renames = request.renames.clone().unwrap_or_default();
            let key = format!("{}\u{0}{}\u{0}{}", request.entity, stable_windows(&request.windows), stable_renames(&request.renames));
            match grouped.get_mut(&key) {
                None => {
                    let mut ids = Ordered::new();
                    let mut asked = OrderedSet::default();
                    for field in &request.fields { asked.add(field); }
                    ids.set(request.id.clone(), asked);
                    let mut slice = Relation { entity: request.entity.clone(), fields: Vec::new(), windows: None, relations: None };
                    merge_into(&mut slice, &request.fields, &request.windows, &request.relations);
                    grouped.set(key, EntityGroup { ids, slice, renames });
                }
                Some(group) => {
                    match group.ids.get_mut(&request.id) {
                        Some(asked) => for field in &request.fields { asked.add(field); },
                        None => {
                            let mut asked = OrderedSet::default();
                            for field in &request.fields { asked.add(field); }
                            group.ids.set(request.id.clone(), asked);
                        }
                    }
                    merge_into(&mut group.slice, &request.fields, &request.windows, &request.relations);
                }
            }
        }
        grouped.into_values()
    }
    fn windows_of(windows: &Option<JsObject<Window>>, fields: &[String]) -> Option<JsObject<Window>> {
        let windows = windows.as_ref()?;
        let mut kept = JsObject::new();
        for field in fields { if let Some(window) = windows.get(field) { kept.set(field.clone(), window.clone()); } }
        if kept.is_empty() { None } else { Some(kept) }
    }
    fn check_pages_per_relation(requirements: &[Relation]) -> Option<String> {
        for requirement in requirements {
            let mut pages: HashMap<&str, usize> = HashMap::new();
            for name in &requirement.fields {
                if !name.contains(RELATION_ALIAS) { continue; }
                let field = aliased_field(name);
                let count = pages.get(field).copied().unwrap_or(0) + 1;
                if count > MAX_PAGES_PER_RELATION { return Some(format!("{}.{}", requirement.entity, field)); }
                pages.insert(field, count);
            }
            let nested: Vec<Relation> = requirement.relations.as_ref().map(|relations| relations.iter().map(|(_, relation)| relation.clone()).collect()).unwrap_or_default();
            if let Some(found) = check_pages_per_relation(&nested) { return Some(found); }
        }
        None
    }
    fn check_ids_per_entity(requirements: &[Requirement]) -> Option<String> {
        let mut ids: HashMap<&str, HashSet<&str>> = HashMap::new();
        for requirement in requirements {
            let seen = ids.entry(requirement.entity.as_str()).or_default();
            seen.insert(requirement.id.as_str());
            if seen.len() > MAX_IDS_PER_ENTITY { return Some(requirement.entity.clone()); }
        }
        None
    }

    // ---- Sources (NR-011): the memory backend.
    pub struct EntityRecord { pub id: String, pub values: JsObject<Value> }
    /// One page of a query: its row ids in order and the boundaries the page advertises.
    pub struct PageIds { pub ids: Vec<String>, pub start: Boundary, pub end: Boundary }
    /// A backend serving entity reads and query pages (SQLX-007). The engine owns everything
    /// upstream's handlers own: limits, grouping, authorization, settling, relations, select.
    pub trait Source: Sync {
        fn has_source(&self, entity: &str) -> bool;
        /// Whether the source declares a field; an undeclared one is withheld, never read.
        fn declares(&self, _entity: &str, _field: &str) -> bool { true }
        /// A source failure is its RemoteServerError message.
        fn read(&self, entity: &str, ids: &[String], fields: &[String], windows: &Option<JsObject<Window>>) -> impl std::future::Future<Output = Result<Vec<EntityRecord>, String>> + Send;
        /// In upstream's order: an unknown query, then input the Input schema refuses. The query's entity.
        fn check_query(&self, query: &str, input: &Value) -> Result<&'static str, String>;
        fn page(&self, query: &str, input: &Value, window: &Window) -> impl std::future::Future<Output = Result<PageIds, String>> + Send;
    }
    /// A row as the memory backend holds it: a plain object, shared until a write replaces it.
    pub type Row = Arc<JsObject<Value>>;
    struct Tables { version: u64, tables: HashMap<String, Ordered<Row>> }
    /// The memory backend's ` +
  "`MemoryStore`" +
  String.raw` (RS-003..006): one server-lifetime store behind a lock,
    /// taken once per operation. Every write bumps the version, which invalidates query caches.
    pub struct Memory { entities: Vec<String>, state: RwLock<Tables>, queries: &'static [QueryDef] }
    impl Memory {
        /// ` +
  "`rows`" +
  String.raw`: entity -> [[String(id), row]] in table order, as the memory backend keys them.
        pub fn new(entities: Vec<String>, rows: &Value, queries: &'static [QueryDef]) -> Memory {
            let mut tables = HashMap::new();
            if let Some(object) = rows.as_object() {
                for (entity, table) in object.iter() {
                    let mut ordered = Ordered::new();
                    for entry in table.as_array().into_iter().flatten() {
                        if let (Some(id), Some(row)) = (entry.get(0).and_then(Value::as_str), entry.get(1).and_then(Value::as_object)) {
                            let mut copy = JsObject::new();
                            for (key, value) in row.iter() { copy.set(key.clone(), value.clone()); }
                            ordered.set(id.to_string(), Arc::new(copy));
                        }
                    }
                    tables.insert(entity.clone(), ordered);
                }
            }
            Memory { entities, state: RwLock::new(Tables { version: 0, tables }), queries }
        }
        fn tables(&self) -> std::sync::RwLockReadGuard<'_, Tables> { self.state.read().unwrap_or_else(|poisoned| poisoned.into_inner()) }
        fn tables_mut(&self) -> std::sync::RwLockWriteGuard<'_, Tables> { self.state.write().unwrap_or_else(|poisoned| poisoned.into_inner()) }
        fn read_now(&self, entity: &str, ids: &[String], fields: &[String], windows: &Option<JsObject<Window>>) -> Vec<EntityRecord> {
            let state = self.tables();
            let Some(table) = state.tables.get(entity) else { return Vec::new() };
            ids.iter().filter_map(|id| {
                let row = table.get(id)?;
                let mut values = JsObject::new();
                for field in fields {
                    if let Some(value) = row.get(field) {
                        let window = windows.as_ref().and_then(|windows| windows.get(field));
                        values.set(field.clone(), value_for(value, window));
                    }
                }
                Some(EntityRecord { id: id.clone(), values })
            }).collect()
        }
        /// The row ` +
  "`rows(entity)`" +
  String.raw` holds under ` +
  "`id`" +
  String.raw`, if any.
        #[allow(dead_code)]
        pub fn get(&self, entity: &str, id: &str) -> Option<Row> { self.tables().tables.get(entity)?.get(id).cloned() }
        /// ` +
  "`write(entity, id, values)`" +
  String.raw`: the row becomes ` +
  "`{ ...existing, id, ...values }`" +
  String.raw`; a new row
        /// goes last. ` +
  "`values`" +
  String.raw` are in JS own-property order.
        #[allow(dead_code)]
        pub fn write(&self, entity: &str, id: &str, values: Vec<(String, Value)>) {
            let mut state = self.tables_mut();
            state.version += 1;
            let table = state.tables.entry(entity.to_string()).or_insert_with(Ordered::new);
            let mut row = table.get(id).map(|row| JsObject::clone(row)).unwrap_or_default();
            row.set("id".to_string(), Value::String(id.to_string()));
            for (key, value) in values { row.set(key, value); }
            table.set(id.to_string(), Arc::new(row));
        }
        /// ` +
  "`remove(entity, id)`" +
  String.raw`; removing an absent row changes nothing.
        #[allow(dead_code)]
        pub fn remove(&self, entity: &str, id: &str) {
            let mut state = self.tables_mut();
            state.version += 1;
            if let Some(table) = state.tables.get_mut(entity) { table.remove(id); }
        }
    }
    #[derive(Clone)]
    pub enum Boundary { Terminal, Unknown, Cursor(String) }
    /// ` +
  "`pageOf`" +
  String.raw` without ` +
  "`locate`" +
  String.raw`; ` +
  "`Err`" +
  String.raw` where the reference throws.
    pub struct Position { index: usize, exact: bool }
    fn page_of<T: Clone>(items: &[T], window: &Window, id_of: &dyn Fn(&T) -> String, locate: Option<&dyn Fn(&str) -> Result<Position, String>>) -> Result<(Vec<T>, Boundary, Boundary), String> {
        if (window.after.is_some() && window.before.is_some()) || (window.first.is_some() && window.last.is_some()) {
            return Err("A query window cannot combine after with before, or first with last".to_string());
        }
        let position = |cursor: &str| -> Result<Position, String> {
            if let Some(index) = items.iter().position(|item| id_of(item) == cursor) { return Ok(Position { index, exact: true }); }
            match locate { Some(locate) => locate(cursor), None => Err(format!("Cursor \"{}\" names nothing in these results", cursor)) }
        };
        let cursor = |id: String| Boundary::Cursor(id);
        let length = items.len();
        if window.last.is_some() || window.before.is_some() {
            let to = match &window.before { None => length, Some(before) => position(before)?.index.min(length) };
            let from = match window.last { None => 0, Some(last) => { let start = to as f64 - last; if start > 0.0 { start as usize } else { 0 } } };
            let page: Vec<T> = items[from.min(to)..to].to_vec();
            let start = if from == 0 { Boundary::Terminal } else if let Some(first) = page.first() { cursor(id_of(first)) } else if let Some(before) = &window.before { cursor(before.clone()) } else { Boundary::Unknown };
            let end = match &window.before { None => Boundary::Terminal, Some(before) => cursor(before.clone()) };
            return Ok((page, start, end));
        }
        let from = match &window.after { None => 0, Some(after) => { let at = position(after)?; (if at.exact { at.index + 1 } else { at.index }).min(length) } };
        let to = match window.first { None => length, Some(first) => { let limit = from as f64 + first; if limit < length as f64 { limit as usize } else { length } } };
        let page: Vec<T> = items[from.min(to)..to].to_vec();
        let end = if to >= length { Boundary::Terminal } else if let Some(last) = page.last() { cursor(id_of(last)) } else if let Some(after) = &window.after { cursor(after.clone()) } else { Boundary::Unknown };
        let start = match &window.after { None => Boundary::Terminal, Some(after) => cursor(after.clone()) };
        Ok((page, start, end))
    }
    /// The memory backend's ` +
  "`valueFor`" +
  String.raw`: a relation page is the refs in a window of the stored list.
    fn value_for(value: &Value, window: Option<&Window>) -> Value {
        let (Some(window), Some(items)) = (window, value.as_array()) else { return value.clone() };
        let empty = json!({ "refs": [], "hasNext": false, "hasPrevious": false });
        // A non-string ref throws inside the reference's try, answering with an empty page.
        if items.iter().any(|item| !item.is_string()) { return empty; }
        let mut seen = HashSet::new();
        let refs: Vec<String> = items.iter().filter_map(Value::as_str).filter(|item| seen.insert(item.to_string())).map(str::to_string).collect();
        let id_of = |reference: &str| -> String { match reference.find(':') { Some(at) => reference[at + 1..].to_string(), None => reference.to_string() } };
        let named = |cursor: &Option<String>| cursor.as_ref().map(|cursor| if cursor.contains(':') { id_of(cursor) } else { cursor.clone() });
        let window = Window { first: window.first, last: window.last, after: named(&window.after), before: named(&window.before) };
        let id_of_ref = |reference: &String| id_of(reference);
        match page_of(&refs, &window, &id_of_ref, None) {
            Err(_) => empty,
            Ok((page, start, end)) => json!({
                "refs": page,
                "hasNext": matches!(end, Boundary::Cursor(_)),
                "hasPrevious": matches!(start, Boundary::Cursor(_)),
            }),
        }
    }

    fn read_error(message: String) -> Value { json!({ "_tag": "RemoteReadError", "message": message }) }
    fn into_object(object: JsObject<Value>) -> Value {
        let mut map = Map::new();
        for (key, value) in object.entries { map.insert(key, value); }
        Value::Object(map)
    }

    /// ` +
  "`readHelper`" +
  String.raw`.
    /// An entity source's ` +
  "`authorize`" +
  String.raw` for the bound principal: declared fields in, permitted fields out.
    pub type Authorize<'a> = &'a (dyn Fn(&str, &[String]) -> Vec<String> + Sync);
    /// ` +
  "`allowedFields`" +
  String.raw`: requested fields ` +
  "`authorize`" +
  String.raw` permits, in request order; it can only remove.
    fn allowed_fields<S: Source>(server: &S, authorize: Authorize, entity: &str, requested: &[String]) -> Vec<String> {
        let declared: Vec<String> = requested.iter().filter(|field| server.declares(entity, field)).cloned().collect();
        if declared.is_empty() { return Vec::new(); }
        let permitted: HashSet<String> = authorize(entity, &declared).into_iter().collect();
        declared.into_iter().filter(|field| permitted.contains(field)).collect()
    }
    async fn read_helper<S: Source>(server: &S, authorize: Authorize<'_>, requests: Vec<Requirement>) -> Result<Value, Value> {
        let mut entities: Vec<Value> = Vec::new();
        let mut settled: Ordered<(String, String, OrderedSet)> = Ordered::new();
        let mut fetched: HashMap<String, HashSet<String>> = HashMap::new();
        let mut fetched_values: HashMap<String, JsObject<Value>> = HashMap::new();
        if let Some(over) = check_ids_per_entity(&requests) { return Err(read_error(format!("Too many \"{}\" ids in one read batch", over))); }
        let relations: Vec<Relation> = requests.iter().map(|request| Relation { entity: request.entity.clone(), fields: request.fields.clone(), windows: request.windows.clone(), relations: request.relations.clone() }).collect();
        if let Some(paged) = check_pages_per_relation(&relations) { return Err(read_error(format!("Too many pages of \"{}\" in one read", paged))); }
        let mut pending = requests;
        let mut depth = 0;
        while !pending.is_empty() {
            if depth > MAX_DEPTH { return Err(read_error(format!("Nested selection deeper than {} relation levels", MAX_DEPTH))); }
            let mut next: Vec<Requirement> = Vec::new();
            for group in group_by_entity(&pending) {
                let name = group.slice.entity.clone();
                if !server.has_source(&name) { continue; }
                let allowed: Vec<String> = allowed_fields(server, authorize, &name, &group.slice.fields);
                let allowed_set: HashSet<&String> = allowed.iter().collect();
                let rename = |field: &String| -> String { group.renames.get(field).cloned().unwrap_or_else(|| field.clone()) };
                let id_list: Vec<String> = group.ids.keys.clone();
                for (id, asked) in group.ids.iter() {
                    let refused: Vec<String> = asked.items.iter().filter(|field| !allowed_set.contains(field)).map(&rename).collect();
                    settle(&mut settled, &name, id, &refused);
                }
                if allowed.is_empty() { continue; }
                let windows = windows_of(&group.slice.windows, &allowed);
                let mut records = Vec::new();
                for chunk in id_list.chunks(MAX_IDS_PER_ENTITY) { records.extend(server.read(&name, chunk, &allowed, &windows).await.map_err(read_error)?); }
                for mut record in records {
                    let mut values: JsObject<Value> = JsObject::new();
                    let mut omitted = Vec::new();
                    let asked = group.ids.get(&record.id);
                    for field in &allowed {
                        if let Some(value) = record.values.take(field) { values.set(rename(field), value); }
                        else if asked.map(|asked| asked.has(field)).unwrap_or(false) { omitted.push(rename(field)); }
                    }
                    settle(&mut settled, &name, &record.id, &omitted);
                    let key = format!("{}:{}", name, record.id);
                    let known = fetched.entry(key.clone()).or_default();
                    for field in &allowed { known.insert(rename(field)); }
                    match fetched_values.get_mut(&key) {
                        Some(old) => for (field, value) in values.iter() { old.set(field.clone(), value.clone()); },
                        None => { fetched_values.insert(key, values.clone()); }
                    }
                    let empty = JsObject::new();
                    follow(&values, group.slice.relations.as_ref().unwrap_or(&empty), &fetched, &fetched_values, &mut next);
                    // Pushed last: following only extends the next level, so the order of entities is unchanged.
                    entities.push(json!({ "entity": name, "id": record.id, "values": into_object(values) }));
                }
            }
            pending = next.into_iter().filter_map(|mut request| {
                let read = fetched.get(&format!("{}:{}", request.entity, request.id));
                request.fields.retain(|field| read.map(|read| !read.contains(field)).unwrap_or(true));
                if request.fields.is_empty() { None } else { Some(request) }
            }).collect();
            depth += 1;
        }
        Ok(json!({
            "entities": entities,
            "settled": settled.into_values().into_iter().map(|(entity, id, fields)| json!({ "entity": entity, "id": id, "fields": fields.items })).collect::<Vec<_>>(),
        }))
    }
    fn settle(settled: &mut Ordered<(String, String, OrderedSet)>, entity: &str, id: &str, fields: &[String]) {
        if fields.is_empty() { return; }
        let key = format!("{}:{}", entity, id);
        if settled.get(&key).is_none() { settled.set(key.clone(), (entity.to_string(), id.to_string(), OrderedSet::default())); }
        let entry = settled.get_mut(&key).unwrap();
        for field in fields { entry.2.add(field); }
    }
    fn follow(values: &JsObject<Value>, relations: &JsObject<Relation>, fetched: &HashMap<String, HashSet<String>>, fetched_values: &HashMap<String, JsObject<Value>>, next: &mut Vec<Requirement>) {
        for (field, relation) in relations.iter() {
            let Some(value) = values.get(field) else { continue };
            for (entity, id) in refs_in(value) {
                if entity != relation.entity { continue; }
                let key = format!("{}:{}", relation.entity, id);
                let read = fetched.get(&key);
                let fields: Vec<String> = relation.fields.iter().filter(|name| read.map(|read| !read.contains(*name)).unwrap_or(true)).cloned().collect();
                if !fields.is_empty() {
                    next.push(Requirement { entity: relation.entity.clone(), id, fields, windows: relation.windows.clone(), relations: relation.relations.clone(), renames: None });
                } else if let Some(nested) = &relation.relations {
                    let empty = JsObject::new();
                    follow(fetched_values.get(&key).unwrap_or(&empty), nested, fetched, fetched_values, next);
                }
            }
        }
    }

    /// The ` +
  "`FoldkitRemoteRead`" +
  String.raw` handler over a validated payload: protocol check, then ` +
  "`readHelper`" +
  String.raw`.
    pub async fn read<S: Source>(server: &S, authorize: Authorize<'_>, payload: &Value) -> Result<Value, Value> {
        let received = payload.get("version").map(number).unwrap_or(f64::NAN);
        if received != PROTOCOL_VERSION {
            let mut buffer = ryu_js::Buffer::new();
            let printed = buffer.format(received).to_string();
            let wire = if received.is_nan() { json!("NaN") } else if received.is_infinite() { json!(if received > 0.0 { "Infinity" } else { "-Infinity" }) } else if received == received.trunc() && received.abs() < 9007199254740992.0 { json!(received as i64) } else { json!(received) };
            return Err(json!({ "_tag": "RemoteProtocolError", "message": format!("Remote protocol version {} is not 4", printed), "expected": 4, "received": wire }));
        }
        let requests: Vec<Requirement> = payload.get("requests").and_then(Value::as_array).map(|items| items.iter().map(requirement).collect()).unwrap_or_default();
        read_helper(server, authorize, requests).await
    }
    // ---- Query (NR-014..017): a domain query's body, run by the milestone-1 evaluator.
    use super::foldkit_eval::Value as Cell;
    /// One registered query: its entity, its input check, its slots and its evaluators.
    pub struct QueryDef {
        pub name: &'static str,
        pub entity: &'static str,
        pub valid: fn(&Value) -> bool,
        pub fields: &'static [&'static str],
        pub inputs: &'static [&'static str],
        pub run: fn(&[Cell], &[Vec<Cell>]) -> Result<Vec<usize>, &'static str>,
        pub order: fn(&[Cell], &[Vec<Cell>]) -> Result<Vec<usize>, &'static str>,
        /// The order-only twin's own slots: without the predicates it reads fewer of them.
        pub order_fields: &'static [&'static str],
        pub order_inputs: &'static [&'static str],
        /// The table's evaluator cells and the store version they were built at.
        pub cells: Mutex<Option<(u64, Arc<Vec<Vec<Cell>>>)>>,
    }
    /// A row or input value as the evaluator sees it; an absent field is null (` +
  "`isNull`" +
  String.raw`).
    fn cell(value: Option<&Value>) -> Cell {
        match value {
            Some(Value::String(text)) => Cell::Text(text.encode_utf16().collect()),
            Some(Value::Number(number)) => Cell::Number(number.as_f64().unwrap_or(f64::NAN)),
            Some(Value::Bool(flag)) => Cell::Bool(*flag),
            _ => Cell::Null,
        }
    }
    fn query_error(message: String) -> Value { json!({ "_tag": "RemoteQueryError", "message": message }) }

    // ---- Mutations (RM-001): the compiled source runs; the handler shapes its outcome.
    pub fn mutation_error(message: String) -> Value { json!({ "_tag": "RemoteMutationError", "message": message }) }
    /// ` +
  "`handlers.FoldkitRemoteMutate`" +
  String.raw`'s result from the encoded ` +
  "`MutationOutcome`" +
  String.raw`: absent lists
    /// default to empty.
    pub fn mutation_result(mut outcome: Value) -> Value {
        let mut take = |key: &str| outcome.as_object_mut().and_then(|object| object.remove(key));
        let output = take("output").unwrap_or(Value::Null);
        let entities = take("entities").unwrap_or_else(|| json!([]));
        let connections = take("connections").unwrap_or_else(|| json!([]));
        let deleted = take("deleted").unwrap_or_else(|| json!([]));
        json!({ "output": output, "entities": entities, "connections": connections, "deleted": deleted })
    }
    fn boundary(boundary: &Boundary) -> Value {
        match boundary {
            Boundary::Terminal => json!({ "_tag": "Terminal" }),
            Boundary::Unknown => json!({ "_tag": "Unknown" }),
            Boundary::Cursor(cursor) => json!({ "_tag": "Cursor", "cursor": cursor }),
        }
    }
    /// ` +
  "`handlers.FoldkitRemoteQuery`" +
  String.raw` with the memory backend's query sources.
    pub async fn query<S: Source>(server: &S, authorize: Authorize<'_>, payload: &Value) -> Result<Value, Value> {
        let name = payload.get("query").and_then(Value::as_str).unwrap_or_default();
        let input = payload.get("input").unwrap_or(&Value::Null);
        let entity = server.check_query(name, input).map_err(query_error)?;
        let select = payload.get("select").filter(|value| !value.is_null()).map(relation);
        if let Some(select) = &select {
            if let Some(paged) = check_pages_per_relation(std::slice::from_ref(select)) {
                return Err(query_error(format!("Too many pages of \"{}\" in one query select", paged)));
            }
        }
        let window = window(payload.get("window").unwrap_or(&Value::Null));
        let PageIds { ids, start, end } = server.page(name, input, &window).await.map_err(query_error)?;
        let edges: Vec<Value> = ids.iter().map(|id| json!({ "entity": entity, "id": id, "key": format!("{}:{}", entity, id) })).collect();
        let Some(select) = select else { return Ok(json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end) })) };
        let requirements: Vec<Requirement> = ids.iter().filter(|_| select.entity == entity).map(|id| Requirement {
            entity: select.entity.clone(), id: id.clone(), fields: select.fields.clone(),
            windows: select.windows.clone(), relations: select.relations.clone(), renames: None,
        }).collect();
        if requirements.is_empty() {
            return Ok(json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end), "entities": [], "settled": [] }));
        }
        let read = read_helper(server, authorize, requirements).await.map_err(|error| query_error(error.get("message").and_then(Value::as_str).unwrap_or_default().to_string()))?;
        Ok(json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end), "entities": read["entities"], "settled": read["settled"] }))
    }
    impl Memory {
        /// The memory backend's query page: the body by the evaluator, paged by pageOf with locate.
        fn page_now(&self, def: &QueryDef, input: &Value, window: &Window) -> Result<PageIds, String> {
            let state = self.tables();
            let empty = Ordered::new();
            let table = state.tables.get(def.entity).unwrap_or(&empty);
            let rows: Vec<(&String, &Row)> = table.iter().collect();
            let encoded: Vec<Cell> = def.inputs.iter().map(|key| cell(input.get(*key))).collect();
            let cells = {
                let mut cache = def.cells.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                match cache.as_ref() {
                    Some((version, cells)) if *version == state.version => cells.clone(),
                    _ => {
                        let cells: Arc<Vec<Vec<Cell>>> = Arc::new(rows.iter().map(|(_, row)| def.fields.iter().map(|field| cell(row.get(field))).collect()).collect());
                        *cache = Some((state.version, cells.clone()));
                        cells
                    }
                }
            };
            let matched = (def.run)(&encoded, &cells).map_err(|error| error.to_string())?;
            // A cursor row that no longer matches still has a place in the order, as a keyset has it.
            let locate = |cursor: &str| -> Result<Position, String> {
                let Some(found) = rows.iter().position(|(id, _)| id.as_str() == cursor) else {
                    return Err(format!("Cursor \"{}\" names a row that no longer exists", cursor));
                };
                let twin = |index: &usize| -> Vec<Cell> { def.order_fields.iter().map(|field| cell(rows[*index].1.get(field))).collect() };
                let mut subset: Vec<Vec<Cell>> = matched.iter().map(twin).collect();
                subset.push(twin(&found));
                let order_input: Vec<Cell> = def.order_inputs.iter().map(|key| cell(input.get(*key))).collect();
                let placed = (def.order)(&order_input, &subset).map_err(|error| error.to_string())?;
                let index = placed.iter().position(|index| *index == subset.len() - 1).unwrap_or(subset.len() - 1);
                Ok(Position { index, exact: false })
            };
            let id_of = |index: &usize| rows[*index].0.clone();
            let (page, start, end) = page_of(&matched, window, &id_of, Some(&locate))?;
            Ok(PageIds { ids: page.iter().map(|index| rows[*index].0.clone()).collect(), start, end })
        }
    }
    impl Source for Memory {
        fn has_source(&self, entity: &str) -> bool { self.entities.iter().any(|name| name == entity) }
        // The memory backend is synchronous: each answer is ready, and no lock is held across an await.
        fn read(&self, entity: &str, ids: &[String], fields: &[String], windows: &Option<JsObject<Window>>) -> impl std::future::Future<Output = Result<Vec<EntityRecord>, String>> + Send {
            std::future::ready(Ok(self.read_now(entity, ids, fields, windows)))
        }
        fn check_query(&self, query: &str, input: &Value) -> Result<&'static str, String> {
            let Some(def) = self.queries.iter().find(|def| def.name == query) else { return Err(format!("Unknown query: {}", query)) };
            if !(def.valid)(input) { return Err("Invalid query input".to_string()); }
            Ok(def.entity)
        }
        fn page(&self, query: &str, input: &Value, window: &Window) -> impl std::future::Future<Output = Result<PageIds, String>> + Send {
            let result = match self.queries.iter().find(|def| def.name == query) {
                Some(def) => self.page_now(def, input, window),
                None => Err(format!("Unknown query: {}", query)),
            };
            std::future::ready(result)
        }
    }
}
`;
