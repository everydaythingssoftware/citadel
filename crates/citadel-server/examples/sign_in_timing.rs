//! Whether sign-in timing shows which usernames exist (ADR 0017). Times
//! password sign-ins for a real user and for unknown names, and OPDS key
//! checks for a username with keys and one without, alternating, then tests
//! each pair for equivalence (TOST, two one-sided Welch t-tests) within a
//! margin of ±2% of the real user's mean.
//!
//!     cargo run --release -p citadel-server --example sign_in_timing
use std::time::Instant;

use citadel_core::store::{warm_dummy_hash, CitadelStore, DeviceKeyVerifier};

const WARM_UP: usize = 100;
const SAMPLES: usize = 2_000;
/// OPDS checks are microseconds, so each sample times this many.
const OPDS_BATCH: usize = 200;
const MARGIN: f64 = 0.02;
/// One-sided 95%: equivalent when the 90% interval lies within the margin.
const Z_95: f64 = 1.644_853_6;

struct Summary {
    mean: f64,
    variance: f64,
    count: f64,
}

fn summary(samples: &[f64]) -> Summary {
    let count = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / count;
    let variance = samples
        .iter()
        .map(|sample| (sample - mean).powi(2))
        .sum::<f64>()
        / (count - 1.0);
    Summary {
        mean,
        variance,
        count,
    }
}

/// The mean of the middle 90%, with the winsorized variance Yuen's test
/// uses, so a few scheduler hiccups don't decide the result.
fn trimmed(samples: &[f64]) -> Summary {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let cut = sorted.len() / 20;
    let kept = &sorted[cut..sorted.len() - cut];
    let low = kept[0];
    let high = kept[kept.len() - 1];
    let winsorized: Vec<f64> = sorted.iter().map(|value| value.clamp(low, high)).collect();
    let mean = kept.iter().sum::<f64>() / kept.len() as f64;
    let winsorized_mean = winsorized.iter().sum::<f64>() / winsorized.len() as f64;
    let variance = winsorized
        .iter()
        .map(|value| (value - winsorized_mean).powi(2))
        .sum::<f64>()
        / (winsorized.len() as f64 - 1.0);
    // Yuen: the winsorized variance, scaled to the trimmed count.
    let count = kept.len() as f64;
    Summary {
        mean,
        variance: variance * (sorted.len() as f64 - 1.0) / (count - 1.0),
        count,
    }
}

/// Two one-sided Welch t-tests of |mean(a) - mean(b)| < margin × mean(a).
fn tost(label: &str, unit: &str, a: &Summary, b: &Summary) -> bool {
    let margin = MARGIN * a.mean;
    let difference = a.mean - b.mean;
    let (va, vb) = (a.variance / a.count, b.variance / b.count);
    let error = (va + vb).sqrt();
    let freedom = (va + vb).powi(2) / (va.powi(2) / (a.count - 1.0) + vb.powi(2) / (b.count - 1.0));
    // Cornish-Fisher: Student's t from the normal quantile.
    let critical = Z_95 + (Z_95.powi(3) + Z_95) / (4.0 * freedom);
    let lower = (difference + margin) / error;
    let upper = (margin - difference) / error;
    let equivalent = lower > critical && upper > critical;
    println!(
        "{label}: {:.3} vs {:.3} {unit}, difference {:+.3} {unit} ({:+.2}%), 90% CI [{:+.3}, {:+.3}], \
         margin ±{:.3}, t = {:.1} / {:.1} (critical {:.2}, df {:.0}): {}",
        a.mean,
        b.mean,
        difference,
        100.0 * difference / a.mean,
        difference - critical * error,
        difference + critical * error,
        margin,
        lower,
        upper,
        critical,
        freedom,
        if equivalent {
            "EQUIVALENT"
        } else {
            "NOT SHOWN EQUIVALENT"
        }
    );
    equivalent
}

fn main() {
    let directory =
        std::env::temp_dir().join(format!("citadel-sign-in-timing-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let store = CitadelStore::open(&directory.join("citadel.db")).unwrap();
    store.create_user("alice", "correct horse battery").unwrap();
    warm_dummy_hash();

    let sign_in = |username: &str| {
        let started = Instant::now();
        let stored = store.lookup_hash(username).unwrap();
        let user = stored.verify("wrong password");
        let elapsed = started.elapsed().as_secs_f64() * 1e3;
        assert!(user.is_none());
        elapsed
    };
    for round in 0..WARM_UP {
        sign_in("alice");
        sign_in(&format!("nobody-{round}"));
    }
    let (mut known, mut unknown) = (Vec::new(), Vec::new());
    for round in 0..SAMPLES {
        known.push(sign_in("alice"));
        unknown.push(sign_in(&format!("nobody-{round}")));
    }

    let verifiers: Vec<DeviceKeyVerifier> = ["kobo", "koreader", "phone", "tablet"]
        .iter()
        .map(|device| DeviceKeyVerifier::new(device, "reader", "wren724=wolf"))
        .collect();
    let opds = |username: &str| {
        let started = Instant::now();
        for _ in 0..OPDS_BATCH {
            let matched = verifiers.iter().fold(false, |matched, key| {
                matched | key.matches(username, b"wrong424=key")
            });
            assert!(!std::hint::black_box(matched));
        }
        started.elapsed().as_secs_f64() * 1e6 / OPDS_BATCH as f64
    };
    for _ in 0..WARM_UP {
        opds("reader");
        opds("nobody");
    }
    let (mut with_keys, mut without_keys) = (Vec::new(), Vec::new());
    for _ in 0..SAMPLES {
        with_keys.push(opds("reader"));
        without_keys.push(opds("nobody"));
    }

    println!(
        "{SAMPLES} alternating samples each after {WARM_UP} warm-up rounds; margin ±{}%",
        MARGIN * 100.0
    );
    let results = [
        tost(
            "sign-in, real vs unknown user (mean)",
            "ms",
            &summary(&known),
            &summary(&unknown),
        ),
        tost(
            "sign-in, real vs unknown user (5% trimmed)",
            "ms",
            &trimmed(&known),
            &trimmed(&unknown),
        ),
        tost(
            "OPDS check, username with keys vs without (mean)",
            "µs",
            &summary(&with_keys),
            &summary(&without_keys),
        ),
        tost(
            "OPDS check, username with keys vs without (5% trimmed)",
            "µs",
            &trimmed(&with_keys),
            &trimmed(&without_keys),
        ),
    ];
    drop(store);
    let _ = std::fs::remove_dir_all(&directory);
    if results.iter().any(|equivalent| !equivalent) {
        std::process::exit(1);
    }
}
