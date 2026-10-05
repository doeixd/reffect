// SchemaBinary as effect 4.0.0 `encoding/SchemaBinary.ts` writes and reads it, for
// `RpcSerialization.layerSchemaBinary` (docs/research/schema-binary.md, the wire format in
// docs/research/schema-binary-format.md). Std only: generated contract codecs build on these
// primitives, and the RPC envelope is a fixed codec here. Writers make Effect's canonical
// choices, so native bytes equal Effect's; readers accept every form Effect's reader accepts.

/// A decode failure: the `expected` text of Effect's `InvalidValue` issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid(pub &'static str);
pub type Decoded<T> = Result<T, Invalid>;

/// A failure where it happened, as `SchemaError.message` reports it: the issue, then its path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub issue: Issue,
    /// Rendered path segments, outermost first: `["headers"]`, `[0]`.
    pub path: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Issue {
    Invalid(&'static str),
    MissingKey,
    UnexpectedKey,
}
impl From<Invalid> for Failure {
    fn from(Invalid(expected): Invalid) -> Self {
        Failure::new(Issue::Invalid(expected))
    }
}
impl Failure {
    pub fn new(issue: Issue) -> Self {
        Failure {
            issue,
            path: Vec::new(),
        }
    }
    /// The same failure inside a property: `JSON.stringify(key)` in brackets.
    pub fn at_key(mut self, key: &str) -> Self {
        let mut segment = String::from("[");
        js_string(key, &mut segment);
        segment.push(']');
        self.path.insert(0, segment);
        self
    }
    pub fn at_index(mut self, index: usize) -> Self {
        self.path.insert(0, format!("[{index}]"));
        self
    }
    /// `SchemaError.message`: the issue, then `\n  at <path>` when it is nested.
    pub fn message(&self) -> String {
        let mut text = match self.issue {
            Issue::Invalid(expected) => format!("Expected {expected}"),
            Issue::MissingKey => "Missing key".to_string(),
            Issue::UnexpectedKey => "Expected no excess property".to_string(),
        };
        if !self.path.is_empty() {
            text.push_str("\n  at ");
            text.push_str(&self.path.concat());
        }
        text
    }
}
/// `JSON.stringify` of a string, into `out`.
pub fn js_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub const ENVELOPE_DEFAULT: u8 = 0x20;
pub const ENVELOPE_FINGERPRINT: u8 = 0x21;
pub const FIELD_WIRE_SIZED: u8 = 0;
pub const FIELD_WIRE_VARINT: u8 = 1;
pub const FIELD_WIRE_FIXED64: u8 = 2;
pub const FIELD_WIRE_FALSE: u8 = 3;
pub const FIELD_WIRE_TRUE: u8 = 4;
pub const FIELD_WIRE_DECIMAL: u8 = 5;
pub const FIELD_WIRE_FIXED32: u8 = 6;
pub const FIELD_WIRE_EMPTY: u8 = 7;
const NUMBER_VARINT_MAX_BYTES: usize = 7;
const NUMBER_VARINT_MAX_MAGNITUDE: f64 = 281_474_976_710_655.0; // 2^48 - 1
const DECIMAL_SCALE_MAX: u8 = 8;
const DECIMAL_MANTISSA_MAX: f64 = 2_199_023_255_551.0; // 2^41 - 1
const POW10: [f64; 9] = [1.0, 10.0, 100.0, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// `layerSchemaBinary`'s default `maxFrameSize`.
pub const DEFAULT_MAX_FRAME_SIZE: u64 = 16 * 1024 * 1024;

pub fn fnv32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811C_9DC5u32, |hash, b| {
        (hash ^ u32::from(*b)).wrapping_mul(0x0100_0193)
    })
}
pub fn fnv64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xCBF2_9CE4_8422_2325u64, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01B3)
    })
}

// ---- Writing

pub fn put_uv(out: &mut Vec<u8>, mut n: u64) {
    while n > 0x7F {
        out.push((n as u8 & 0x7F) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}
/// A sign-magnitude varint of an integral `x` with |x| <= 2^53 - 1; `-0` keeps its sign.
pub fn put_sm(out: &mut Vec<u8>, x: f64) {
    let negative = x.is_sign_negative();
    put_uv(out, (x.abs() as u64) * 2 + u64::from(negative));
}
/// A field tag: the id and the payload's wire kind.
pub fn put_tag(out: &mut Vec<u8>, id: u32, wire: u8) {
    put_uv(out, u64::from(id) * 8 + u64::from(wire));
}
/// A sized slot: the length, then the bytes.
pub fn put_sized(out: &mut Vec<u8>, bytes: &[u8]) {
    put_uv(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}
pub fn put_f64(out: &mut Vec<u8>, x: f64) {
    out.extend_from_slice(&x.to_le_bytes());
}
/// JS `Math.round`: the nearest integer, halves toward +Infinity. `v - floor(v)` is exact.
fn js_round(v: f64) -> f64 {
    let floor = v.floor();
    if v - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}
pub fn is_varint_number(x: f64) -> bool {
    x.fract() == 0.0 && x.abs() <= NUMBER_VARINT_MAX_MAGNITUDE
}
/// The scale in 1..=8 that makes `x` an exact short-decimal mantissa, or 0 (`decimalScale`).
pub fn decimal_scale(x: f64) -> u8 {
    for scale in 1..=DECIMAL_SCALE_MAX {
        let mantissa = js_round(x * POW10[scale as usize]);
        // The mantissa only grows with the scale; this also rejects NaN and the infinities.
        if !(-DECIMAL_MANTISSA_MAX..=DECIMAL_MANTISSA_MAX).contains(&mantissa) {
            return 0;
        }
        if mantissa / POW10[scale as usize] == x {
            return scale;
        }
    }
    0
}
/// A `number` filling its extent: a varint, a short decimal, or an f64.
pub fn put_number(out: &mut Vec<u8>, x: f64) {
    if is_varint_number(x) {
        return put_sm(out, x);
    }
    match decimal_scale(x) {
        0 => put_f64(out, x),
        scale => {
            put_sm(out, js_round(x * POW10[scale as usize]));
            out.push(scale);
        }
    }
}
/// A default-mode struct field holding a `number`, with the wire kind its value selects.
pub fn put_number_field(out: &mut Vec<u8>, id: u32, x: f64) {
    if is_varint_number(x) {
        put_tag(out, id, FIELD_WIRE_VARINT);
        return put_sm(out, x);
    }
    match decimal_scale(x) {
        0 => {
            put_tag(out, id, FIELD_WIRE_FIXED64);
            put_f64(out, x);
        }
        scale => {
            put_tag(out, id, FIELD_WIRE_DECIMAL);
            put_sm(out, js_round(x * POW10[scale as usize]));
            put_uv(out, u64::from(scale));
        }
    }
}
/// A default-mode struct field holding a `boolean`: the wire kind is the value.
pub fn put_bool_field(out: &mut Vec<u8>, id: u32, value: bool) {
    put_tag(
        out,
        id,
        if value {
            FIELD_WIRE_TRUE
        } else {
            FIELD_WIRE_FALSE
        },
    );
}
/// A default-mode struct field in a sized slot.
pub fn put_sized_field(out: &mut Vec<u8>, id: u32, bytes: &[u8]) {
    put_tag(out, id, FIELD_WIRE_SIZED);
    put_sized(out, bytes);
}
/// One frame: its length, the envelope byte, the fingerprint in fingerprint mode, the value.
pub fn put_frame(out: &mut Vec<u8>, fingerprint: Option<&[u8; 8]>, value: &[u8]) {
    let len = 1 + fingerprint.map_or(0, |f| f.len()) + value.len();
    put_uv(out, len as u64);
    match fingerprint {
        Some(fingerprint) => {
            out.push(ENVELOPE_FINGERPRINT);
            out.extend_from_slice(fingerprint);
        }
        None => out.push(ENVELOPE_DEFAULT),
    }
    out.extend_from_slice(value);
}

// ---- Reading

/// A cursor over one extent: a region whose end the reader already knows.
#[derive(Clone, Debug)]
pub struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }
    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }
    /// The extent was consumed exactly.
    pub fn finish(&self) -> Decoded<()> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(Invalid("no leftover bytes"))
        }
    }
    pub fn byte(&mut self) -> Decoded<u8> {
        let b = *self.bytes.get(self.pos).ok_or(Invalid("complete value"))?;
        self.pos += 1;
        Ok(b)
    }
    pub fn take(&mut self, n: usize) -> Decoded<&'a [u8]> {
        if n > self.remaining() {
            return Err(Invalid("complete value"));
        }
        let bytes = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(bytes)
    }
    /// The rest of the extent.
    pub fn rest(&mut self) -> &'a [u8] {
        let bytes = &self.bytes[self.pos..];
        self.pos = self.bytes.len();
        bytes
    }
    /// A sized slot's region, as a reader of its own.
    pub fn sized(&mut self) -> Decoded<Reader<'a>> {
        let len = self.uv()?;
        let len = usize::try_from(len).map_err(|_| Invalid("complete value"))?;
        Ok(Reader::new(self.take(len)?))
    }
    /// A uvarint: at most 10 bytes, and at most 2^53 - 1.
    pub fn uv(&mut self) -> Decoded<u64> {
        let mut value: u128 = 0;
        for i in 0..10 {
            let b = self.byte()?;
            value += u128::from(b & 0x7F) << (7 * i);
            if value > u128::from(MAX_SAFE_INTEGER) {
                return Err(Invalid("safe integer length"));
            }
            if b < 0x80 {
                return Ok(value as u64);
            }
        }
        Err(Invalid("uvarint"))
    }
    /// A field tag: at most 5 bytes (35 bits).
    pub fn field_tag(&mut self) -> Decoded<u64> {
        let mut value: u64 = 0;
        for i in 0..5 {
            let b = self.byte()?;
            if i == 4 && b >= 0x80 {
                return Err(Invalid("uvarint"));
            }
            value |= u64::from(b & 0x7F) << (7 * i);
            if b < 0x80 {
                break;
            }
        }
        Ok(value)
    }
    /// A sign-magnitude varint as a JS number: wider codes round as `Number(bigint)` does.
    pub fn sm(&mut self) -> Decoded<f64> {
        let start = self.pos;
        let mut code: u64 = 0;
        for i in 0..NUMBER_VARINT_MAX_BYTES {
            let b = self.byte()?;
            code |= u64::from(b & 0x7F) << (7 * i);
            if b < 0x80 {
                let magnitude = (code / 2) as f64;
                return Ok(if code % 2 == 1 { -magnitude } else { magnitude });
            }
        }
        // Effect rereads the whole varint as a bigint, of any length.
        self.pos = start;
        let mut groups: Vec<u8> = Vec::new();
        loop {
            let b = self.byte()?;
            groups.push(b & 0x7F);
            if b < 0x80 {
                break;
            }
        }
        let negative = groups[0] & 1 == 1;
        let magnitude = big_magnitude(&groups);
        if !magnitude.is_finite() {
            return Err(Invalid("safe integer length"));
        }
        Ok(if negative { -magnitude } else { magnitude })
    }
    pub fn f64(&mut self) -> Decoded<f64> {
        let bytes = self.take(8)?;
        let mut le = [0u8; 8];
        le.copy_from_slice(bytes);
        Ok(f64::from_le_bytes(le))
    }
    /// A `number` filling the rest of the extent.
    pub fn number(&mut self) -> Decoded<f64> {
        match self.remaining() {
            8 => self.f64(),
            0 | 9.. => Err(Invalid("f64")),
            _ => {
                let value = self.sm()?;
                if self.is_empty() {
                    return Ok(value);
                }
                let scale = self.byte()?;
                if !self.is_empty() || scale == 0 || scale > DECIMAL_SCALE_MAX {
                    return Err(Invalid("decimal"));
                }
                Ok(value / POW10[scale as usize])
            }
        }
    }
    /// A `boolean` filling the rest of the extent.
    pub fn bool(&mut self) -> Decoded<bool> {
        if self.remaining() != 1 {
            return Err(Invalid("bool"));
        }
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Invalid("bool")),
        }
    }
    /// A `string` filling the rest of the extent: fatal UTF-8, a leading BOM kept.
    pub fn string(&mut self) -> Decoded<String> {
        std::str::from_utf8(self.rest())
            .map(str::to_string)
            .map_err(|_| Invalid("utf-8"))
    }
    /// A `null` or `undefined`: an empty extent.
    pub fn empty(&mut self) -> Decoded<()> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(Invalid("empty"))
        }
    }
}
/// `Number(code >> 1n)` for a varint's 7-bit groups (least significant first): the magnitude
/// rounded to the nearest double, ties to even.
fn big_magnitude(groups: &[u8]) -> f64 {
    // The code's bits, most significant first, without the sign bit.
    let mut bits: Vec<bool> = Vec::with_capacity(groups.len() * 7);
    for group in groups.iter().rev() {
        for shift in (0..7).rev() {
            bits.push((group >> shift) & 1 == 1);
        }
    }
    bits.pop();
    let Some(first) = bits.iter().position(|bit| *bit) else {
        return 0.0;
    };
    let bits = &bits[first..];
    let take = bits.len().min(53);
    let mut mantissa: u64 = bits[..take]
        .iter()
        .fold(0, |acc, bit| acc << 1 | u64::from(*bit));
    if bits.len() <= 53 {
        return mantissa as f64;
    }
    let round = bits[53];
    let sticky = bits[54..].iter().any(|bit| *bit);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = i32::try_from(bits.len() - 53).unwrap_or(i32::MAX);
    mantissa as f64 * 2f64.powi(exponent)
}

/// The frames of a body, in order. A failure ends the sequence; values before it come first.
/// A body ending inside a frame is no failure (the parser waits for more): the sequence ends,
/// and `unfinished` reports the frame.
pub struct Frames<'a> {
    bytes: &'a [u8],
    pos: usize,
    fingerprint: Option<[u8; 8]>,
    max_frame_size: Option<u64>,
    done: bool,
    unfinished: bool,
}
impl<'a> Frames<'a> {
    /// `fingerprint` selects fingerprint mode; `max_frame_size` of `None` is `"unbounded"`.
    pub fn new(bytes: &'a [u8], fingerprint: Option<[u8; 8]>, max_frame_size: Option<u64>) -> Self {
        Frames {
            bytes,
            pos: 0,
            fingerprint,
            max_frame_size,
            done: false,
            unfinished: false,
        }
    }
    /// The body ended inside a frame.
    pub fn unfinished(&self) -> bool {
        self.unfinished
    }
    fn frame(&mut self) -> Decoded<Option<&'a [u8]>> {
        let buffered = &self.bytes[self.pos..];
        if buffered.is_empty() {
            return Ok(None);
        }
        let mut len: u128 = 0;
        let mut header = None;
        for (i, b) in buffered.iter().take(10).enumerate() {
            len |= u128::from(b & 0x7F) << (7 * i);
            if b & 0x80 == 0 {
                header = Some(i + 1);
                break;
            }
        }
        let Some(header) = header else {
            if buffered.len() >= 10 {
                return Err(Invalid("uvarint"));
            }
            self.unfinished = true;
            return Ok(None);
        };
        if len > u128::from(MAX_SAFE_INTEGER) {
            return Err(Invalid("safe integer length"));
        }
        if len == 0 {
            return Err(Invalid("nonzero frame length"));
        }
        if self.max_frame_size.is_some_and(|max| len > u128::from(max)) {
            return Err(Invalid("frame within maxFrameSize"));
        }
        if (header as u128) + len > buffered.len() as u128 {
            self.unfinished = true;
            return Ok(None);
        }
        let body = &buffered[header..header + len as usize];
        self.pos += header + len as usize;
        let mut reader = Reader::new(body);
        let envelope = reader.byte()?;
        match self.fingerprint {
            Some(expected) => {
                if envelope != ENVELOPE_FINGERPRINT {
                    return Err(Invalid("version 2 envelope, flags 1"));
                }
                if reader.remaining() < 8 {
                    return Err(Invalid("complete value"));
                }
                if reader.take(8)? != expected {
                    return Err(Invalid("matching layout fingerprint"));
                }
            }
            None => {
                if envelope != ENVELOPE_DEFAULT {
                    return Err(Invalid("version 2 envelope, flags 0"));
                }
            }
        }
        Ok(Some(reader.rest()))
    }
}
impl<'a> Iterator for Frames<'a> {
    /// A frame's value region, after its envelope.
    type Item = Decoded<&'a [u8]>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        match self.frame() {
            Ok(Some(value)) => Some(Ok(value)),
            Ok(None) => {
                self.done = true;
                None
            }
            Err(invalid) => {
                self.done = true;
                Some(Err(invalid))
            }
        }
    }
}
/// The value of a body holding exactly one frame (`toCodec`'s one-shot decode).
pub fn one_frame(bytes: &[u8], fingerprint: Option<[u8; 8]>) -> Decoded<&[u8]> {
    let mut frames = Frames::new(bytes, fingerprint, None);
    match (frames.next(), frames.next()) {
        (Some(Err(invalid)), _) | (_, Some(Err(invalid))) => Err(invalid),
        (Some(Ok(value)), None) if !frames.unfinished() => Ok(value),
        _ => Err(Invalid("complete value")),
    }
}

// ---- The RPC envelope: `RpcMessage.EncodedSchema` in fingerprint mode

/// `RequestIdSchema`, `Union[String, Number]`: positions by kind, number 0 and string 1.
#[derive(Clone, Debug, PartialEq)]
pub enum RequestId {
    Number(f64),
    String(String),
}
/// An `optional(X)` field: absent, present as `undefined`, or present with a value.
pub type Optional<T> = Option<Option<T>>;
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: RequestId,
    pub tag: String,
    /// The payload's own frame.
    pub payload: Vec<u8>,
    pub headers: Vec<(String, String)>,
    /// `optional(Literal(true))`.
    pub is_notification: Optional<bool>,
    pub trace_id: Optional<String>,
    pub span_id: Optional<String>,
    pub sampled: Optional<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Request(Request),
    Ack {
        request_id: RequestId,
    },
    Interrupt {
        request_id: RequestId,
    },
    Ping,
    Eof,
    /// `values` is a frame of the procedure's `NonEmptyArray` of stream elements.
    Chunk {
        request_id: RequestId,
        values: Vec<u8>,
    },
    /// `exit` is a frame of the procedure's `Rpc.exitSchema`.
    Exit {
        request_id: RequestId,
        exit: Vec<u8>,
    },
    /// `defect` is a frame of `Schema.Defect()`.
    Defect {
        defect: Vec<u8>,
    },
    Pong,
}
// Variant positions: the variants sorted by their `_tag` sentinel hash.
const ACK: u64 = 0;
const EXIT: u64 = 1;
const DEFECT: u64 = 2;
const PING: u64 = 3;
const EOF: u64 = 4;
const CHUNK: u64 = 5;
const PONG: u64 = 6;
const REQUEST: u64 = 7;
const INTERRUPT: u64 = 8;

fn put_request_id(out: &mut Vec<u8>, id: &RequestId) {
    let mut slot = Vec::new();
    match id {
        RequestId::Number(n) => {
            slot.push(0);
            put_number(&mut slot, *n);
        }
        RequestId::String(s) => {
            slot.push(1);
            slot.extend_from_slice(s.as_bytes());
        }
    }
    put_sized(out, &slot);
}
fn read_request_id(r: &mut Reader) -> Result<RequestId, Failure> {
    let mut slot = r.sized()?;
    let id = match slot.uv()? {
        0 => RequestId::Number(slot.number()?),
        1 => RequestId::String(slot.string()?),
        _ => return Err(Invalid("known union member").into()),
    };
    slot.finish()?;
    Ok(id)
}
/// A field's value, its failure located at the field.
fn field<T>(key: &str, read: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
    read().map_err(|failure| failure.at_key(key))
}
/// An optional field's `Union[X, Undefined]` slot, with X's and undefined's positions.
fn put_optional<T>(
    out: &mut Vec<u8>,
    value: &Optional<T>,
    positions: (u64, u64),
    write: impl Fn(&mut Vec<u8>, &T),
) {
    let Some(present) = value else { return };
    let mut slot = Vec::new();
    match present {
        Some(value) => {
            put_uv(&mut slot, positions.0);
            write(&mut slot, value);
        }
        None => put_uv(&mut slot, positions.1),
    }
    put_sized(out, &slot);
}
fn read_optional<T>(
    r: &mut Reader,
    present: bool,
    positions: (u64, u64),
    read: impl Fn(&mut Reader) -> Decoded<T>,
) -> Result<Optional<T>, Failure> {
    if !present {
        return Ok(None);
    }
    let mut slot = r.sized()?;
    let position = slot.uv()?;
    let value = if position == positions.0 {
        Some(read(&mut slot)?)
    } else if position == positions.1 {
        slot.empty()?;
        None
    } else {
        return Err(Invalid("known union member").into());
    };
    slot.finish()?;
    Ok(Some(value))
}
// Request's optional fields, ascending by field id: their bitmap bits.
const SPAN_ID: u8 = 1;
const SAMPLED: u8 = 2;
const TRACE_ID: u8 = 4;
const IS_NOTIFICATION: u8 = 8;
// Union positions within each optional field: String/Boolean/Literal(true) against Undefined.
const STRING_OR_UNDEFINED: (u64, u64) = (1, 0);
const BOOL_OR_UNDEFINED: (u64, u64) = (0, 1);

fn put_request(out: &mut Vec<u8>, request: &Request) {
    let bit = |present: bool, bit: u8| if present { bit } else { 0 };
    let bitmap = bit(request.span_id.is_some(), SPAN_ID)
        | bit(request.sampled.is_some(), SAMPLED)
        | bit(request.trace_id.is_some(), TRACE_ID)
        | bit(request.is_notification.is_some(), IS_NOTIFICATION);
    out.push(bitmap);
    let string = |slot: &mut Vec<u8>, s: &String| slot.extend_from_slice(s.as_bytes());
    let boolean = |slot: &mut Vec<u8>, b: &bool| slot.push(u8::from(*b));
    put_optional(out, &request.span_id, STRING_OR_UNDEFINED, string);
    put_sized(out, &request.payload);
    put_request_id(out, &request.id);
    put_optional(out, &request.sampled, BOOL_OR_UNDEFINED, boolean);
    put_sized(out, request.tag.as_bytes());
    put_optional(out, &request.trace_id, STRING_OR_UNDEFINED, string);
    let mut headers = Vec::new();
    put_uv(&mut headers, request.headers.len() as u64);
    for (name, value) in &request.headers {
        let mut pair = Vec::new();
        put_sized(&mut pair, name.as_bytes());
        put_sized(&mut pair, value.as_bytes());
        put_sized(&mut headers, &pair);
    }
    put_sized(out, &headers);
    put_optional(out, &request.is_notification, BOOL_OR_UNDEFINED, boolean);
}
/// A header, `Tuple([String, String])`: two sized slots and nothing after them.
fn read_header(pair: &mut Reader) -> Result<(String, String), Failure> {
    let mut slot = |index: usize| -> Result<String, Failure> {
        if pair.is_empty() {
            return Err(Failure::new(Issue::MissingKey).at_index(index));
        }
        pair.sized()
            .and_then(|mut slot| slot.string())
            .map_err(|invalid| Failure::from(invalid).at_index(index))
    };
    let name = slot(0)?;
    let value = slot(1)?;
    if !pair.is_empty() {
        return Err(Failure::new(Issue::UnexpectedKey).at_index(2));
    }
    Ok((name, value))
}
fn read_headers(r: &mut Reader) -> Result<Vec<(String, String)>, Failure> {
    let mut slot = r.sized()?;
    let count = slot.uv()?;
    // Each pair takes at least one byte, so a count beyond the region is never allocated.
    if count > slot.remaining() as u64 + 1_048_576 {
        return Err(Invalid("array count within allocation limit").into());
    }
    let mut headers = Vec::new();
    for index in 0..count as usize {
        let header = slot
            .sized()
            .map_err(Failure::from)
            .and_then(|mut pair| read_header(&mut pair))
            .map_err(|failure| failure.at_index(index))?;
        headers.push(header);
    }
    slot.finish()?;
    Ok(headers)
}
fn read_request(r: &mut Reader) -> Result<Request, Failure> {
    let bitmap = r.byte()?;
    let string = |slot: &mut Reader| slot.string();
    let boolean = |slot: &mut Reader| slot.bool();
    let present = |bit: u8| bitmap & bit != 0;
    let span_id = field("spanId", || {
        read_optional(r, present(SPAN_ID), STRING_OR_UNDEFINED, string)
    })?;
    let payload = field("payload", || Ok(r.sized()?.rest().to_vec()))?;
    let id = field("id", || read_request_id(r))?;
    let sampled = field("sampled", || {
        read_optional(r, present(SAMPLED), BOOL_OR_UNDEFINED, boolean)
    })?;
    let tag = field("tag", || Ok(r.sized()?.string()?))?;
    let trace_id = field("traceId", || {
        read_optional(r, present(TRACE_ID), STRING_OR_UNDEFINED, string)
    })?;
    let headers = field("headers", || read_headers(r))?;
    let is_notification = field("isNotification", || {
        read_optional(
            r,
            present(IS_NOTIFICATION),
            BOOL_OR_UNDEFINED,
            |slot| match slot.bool()? {
                true => Ok(true),
                false => Err(Invalid("true")),
            },
        )
    })?;
    Ok(Request {
        id,
        tag,
        payload,
        headers,
        is_notification,
        trace_id,
        span_id,
        sampled,
    })
}
/// One envelope message as its frame.
pub fn put_message(out: &mut Vec<u8>, fingerprint: &[u8; 8], message: &Message) {
    let mut value = Vec::new();
    // A variant without optional fields has an empty bitmap: no bytes.
    match message {
        Message::Request(request) => {
            put_uv(&mut value, REQUEST);
            put_request(&mut value, request);
        }
        Message::Ack { request_id } => {
            put_uv(&mut value, ACK);
            put_request_id(&mut value, request_id);
        }
        Message::Interrupt { request_id } => {
            put_uv(&mut value, INTERRUPT);
            put_request_id(&mut value, request_id);
        }
        Message::Ping => put_uv(&mut value, PING),
        Message::Eof => put_uv(&mut value, EOF),
        Message::Pong => put_uv(&mut value, PONG),
        // `values` sorts before `requestId`, `requestId` before `exit`.
        Message::Chunk { request_id, values } => {
            put_uv(&mut value, CHUNK);
            put_sized(&mut value, values);
            put_request_id(&mut value, request_id);
        }
        Message::Exit { request_id, exit } => {
            put_uv(&mut value, EXIT);
            put_request_id(&mut value, request_id);
            put_sized(&mut value, exit);
        }
        Message::Defect { defect } => {
            put_uv(&mut value, DEFECT);
            put_sized(&mut value, defect);
        }
    }
    put_frame(out, Some(fingerprint), &value);
}
/// One envelope message from a frame's value region.
pub fn read_message(value: &[u8]) -> Result<Message, Failure> {
    let mut r = Reader::new(value);
    let message = match r.uv()? {
        REQUEST => Message::Request(read_request(&mut r)?),
        ACK => Message::Ack {
            request_id: field("requestId", || read_request_id(&mut r))?,
        },
        INTERRUPT => Message::Interrupt {
            request_id: field("requestId", || read_request_id(&mut r))?,
        },
        PING => Message::Ping,
        EOF => Message::Eof,
        PONG => Message::Pong,
        CHUNK => {
            let values = field("values", || Ok(r.sized()?.rest().to_vec()))?;
            Message::Chunk {
                request_id: field("requestId", || read_request_id(&mut r))?,
                values,
            }
        }
        EXIT => {
            let request_id = field("requestId", || read_request_id(&mut r))?;
            Message::Exit {
                request_id,
                exit: field("exit", || Ok(r.sized()?.rest().to_vec()))?,
            }
        }
        DEFECT => Message::Defect {
            defect: field("defect", || Ok(r.sized()?.rest().to_vec()))?,
        },
        _ => return Err(Invalid("known union member").into()),
    };
    r.finish()?;
    Ok(message)
}

// ---- Exit and Cause (`Schema.Exit`, `Schema.Cause`)

/// One reason of a failed Exit's Cause, each already encoded by its own layout.
#[derive(Clone, Debug, PartialEq)]
pub enum Reason {
    Fail(Vec<u8>),
    Die(Vec<u8>),
    Interrupt(Option<f64>),
}
/// A successful Exit, around its encoded value.
pub fn put_exit_success(out: &mut Vec<u8>, value: &[u8]) {
    out.push(0);
    out.extend_from_slice(value);
}
/// A failed Exit, around its Cause's reasons.
pub fn put_exit_failure(out: &mut Vec<u8>, reasons: &[Reason]) {
    out.push(1);
    put_uv(out, reasons.len() as u64);
    for reason in reasons {
        let mut slot = Vec::new();
        match reason {
            Reason::Fail(error) => {
                slot.push(0);
                slot.extend_from_slice(error);
            }
            Reason::Die(defect) => {
                slot.push(1);
                slot.extend_from_slice(defect);
            }
            Reason::Interrupt(None) => slot.push(2),
            Reason::Interrupt(Some(fiber)) => {
                slot.push(3);
                put_f64(&mut slot, *fiber);
            }
        }
        put_sized(out, &slot);
    }
}
/// An Exit: its success value region, or its Cause's reasons, unknown ones dropped.
pub fn read_exit(value: &[u8]) -> Decoded<Result<&[u8], Vec<Reason>>> {
    let mut r = Reader::new(value);
    match r.byte()? {
        0 => Ok(Ok(r.rest())),
        1 => {
            let count = r.uv()?;
            let mut reasons = Vec::new();
            for _ in 0..count {
                let mut slot = r.sized()?;
                match slot.byte()? {
                    0 => reasons.push(Reason::Fail(slot.rest().to_vec())),
                    1 => reasons.push(Reason::Die(slot.rest().to_vec())),
                    2 => {
                        slot.empty()?;
                        reasons.push(Reason::Interrupt(None));
                    }
                    3 => {
                        if slot.remaining() != 8 {
                            return Err(Invalid("f64"));
                        }
                        reasons.push(Reason::Interrupt(Some(slot.f64()?)));
                    }
                    _ => {}
                }
            }
            r.finish()?;
            Ok(Err(reasons))
        }
        _ => Err(Invalid("bool")),
    }
}
