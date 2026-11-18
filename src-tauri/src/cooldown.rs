//! Backing off when AO3 says so. A 429 ("slow down") stops every AO3
//! request for five minutes, or for as long as AO3's Retry-After asks if
//! that is longer; a 503 ("overloaded") for one minute. Another one within
//! the hour doubles the wait, up to 30 and 10 minutes. The state is a line
//! of text so it can be kept on disk and survive the app being closed.
//!
//! Free of external crates so it can be tested on its own.

const SLOW_DOWN_BASE: i64 = 5 * 60;
const SLOW_DOWN_MAX: i64 = 30 * 60;
const BUSY_BASE: i64 = 60;
const BUSY_MAX: i64 = 10 * 60;
/// Hits further apart than this start counting from the beginning again.
const MEMORY: i64 = 60 * 60;
/// Never trust a Retry-After longer than this.
const RETRY_AFTER_MAX: i64 = 2 * 60 * 60;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Cooldown {
    /// Unix seconds until which no request is sent.
    pub until: i64,
    /// 429 or 503: what started the current wait.
    pub reason: u16,
    slow_strikes: u32,
    busy_strikes: u32,
    last_hit: i64,
}

impl Cooldown {
    /// Seconds left to wait, if any.
    pub fn remaining(&self, now: i64) -> Option<i64> {
        (self.until > now).then(|| self.until - now)
    }

    /// Record an answer from AO3. Returns true if it started (or lengthened)
    /// a wait.
    pub fn answered(&mut self, now: i64, status: u16, retry_after: Option<i64>) -> bool {
        if status != 429 && status != 503 {
            return false;
        }
        if now - self.last_hit > MEMORY {
            self.slow_strikes = 0;
            self.busy_strikes = 0;
        }
        self.last_hit = now;
        let wait = if status == 429 {
            let w = backoff(SLOW_DOWN_BASE, SLOW_DOWN_MAX, self.slow_strikes);
            self.slow_strikes += 1;
            w
        } else {
            let w = backoff(BUSY_BASE, BUSY_MAX, self.busy_strikes);
            self.busy_strikes += 1;
            w
        };
        let asked = retry_after.unwrap_or(0).clamp(0, RETRY_AFTER_MAX);
        let until = now + wait.max(asked);
        if until > self.until {
            self.until = until;
            self.reason = status;
        }
        true
    }

    pub fn to_line(&self) -> String {
        format!(
            "{} {} {} {} {}",
            self.until, self.reason, self.slow_strikes, self.busy_strikes, self.last_hit
        )
    }

    pub fn from_line(s: &str) -> Cooldown {
        let n: Vec<i64> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if n.len() != 5 {
            return Cooldown::default();
        }
        Cooldown {
            until: n[0],
            reason: n[1].clamp(0, 999) as u16,
            slow_strikes: n[2].clamp(0, 16) as u32,
            busy_strikes: n[3].clamp(0, 16) as u32,
            last_hit: n[4],
        }
    }
}

fn backoff(base: i64, max: i64, strikes: u32) -> i64 {
    base.saturating_mul(1i64 << strikes.min(10)).min(max)
}

/// Retry-After in seconds. AO3 sends a number when it sends one at all;
/// the HTTP-date form is ignored (the defaults then apply).
pub fn parse_retry_after(value: &str) -> Option<i64> {
    value.trim().parse::<i64>().ok().filter(|s| *s >= 0)
}

/// "4:05" or "12 min" for a wait, for messages.
pub fn describe(secs: i64) -> String {
    if secs >= 600 {
        format!("{} min", (secs + 59) / 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    }
}

/// At most this many works saved in any hour.
pub const SAVES_PER_HOUR: usize = 30;
const HOUR: i64 = 60 * 60;

/// When works were saved in the last hour, for the hourly limit.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Budget {
    times: Vec<i64>,
}

impl Budget {
    fn prune(&mut self, now: i64) {
        self.times.retain(|t| *t > now - HOUR && *t <= now);
    }

    /// Seconds until another save is allowed, if the limit is reached.
    pub fn wait(&mut self, now: i64) -> Option<i64> {
        self.prune(now);
        if self.times.len() < SAVES_PER_HOUR {
            return None;
        }
        let oldest = *self.times.iter().min()?;
        Some((oldest + HOUR - now).max(1))
    }

    pub fn record(&mut self, now: i64) {
        self.prune(now);
        self.times.push(now);
    }

    pub fn to_line(&self) -> String {
        self.times.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(" ")
    }

    pub fn from_line(s: &str) -> Budget {
        Budget { times: s.split_whitespace().filter_map(|x| x.parse().ok()).take(1000).collect() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_and_forgets() {
        let mut c = Cooldown::default();
        assert_eq!(c.remaining(0), None);
        assert!(!c.answered(0, 200, None));
        assert!(c.answered(1000, 429, None));
        assert_eq!(c.remaining(1000), Some(300));
        assert_eq!(c.reason, 429);
        // Again soon: doubled, then doubled, then capped.
        c.answered(1400, 429, None);
        assert_eq!(c.remaining(1400), Some(600));
        c.answered(2100, 429, None);
        assert_eq!(c.remaining(2100), Some(1200));
        c.answered(3400, 429, None);
        assert_eq!(c.remaining(3400), Some(1800));
        c.answered(5300, 429, None);
        assert_eq!(c.remaining(5300), Some(1800));
        // Over an hour later: back to the start.
        c.answered(5300 + 3601, 429, None);
        assert_eq!(c.remaining(5300 + 3601), Some(300));
    }

    #[test]
    fn busy_is_shorter_and_retry_after_wins_when_longer() {
        let mut c = Cooldown::default();
        c.answered(0, 503, None);
        assert_eq!(c.remaining(0), Some(60));
        assert_eq!(c.reason, 503);
        let mut d = Cooldown::default();
        d.answered(0, 429, Some(900));
        assert_eq!(d.remaining(0), Some(900));
        let mut e = Cooldown::default();
        e.answered(0, 429, Some(10));
        assert_eq!(e.remaining(0), Some(300));
        let mut f = Cooldown::default();
        f.answered(0, 429, Some(99_999));
        assert_eq!(f.remaining(0), Some(RETRY_AFTER_MAX));
    }

    #[test]
    fn a_shorter_wait_never_cuts_a_longer_one() {
        let mut c = Cooldown::default();
        c.answered(0, 429, Some(1200));
        c.answered(10, 503, None);
        assert_eq!(c.remaining(10), Some(1190));
        assert_eq!(c.reason, 429);
    }

    #[test]
    fn round_trips_and_text() {
        let mut c = Cooldown::default();
        c.answered(50, 429, None);
        c.answered(60, 503, None);
        assert_eq!(Cooldown::from_line(&c.to_line()), c);
        assert_eq!(Cooldown::from_line("garbage"), Cooldown::default());
        assert_eq!(parse_retry_after(" 120 "), Some(120));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(describe(65), "1:05");
        assert_eq!(describe(1800), "30 min");
    }

    #[test]
    fn hourly_budget() {
        let mut b = Budget::default();
        for i in 0..SAVES_PER_HOUR as i64 {
            assert_eq!(b.wait(1000 + i), None);
            b.record(1000 + i);
        }
        // Full: the next one waits until the first is an hour old.
        assert_eq!(b.wait(1100), Some(1000 + 3600 - 1100));
        assert_eq!(b.wait(1000 + 3600), None);
        let line = b.to_line();
        assert_eq!(Budget::from_line(&line), b);
    }
}
