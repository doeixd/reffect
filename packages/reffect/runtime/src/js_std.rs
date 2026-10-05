// ECMAScript and Effect semantics R's pure operations read: std only, so a crate that reaches
// none of them pays nothing, and each function is differential against the JS reference.

/// ECMAScript white space and line terminators, which `String.prototype.trim` and `Number(s)`
/// strip: WhiteSpace (TAB, VT, FF, SP, NBSP, ZWNBSP and the Zs category) and LineTerminator.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\u{000B}' | '\u{000C}' | ' ' | '\u{00A0}' | '\u{FEFF}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\n'
                | '\r'
                | '\u{2028}'
                | '\u{2029}'
    )
}

/// The value of `digits` in `radix` (2, 8 or 16), rounded to the nearest double with ties to
/// even, as ECMAScript reads a NonDecimalIntegerLiteral of any length.
fn radix_value(digits: &str, radix: u32) -> Option<f64> {
    let bits_per_digit = radix.trailing_zeros() as usize;
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit);
    for c in digits.chars() {
        let value = c.to_digit(radix)?;
        for shift in (0..bits_per_digit).rev() {
            bits.push((value >> shift) & 1 == 1);
        }
    }
    let first = match bits.iter().position(|bit| *bit) {
        Some(first) => first,
        None => return Some(0.0),
    };
    let bits = &bits[first..];
    if bits.len() <= 53 {
        return Some(bits.iter().fold(0u64, |acc, bit| (acc << 1) | *bit as u64) as f64);
    }
    // The top 53 bits, rounded by the next bit and whether any bit after it is set.
    let mut mantissa = bits[..53]
        .iter()
        .fold(0u64, |acc, bit| (acc << 1) | *bit as u64);
    let round = bits[53];
    let sticky = bits[54..].iter().any(|bit| *bit);
    let mut exponent = bits.len() - 53;
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
        if mantissa == 1 << 53 {
            mantissa >>= 1;
            exponent += 1;
        }
    }
    if exponent > 1023 - 52 {
        return Some(f64::INFINITY);
    }
    Some(mantissa as f64 * 2f64.powi(exponent as i32))
}

/// Whether `text` is a StrUnsignedDecimalLiteral other than `Infinity`: digits with an optional
/// fraction, or a fraction alone, then an optional exponent. Rust's own parser also takes `inf`,
/// `nan` and other spellings JS does not, so the grammar is checked first.
fn is_unsigned_decimal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    let whole = digits(&mut i);
    let fraction = if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        digits(&mut i)
    } else {
        false
    };
    if !whole && !fraction {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == bytes.len()
}

/// ECMAScript `Number(s)` on a string (StringToNumber): white space trimmed, the empty string 0,
/// `Infinity` with an optional sign, a decimal literal with an optional sign, or a `0x`/`0o`/`0b`
/// integer without one; anything else NaN.
pub fn string_to_number(s: &str) -> f64 {
    let text = s.trim_matches(is_js_space);
    if text.is_empty() {
        return 0.0;
    }
    let lower = text.get(..2).map(str::to_ascii_lowercase);
    let radix = match lower.as_deref() {
        Some("0x") => Some(16),
        Some("0o") => Some(8),
        Some("0b") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        return if digits.is_empty() {
            f64::NAN
        } else {
            radix_value(digits, radix).unwrap_or(f64::NAN)
        };
    }
    let (negative, unsigned) = match text.as_bytes()[0] {
        b'+' => (false, &text[1..]),
        b'-' => (true, &text[1..]),
        _ => (false, text),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else if is_unsigned_decimal(unsigned) {
        match unsigned.parse::<f64>() {
            Ok(value) => value,
            Err(_) => return f64::NAN,
        }
    } else {
        return f64::NAN;
    };
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

/// Effect's `Number.parse` (effect 4.0.0): `NaN`, `Infinity` and `-Infinity` literally, nothing
/// for blank text, else `Number(s)` unless that is NaN.
pub fn number_parse(s: &str) -> Option<f64> {
    match s {
        "NaN" => return Some(f64::NAN),
        "Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if s.trim_matches(is_js_space).is_empty() {
        return None;
    }
    let value = string_to_number(s);
    (!value.is_nan()).then_some(value)
}

/// ECMAScript `Number.isSafeInteger`.
pub fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.trunc() == n && n.abs() <= 9_007_199_254_740_991.0
}

/// A canonical array index, which JS objects order first, ascending.
fn array_index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// ECMAScript `decodeURIComponent`, or None where it throws a URIError: every `%XX` is a byte,
/// and the bytes must be well-formed UTF-8 (no overlong form, surrogate or code point past
/// U+10FFFF), which `from_utf8` checks exactly as the URI decoding algorithm does.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
            let (high, low) = (hex(i + 1)?, hex(i + 2)?);
            out.push((high * 16 + low) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Effect `Cookies.parseHeader` (effect 4.0.0, from fastify-cookie), over UTF-16 code units as
/// JS indexes them, with the result in JS own-property order. A lone surrogate the JS algorithm
/// could leave in a malformed quoted value becomes U+FFFD (recorded in native divergences).
pub fn cookies_parse_header(header: &str) -> Vec<(String, String)> {
    let units: Vec<u16> = header.encode_utf16().collect();
    let len = units.len();
    let index_of = |unit: u8, from: usize| {
        units
            .get(from.min(len)..)
            .and_then(|rest| rest.iter().position(|u| *u == unit as u16))
            .map(|at| at + from)
    };
    // JS `substring`: clamped, and swapped when start > end.
    let substring = |start: usize, end: usize| {
        let (start, end) = (start.min(len), end.min(len));
        let (start, end) = if start > end {
            (end, start)
        } else {
            (start, end)
        };
        String::from_utf16_lossy(&units[start..end])
    };
    let trim = |text: String| text.trim_matches(is_js_space).to_string();
    let mut indexed: Vec<(u32, String, String)> = Vec::new();
    let mut named: Vec<(String, String)> = Vec::new();
    let mut pos = 0;
    let mut terminator = 0;
    loop {
        if terminator == len {
            break;
        }
        terminator = index_of(b';', pos).unwrap_or(len);
        let Some(eq) = index_of(b'=', pos) else {
            break;
        };
        if eq > terminator {
            pos = terminator + 1;
            continue;
        }
        let key = trim(substring(pos, eq));
        let value_at = eq + 1;
        let taken =
            indexed.iter().any(|(_, k, _)| *k == key) || named.iter().any(|(k, _)| *k == key);
        if !taken {
            let value = if units.get(value_at) == Some(&0x22) {
                trim(substring(value_at + 1, terminator.saturating_sub(1)))
            } else {
                trim(substring(value_at, terminator))
            };
            let value = if value.contains('%') {
                decode_uri_component(&value).unwrap_or(value)
            } else {
                value
            };
            match array_index(&key) {
                Some(index) => indexed.push((index, key, value)),
                None => named.push((key, value)),
            }
        }
        pos = terminator + 1;
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}
