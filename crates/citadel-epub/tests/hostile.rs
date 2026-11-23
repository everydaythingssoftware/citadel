//! Hostile EPUBs, each read in a child process on a thread with a 256 KiB
//! stack, so a stack overflow aborts the child rather than this test. The
//! child also counts the reading thread's heap and fails above 32 MiB.
use citadel_epub::fixtures as support;

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::Cursor,
    process::Command,
};

use citadel_epub::{fixtures::Build, EpubError, Part, Refusal, Unreadable};

struct Counting;

thread_local! {
    static CURRENT: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn grew(bytes: usize) {
    let _ = CURRENT.try_with(|current| {
        let now = current.get() + bytes;
        current.set(now);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
    });
}

fn shrank(bytes: usize) {
    let _ = CURRENT.try_with(|current| current.set(current.get().saturating_sub(bytes)));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        shrank(layout.size());
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            shrank(layout.size());
            grew(new_size);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const CHILD_STACK: usize = 256 * 1024;
const MAX_PEAK_HEAP: usize = 32 * 1024 * 1024;
const CASE: &str = "CITADEL_EPUB_HOSTILE_CASE";

type Expectation = fn(&Result<citadel_epub::Package, EpubError>) -> bool;

fn refused(result: &Result<citadel_epub::Package, EpubError>, check: fn(&Refusal) -> bool) -> bool {
    matches!(result, Err(EpubError::Refused(refusal)) if check(refusal))
}

/// Each hostile fixture and what reading it must give.
fn cases() -> Vec<(&'static str, Build, Expectation)> {
    let expectations: [(&str, Expectation); 8] = [
        ("opf-depth-70k", |result| {
            refused(result, |r| {
                matches!(
                    r,
                    Refusal::TooDeep {
                        part: Part::Package,
                        ..
                    }
                )
            })
        }),
        ("xmlns-1000-on-one-element", |result| {
            refused(result, |r| matches!(r, Refusal::TooManyAttributes { .. }))
        }),
        ("xmlns-1000-in-scope", |result| {
            refused(result, |r| {
                matches!(r, Refusal::TooManyNamespaces { limit: 256, .. })
            })
        }),
        ("opf-9mib", |result| {
            refused(
                result,
                |r| matches!(r, Refusal::TooLarge { part: Part::Package, limit } if *limit == 8 << 20),
            )
        }),
        ("container-1mib", |result| {
            refused(
                result,
                |r| matches!(r, Refusal::TooLarge { part: Part::Container, limit } if *limit == 64 << 10),
            )
        }),
        ("cd-1m-entries", |result| {
            refused(result, |r| {
                matches!(r, Refusal::TooManyEntries { limit: 20_000 })
            })
        }),
        ("rootfile-empty", |result| {
            refused(result, |r| matches!(r, Refusal::NoRootfile))
        }),
        ("rootfile-parent", |result| {
            refused(result, |r| matches!(r, Refusal::InvalidRootfile))
        }),
    ];
    let mut fixtures = support::hostile();
    let mut cases: Vec<(&str, Build, Expectation)> = expectations
        .into_iter()
        .map(|(name, expectation)| {
            let at = fixtures
                .iter()
                .position(|(fixture, _)| *fixture == name)
                .unwrap();
            (name, fixtures.swap_remove(at).1, expectation)
        })
        .collect();
    assert!(
        fixtures.is_empty(),
        "every hostile fixture has an expectation"
    );

    let extra: [(&str, Build, Expectation); 8] = [
        (
            "opf-9mib-declared-small",
            || {
                support::understated(
                    support::padded_package(9 * 1024 * 1024).build(),
                    support::PACKAGE_PATH,
                )
            },
            |result| {
                refused(result, |r| {
                    matches!(
                        r,
                        Refusal::TooLarge {
                            part: Part::Package,
                            ..
                        }
                    )
                })
            },
        ),
        (
            "elements-300k",
            || {
                support::Builder::book(
                    &format!("{}{}", support::METADATA, "<x/>".repeat(300_000)),
                    "",
                )
                .build()
            },
            |result| refused(result, |r| matches!(r, Refusal::TooManyElements { .. })),
        ),
        (
            "metadata-items-5k",
            || {
                support::Builder::book(
                    &format!(
                        "{}{}",
                        support::METADATA,
                        "<dc:subject>s</dc:subject>".repeat(5_000)
                    ),
                    "",
                )
                .build()
            },
            |result| {
                refused(result, |r| {
                    matches!(r, Refusal::TooManyMetadataItems { .. })
                })
            },
        ),
        (
            "value-70kib",
            || {
                support::Builder::book(
                    &format!(
                        "{}<dc:description>{}</dc:description>",
                        support::METADATA,
                        "x".repeat(70 * 1024)
                    ),
                    "",
                )
                .build()
            },
            |result| refused(result, |r| matches!(r, Refusal::ValueTooLong { .. })),
        ),
        (
            "entity-expansion",
            || {
                support::Builder::with_package(format!(
                r#"<?xml version="1.0"?><!DOCTYPE package [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>{}"#,
                support::package("3.0", "<dc:title>&c;</dc:title>", "")
                    .trim_start_matches(r#"<?xml version="1.0" encoding="UTF-8"?>"#)
            ))
            .build()
            },
            |result| {
                matches!(
                    result,
                    Err(EpubError::Unreadable(Unreadable::Malformed(Part::Package)))
                )
            },
        ),
        (
            // The locator names a small decoy record, but the zip crate
            // only accepts the record that ends at the locator: 30,000.
            "zip64-decoy-record",
            || support::zip64_end_records(&[(1, 0), (30_000, 0)], 0),
            |result| refused(result, |r| matches!(r, Refusal::TooManyEntries { .. })),
        ),
        (
            // The zip crate reads a zip64 record's extensible data into
            // memory, however large it claims to be.
            "zip64-huge-extensible-data",
            || support::zip64_end_records(&[(1, 5 * 1024 * 1024)], 0),
            |result| {
                refused(result, |r| {
                    matches!(r, Refusal::CentralDirectoryTooLarge { .. })
                })
            },
        ),
        (
            // A decoy record that fits before the locator but doesn't end at
            // it: the zip crate reads its 5 MiB of extensible data before it
            // moves on to the real record.
            "zip64-decoy-extensible-data",
            || support::zip64_end_records(&[(1, 5 * 1024 * 1024), (1, 0)], 0),
            |result| {
                refused(result, |r| {
                    matches!(r, Refusal::CentralDirectoryTooLarge { .. })
                })
            },
        ),
    ];
    cases.extend(extra);
    cases
}

/// Reads one case on a small stack, reporting its heap peak.
fn run_case(name: &str) {
    let (_, build, expectation) = cases()
        .into_iter()
        .find(|(case, ..)| *case == name)
        .unwrap_or_else(|| panic!("no case {name}"));
    let bytes = build();
    let (outcome, peak) = std::thread::Builder::new()
        .stack_size(CHILD_STACK)
        .spawn(move || {
            let result = citadel_epub::read(Cursor::new(bytes));
            let ok = expectation(&result);
            let description = format!("{result:?}");
            (
                (ok, description.chars().take(300).collect::<String>()),
                PEAK.with(Cell::get),
            )
        })
        .unwrap()
        .join()
        .unwrap();
    println!("case {name}: peak heap {} KiB, {}", peak / 1024, outcome.1);
    assert!(outcome.0, "{name}: unexpected result {}", outcome.1);
    assert!(peak < MAX_PEAK_HEAP, "{name}: peak heap {peak} bytes");
}

#[test]
fn child() {
    if let Ok(name) = std::env::var(CASE) {
        run_case(&name);
    }
}

#[test]
fn hostile_epubs_are_refused_without_crashing() {
    let exe = std::env::current_exe().unwrap();
    let mut failures = Vec::new();
    for (name, ..) in cases() {
        let output = Command::new(&exe)
            .args(["child", "--exact", "--nocapture", "--test-threads=1"])
            .env(CASE, name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .find_map(|line| line.find("case ").map(|at| &line[at..]))
            .unwrap_or("");
        println!("{line}");
        if !output.status.success() || line.is_empty() {
            failures.push(format!(
                "{name}: {:?}\n{stdout}\n{}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
