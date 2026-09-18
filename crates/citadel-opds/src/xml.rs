use std::borrow::Cow;

use quick_xml::{
    events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event},
    Writer,
};

use super::catalog::{Feed, FeedEntry, IMAGE_REL, IMAGE_TYPE};

pub(crate) fn write_feed(feed: &Feed) -> Result<Vec<u8>, quick_xml::Error> {
    let mut writer = Writer::new(Vec::new());
    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    let mut element = BytesStart::new("feed");
    element.push_attribute(("xmlns", "http://www.w3.org/2005/Atom"));
    element.push_attribute(("xmlns:dc", "http://purl.org/dc/terms/"));
    writer.write_event(Event::Start(element))?;
    text_element(&mut writer, "id", &feed.id)?;
    text_element(&mut writer, "title", &feed.title)?;
    text_element(&mut writer, "updated", &feed.updated)?;
    writer.write_event(Event::Start(BytesStart::new("author")))?;
    text_element(&mut writer, "name", "Citadel")?;
    writer.write_event(Event::End(BytesEnd::new("author")))?;

    for link in &feed.links {
        write_link(&mut writer, link.rel, &link.href, link.media_type)?;
    }
    for entry in &feed.entries {
        write_entry(&mut writer, entry)?;
    }

    writer.write_event(Event::End(BytesEnd::new("feed")))?;
    Ok(writer.into_inner())
}

fn write_entry(writer: &mut Writer<Vec<u8>>, entry: &FeedEntry) -> Result<(), quick_xml::Error> {
    writer.write_event(Event::Start(BytesStart::new("entry")))?;
    text_element(writer, "id", &entry.id)?;
    text_element(writer, "title", &entry.title)?;
    text_element(writer, "updated", &entry.updated)?;
    for author in &entry.authors {
        writer.write_event(Event::Start(BytesStart::new("author")))?;
        text_element(writer, "name", author)?;
        writer.write_event(Event::End(BytesEnd::new("author")))?;
    }
    text_element(writer, "published", &entry.published)?;
    let mut content = BytesStart::new("content");
    content.push_attribute(("type", "text"));
    writer.write_event(Event::Start(content))?;
    writer.write_event(Event::Text(BytesText::new(&xml_text(
        entry.content.as_deref().unwrap_or(""),
    ))))?;
    writer.write_event(Event::End(BytesEnd::new("content")))?;
    for language in &entry.languages {
        text_element(writer, "dc:language", language)?;
    }
    for identifier in &entry.identifiers {
        text_element(writer, "dc:identifier", identifier)?;
    }
    for term in &entry.categories {
        let mut category = BytesStart::new("category");
        category.push_attribute(("term", xml_text(term).as_ref()));
        writer.write_event(Event::Empty(category))?;
    }
    if let Some(href) = &entry.image_link {
        write_link(writer, IMAGE_REL, href, IMAGE_TYPE)?;
    }
    for (rel, href, media_type) in &entry.acquisition_links {
        write_link(writer, rel, href, media_type)?;
    }
    writer.write_event(Event::End(BytesEnd::new("entry")))?;
    Ok(())
}

fn write_link(
    writer: &mut Writer<Vec<u8>>,
    relation: &str,
    href: &str,
    media_type: &str,
) -> Result<(), quick_xml::Error> {
    let mut element = BytesStart::new("link");
    element.push_attribute(("rel", relation));
    element.push_attribute(("href", href));
    element.push_attribute(("type", media_type));
    writer.write_event(Event::Empty(element))?;
    Ok(())
}

fn text_element(
    writer: &mut Writer<Vec<u8>>,
    name: &str,
    value: &str,
) -> Result<(), quick_xml::Error> {
    writer.write_event(Event::Start(BytesStart::new(name)))?;
    writer.write_event(Event::Text(BytesText::new(&xml_text(value))))?;
    writer.write_event(Event::End(BytesEnd::new(name)))?;
    Ok(())
}

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
