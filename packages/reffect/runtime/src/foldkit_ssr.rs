fn representable(value: &str, context: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("[foldkit] {} contains a NUL (U+0000) character, which has no HTML representation and cannot round-trip. Remove it from the value.", context));
    }
    Ok(())
}
/// `escapeText`: &, <, > and CR.
pub fn escape_text(value: &str, out: &mut String) -> Result<(), String> {
    representable(value, "text content")?;
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#13;"),
            other => out.push(other),
        }
    }
    Ok(())
}
/// `escapeAttributeValue`: &, ", < and CR; > stays as it is.
pub fn escape_attribute(value: &str, out: &mut String) -> Result<(), String> {
    representable(value, "attribute value")?;
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '\r' => out.push_str("&#13;"),
            other => out.push(other),
        }
    }
    Ok(())
}
/// FNV-1a in two 32-bit lanes over UTF-16 code units, as JS's Math.imul computes them.
pub fn fingerprint(value: &str) -> String {
    const PRIME: u32 = 16777619;
    let (mut low, mut high): (u32, u32) = (2166136261, 1099511628);
    for unit in value.encode_utf16() {
        let (low_byte, high_byte) = (u32::from(unit & 0xff), u32::from(unit >> 8));
        low = (low ^ low_byte).wrapping_mul(PRIME);
        low = (low ^ high_byte).wrapping_mul(PRIME);
        high = (high ^ high_byte).wrapping_mul(PRIME);
        high = (high ^ low_byte).wrapping_mul(PRIME);
    }
    format!("{:08x}{:08x}", low, high)
}
/// The marker of a string key; number keys wait for JS number text (SSR-008).
pub fn string_key_marker(key: &str) -> String {
    fingerprint(&format!("s:{}", key))
}
