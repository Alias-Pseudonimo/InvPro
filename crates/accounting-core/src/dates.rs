//! Date arithmetic for schedules. Dates are `YYYY-MM-DD` strings because that
//! is what SQLite stores and what sorts correctly; the only thing needed on top
//! of that is moving a date forward by days or by whole months.

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn parts(date: &str) -> Option<(i64, i64, i64)> {
    let mut pieces = date.split('-');
    let year: i64 = pieces.next()?.parse().ok()?;
    let month: i64 = pieces.next()?.parse().ok()?;
    let day: i64 = pieces.next()?.parse().ok()?;
    if pieces.next().is_some() {
        return None;
    }
    Some((year, month, day))
}

fn format(year: i64, month: i64, day: i64) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 30,
    }
}

/// Move a date forward (or backward) by whole days.
pub fn add_days(date: &str, days: i64) -> String {
    let (year, month, day) = parts(date).unwrap_or((1970, 1, 1));
    let (year, month, day) = civil_from_days(days_from_civil(year, month, day) + days);
    format(year, month, day)
}

/// Move a date forward (or backward) by whole months, keeping the day where it
/// exists and clamping to the last day of the month otherwise: 31 January plus
/// one month is 28 (or 29) February.
pub fn add_months(date: &str, months: i64) -> String {
    let (year, month, day) = parts(date).unwrap_or((1970, 1, 1));
    let total = year * 12 + (month - 1) + months;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    let day = day.min(days_in_month(year, month));
    format(year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_cross_months_and_years() {
        assert_eq!(add_days("2026-01-31", 1), "2026-02-01");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(add_days("2024-02-28", 1), "2024-02-29");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(add_days("2026-06-15", 30), "2026-07-15");
    }

    #[test]
    fn months_clamp_to_the_end_of_the_month() {
        assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_months("2024-01-31", 1), "2024-02-29");
        assert_eq!(add_months("2026-11-15", 3), "2027-02-15");
        assert_eq!(add_months("2026-05-31", 12), "2027-05-31");
    }
}
