#![no_main]

use std::io::Cursor;

use libfuzzer_sys::fuzz_target;

// The reader must never recurse on its input, so a 2 MiB stack (a server
// worker's) is plenty for any file; an overflow here is a bug.
fuzz_target!(|data: &[u8]| {
    let data = data.to_vec();
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            if let Ok(mut epub) = citadel_epub::Epub::open(Cursor::new(data)) {
                let _ = epub.cover(16 * 1024 * 1024);
            }
        })
        .unwrap()
        .join()
        .unwrap();
});
