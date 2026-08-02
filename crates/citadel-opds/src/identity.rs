use libcalibre::BookId;

pub(crate) fn library_identity(raw_uuid: &str) -> String {
    match uuid::Uuid::parse_str(raw_uuid) {
        Ok(uuid) => format!("urn:uuid:{uuid}"),
        Err(_) => format!("urn:citadel:library:{}", hex(raw_uuid.as_bytes())),
    }
}

pub(crate) fn book_identity(library_uuid: &str, raw_uuid: Option<&str>, book_id: BookId) -> String {
    match raw_uuid.and_then(|value| uuid::Uuid::parse_str(value).ok()) {
        Some(uuid) => format!("urn:uuid:{uuid}"),
        None => format!(
            "urn:citadel:book:{}:{}",
            hex(library_uuid.as_bytes()),
            book_id.as_i32()
        ),
    }
}

pub(crate) fn navigation_identity(library_uuid: &str, key: &str) -> String {
    format!(
        "{}:navigation:{}",
        library_identity(library_uuid),
        hex(key.as_bytes())
    )
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(HEX[usize::from(byte >> 4)]));
        result.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    result
}
