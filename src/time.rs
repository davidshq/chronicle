//! Timezone helpers.
//!
//! Transcript timestamps — and therefore the stored `started_at` column — are
//! UTC ISO-8601 (`...Z`). Anything that groups by *calendar day* (the markdown
//! `<YYYY-MM-DD>/` folders and the `--today` listing) must convert to the
//! user's local zone first, or sessions recorded near midnight land on the
//! wrong day for any non-UTC user.

use chrono::{DateTime, Local, LocalResult, NaiveDate, TimeZone, Utc};

/// A UTC/offset RFC3339 timestamp rendered as its **local** calendar date
/// (`YYYY-MM-DD`), or `None` if it can't be parsed.
pub fn local_date(ts: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

/// UTC RFC3339 bounds `[start, end)` covering the current local calendar day.
/// `started_at` is stored in UTC, so a local-day filter is a UTC range query.
pub fn today_local_utc_bounds() -> (String, String) {
    let today = Local::now().date_naive();
    let tomorrow = today.succ_opt().unwrap_or(today);
    // End is the *next* local midnight, not start + 24h: a local day is 23h or
    // 25h across a DST transition, and a fixed 24h window would clip or overrun
    // it by an hour on those two days a year.
    (
        fmt_utc(&local_midnight(today)),
        fmt_utc(&local_midnight(tomorrow)),
    )
}

/// Local midnight (00:00) of `date`. Resolves the rare DST "spring-forward" gap
/// — when local midnight doesn't exist — to the next valid instant, and the
/// "fall-back" overlap to the earlier of the two, so we never panic on `unwrap`.
fn local_midnight(date: NaiveDate) -> DateTime<Local> {
    let naive = date.and_hms_opt(0, 0, 0).expect("00:00:00 is always a valid time");
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
        LocalResult::None => date
            .and_hms_opt(1, 0, 0)
            .and_then(|n| Local.from_local_datetime(&n).earliest())
            .unwrap_or_else(|| Utc.from_utc_datetime(&naive).with_timezone(&Local)),
    }
}

/// Format an instant as a UTC RFC3339 string (`...Z`), matching how transcript
/// timestamps are stored so string range comparisons stay well-ordered.
fn fmt_utc(dt: &DateTime<Local>) -> String {
    dt.with_timezone(&Utc)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_date_converts_to_the_machine_local_zone() {
        // The substance of the fix: `local_date` reflects the *instant* in the
        // local zone, not a blind slice of the UTC string. Assert it against an
        // independent local conversion so the test is machine-zone agnostic.
        let ts = "2026-01-06T02:30:00Z";
        let expected = DateTime::parse_from_rfc3339(ts)
            .unwrap()
            .with_timezone(&Local)
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(local_date(ts).as_deref(), Some(expected.as_str()));
        // Fractional-second UTC (transcript format) parses too.
        assert!(local_date("2026-01-06T12:00:00.123Z").is_some());
        // Garbage yields None rather than panicking.
        assert_eq!(local_date("not-a-timestamp"), None);
        assert_eq!(local_date(""), None);
    }

    #[test]
    fn today_bounds_are_a_well_ordered_local_day_utc_window() {
        let (start, end) = today_local_utc_bounds();
        let s = DateTime::parse_from_rfc3339(&start).expect("start is RFC3339");
        let e = DateTime::parse_from_rfc3339(&end).expect("end is RFC3339");
        assert!(s < e, "start must precede end");
        // A local day is 24h normally, 23h/25h across a DST transition — never
        // outside that band. (Asserting exactly 24h would bake in a DST bug.)
        let hours = (e - s).num_hours();
        assert!((23..=25).contains(&hours), "local day spans 23–25h, got {hours}");
        assert!(start.ends_with('Z') && end.ends_with('Z'), "bounds are UTC");
    }
}
