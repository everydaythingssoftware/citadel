//! Vets an archive's end-of-central-directory record before the zip crate
//! sees it. The zip crate reserves memory for as many entries as the record
//! declares, so a few hundred bytes could otherwise claim millions of them.
//!
//! The zip crate reads the newest end record whose comment fits in the file
//! and falls back to older ones, and accepts any zip64 record that ends
//! exactly at the zip64 locator. Every record it could use is held to the
//! limits here, including the size of a zip64 record's extensible data,
//! which it reads into memory. The central directory of the record it reads
//! first is then walked to check it holds that many entries.
use std::io::{Read, Seek, SeekFrom};

use crate::{
    error::{EpubError, Refusal, Unreadable},
    limits::{MAX_ARCHIVE_ENTRIES, MAX_CENTRAL_DIRECTORY_BYTES},
};

const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
const EOCD_LEN: u64 = 22;
const LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";
const LOCATOR_LEN: u64 = 20;
const EOCD64_SIGNATURE: &[u8; 4] = b"PK\x06\x06";
const EOCD64_LEN: u64 = 56;
const HEADER_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
const HEADER_LEN: usize = 46;
const MAX_COMMENT: u64 = u16::MAX as u64;
const SCAN_CHUNK: usize = 64 * 1024;

fn unreadable() -> EpubError {
    EpubError::Unreadable(Unreadable::NotAZip)
}

fn io(_: std::io::Error) -> EpubError {
    unreadable()
}

fn u16_at(bytes: &[u8], at: usize) -> u64 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]]) as u64
}

fn u32_at(bytes: &[u8], at: usize) -> u64 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap_or_default()) as u64
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap_or_default())
}

fn read_at<R: Read + Seek>(reader: &mut R, at: u64, len: usize) -> Result<Vec<u8>, EpubError> {
    reader.seek(SeekFrom::Start(at)).map_err(io)?;
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).map_err(io)?;
    Ok(bytes)
}

/// The first offset in `from..until` where `signature` starts, trying
/// `from` itself first.
fn find_forward<R: Read + Seek>(
    reader: &mut R,
    signature: &[u8; 4],
    from: u64,
    until: u64,
) -> Result<Option<u64>, EpubError> {
    let mut at = from;
    while at + 4 <= until {
        let len = ((until - at) as usize).min(SCAN_CHUNK);
        let chunk = read_at(reader, at, len)?;
        if let Some(found) = chunk.windows(4).position(|window| window == signature) {
            return Ok(Some(at + found as u64));
        }
        if len < 4 || at + len as u64 >= until {
            break;
        }
        at += len as u64 - 3;
    }
    Ok(None)
}

struct Directory {
    entries: u64,
    /// Where the entries are said to start, relative to the archive.
    relative_start: u64,
    /// Bytes prepended to the archive, as far as the record tells.
    archive_offset: u64,
    /// Where the directory has to end.
    end: u64,
}

fn check_counts(entries: &[u64], size: u64) -> Result<(), EpubError> {
    if entries.iter().any(|entries| *entries > MAX_ARCHIVE_ENTRIES) {
        return Err(Refusal::TooManyEntries {
            limit: MAX_ARCHIVE_ENTRIES,
        }
        .into());
    }
    if size > MAX_CENTRAL_DIRECTORY_BYTES {
        return Err(Refusal::CentralDirectoryTooLarge {
            limit: MAX_CENTRAL_DIRECTORY_BYTES,
        }
        .into());
    }
    Ok(())
}

/// End records the zip crate might use: every signature whose comment fits
/// in the file, newest first. It reads the newest and falls back to older
/// ones, so each is held to the limits. A real archive has one.
const MAX_END_RECORDS: usize = 4;
/// zip64 end records between the locator's offset and the locator itself.
const MAX_ZIP64_END_RECORDS: usize = 16;

fn find_eocds<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> Result<Vec<(u64, Vec<u8>)>, EpubError> {
    if file_len < EOCD_LEN {
        return Err(unreadable());
    }
    let tail_start = file_len.saturating_sub(EOCD_LEN + MAX_COMMENT);
    let tail = read_at(reader, tail_start, (file_len - tail_start) as usize)?;
    let last = tail.len() - EOCD_LEN as usize;
    let found: Vec<(u64, Vec<u8>)> = (0..=last)
        .rev()
        .filter(|at| &tail[*at..at + 4] == EOCD_SIGNATURE)
        .filter(|at| tail_start + *at as u64 + EOCD_LEN + u16_at(&tail, at + 20) <= file_len)
        .take(MAX_END_RECORDS + 1)
        .map(|at| {
            (
                tail_start + at as u64,
                tail[at..at + EOCD_LEN as usize].to_vec(),
            )
        })
        .collect();
    if found.is_empty() || found.len() > MAX_END_RECORDS {
        return Err(unreadable());
    }
    Ok(found)
}

/// Every end record the zip crate could use must be within the limits;
/// the walk then checks the newest one it would read.
fn directory<R: Read + Seek>(reader: &mut R, file_len: u64) -> Result<Directory, EpubError> {
    let mut chosen = None;
    for (eocd_at, eocd) in find_eocds(reader, file_len)? {
        match directory_at(reader, eocd_at, &eocd) {
            Ok(found) => {
                chosen.get_or_insert(found);
            }
            Err(EpubError::Refused(refusal)) => return Err(EpubError::Refused(refusal)),
            // The zip crate rejects such a record too, and tries the next.
            Err(_) => {}
        }
    }
    chosen.ok_or_else(unreadable)
}

fn directory_at<R: Read + Seek>(
    reader: &mut R,
    eocd_at: u64,
    eocd: &[u8],
) -> Result<Directory, EpubError> {
    let entries_here = u16_at(eocd, 8);
    let entries = u16_at(eocd, 10);
    let size = u32_at(eocd, 12);
    let start = u32_at(eocd, 16);

    let may_be_zip64 = entries == u16::MAX as u64 || start == u32::MAX as u64;
    let locator = match eocd_at.checked_sub(LOCATOR_LEN) {
        Some(at) if may_be_zip64 => {
            let locator = read_at(reader, at, LOCATOR_LEN as usize)?;
            (&locator[..4] == LOCATOR_SIGNATURE).then_some((at, locator))
        }
        _ => None,
    };
    let Some((locator_at, locator)) = locator else {
        check_counts(&[entries_here, entries], size)?;
        return Ok(Directory {
            entries: entries_here.max(entries),
            relative_start: start,
            archive_offset: 0,
            end: eocd_at,
        });
    };

    let declared = u64_at(&locator, 8);
    if declared >= locator_at || u32_at(&locator, 16) > 1 {
        return Err(unreadable());
    }
    let locator_disk = u32_at(&locator, 4);
    let latest = locator_at.checked_sub(EOCD64_LEN).ok_or_else(unreadable)?;

    // The zip crate accepts any zip64 record in this range that ends exactly
    // at the locator and names the locator's disk, so every one is checked.
    let mut chosen = None;
    let mut seen = 0;
    let mut from = declared;
    while let Some(eocd64_at) = find_forward(reader, EOCD64_SIGNATURE, from, latest + 4)? {
        seen += 1;
        if seen > MAX_ZIP64_END_RECORDS {
            return Err(unreadable());
        }
        from = eocd64_at + 1;
        let eocd64 = read_at(reader, eocd64_at, EOCD64_LEN as usize)?;
        let record_size = u64_at(&eocd64, 4);
        let accepted = record_size >= 44
            && record_size.checked_add(12) == Some(locator_at - eocd64_at)
            && u32_at(&eocd64, 20) == locator_disk;
        if !accepted {
            continue;
        }
        // The zip crate reads the record's extensible data into memory.
        if record_size - 44 > MAX_CENTRAL_DIRECTORY_BYTES {
            return Err(Refusal::CentralDirectoryTooLarge {
                limit: MAX_CENTRAL_DIRECTORY_BYTES,
            }
            .into());
        }
        let entries_here = u64_at(&eocd64, 24);
        let entries = u64_at(&eocd64, 32);
        let size = u64_at(&eocd64, 40);
        check_counts(&[entries_here, entries], size)?;
        chosen.get_or_insert(Directory {
            entries: entries_here.max(entries),
            relative_start: u64_at(&eocd64, 48),
            archive_offset: eocd64_at - declared,
            end: eocd64_at,
        });
    }
    chosen.ok_or_else(unreadable)
}

/// Refuses an archive whose central directory declares more entries or
/// bytes than the limits allow, and rejects one whose directory isn't where
/// its record says.
pub(crate) fn check<R: Read + Seek>(reader: &mut R) -> Result<(), EpubError> {
    let file_len = reader.seek(SeekFrom::End(0)).map_err(io)?;
    let directory = directory(reader, file_len)?;
    if directory.entries == 0 {
        return reader.seek(SeekFrom::Start(0)).map(drop).map_err(io);
    }
    let hint = directory
        .relative_start
        .checked_add(directory.archive_offset)
        .filter(|start| *start < directory.end)
        .ok_or_else(unreadable)?;
    let start =
        find_forward(reader, HEADER_SIGNATURE, hint, directory.end)?.ok_or_else(unreadable)?;

    // Walk the headers the zip crate will read, within the byte limit
    // whatever size the record declares.
    let available = directory.end - start;
    let len = available.min(MAX_CENTRAL_DIRECTORY_BYTES) as usize;
    let headers = read_at(reader, start, len)?;
    let mut at = 0usize;
    for _ in 0..directory.entries {
        let fits =
            at + HEADER_LEN <= headers.len() && &headers[at..at + 4] == HEADER_SIGNATURE && {
                let variable = u16_at(&headers, at + 28)
                    + u16_at(&headers, at + 30)
                    + u16_at(&headers, at + 32);
                at += HEADER_LEN + variable as usize;
                at <= headers.len()
            };
        if !fits {
            return Err(
                if available > MAX_CENTRAL_DIRECTORY_BYTES && at > headers.len() {
                    Refusal::CentralDirectoryTooLarge {
                        limit: MAX_CENTRAL_DIRECTORY_BYTES,
                    }
                    .into()
                } else {
                    unreadable()
                },
            );
        }
    }
    reader.seek(SeekFrom::Start(0)).map(drop).map_err(io)
}
