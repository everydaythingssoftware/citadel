use std::borrow::Cow;

pub(crate) fn xml_text(value: &str) -> Cow<'_, str> {
    if value.chars().all(valid_xml_char) {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(
            value
                .chars()
                .filter(|character| valid_xml_char(*character))
                .collect(),
        )
    }
}

pub(crate) fn valid_xml_char(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{a}' | '\u{d}')
        || ('\u{20}'..='\u{d7ff}').contains(&character)
        || ('\u{e000}'..='\u{fffd}').contains(&character)
        || ('\u{10000}'..='\u{10ffff}').contains(&character)
}
