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
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// A plain JS object: index keys first, ascending, then insertion order; a reassigned key
/// keeps its position (NR-009). Lookups are hashed, so client-sized maps stay linear (#17):
/// index keys live in a sorted map, other keys in insertion slots, and a removed key leaves a
/// hole so that setting it again appends it, as `delete` then assignment does in JS.
#[derive(Clone, Debug)]
pub struct JsObject<T> {
    indexed: std::collections::BTreeMap<u32, (String, T)>,
    named: Vec<Option<(String, T)>>,
    slots: HashMap<String, usize>,
}
impl<T> Default for JsObject<T> {
    fn default() -> Self {
        JsObject {
            indexed: std::collections::BTreeMap::new(),
            named: Vec::new(),
            slots: HashMap::new(),
        }
    }
}
impl<T: Clone> JsObject<T> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn get(&self, key: &str) -> Option<&T> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index).map(|(_, value)| value),
            None => self
                .slots
                .get(key)
                .and_then(|slot| self.named[*slot].as_ref())
                .map(|(_, value)| value),
        }
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        match array_index(key) {
            Some(index) => self.indexed.get_mut(&index).map(|(_, value)| value),
            None => match self.slots.get(key) {
                Some(slot) => self.named[*slot].as_mut().map(|(_, value)| value),
                None => None,
            },
        }
    }
    /// Moves a value out, leaving the key absent.
    pub fn take(&mut self, key: &str) -> Option<T> {
        let taken = match array_index(key) {
            Some(index) => self.indexed.remove(&index).map(|(_, value)| value),
            None => {
                let slot = self.slots.remove(key)?;
                self.named[slot].take().map(|(_, value)| value)
            }
        };
        // Holes are reclaimed once they outnumber the live keys.
        if self.named.len() > 2 * self.slots.len() + 8 {
            self.named.retain(Option::is_some);
            for (slot, entry) in self.named.iter().enumerate() {
                if let Some((key, _)) = entry {
                    self.slots.insert(key.clone(), slot);
                }
            }
        }
        taken
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn len(&self) -> usize {
        self.indexed.len() + self.slots.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, T)> {
        self.indexed.values().chain(self.named.iter().flatten())
    }
    /// The entries in JS key order, by value.
    pub fn into_entries(self) -> impl Iterator<Item = (String, T)> {
        self.indexed
            .into_values()
            .chain(self.named.into_iter().flatten())
    }
    pub fn set(&mut self, key: String, value: T) {
        match array_index(&key) {
            Some(index) => match self.indexed.get_mut(&index) {
                Some(entry) => entry.1 = value,
                None => {
                    self.indexed.insert(index, (key, value));
                }
            },
            None => match self.slots.get(&key) {
                Some(slot) => {
                    if let Some(entry) = self.named[*slot].as_mut() {
                        entry.1 = value;
                    }
                }
                None => {
                    self.slots.insert(key.clone(), self.named.len());
                    self.named.push(Some((key, value)));
                }
            },
        }
    }
    /// `{ ...self, ...other }`.
    pub fn spread(&self, other: &JsObject<T>) -> JsObject<T> {
        let mut out = self.clone();
        for (key, value) in other.iter() {
            out.set(key.clone(), value.clone());
        }
        out
    }
}

/// Insertion-ordered map, as a JS `Map`.
#[derive(Clone, Debug)]
struct Ordered<V> {
    keys: Vec<String>,
    values: HashMap<String, V>,
}
impl<V> Ordered<V> {
    fn new() -> Self {
        Ordered {
            keys: Vec::new(),
            values: HashMap::new(),
        }
    }
    fn get(&self, key: &str) -> Option<&V> {
        self.values.get(key)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.values.get_mut(key)
    }
    fn set(&mut self, key: String, value: V) {
        if !self.values.contains_key(&key) {
            self.keys.push(key.clone());
        }
        self.values.insert(key, value);
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.keys.iter().map(move |key| (key, &self.values[key]))
    }
    /// `Map.prototype.delete`: setting the key again appends it.
    fn remove(&mut self, key: &str) {
        if self.values.remove(key).is_some() {
            self.keys.retain(|existing| existing != key);
        }
    }
    fn into_values(mut self) -> Vec<V> {
        self.keys
            .iter()
            .map(|key| self.values.remove(key).unwrap())
            .collect()
    }
}
/// Insertion-ordered set, as a JS `Set` of strings.
#[derive(Clone, Debug, Default)]
struct OrderedSet {
    items: Vec<String>,
    seen: HashSet<String>,
}
impl OrderedSet {
    fn add(&mut self, item: &str) {
        if self.seen.insert(item.to_string()) {
            self.items.push(item.to_string());
        }
    }
    fn has(&self, item: &str) -> bool {
        self.seen.contains(item)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub first: Option<f64>,
    pub last: Option<f64>,
    pub after: Option<String>,
    pub before: Option<String>,
}
/// A relation's fields in first-seen order, with a set so merging many requests stays linear
/// (#17); it reads as a slice of names.
#[derive(Clone, Debug, Default)]
pub struct FieldList {
    names: Vec<String>,
    seen: HashSet<String>,
}
impl FieldList {
    fn add(&mut self, field: &str) {
        if self.seen.insert(field.to_string()) {
            self.names.push(field.to_string());
        }
    }
}
/// A request's own list is kept as given, duplicates included, as upstream keeps it; only a
/// merge skips names already present.
impl From<Vec<String>> for FieldList {
    fn from(names: Vec<String>) -> Self {
        let seen = names.iter().cloned().collect();
        FieldList { names, seen }
    }
}
impl std::ops::Deref for FieldList {
    type Target = [String];
    fn deref(&self) -> &[String] {
        &self.names
    }
}
#[derive(Clone, Debug)]
pub struct Relation {
    entity: String,
    fields: FieldList,
    windows: Option<JsObject<Window>>,
    relations: Option<JsObject<Relation>>,
}
#[derive(Clone, Debug)]
pub struct Requirement {
    entity: String,
    id: String,
    fields: Vec<String>,
    windows: Option<JsObject<Window>>,
    relations: Option<JsObject<Relation>>,
    /// The alias each field read here is answered under (`splitAliases`).
    renames: Option<JsObject<String>>,
}

// ---- Reading the validated payload (NR-008): absent and null are both undefined.
fn number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => match text.as_str() {
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        },
        _ => f64::NAN,
    }
}
fn present<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}
fn text(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn texts(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in object.iter() {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|entry| entry.0);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}
fn record<T: Clone>(value: Option<&Value>, item: impl Fn(&Value) -> T) -> Option<JsObject<T>> {
    let object = value?.as_object()?;
    let mut out = JsObject::new();
    for (key, entry) in js_entries(object) {
        out.set(key.clone(), item(entry));
    }
    Some(out)
}
fn window(value: &Value) -> Window {
    let empty = Map::new();
    let object = value.as_object().unwrap_or(&empty);
    Window {
        first: present(object, "first").map(number),
        last: present(object, "last").map(number),
        after: present(object, "after")
            .and_then(Value::as_str)
            .map(str::to_string),
        before: present(object, "before")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}
fn relation(value: &Value) -> Relation {
    let empty = Map::new();
    let object = value.as_object().unwrap_or(&empty);
    Relation {
        entity: text(object, "entity"),
        fields: texts(object.get("fields")).into(),
        windows: record(present(object, "windows"), window),
        relations: record(present(object, "relations"), relation),
    }
}
impl Requirement {
    /// The requirement as the relation its pages are counted on.
    fn as_relation(&self) -> Relation {
        Relation {
            entity: self.entity.clone(),
            fields: self.fields.clone().into(),
            windows: self.windows.clone(),
            relations: self.relations.clone(),
        }
    }
}
fn requirement(value: &Value) -> Requirement {
    let empty = Map::new();
    let object = value.as_object().unwrap_or(&empty);
    let relation = relation(value);
    Requirement {
        entity: relation.entity,
        id: text(object, "id"),
        fields: relation.fields.names,
        windows: relation.windows,
        relations: relation.relations,
        renames: None,
    }
}

// ---- stableStringify: an injective canonical text, used only to compare group keys.
fn number_key(x: f64) -> String {
    if x == 0.0 {
        "0".to_string()
    } else {
        format!("{:?}", x)
    }
}
fn stable_windows(windows: &Option<JsObject<Window>>) -> String {
    let Some(windows) = windows else {
        return "null".to_string();
    };
    let mut keys: Vec<&(String, Window)> = windows.iter().collect();
    keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    keys.iter()
        .map(|(key, w)| {
            format!(
                "{}:[{},{},{},{}]",
                serde_json::to_string(key).unwrap(),
                w.after
                    .as_ref()
                    .map(|s| serde_json::to_string(s).unwrap())
                    .unwrap_or_default(),
                w.before
                    .as_ref()
                    .map(|s| serde_json::to_string(s).unwrap())
                    .unwrap_or_default(),
                w.first.map(number_key).unwrap_or_default(),
                w.last.map(number_key).unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}
fn stable_renames(renames: &Option<JsObject<String>>) -> String {
    let Some(renames) = renames else {
        return "{}".to_string();
    };
    let mut keys: Vec<&(String, String)> = renames.iter().collect();
    keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    keys.iter()
        .map(|(key, value)| {
            format!(
                "{}:{}",
                serde_json::to_string(key).unwrap(),
                serde_json::to_string(value).unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

// ---- foldkit-remote helpers.
fn aliased_field(name: &str) -> &str {
    match name.find(RELATION_ALIAS) {
        Some(at) => &name[..at],
        None => name,
    }
}
fn ref_parts(encoded: &str) -> (String, String) {
    match encoded.find(':') {
        Some(at) => (encoded[..at].to_string(), encoded[at + 1..].to_string()),
        None => (encoded.to_string(), String::new()),
    }
}
/// `refsIn`: a ref key, an array of them, or a page of them.
fn refs_in(value: &Value) -> Vec<(String, String)> {
    let strings = |items: &Vec<Value>| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(ref_parts)
            .collect()
    };
    match value {
        Value::String(text) => vec![ref_parts(text)],
        Value::Array(items) => strings(items),
        Value::Object(object) => match object.get("refs") {
            Some(Value::Array(items)) => strings(items),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}
/// `target = mergeRelation(target, next)`, in place: unseen fields appended, windows
/// spread (a reassigned key keeps its position; an empty result is absent), relations merged.
fn merge_into(
    target: &mut Relation,
    fields: &[String],
    windows: &Option<JsObject<Window>>,
    relations: &Option<JsObject<Relation>>,
) {
    for field in fields {
        target.fields.add(field);
    }
    if let Some(windows) = windows {
        let own = target.windows.get_or_insert_with(JsObject::new);
        for (key, window) in windows.iter() {
            own.set(key.clone(), window.clone());
        }
    }
    if target
        .windows
        .as_ref()
        .map(JsObject::is_empty)
        .unwrap_or(false)
    {
        target.windows = None;
    }
    match (&mut target.relations, relations) {
        (_, None) => {}
        (None, Some(next)) => target.relations = Some(next.clone()),
        (Some(own), Some(next)) => {
            for (field, relation) in next.iter() {
                match own.get_mut(field) {
                    Some(existing) => merge_into(
                        existing,
                        &relation.fields,
                        &relation.windows,
                        &relation.relations,
                    ),
                    None => own.set(field.clone(), relation.clone()),
                }
            }
        }
    }
}

// ---- remote-server helpers.
fn pick_names<T: Clone>(record: &Option<JsObject<T>>, names: &[String]) -> JsObject<T> {
    let mut picked = JsObject::new();
    if let Some(record) = record {
        for name in names {
            if let Some(value) = record.get(name) {
                picked.set(name.clone(), value.clone());
            }
        }
    }
    picked
}
struct Building {
    fields: Vec<String>,
    windows: JsObject<Window>,
    relations: JsObject<Relation>,
    renames: JsObject<String>,
}
fn split_aliases(request: &Requirement) -> Vec<Requirement> {
    let aliases: Vec<&String> = request
        .fields
        .iter()
        .filter(|field| field.contains(RELATION_ALIAS))
        .collect();
    if aliases.is_empty() {
        return vec![request.clone()];
    }
    let plain: Vec<String> = request
        .fields
        .iter()
        .filter(|field| !field.contains(RELATION_ALIAS))
        .cloned()
        .collect();
    let mut building = vec![Building {
        fields: plain.clone(),
        windows: pick_names(&request.windows, &plain),
        relations: pick_names(&request.relations, &plain),
        renames: JsObject::new(),
    }];
    for alias in aliases {
        // An alias is a page: one that names no window asks for nothing.
        let Some(window) = request
            .windows
            .as_ref()
            .and_then(|windows| windows.get(alias))
        else {
            continue;
        };
        let field = aliased_field(alias).to_string();
        let index = match building
            .iter()
            .position(|candidate| !candidate.fields.contains(&field))
        {
            Some(index) => index,
            None => {
                building.push(Building {
                    fields: Vec::new(),
                    windows: JsObject::new(),
                    relations: JsObject::new(),
                    renames: JsObject::new(),
                });
                building.len() - 1
            }
        };
        let part = &mut building[index];
        part.fields.push(field.clone());
        part.windows.set(field.clone(), window.clone());
        part.renames.set(field, alias.clone());
        if let Some(relation) = request
            .relations
            .as_ref()
            .and_then(|relations| relations.get(alias))
        {
            part.relations.set(alias.clone(), relation.clone());
        }
    }
    building
        .into_iter()
        .filter(|part| !part.fields.is_empty())
        .map(|part| Requirement {
            entity: request.entity.clone(),
            id: request.id.clone(),
            fields: part.fields,
            windows: if part.windows.is_empty() {
                None
            } else {
                Some(part.windows)
            },
            relations: if part.relations.is_empty() {
                None
            } else {
                Some(part.relations)
            },
            renames: if part.renames.is_empty() {
                None
            } else {
                Some(part.renames)
            },
        })
        .collect()
}
struct EntityGroup {
    ids: Ordered<OrderedSet>,
    slice: Relation,
    renames: JsObject<String>,
}
fn group_by_entity(requests: &[Requirement]) -> Vec<EntityGroup> {
    let mut grouped: Ordered<EntityGroup> = Ordered::new();
    for request in requests.iter().flat_map(split_aliases) {
        let renames = request.renames.clone().unwrap_or_default();
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            request.entity,
            stable_windows(&request.windows),
            stable_renames(&request.renames)
        );
        match grouped.get_mut(&key) {
            None => {
                let mut ids = Ordered::new();
                let mut asked = OrderedSet::default();
                for field in &request.fields {
                    asked.add(field);
                }
                ids.set(request.id.clone(), asked);
                let mut slice = Relation {
                    entity: request.entity.clone(),
                    fields: FieldList::default(),
                    windows: None,
                    relations: None,
                };
                merge_into(
                    &mut slice,
                    &request.fields,
                    &request.windows,
                    &request.relations,
                );
                grouped.set(
                    key,
                    EntityGroup {
                        ids,
                        slice,
                        renames,
                    },
                );
            }
            Some(group) => {
                match group.ids.get_mut(&request.id) {
                    Some(asked) => {
                        for field in &request.fields {
                            asked.add(field);
                        }
                    }
                    None => {
                        let mut asked = OrderedSet::default();
                        for field in &request.fields {
                            asked.add(field);
                        }
                        group.ids.set(request.id.clone(), asked);
                    }
                }
                merge_into(
                    &mut group.slice,
                    &request.fields,
                    &request.windows,
                    &request.relations,
                );
            }
        }
    }
    grouped.into_values()
}
fn windows_of(windows: &Option<JsObject<Window>>, fields: &[String]) -> Option<JsObject<Window>> {
    let windows = windows.as_ref()?;
    let mut kept = JsObject::new();
    for field in fields {
        if let Some(window) = windows.get(field) {
            kept.set(field.clone(), window.clone());
        }
    }
    if kept.is_empty() {
        None
    } else {
        Some(kept)
    }
}
fn check_pages_per_relation(requirements: &[Relation]) -> Option<String> {
    for requirement in requirements {
        let mut pages: HashMap<&str, usize> = HashMap::new();
        for name in requirement.fields.iter() {
            if !name.contains(RELATION_ALIAS) {
                continue;
            }
            let field = aliased_field(name);
            let count = pages.get(field).copied().unwrap_or(0) + 1;
            if count > MAX_PAGES_PER_RELATION {
                return Some(format!("{}.{}", requirement.entity, field));
            }
            pages.insert(field, count);
        }
        let nested: Vec<Relation> = requirement
            .relations
            .as_ref()
            .map(|relations| {
                relations
                    .iter()
                    .map(|(_, relation)| relation.clone())
                    .collect()
            })
            .unwrap_or_default();
        if let Some(found) = check_pages_per_relation(&nested) {
            return Some(found);
        }
    }
    None
}
fn check_ids_per_entity(requirements: &[Requirement]) -> Option<String> {
    let mut ids: HashMap<&str, HashSet<&str>> = HashMap::new();
    for requirement in requirements {
        let seen = ids.entry(requirement.entity.as_str()).or_default();
        seen.insert(requirement.id.as_str());
        if seen.len() > MAX_IDS_PER_ENTITY {
            return Some(requirement.entity.clone());
        }
    }
    None
}

// ---- Sources (NR-011): the memory backend.
pub struct EntityRecord {
    pub id: String,
    pub values: JsObject<Value>,
}
/// One page of a query: its row ids in order and the boundaries the page advertises.
pub struct PageIds {
    pub ids: Vec<String>,
    pub start: Boundary,
    pub end: Boundary,
}
/// A backend serving entity reads and query pages (SQLX-007). The engine owns everything
/// upstream's handlers own: limits, grouping, authorization, settling, relations, select.
pub trait Source: Sync {
    fn has_source(&self, entity: &str) -> bool;
    /// Whether the source declares a field; an undeclared one is withheld, never read.
    fn declares(&self, _entity: &str, _field: &str) -> bool {
        true
    }
    /// A source failure is its RemoteServerError message.
    fn read(
        &self,
        entity: &str,
        ids: &[String],
        fields: &[String],
        windows: &Option<JsObject<Window>>,
    ) -> impl std::future::Future<Output = Result<Vec<EntityRecord>, String>> + Send;
    /// In upstream's order: an unknown query, then input the Input schema refuses. The query's entity.
    fn check_query(&self, query: &str, input: &Value) -> Result<&'static str, String>;
    fn page(
        &self,
        query: &str,
        input: &Value,
        window: &Window,
    ) -> impl std::future::Future<Output = Result<PageIds, String>> + Send;
}
/// A row as the memory backend holds it: a plain object, shared until a write replaces it.
pub type Row = Arc<JsObject<Value>>;
struct Tables {
    /// A counter stamping each write, so a table's stamp changes whenever it does.
    version: u64,
    /// The stamp of each table's last write: a query's cells are rebuilt only when its own table
    /// changed, not on a write to any other (#35).
    versions: HashMap<String, u64>,
    tables: HashMap<String, Ordered<Row>>,
}
impl Tables {
    fn touch(&mut self, entity: &str) {
        self.version += 1;
        let version = self.version;
        self.versions.insert(entity.to_string(), version);
    }
    fn version_of(&self, entity: &str) -> u64 {
        self.versions.get(entity).copied().unwrap_or(0)
    }
}
/// The memory backend's `MemoryStore` (RS-003..006): one server-lifetime store behind a lock,
/// taken once per operation. A write stamps its table, which invalidates that table's query caches.
pub struct Memory {
    entities: Vec<String>,
    state: RwLock<Tables>,
    queries: &'static [QueryDef],
}
impl Memory {
    /// `rows`: entity -> [[String(id), row]] in table order, as the memory backend keys them.
    pub fn new(entities: Vec<String>, rows: &Value, queries: &'static [QueryDef]) -> Memory {
        let mut tables = HashMap::new();
        if let Some(object) = rows.as_object() {
            for (entity, table) in object.iter() {
                let mut ordered = Ordered::new();
                for entry in table.as_array().into_iter().flatten() {
                    if let (Some(id), Some(row)) = (
                        entry.get(0).and_then(Value::as_str),
                        entry.get(1).and_then(Value::as_object),
                    ) {
                        let mut copy = JsObject::new();
                        for (key, value) in row.iter() {
                            copy.set(key.clone(), value.clone());
                        }
                        ordered.set(id.to_string(), Arc::new(copy));
                    }
                }
                tables.insert(entity.clone(), ordered);
            }
        }
        Memory {
            entities,
            state: RwLock::new(Tables {
                version: 0,
                versions: HashMap::new(),
                tables,
            }),
            queries,
        }
    }
    fn tables(&self) -> std::sync::RwLockReadGuard<'_, Tables> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn tables_mut(&self) -> std::sync::RwLockWriteGuard<'_, Tables> {
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn read_now(
        &self,
        entity: &str,
        ids: &[String],
        fields: &[String],
        windows: &Option<JsObject<Window>>,
    ) -> Vec<EntityRecord> {
        let state = self.tables();
        let Some(table) = state.tables.get(entity) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|id| {
                let row = table.get(id)?;
                let mut values = JsObject::new();
                for field in fields {
                    if let Some(value) = row.get(field) {
                        let window = windows.as_ref().and_then(|windows| windows.get(field));
                        values.set(field.clone(), value_for(value, window));
                    }
                }
                Some(EntityRecord {
                    id: id.clone(),
                    values,
                })
            })
            .collect()
    }
    /// The row `rows(entity)` holds under `id`, if any.
    #[allow(dead_code)]
    pub fn get(&self, entity: &str, id: &str) -> Option<Row> {
        self.tables().tables.get(entity)?.get(id).cloned()
    }
    /// `write(entity, id, values)`: the row becomes `{ ...existing, id, ...values }`; a new row
    /// goes last. `values` are in JS own-property order.
    #[allow(dead_code)]
    pub fn write(&self, entity: &str, id: &str, values: Vec<(String, Value)>) {
        let mut state = self.tables_mut();
        state.touch(entity);
        let table = state
            .tables
            .entry(entity.to_string())
            .or_insert_with(Ordered::new);
        let mut row = table
            .get(id)
            .map(|row| JsObject::clone(row))
            .unwrap_or_default();
        row.set("id".to_string(), Value::String(id.to_string()));
        for (key, value) in values {
            row.set(key, value);
        }
        table.set(id.to_string(), Arc::new(row));
    }
    /// `remove(entity, id)`; removing an absent row changes nothing.
    #[allow(dead_code)]
    pub fn remove(&self, entity: &str, id: &str) {
        let mut state = self.tables_mut();
        state.touch(entity);
        if let Some(table) = state.tables.get_mut(entity) {
            table.remove(id);
        }
    }
}
#[derive(Clone)]
pub enum Boundary {
    Terminal,
    Unknown,
    Cursor(String),
}
/// `pageOf` without `locate`; `Err` where the reference throws.
pub struct Position {
    index: usize,
    exact: bool,
}
/// Finds a cursor's position in the ordered items.
type Locate<'a> = &'a dyn Fn(&str) -> Result<Position, String>;
/// A window's items and its start and end boundaries.
type PageOf<T> = (Vec<T>, Boundary, Boundary);
fn page_of<T: Clone>(
    items: &[T],
    window: &Window,
    id_of: &dyn Fn(&T) -> String,
    locate: Option<Locate>,
) -> Result<PageOf<T>, String> {
    if (window.after.is_some() && window.before.is_some())
        || (window.first.is_some() && window.last.is_some())
    {
        return Err(
            "A query window cannot combine after with before, or first with last".to_string(),
        );
    }
    let position = |cursor: &str| -> Result<Position, String> {
        if let Some(index) = items.iter().position(|item| id_of(item) == cursor) {
            return Ok(Position { index, exact: true });
        }
        match locate {
            Some(locate) => locate(cursor),
            None => Err(format!(
                "Cursor \"{}\" names nothing in these results",
                cursor
            )),
        }
    };
    let cursor = |id: String| Boundary::Cursor(id);
    let length = items.len();
    if window.last.is_some() || window.before.is_some() {
        let to = match &window.before {
            None => length,
            Some(before) => position(before)?.index.min(length),
        };
        let from = match window.last {
            None => 0,
            Some(last) => {
                let start = to as f64 - last;
                if start > 0.0 {
                    start as usize
                } else {
                    0
                }
            }
        };
        let page: Vec<T> = items[from.min(to)..to].to_vec();
        let start = if from == 0 {
            Boundary::Terminal
        } else if let Some(first) = page.first() {
            cursor(id_of(first))
        } else if let Some(before) = &window.before {
            cursor(before.clone())
        } else {
            Boundary::Unknown
        };
        let end = match &window.before {
            None => Boundary::Terminal,
            Some(before) => cursor(before.clone()),
        };
        return Ok((page, start, end));
    }
    let from = match &window.after {
        None => 0,
        Some(after) => {
            let at = position(after)?;
            (if at.exact { at.index + 1 } else { at.index }).min(length)
        }
    };
    let to = match window.first {
        None => length,
        Some(first) => {
            let limit = from as f64 + first;
            if limit < length as f64 {
                limit as usize
            } else {
                length
            }
        }
    };
    let page: Vec<T> = items[from.min(to)..to].to_vec();
    let end = if to >= length {
        Boundary::Terminal
    } else if let Some(last) = page.last() {
        cursor(id_of(last))
    } else if let Some(after) = &window.after {
        cursor(after.clone())
    } else {
        Boundary::Unknown
    };
    let start = match &window.after {
        None => Boundary::Terminal,
        Some(after) => cursor(after.clone()),
    };
    Ok((page, start, end))
}
/// SameValueZero on JSON primitives: numbers by value, so 0 and -0 are one.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => a == b,
    }
}
/// The memory backend's `valueFor`: a relation page is the refs in a window of the stored list.
fn value_for(value: &Value, window: Option<&Window>) -> Value {
    let (Some(window), Some(items)) = (window, value.as_array()) else {
        return value.clone();
    };
    let empty = json!({ "refs": [], "hasNext": false, "hasPrevious": false });
    // `[...new Set(value)]`: equal primitives once, each array or object its own item.
    let mut seen: Vec<&Value> = Vec::new();
    let refs: Vec<Value> = items
        .iter()
        .filter(|item| {
            if item.is_array() || item.is_object() {
                return true;
            }
            let repeated = seen.iter().any(|old| same_value_zero(old, item));
            seen.push(item);
            !repeated
        })
        .cloned()
        .collect();
    let id_of = |reference: &str| -> String {
        match reference.find(':') {
            Some(at) => reference[at + 1..].to_string(),
            None => reference.to_string(),
        }
    };
    let named = |cursor: &Option<String>| {
        cursor.as_ref().map(|cursor| {
            if cursor.contains(':') {
                id_of(cursor)
            } else {
                cursor.clone()
            }
        })
    };
    let window = Window {
        first: window.first,
        last: window.last,
        after: named(&window.after),
        before: named(&window.before),
    };
    // `ref.slice` throws on a non-string only where the reference's idOf reaches one: a cursor
    // search passing it, or a page bounded by it. The throw answers with an empty page (#26).
    let reached_non_string = std::cell::Cell::new(false);
    let id_of_ref = |reference: &Value| match reference.as_str() {
        Some(reference) => id_of(reference),
        None => {
            reached_non_string.set(true);
            String::new()
        }
    };
    match page_of(&refs, &window, &id_of_ref, None) {
        Err(_) => empty,
        Ok(_) if reached_non_string.get() => empty,
        Ok((page, start, end)) => json!({
            "refs": page,
            "hasNext": matches!(end, Boundary::Cursor(_)),
            "hasPrevious": matches!(start, Boundary::Cursor(_)),
        }),
    }
}

fn read_error(message: String) -> Value {
    json!({ "_tag": "RemoteReadError", "message": message })
}
fn into_object(object: JsObject<Value>) -> Value {
    let mut map = Map::new();
    for (key, value) in object.into_entries() {
        map.insert(key, value);
    }
    Value::Object(map)
}
/// An `EntityPatched` payload: the record's values for `fields`, each as `(field, name told)`,
/// with the names in order; nothing when none of them is present. Live events and snapshots
/// both tell a row this way.
fn patched<'a>(
    record: &EntityRecord,
    fields: impl Iterator<Item = (&'a String, String)>,
) -> Option<(Value, Vec<String>)> {
    let mut values: JsObject<Value> = JsObject::new();
    for (field, name) in fields {
        if let Some(value) = record.values.get(field) {
            values.set(name, value.clone());
        }
    }
    if values.is_empty() {
        return None;
    }
    let changed: Vec<String> = values.iter().map(|(key, _)| key.clone()).collect();
    Some((into_object(values), changed))
}
/// `check_query` for any registry of `(name, entity, valid)` queries: the query's entity, or why
/// it cannot run. Every backend answers an unknown query and invalid input the same way.
pub fn checked_query<'a>(
    queries: impl IntoIterator<Item = (&'a str, &'static str, fn(&Value) -> bool)>,
    query: &str,
    input: &Value,
) -> Result<&'static str, String> {
    let Some((_, entity, valid)) = queries.into_iter().find(|(name, _, _)| *name == query) else {
        return Err(format!("Unknown query: {}", query));
    };
    if !valid(input) {
        return Err("Invalid query input".to_string());
    }
    Ok(entity)
}

/// `readHelper`.
/// An entity source's `authorize` for the bound principal: declared fields in, permitted fields out.
pub type Authorize<'a> = &'a (dyn Fn(&str, &[String]) -> Vec<String> + Sync);
/// `allowedFields`: requested fields `authorize` permits, in request order; it can only remove.
fn allowed_fields<S: Source>(
    server: &S,
    authorize: Authorize,
    entity: &str,
    requested: &[String],
) -> Vec<String> {
    let declared: Vec<String> = requested
        .iter()
        .filter(|field| server.declares(entity, field))
        .cloned()
        .collect();
    if declared.is_empty() {
        return Vec::new();
    }
    let permitted: HashSet<String> = authorize(entity, &declared).into_iter().collect();
    declared
        .into_iter()
        .filter(|field| permitted.contains(field))
        .collect()
}
async fn read_helper<S: Source>(
    server: &S,
    authorize: Authorize<'_>,
    requests: Vec<Requirement>,
) -> Result<Value, Value> {
    let mut entities: Vec<Value> = Vec::new();
    let mut settled: Ordered<(String, String, OrderedSet)> = Ordered::new();
    let mut fetched: HashMap<String, HashSet<String>> = HashMap::new();
    let mut fetched_values: HashMap<String, JsObject<Value>> = HashMap::new();
    if let Some(over) = check_ids_per_entity(&requests) {
        return Err(read_error(format!(
            "Too many \"{}\" ids in one read batch",
            over
        )));
    }
    let relations: Vec<Relation> = requests.iter().map(Requirement::as_relation).collect();
    if let Some(paged) = check_pages_per_relation(&relations) {
        return Err(read_error(format!(
            "Too many pages of \"{}\" in one read",
            paged
        )));
    }
    let mut pending = requests;
    let mut depth = 0;
    while !pending.is_empty() {
        if depth > MAX_DEPTH {
            return Err(read_error(format!(
                "Nested selection deeper than {} relation levels",
                MAX_DEPTH
            )));
        }
        let mut next: Vec<Requirement> = Vec::new();
        for group in group_by_entity(&pending) {
            let name = group.slice.entity.clone();
            if !server.has_source(&name) {
                continue;
            }
            let allowed: Vec<String> =
                allowed_fields(server, authorize, &name, &group.slice.fields);
            let allowed_set: HashSet<&String> = allowed.iter().collect();
            let rename = |field: &String| -> String {
                group
                    .renames
                    .get(field)
                    .cloned()
                    .unwrap_or_else(|| field.clone())
            };
            let id_list: Vec<String> = group.ids.keys.clone();
            for (id, asked) in group.ids.iter() {
                let refused: Vec<String> = asked
                    .items
                    .iter()
                    .filter(|field| !allowed_set.contains(field))
                    .map(&rename)
                    .collect();
                settle(&mut settled, &name, id, &refused);
            }
            if allowed.is_empty() {
                continue;
            }
            let windows = windows_of(&group.slice.windows, &allowed);
            let mut records = Vec::new();
            for chunk in id_list.chunks(MAX_IDS_PER_ENTITY) {
                records.extend(
                    server
                        .read(&name, chunk, &allowed, &windows)
                        .await
                        .map_err(read_error)?,
                );
            }
            for mut record in records {
                let mut values: JsObject<Value> = JsObject::new();
                let mut omitted = Vec::new();
                let asked = group.ids.get(&record.id);
                for field in &allowed {
                    if let Some(value) = record.values.take(field) {
                        values.set(rename(field), value);
                    } else if asked.map(|asked| asked.has(field)).unwrap_or(false) {
                        omitted.push(rename(field));
                    }
                }
                settle(&mut settled, &name, &record.id, &omitted);
                let key = format!("{}:{}", name, record.id);
                let known = fetched.entry(key.clone()).or_default();
                for field in &allowed {
                    known.insert(rename(field));
                }
                match fetched_values.get_mut(&key) {
                    Some(old) => {
                        for (field, value) in values.iter() {
                            old.set(field.clone(), value.clone());
                        }
                    }
                    None => {
                        fetched_values.insert(key, values.clone());
                    }
                }
                let empty = JsObject::new();
                follow(
                    &values,
                    group.slice.relations.as_ref().unwrap_or(&empty),
                    &fetched,
                    &fetched_values,
                    &mut next,
                );
                // Pushed last: following only extends the next level, so the order of entities is unchanged.
                entities.push(
                    json!({ "entity": name, "id": record.id, "values": into_object(values) }),
                );
            }
        }
        pending = next
            .into_iter()
            .filter_map(|mut request| {
                let read = fetched.get(&format!("{}:{}", request.entity, request.id));
                request
                    .fields
                    .retain(|field| read.map(|read| !read.contains(field)).unwrap_or(true));
                if request.fields.is_empty() {
                    None
                } else {
                    Some(request)
                }
            })
            .collect();
        depth += 1;
    }
    Ok(json!({
        "entities": entities,
        "settled": settled.into_values().into_iter().map(|(entity, id, fields)| json!({ "entity": entity, "id": id, "fields": fields.items })).collect::<Vec<_>>(),
    }))
}
fn settle(
    settled: &mut Ordered<(String, String, OrderedSet)>,
    entity: &str,
    id: &str,
    fields: &[String],
) {
    if fields.is_empty() {
        return;
    }
    let key = format!("{}:{}", entity, id);
    if settled.get(&key).is_none() {
        settled.set(
            key.clone(),
            (entity.to_string(), id.to_string(), OrderedSet::default()),
        );
    }
    let entry = settled.get_mut(&key).unwrap();
    for field in fields {
        entry.2.add(field);
    }
}
fn follow(
    values: &JsObject<Value>,
    relations: &JsObject<Relation>,
    fetched: &HashMap<String, HashSet<String>>,
    fetched_values: &HashMap<String, JsObject<Value>>,
    next: &mut Vec<Requirement>,
) {
    for (field, relation) in relations.iter() {
        let Some(value) = values.get(field) else {
            continue;
        };
        for (entity, id) in refs_in(value) {
            if entity != relation.entity {
                continue;
            }
            let key = format!("{}:{}", relation.entity, id);
            let read = fetched.get(&key);
            let fields: Vec<String> = relation
                .fields
                .iter()
                .filter(|name| read.map(|read| !read.contains(*name)).unwrap_or(true))
                .cloned()
                .collect();
            if !fields.is_empty() {
                next.push(Requirement {
                    entity: relation.entity.clone(),
                    id,
                    fields,
                    windows: relation.windows.clone(),
                    relations: relation.relations.clone(),
                    renames: None,
                });
            } else if let Some(nested) = &relation.relations {
                let empty = JsObject::new();
                follow(
                    fetched_values.get(&key).unwrap_or(&empty),
                    nested,
                    fetched,
                    fetched_values,
                    next,
                );
            }
        }
    }
}

/// The `FoldkitRemoteRead` handler over a validated payload: protocol check, then `readHelper`.
pub async fn read<S: Source>(
    server: &S,
    authorize: Authorize<'_>,
    payload: &Value,
) -> Result<Value, Value> {
    if let Some(mismatch) = protocol_mismatch(payload) {
        return Err(mismatch);
    }
    let requests: Vec<Requirement> = payload
        .get("requests")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(requirement).collect())
        .unwrap_or_default();
    read_helper(server, authorize, requests).await
}
// ---- Live (LIVE-002): a port of liveHub. Subscribers keep upstream's Set order.
/// A JS number as the wire's JSON codec writes it: integers plainly, non-finite as text.
fn js_number(x: f64) -> Value {
    if x.is_nan() {
        json!("NaN")
    } else if x.is_infinite() {
        json!(if x > 0.0 { "Infinity" } else { "-Infinity" })
    } else if x == x.trunc() && x.abs() < 9007199254740992.0 {
        json!(x as i64)
    } else {
        json!(x)
    }
}
fn protocol_mismatch(payload: &Value) -> Option<Value> {
    let received = payload.get("version").map(number).unwrap_or(f64::NAN);
    if received == PROTOCOL_VERSION {
        return None;
    }
    let mut buffer = ryu_js::Buffer::new();
    let printed = buffer.format(received).to_string();
    Some(
        json!({ "_tag": "RemoteProtocolError", "message": format!("Remote protocol version {} is not 4", printed), "expected": 4, "received": js_number(received) }),
    )
}
struct Selected {
    fields: OrderedSet,
    windows: JsObject<Window>,
}
struct Subscriber {
    id: u64,
    selected: Ordered<Selected>,
    principal: Option<u64>,
    queue: tokio::sync::mpsc::Sender<Value>,
    cursor: Mutex<f64>,
    /// While a snapshot runs (LIVE-015), what ordinary events already told this subscriber, per
    /// row: the fields patched, or `None` once deleted. The snapshot leaves those out, so its
    /// older read cannot overwrite a newer event (#8).
    pending: Mutex<Option<HashMap<String, Option<HashSet<String>>>>>,
}
/// Bounds on the hub (#19; upstream's liveHub has none). A subscriber that stops reading loses
/// events past `queue`; their cursors are still numbered, so its next event shows a gap and the
/// client resyncs (LIVE-007). `per_principal` bounds each authenticated principal only.
#[derive(Clone, Copy, Debug)]
pub struct LiveLimits {
    pub queue: usize,
    pub subscriptions: usize,
    pub per_principal: usize,
}
impl Default for LiveLimits {
    fn default() -> Self {
        LiveLimits {
            queue: 1024,
            subscriptions: 10_000,
            per_principal: 64,
        }
    }
}
/// The hub's subscribers; `changed` and `deleted` are signalled by mutations (LIVE-001).
#[derive(Default)]
pub struct Hub {
    next: std::sync::atomic::AtomicU64,
    subscribers: Mutex<Vec<Arc<Subscriber>>>,
    limits: LiveLimits,
}
/// One live stream: its events, and a guard that unsubscribes when dropped (`Stream.ensuring`).
pub struct Subscription {
    pub events: tokio::sync::mpsc::Receiver<Value>,
    pub guard: Unsubscribe,
}
pub struct Unsubscribe {
    hub: Option<&'static Hub>,
    id: u64,
}
impl Drop for Unsubscribe {
    fn drop(&mut self) {
        if let Some(hub) = self.hub {
            let mut subscribers = hub.lock();
            subscribers.retain(|subscriber| subscriber.id != self.id);
            trace("unsubscribed", Some(subscribers.len()));
        }
    }
}
/// With REFFECT_LIVE_TRACE set, each subscribe and unsubscribe writes a stderr record with
/// the hub's subscriber count, so tests and operators can see subscriptions end (LR-2).
fn trace(event: &str, subscribers: Option<usize>) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ENABLED.get_or_init(|| std::env::var_os("REFFECT_LIVE_TRACE").is_some()) {
        let record = match subscribers {
            Some(subscribers) => {
                json!({ "schema": "reffect.live@1", "event": event, "subscribers": subscribers })
            }
            None => json!({ "schema": "reffect.live@1", "event": event }),
        };
        eprintln!("{}", record);
    }
}
fn live_error(message: String) -> Value {
    json!({ "_tag": "RemoteLiveError", "message": message })
}
/// The live stream without a hub: upstream merges no streams, so it ends at once.
pub fn no_live(payload: &Value) -> Result<Subscription, Value> {
    if let Some(mismatch) = protocol_mismatch(payload) {
        return Err(mismatch);
    }
    let (_, events) = tokio::sync::mpsc::channel(1);
    Ok(Subscription {
        events,
        guard: Unsubscribe { hub: None, id: 0 },
    })
}
impl Hub {
    pub fn with_limits(limits: LiveLimits) -> Hub {
        Hub {
            limits,
            ..Hub::default()
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Arc<Subscriber>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    /// `handlers.FoldkitRemoteLive` with only the hub: protocol check, limits, then a subscriber.
    pub fn subscribe(
        &'static self,
        payload: &Value,
        principal: Option<u64>,
    ) -> Result<Subscription, Value> {
        if let Some(mismatch) = protocol_mismatch(payload) {
            return Err(mismatch);
        }
        let requirements: Vec<Requirement> = payload
            .get("requirements")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(requirement).collect())
            .unwrap_or_default();
        if let Some(over) = check_ids_per_entity(&requirements) {
            return Err(live_error(format!(
                "Too many \"{}\" ids in one live subscription",
                over
            )));
        }
        let relations: Vec<Relation> = requirements.iter().map(Requirement::as_relation).collect();
        if let Some(paged) = check_pages_per_relation(&relations) {
            return Err(live_error(format!(
                "Too many pages of \"{}\" in one live subscription",
                paged
            )));
        }
        let mut selected: Ordered<Selected> = Ordered::new();
        for requirement in &requirements {
            // Source names hold no colon (refused when authored), so such an entity names no
            // source; keyed, it would collide with a real row ("A:1" + "x" is "A" + "1:x") (#26).
            if requirement.entity.contains(':') {
                continue;
            }
            let key = format!("{}:{}", requirement.entity, requirement.id);
            if selected.get(&key).is_none() {
                selected.set(
                    key.clone(),
                    Selected {
                        fields: OrderedSet::default(),
                        windows: JsObject::new(),
                    },
                );
            }
            let entry = selected.get_mut(&key).unwrap();
            for field in &requirement.fields {
                entry.fields.add(field);
            }
            if let Some(windows) = &requirement.windows {
                for (field, window) in windows.iter() {
                    entry.windows.set(field.clone(), window.clone());
                }
            }
        }
        let after = payload.get("after").map(number).unwrap_or(f64::NAN);
        let (queue, events) = tokio::sync::mpsc::channel(self.limits.queue.max(1));
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut subscribers = self.lock();
        if subscribers.len() >= self.limits.subscriptions {
            return Err(live_error("Too many live subscriptions".to_string()));
        }
        if principal.is_some()
            && subscribers
                .iter()
                .filter(|subscriber| subscriber.principal == principal)
                .count()
                >= self.limits.per_principal
        {
            return Err(live_error(
                "Too many live subscriptions for this principal".to_string(),
            ));
        }
        subscribers.push(Arc::new(Subscriber {
            id,
            selected,
            principal,
            queue,
            cursor: Mutex::new(after),
            pending: Mutex::new(None),
        }));
        trace("subscribed", Some(subscribers.len()));
        drop(subscribers);
        Ok(Subscription {
            events,
            guard: Unsubscribe {
                hub: Some(self),
                id,
            },
        })
    }
    /// Consumes a cursor number without an event, which the client classifies as a gap.
    fn skip(subscriber: &Subscriber) {
        *subscriber
            .cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) += 1.0;
    }
    /// Numbers the change on the subscriber's own cursor; a closed stream drops it.
    /// An ordinary event: recorded for a running snapshot, then numbered and sent, under the
    /// pending lock so the snapshot sees it either entirely before or entirely after (#8).
    fn emit(
        subscriber: &Subscriber,
        tag: &str,
        entity: &str,
        id: &str,
        rest: Option<(Value, Vec<String>)>,
    ) {
        let mut pending = subscriber
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(told) = pending.as_mut() {
            let key = format!("{}:{}", entity, id);
            match &rest {
                None => {
                    told.insert(key, None);
                }
                // A row already deleted stays deleted; otherwise its patched fields add up.
                Some((_, changed)) => {
                    if let Some(fields) = told.entry(key).or_insert_with(|| Some(HashSet::new())) {
                        fields.extend(changed.iter().cloned());
                    }
                }
            }
        }
        Hub::send(subscriber, tag, entity, id, rest);
    }
    fn send(
        subscriber: &Subscriber,
        tag: &str,
        entity: &str,
        id: &str,
        rest: Option<(Value, Vec<String>)>,
    ) {
        let mut cursor = subscriber
            .cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cursor += 1.0;
        // LiveChange's schema order: _tag, cursor, entity, id, then values and changed.
        let mut change = Map::new();
        change.insert("_tag".to_string(), json!(tag));
        change.insert("cursor".to_string(), js_number(*cursor));
        change.insert("entity".to_string(), json!(entity));
        change.insert("id".to_string(), json!(id));
        if let Some((values, changed)) = rest {
            change.insert("values".to_string(), values);
            change.insert("changed".to_string(), json!(changed));
        }
        // A full queue drops the event after its cursor was numbered: the client's next event
        // shows the gap (#19). A closed one belongs to a stream that already ended.
        if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) =
            subscriber.queue.try_send(Value::Object(change))
        {
            trace("overflow", None);
        }
    }
    /// `hub.changed(ref, fields)`: each subscriber selecting the row gets the fields it
    /// selected, re-read once per principal and window group, authorized under that principal.
    pub async fn changed<S: Source>(
        &self,
        server: &S,
        authorize: fn(Option<u64>, &str, &[String]) -> Vec<String>,
        entity: &str,
        id: &str,
        fields: &[String],
    ) {
        if !server.has_source(entity) {
            return;
        }
        struct Group {
            windows: JsObject<Window>,
            renames: JsObject<String>,
            entries: Vec<(Arc<Subscriber>, Vec<String>)>,
        }
        let key = format!("{}:{}", entity, id);
        let subscribers: Vec<Arc<Subscriber>> = self.lock().clone();
        let mut groups: Vec<(Option<u64>, Ordered<Group>)> = Vec::new();
        for subscriber in subscribers {
            let Some(selected) = subscriber.selected.get(&key) else {
                continue;
            };
            let at = match groups
                .iter()
                .position(|(principal, _)| *principal == subscriber.principal)
            {
                Some(at) => at,
                None => {
                    groups.push((subscriber.principal, Ordered::new()));
                    groups.len() - 1
                }
            };
            let by_windows = &mut groups[at].1;
            let mut join =
                |windows: JsObject<Window>, renames: JsObject<String>, wanted: Vec<String>| {
                    let group_key = format!(
                        "{}\u{0}{}",
                        stable_windows(&Some(windows.clone())),
                        stable_renames(&Some(renames.clone()))
                    );
                    if by_windows.get(&group_key).is_none() {
                        by_windows.set(
                            group_key.clone(),
                            Group {
                                windows,
                                renames,
                                entries: Vec::new(),
                            },
                        );
                    }
                    by_windows
                        .get_mut(&group_key)
                        .unwrap()
                        .entries
                        .push((subscriber.clone(), wanted));
                };
            let wanted: Vec<String> = fields
                .iter()
                .filter(|field| selected.fields.has(field))
                .cloned()
                .collect();
            if !wanted.is_empty() {
                let mut windows = JsObject::new();
                for field in &wanted {
                    if let Some(window) = selected.windows.get(field) {
                        windows.set(field.clone(), window.clone());
                    }
                }
                join(windows, JsObject::new(), wanted);
            }
            for alias in &selected.fields.items {
                let field = aliased_field(alias);
                let Some(window) = selected.windows.get(alias) else {
                    continue;
                };
                if field == alias || !fields.iter().any(|changed| changed == field) {
                    continue;
                }
                let mut windows = JsObject::new();
                windows.set(field.to_string(), window.clone());
                let mut renames = JsObject::new();
                renames.set(field.to_string(), alias.clone());
                join(windows, renames, vec![field.to_string()]);
            }
        }
        for (principal, by_windows) in groups {
            for group in by_windows.into_values() {
                let mut requested = OrderedSet::default();
                for (_, wanted) in &group.entries {
                    for field in wanted {
                        requested.add(field);
                    }
                }
                let permit =
                    move |entity: &str, fields: &[String]| authorize(principal, entity, fields);
                let allowed = allowed_fields(server, &permit, entity, &requested.items);
                if allowed.is_empty() {
                    continue;
                }
                let allowed_set: HashSet<&String> = allowed.iter().collect();
                let windows = windows_of(&Some(group.windows.clone()), &allowed);
                // A failed re-read must not undo a committed mutation or stop its other signals.
                // Skipping the cursor lets Foldkit's classifyLive see a gap and resync (LIVE-007).
                let records = match server
                    .read(entity, &[id.to_string()], &allowed, &windows)
                    .await
                {
                    Ok(records) => records,
                    Err(message) => {
                        eprintln!(
                            "{}",
                            json!({ "schema": "reffect.live@1", "event": "reread-failed", "entity": entity, "id": id, "message": message })
                        );
                        for (subscriber, _) in &group.entries {
                            Hub::skip(subscriber);
                        }
                        continue;
                    }
                };
                let Some(record) = records.into_iter().find(|record| record.id == id) else {
                    continue;
                };
                for (subscriber, wanted) in &group.entries {
                    let fields = wanted
                        .iter()
                        .filter(|field| allowed_set.contains(field))
                        .map(|field| {
                            let name = group.renames.get(field).cloned();
                            (field, name.unwrap_or_else(|| field.clone()))
                        });
                    if let Some(patch) = patched(&record, fields) {
                        Hub::emit(subscriber, "EntityPatched", entity, id, Some(patch));
                    }
                }
            }
        }
    }
    /// Opt-in, not upstream (LIVE-015): a fresh subscription (`after` 0) is told each selected
    /// row's current plain fields, re-read under its principal after it is registered, or that
    /// the row is gone. A change committed between a server render and the browser's subscription
    /// is then delivered; any change after registration arrives as an ordinary event. A failed
    /// re-read skips a cursor so the client sees a gap (LIVE-007).
    pub async fn snapshot<S: Source>(
        &self,
        subscription: &Subscription,
        server: &S,
        authorize: fn(Option<u64>, &str, &[String]) -> Vec<String>,
    ) {
        let Some(subscriber) = self
            .lock()
            .iter()
            .find(|subscriber| subscriber.id == subscription.guard.id)
            .cloned()
        else {
            return;
        };
        if *subscriber
            .cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            != 0.0
        {
            return;
        }
        *subscriber
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(HashMap::new());
        let principal = subscriber.principal;
        let permit = move |entity: &str, fields: &[String]| authorize(principal, entity, fields);
        // Rows that read the same fields of one entity are read together (#10).
        struct Group<'a> {
            entity: &'a str,
            fields: Vec<String>,
            ids: Vec<String>,
            records: Result<HashMap<String, EntityRecord>, String>,
        }
        let mut groups: Vec<Group> = Vec::new();
        let mut rows: Vec<(&str, &str, usize)> = Vec::new();
        for (key, selected) in subscriber.selected.iter() {
            // Entity names hold no colon, so the first one ends the entity.
            let Some((entity, id)) = key.split_once(':') else {
                continue;
            };
            if !server.has_source(entity) {
                continue;
            }
            // Plain fields only: an aliased or windowed field is a relation page, not a value.
            let plain: Vec<String> = selected
                .fields
                .items
                .iter()
                .filter(|field| {
                    aliased_field(field) == field.as_str() && selected.windows.get(field).is_none()
                })
                .cloned()
                .collect();
            let allowed = allowed_fields(server, &permit, entity, &plain);
            if allowed.is_empty() {
                continue;
            }
            let group = match groups
                .iter()
                .position(|group| group.entity == entity && group.fields == allowed)
            {
                Some(group) => group,
                None => {
                    groups.push(Group {
                        entity,
                        fields: allowed,
                        ids: Vec::new(),
                        records: Ok(HashMap::new()),
                    });
                    groups.len() - 1
                }
            };
            groups[group].ids.push(id.to_string());
            rows.push((entity, id, group));
        }
        for group in &mut groups {
            group.records = server
                .read(group.entity, &group.ids, &group.fields, &None)
                .await
                .map(|records| {
                    records
                        .into_iter()
                        .map(|record| (record.id.clone(), record))
                        .collect()
                });
        }
        // Rows are told in selection order, under the pending lock: what an ordinary event
        // already told since registration is left out.
        let mut pending = subscriber
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let told = pending.take().unwrap_or_default();
        for (entity, id, group) in rows {
            let group = &groups[group];
            let key = format!("{}:{}", entity, id);
            let already = told.get(&key);
            if let Some(None) = already {
                continue;
            }
            let records = match &group.records {
                Ok(records) => records,
                Err(message) => {
                    eprintln!(
                        "{}",
                        json!({ "schema": "reffect.live@1", "event": "snapshot-failed", "entity": entity, "id": id, "message": message })
                    );
                    Hub::skip(&subscriber);
                    continue;
                }
            };
            match records.get(id) {
                Some(record) => {
                    let fields = group
                        .fields
                        .iter()
                        .filter(
                            |field| !matches!(already, Some(Some(told)) if told.contains(*field)),
                        )
                        .map(|field| (field, field.clone()));
                    if let Some(patch) = patched(record, fields) {
                        Hub::send(&subscriber, "EntityPatched", entity, id, Some(patch));
                    }
                }
                None => Hub::send(&subscriber, "EntityDeleted", entity, id, None),
            }
        }
    }
    /// `hub.deleted(ref)`: every subscriber selecting the row, without a re-read.
    pub fn deleted(&self, entity: &str, id: &str) {
        let key = format!("{}:{}", entity, id);
        let subscribers: Vec<Arc<Subscriber>> = self.lock().clone();
        for subscriber in subscribers {
            if subscriber.selected.get(&key).is_some() {
                Hub::emit(&subscriber, "EntityDeleted", entity, id, None);
            }
        }
    }
}

// ---- Query (NR-014..017): a domain query's body, run by the milestone-1 evaluator.
use super::foldkit_eval::Value as Cell;
/// A compiled query body over input cells and row cells: the matching row indexes, in order.
pub type Evaluator = fn(&[Cell], &[Vec<Cell>]) -> Result<Vec<usize>, &'static str>;
/// A table's evaluator cells and that table's version when they were built.
pub type CellCache = Mutex<Option<(u64, Arc<Vec<Vec<Cell>>>)>>;
/// One registered query: its entity, its input check, its slots and its evaluators.
pub struct QueryDef {
    pub name: &'static str,
    pub entity: &'static str,
    pub valid: fn(&Value) -> bool,
    pub fields: &'static [&'static str],
    pub inputs: &'static [&'static str],
    pub run: Evaluator,
    pub order: Evaluator,
    /// The order-only twin's own slots: without the predicates it reads fewer of them.
    pub order_fields: &'static [&'static str],
    pub order_inputs: &'static [&'static str],
    pub cells: CellCache,
}
/// A row or input value as the evaluator sees it; an absent field is null (`isNull`).
fn cell(value: Option<&Value>) -> Cell {
    match value {
        Some(Value::String(text)) => Cell::Text(text.encode_utf16().collect()),
        Some(Value::Number(number)) => Cell::Number(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(flag)) => Cell::Bool(*flag),
        _ => Cell::Null,
    }
}
fn query_error(message: String) -> Value {
    json!({ "_tag": "RemoteQueryError", "message": message })
}

// ---- Mutations (RM-001): the compiled source runs; the handler shapes its outcome.
pub fn mutation_error(message: String) -> Value {
    json!({ "_tag": "RemoteMutationError", "message": message })
}
/// `handlers.FoldkitRemoteMutate`'s result from the encoded `MutationOutcome`: absent lists
/// default to empty.
pub fn mutation_result(mut outcome: Value) -> Value {
    let mut take = |key: &str| {
        outcome
            .as_object_mut()
            .and_then(|object| object.remove(key))
    };
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
/// `handlers.FoldkitRemoteQuery` with the memory backend's query sources.
pub async fn query<S: Source>(
    server: &S,
    authorize: Authorize<'_>,
    payload: &Value,
) -> Result<Value, Value> {
    let name = payload
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = payload.get("input").unwrap_or(&Value::Null);
    let entity = server.check_query(name, input).map_err(query_error)?;
    let select = payload
        .get("select")
        .filter(|value| !value.is_null())
        .map(relation);
    if let Some(select) = &select {
        if let Some(paged) = check_pages_per_relation(std::slice::from_ref(select)) {
            return Err(query_error(format!(
                "Too many pages of \"{}\" in one query select",
                paged
            )));
        }
    }
    let window = window(payload.get("window").unwrap_or(&Value::Null));
    let PageIds { ids, start, end } = server
        .page(name, input, &window)
        .await
        .map_err(query_error)?;
    let edges: Vec<Value> = ids
        .iter()
        .map(|id| json!({ "entity": entity, "id": id, "key": format!("{}:{}", entity, id) }))
        .collect();
    let Some(select) = select else {
        return Ok(json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end) }));
    };
    let requirements: Vec<Requirement> = ids
        .iter()
        .filter(|_| select.entity == entity)
        .map(|id| Requirement {
            entity: select.entity.clone(),
            id: id.clone(),
            fields: select.fields.to_vec(),
            windows: select.windows.clone(),
            relations: select.relations.clone(),
            renames: None,
        })
        .collect();
    if requirements.is_empty() {
        return Ok(
            json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end), "entities": [], "settled": [] }),
        );
    }
    let read = read_helper(server, authorize, requirements)
        .await
        .map_err(|error| {
            query_error(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            )
        })?;
    Ok(
        json!({ "edges": edges, "start": boundary(&start), "end": boundary(&end), "entities": read["entities"], "settled": read["settled"] }),
    )
}
impl Memory {
    /// The memory backend's query page: the body by the evaluator, paged by pageOf with locate.
    fn page_now(&self, def: &QueryDef, input: &Value, window: &Window) -> Result<PageIds, String> {
        let state = self.tables();
        let empty = Ordered::new();
        let table = state.tables.get(def.entity).unwrap_or(&empty);
        let rows: Vec<(&String, &Row)> = table.iter().collect();
        let encoded: Vec<Cell> = def.inputs.iter().map(|key| cell(input.get(*key))).collect();
        let version = state.version_of(def.entity);
        let cells = {
            let mut cache = def
                .cells
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match cache.as_ref() {
                Some((built, cells)) if *built == version => cells.clone(),
                _ => {
                    let cells: Arc<Vec<Vec<Cell>>> = Arc::new(
                        rows.iter()
                            .map(|(_, row)| {
                                def.fields
                                    .iter()
                                    .map(|field| cell(row.get(field)))
                                    .collect()
                            })
                            .collect(),
                    );
                    *cache = Some((version, cells.clone()));
                    cells
                }
            }
        };
        let matched = (def.run)(&encoded, &cells).map_err(|error| error.to_string())?;
        // A cursor row that no longer matches still has a place in the order, as a keyset has it.
        let locate = |cursor: &str| -> Result<Position, String> {
            let Some(found) = rows.iter().position(|(id, _)| id.as_str() == cursor) else {
                return Err(format!(
                    "Cursor \"{}\" names a row that no longer exists",
                    cursor
                ));
            };
            let twin = |index: &usize| -> Vec<Cell> {
                def.order_fields
                    .iter()
                    .map(|field| cell(rows[*index].1.get(field)))
                    .collect()
            };
            let mut subset: Vec<Vec<Cell>> = matched.iter().map(twin).collect();
            subset.push(twin(&found));
            let order_input: Vec<Cell> = def
                .order_inputs
                .iter()
                .map(|key| cell(input.get(*key)))
                .collect();
            let placed = (def.order)(&order_input, &subset).map_err(|error| error.to_string())?;
            let index = placed
                .iter()
                .position(|index| *index == subset.len() - 1)
                .unwrap_or(subset.len() - 1);
            Ok(Position {
                index,
                exact: false,
            })
        };
        let id_of = |index: &usize| rows[*index].0.clone();
        let (page, start, end) = page_of(&matched, window, &id_of, Some(&locate))?;
        Ok(PageIds {
            ids: page.iter().map(|index| rows[*index].0.clone()).collect(),
            start,
            end,
        })
    }
}
impl Source for Memory {
    fn has_source(&self, entity: &str) -> bool {
        self.entities.iter().any(|name| name == entity)
    }
    // The memory backend is synchronous: each answer is ready, and no lock is held across an await.
    fn read(
        &self,
        entity: &str,
        ids: &[String],
        fields: &[String],
        windows: &Option<JsObject<Window>>,
    ) -> impl std::future::Future<Output = Result<Vec<EntityRecord>, String>> + Send {
        std::future::ready(Ok(self.read_now(entity, ids, fields, windows)))
    }
    fn check_query(&self, query: &str, input: &Value) -> Result<&'static str, String> {
        let queries = self
            .queries
            .iter()
            .map(|def| (def.name, def.entity, def.valid));
        checked_query(queries, query, input)
    }
    fn page(
        &self,
        query: &str,
        input: &Value,
        window: &Window,
    ) -> impl std::future::Future<Output = Result<PageIds, String>> + Send {
        let result = match self.queries.iter().find(|def| def.name == query) {
            Some(def) => self.page_now(def, input, window),
            None => Err(format!("Unknown query: {}", query)),
        };
        std::future::ready(result)
    }
}

// ---- Pages (M9-3 step 2): a server-rendered page's Remote data.
/// One read a page plans while compiling: `Query` or `Read`, with its wire request.
pub struct PageRead {
    pub tag: &'static str,
    pub request: Value,
}
/// What a page's answers so far hold, as upstream's store would after merging them: each
/// entity's present values, the fields the server settled (withheld), and the entities a Read
/// asked for and did not get (upstream's tombstones). Keys are upstream's `Entity:id`.
#[derive(Default)]
struct PageStore {
    values: HashMap<String, Map<String, Value>>,
    settled: HashMap<String, HashSet<String>>,
    tombstones: HashSet<String>,
}
fn entity_key(entity: &Value, id: &Value) -> String {
    format!(
        "{}:{}",
        entity.as_str().unwrap_or_default(),
        id.as_str().unwrap_or_default()
    )
}
fn listed<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
/// Upstream's `targetsOf`: the refs a relation value carries that name `relation`'s entity.
fn targets_of(value: &Value, relation: &Value) -> Vec<(String, String)> {
    refs_in(value)
        .into_iter()
        .filter(|(entity, _)| relation["entity"].as_str() == Some(entity.as_str()))
        .collect()
}
impl PageStore {
    fn of(exchanges: &[Value]) -> Self {
        let mut store = PageStore::default();
        for exchange in exchanges {
            let answer = &exchange["answer"];
            for entity in listed(answer, "entities") {
                if let Some(values) = entity["values"].as_object() {
                    store
                        .values
                        .entry(entity_key(&entity["entity"], &entity["id"]))
                        .or_default()
                        .extend(values.iter().map(|(k, v)| (k.clone(), v.clone())));
                }
            }
            for entry in listed(answer, "settled") {
                store
                    .settled
                    .entry(entity_key(&entry["entity"], &entry["id"]))
                    .or_default()
                    .extend(
                        listed(entry, "fields")
                            .iter()
                            .filter_map(|field| field.as_str().map(str::to_string)),
                    );
            }
            if exchange["_tag"] == "Read" {
                for requirement in listed(&exchange["request"], "requests") {
                    let key = entity_key(&requirement["entity"], &requirement["id"]);
                    if !store.values.contains_key(&key) && !store.settled.contains_key(&key) {
                        store.tombstones.insert(key);
                    }
                }
            }
        }
        store
    }
    fn field(&self, key: &str, field: &str) -> Option<&Value> {
        if self.tombstones.contains(key) {
            return None;
        }
        self.values.get(key)?.get(field)
    }
    /// Upstream's `missingFields` for a fresh store: none of a tombstone, and otherwise each field
    /// neither present nor settled.
    fn missing(&self, key: &str, fields: &[Value]) -> Vec<Value> {
        if self.tombstones.contains(key) {
            return Vec::new();
        }
        fields
            .iter()
            .filter(|field| {
                field.as_str().is_some_and(|field| {
                    self.field(key, field).is_none()
                        && !self
                            .settled
                            .get(key)
                            .is_some_and(|settled| settled.contains(field))
                })
            })
            .cloned()
            .collect()
    }
    /// Upstream's `plan` over this store: each entity's missing fields with their windows and
    /// relations, then the targets of the relations it already holds, merged and sorted by key.
    fn plan(&self, requirements: Vec<Value>) -> Vec<Value> {
        let mut planned = Vec::new();
        let mut followed = Vec::new();
        for group in merge_requirements(requirements) {
            let key = entity_key(&group["entity"], &group["id"]);
            let missing = self.missing(&key, listed(&group, "fields"));
            let is_missing = |field: &str| missing.iter().any(|m| m.as_str() == Some(field));
            if let Some(relations) = group["relations"].as_object() {
                for (field, relation) in relations {
                    if is_missing(field) {
                        continue;
                    }
                    if let Some(value) = self.field(&key, field) {
                        for (entity, id) in targets_of(value, relation) {
                            let mut target = Map::new();
                            target.insert("entity".to_string(), Value::String(entity));
                            target.insert("id".to_string(), Value::String(id));
                            for part in ["fields", "windows", "relations"] {
                                if let Some(value) = relation.get(part) {
                                    target.insert(part.to_string(), value.clone());
                                }
                            }
                            followed.push(Value::Object(target));
                        }
                    }
                }
            }
            if missing.is_empty() {
                continue;
            }
            let mut narrowed = Map::new();
            narrowed.insert("entity".to_string(), group["entity"].clone());
            narrowed.insert("id".to_string(), group["id"].clone());
            for part in ["windows", "relations"] {
                if let Some(record) = group[part].as_object() {
                    let picked: Map<String, Value> = record
                        .iter()
                        .filter(|(field, _)| is_missing(field))
                        .map(|(field, value)| (field.clone(), value.clone()))
                        .collect();
                    if !picked.is_empty() {
                        narrowed.insert(part.to_string(), Value::Object(picked));
                    }
                }
            }
            narrowed.insert("fields".to_string(), Value::Array(missing));
            planned.push(Value::Object(narrowed));
        }
        let nested = if followed.is_empty() {
            Vec::new()
        } else {
            self.plan(followed)
        };
        let mut all = merge_requirements(planned.into_iter().chain(nested).collect());
        all.sort_by_key(|requirement| entity_key(&requirement["entity"], &requirement["id"]));
        all.into_iter().map(canonical_requirement).collect()
    }
    /// Upstream's `assemble`: the entity's selected fields, following each relation into its
    /// targets. None when a field, at any depth, is not present.
    fn assemble(&self, key: &str, requirement: &Value) -> Option<Value> {
        let mut values = Map::new();
        for field in listed(requirement, "fields") {
            let field = field.as_str()?;
            let value = self.field(key, field)?;
            let assembled = match requirement["relations"].get(field) {
                None => value.clone(),
                Some(relation) => self.assemble_relation(value, relation)?,
            };
            values.insert(aliased_field(field).to_string(), assembled);
        }
        Some(Value::Object(values))
    }
    /// Upstream's `assembleRelation`: the targets a relation value refers to, in its own shape.
    /// A tombstoned target is dropped, so a ref to one reads as null.
    fn assemble_relation(&self, value: &Value, relation: &Value) -> Option<Value> {
        if value.is_null() {
            return Some(Value::Null);
        }
        let mut targets = Vec::new();
        for (entity, id) in targets_of(value, relation) {
            let key = format!("{}:{}", entity, id);
            if self.tombstones.contains(&key) {
                continue;
            }
            targets.push(self.assemble(&key, relation)?);
        }
        Some(match value {
            Value::String(_) => targets.into_iter().next().unwrap_or(Value::Null),
            Value::Object(page) if page.get("refs").is_some_and(Value::is_array) => json!({
                "items": targets,
                "hasNext": page.get("hasNext").cloned().unwrap_or(Value::Bool(false)),
                "hasPrevious": page.get("hasPrevious").cloned().unwrap_or(Value::Bool(false)),
            }),
            _ => Value::Array(targets),
        })
    }
}
/// Upstream's `Requirement.merge`: one requirement per entity key in first-seen order, its fields
/// unioned in order and its windows and relations combined.
fn merge_requirements(requirements: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for requirement in requirements {
        let key = entity_key(&requirement["entity"], &requirement["id"]);
        let Some(existing) = merged
            .iter_mut()
            .find(|existing| entity_key(&existing["entity"], &existing["id"]) == key)
        else {
            merged.push(requirement);
            continue;
        };
        for field in listed(&requirement, "fields") {
            let fields = existing["fields"].as_array_mut();
            if let Some(fields) = fields {
                if !fields.contains(field) {
                    fields.push(field.clone());
                }
            }
        }
        for part in ["windows", "relations"] {
            if let Some(record) = requirement[part].as_object() {
                if !existing[part].is_object() {
                    existing[part] = json!({});
                }
                if let Some(target) = existing[part].as_object_mut() {
                    for (field, value) in record {
                        target.entry(field.clone()).or_insert_with(|| value.clone());
                    }
                }
            }
        }
    }
    merged
}
/// A requirement in its schema's key order (`entity, id, fields, windows, relations`), as the
/// page's Flags encode it.
fn canonical_requirement(requirement: Value) -> Value {
    let mut ordered = Map::new();
    for part in ["entity", "id", "fields", "windows", "relations", "live"] {
        if let Some(value) = requirement.get(part) {
            ordered.insert(part.to_string(), value.clone());
        }
    }
    Value::Object(ordered)
}
/// Each view: a query view as upstream's `Page` of a Ready read, a get view as its settled
/// `RemoteData` (`get_view`), both assembled from everything the page's answers hold.
pub(crate) fn page_views(
    reads: &[PageRead],
    made: &[Option<usize>],
    exchanges: &[Value],
    views: &[(&str, usize)],
) -> Value {
    let store = PageStore::of(exchanges);
    let mut out = Map::new();
    for (name, read) in views {
        let view = match (reads[*read].tag, made[*read]) {
            ("Query", Some(exchange)) => query_view(
                &exchanges[exchange]["answer"],
                &reads[*read].request["select"],
                &store,
            ),
            ("Query", None) => Value::Null,
            _ => get_view(&reads[*read].request["requests"][0], &store),
        };
        out.insert(name.to_string(), view);
    }
    Value::Object(out)
}
/// A query view as upstream's `Page` of a Ready read: each edge's entity assembled through the
/// query's selection, in edge order, and more on a side whose boundary is not `Terminal` (one
/// segment, cut to its own window). An item that does not assemble reads as null, which the
/// page's typed decoding then refuses.
fn query_view(answer: &Value, select: &Value, store: &PageStore) -> Value {
    let items: Vec<Value> = listed(answer, "edges")
        .iter()
        .map(|edge| {
            store
                .assemble(&entity_key(&edge["entity"], &edge["id"]), select)
                .unwrap_or(Value::Null)
        })
        .collect();
    let more = |side: &str| answer[side]["_tag"].as_str() != Some("Terminal");
    json!({ "items": items, "hasNext": more("end"), "hasPrevious": more("start") })
}
/// A get view as upstream's settled `RemoteData` of its requirement: `NotFound` for a tombstone,
/// `Ready` with the assembled value, and otherwise null, which the page's typed decoding
/// refuses, as upstream reads `Failed` or a value still loading.
fn get_view(requirement: &Value, store: &PageStore) -> Value {
    let key = entity_key(&requirement["entity"], &requirement["id"]);
    if store.tombstones.contains(&key) {
        return json!({ "_tag": "NotFound" });
    }
    let settled = store
        .settled
        .get(&key)
        .is_some_and(|settled| !settled.is_empty());
    match store.assemble(&key, requirement) {
        Some(value) if !settled => json!({ "_tag": "Ready", "value": value }),
        _ => Value::Null,
    }
}
/// A planned Read as upstream's planner plans it over the store the page's earlier answers
/// built (`PageStore::plan`). None when nothing is left to read.
pub(crate) fn lacking(request: &Value, exchanges: &[Value]) -> Option<Value> {
    let requirements = PageStore::of(exchanges).plan(listed(request, "requests").to_vec());
    if requirements.is_empty() {
        return None;
    }
    let mut narrowed = request.clone();
    narrowed["requests"] = Value::Array(requirements);
    Some(narrowed)
}
/// The page's data: each planned request run as the RPC handlers run it, recorded with its
/// answer as `{ now, exchanges }` for the browser's replay, and the views built from them. A
/// planned Read asks only for what earlier answers lack, and is skipped when they hold it all,
/// as the browser's replayed planner skips it. A read the engine refuses is the error.
pub async fn page_data<S: Source>(
    server: &S,
    authorize: Authorize<'_>,
    reads: &[PageRead],
    views: &[(&str, usize)],
    now: u64,
) -> Result<(Value, Value), Value> {
    let mut exchanges: Vec<Value> = Vec::with_capacity(reads.len());
    let mut made = Vec::with_capacity(reads.len());
    for planned in reads {
        let (request, answer) = if planned.tag == "Query" {
            let answer = query(server, authorize, &planned.request).await?;
            (planned.request.clone(), answer)
        } else {
            let Some(request) = lacking(&planned.request, &exchanges) else {
                made.push(None);
                continue;
            };
            let answer = read(server, authorize, &request).await?;
            (request, answer)
        };
        made.push(Some(exchanges.len()));
        exchanges.push(json!({ "_tag": planned.tag, "request": request, "answer": answer }));
    }
    let views = page_views(reads, &made, &exchanges, views);
    Ok((json!({ "now": now, "exchanges": exchanges }), views))
}
