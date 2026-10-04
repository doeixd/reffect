fn path_error(message: &str, name: Option<&str>) -> String {
    match name {
        None => message.to_string(),
        Some(name) => format!(
            "{}\n  at [{}]",
            message,
            serde_json::to_string(name).unwrap()
        ),
    }
}
fn u64_arg(value: &Value, name: Option<&str>) -> Result<u64, String> {
    let text = value
        .as_str()
        .ok_or_else(|| path_error("Expected string", name))?;
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(path_error("Expected a string representing a bigint", name));
    }
    let significant = digits.trim_start_matches('0');
    if text.starts_with('-') && !significant.is_empty() {
        return Err(path_error(
            "Expected a value greater than or equal to 0n",
            name,
        ));
    }
    if significant.len() > 20 || (significant.len() == 20 && significant > "18446744073709551615") {
        return Err(path_error(
            "Expected a value less than or equal to 18446744073709551615n",
            name,
        ));
    }
    if significant.is_empty() {
        Ok(0)
    } else {
        significant
            .parse()
            .map_err(|_| path_error("Invalid u64", name))
    }
}
#[allow(dead_code)]
fn u64_range_arg(
    value: &Value,
    name: Option<&str>,
    minimum: u64,
    maximum: u64,
) -> Result<u64, String> {
    let decoded = u64_arg(value, name)?;
    if decoded < minimum {
        return Err(path_error(
            &format!("Expected a value greater than or equal to {}n", minimum),
            name,
        ));
    }
    if decoded > maximum {
        return Err(path_error(
            &format!("Expected a value less than or equal to {}n", maximum),
            name,
        ));
    }
    Ok(decoded)
}
fn string_arg(value: &Value, name: Option<&str>) -> Result<String, String> {
    // serde_json strings are always well-formed, so StringJson's check cannot fail here.
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| path_error("Expected string", name))
}
fn bool_arg(value: &Value, name: Option<&str>) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| path_error("Expected boolean", name))
}
fn unit_arg(value: &Value, name: Option<&str>) -> Result<(), String> {
    if value.is_null() {
        Ok(())
    } else {
        Err(path_error("Expected null", name))
    }
}
