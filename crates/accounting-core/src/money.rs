//! Money is stored as signed integer cents everywhere. No floats touch the
//! books; the only text parsing happens at the UI boundary.

use crate::{CoreError, Result};

/// Parse a user-entered amount such as `"1,234.5"`, `"$80"` or `"-12.34"` into
/// cents. Rejects anything that is not an unambiguous amount.
pub fn parse(input: &str) -> Result<i64> {
    let raw: String = input
        .trim()
        .chars()
        .filter(|c| !matches!(c, '$' | ',' | '_' | ' '))
        .collect();
    if raw.is_empty() {
        return Err(CoreError::validation("an amount is required"));
    }

    let (negative, unsigned) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw.strip_prefix('+').unwrap_or(&raw)),
    };
    if unsigned.starts_with('-') {
        return Err(CoreError::validation("invalid amount"));
    }

    let mut parts = unsigned.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(CoreError::validation("invalid amount: too many decimal points"));
    }
    if whole.is_empty() && fraction.is_empty() {
        return Err(CoreError::validation("invalid amount"));
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !fraction.chars().all(|c| c.is_ascii_digit()) {
        return Err(CoreError::validation("invalid amount: digits only"));
    }
    if fraction.len() > 2 {
        return Err(CoreError::validation(
            "amounts are recorded in whole cents: at most two decimal places",
        ));
    }

    let whole_value: i128 = if whole.is_empty() {
        0
    } else {
        whole
            .parse()
            .map_err(|_| CoreError::validation("amount is too large"))?
    };
    let fraction_value: i128 = match fraction.len() {
        0 => 0,
        1 => i128::from(fraction.parse::<u8>().unwrap_or(0)) * 10,
        _ => i128::from(fraction.parse::<u8>().unwrap_or(0)),
    };

    let cents = whole_value
        .checked_mul(100)
        .and_then(|value| value.checked_add(fraction_value))
        .ok_or_else(|| CoreError::validation("amount is too large"))?;
    i64::try_from(if negative { -cents } else { cents })
        .map_err(|_| CoreError::validation("amount is too large"))
}

/// Render cents as `1,234.56` (or `-1,234.56`).
pub fn format(cents: i64) -> String {
    let negative = cents < 0;
    let magnitude = (cents as i128).abs();
    let whole = magnitude / 100;
    let fraction = magnitude % 100;

    let digits = whole.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }

    format!(
        "{}{}.{:02}",
        if negative { "-" } else { "" },
        grouped,
        fraction
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_decorated_amounts() {
        assert_eq!(parse("1234.56").unwrap(), 123_456);
        assert_eq!(parse("$1,234.56").unwrap(), 123_456);
        assert_eq!(parse("0.5").unwrap(), 50);
        assert_eq!(parse(".05").unwrap(), 5);
        assert_eq!(parse("42").unwrap(), 4_200);
        assert_eq!(parse("-12.34").unwrap(), -1_234);
        assert_eq!(parse("0").unwrap(), 0);
    }

    #[test]
    fn rejects_ambiguous_amounts() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
        assert!(parse("1.2.3").is_err());
        assert!(parse("1.234").is_err());
        assert!(parse("twelve").is_err());
        assert!(parse("--5").is_err());
        assert!(parse("99999999999999999999").is_err());
    }

    #[test]
    fn formats_with_grouping() {
        assert_eq!(format(123_456), "1,234.56");
        assert_eq!(format(-5), "-0.05");
        assert_eq!(format(0), "0.00");
        assert_eq!(format(1_000_000_00), "1,000,000.00");
    }
}
