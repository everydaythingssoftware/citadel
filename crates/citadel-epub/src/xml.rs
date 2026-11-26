//! A pull reader over one in-memory XML document that enforces the
//! structural limits as it goes. It keeps a counter per open element and
//! never recurses, so nesting costs a few bytes per level up to
//! [`MAX_DEPTH`].
use std::borrow::Cow;

use quick_xml::{
    escape::resolve_predefined_entity,
    events::{BytesStart, Event},
    name::ResolveResult,
    NsReader,
};

use crate::{
    error::{EpubError, Part, Refusal},
    limits::{MAX_ATTRIBUTES, MAX_DEPTH, MAX_ELEMENTS, MAX_NAMESPACE_BINDINGS, MAX_VALUE_BYTES},
};

pub(crate) const OPF_NS: &str = "http://www.idpf.org/2007/opf";
pub(crate) const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
pub(crate) const CONTAINER_NS: &str = "urn:oasis:names:tc:opendocument:xmlns:container";

/// An attribute with its namespace resolved; unprefixed attributes have none.
pub(crate) struct Attribute {
    pub namespace: Option<String>,
    pub local: String,
    pub value: String,
}

pub(crate) struct Element {
    pub namespace: Option<String>,
    pub local: String,
    pub attributes: Vec<Attribute>,
}

impl Element {
    /// An unprefixed attribute's value.
    pub fn attribute(&self, local: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|attribute| attribute.namespace.is_none() && attribute.local == local)
            .map(|attribute| attribute.value.as_str())
    }

    /// An attribute in `namespace`.
    pub fn attribute_in(&self, namespace: &str, local: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|attribute| {
                attribute.namespace.as_deref() == Some(namespace) && attribute.local == local
            })
            .map(|attribute| attribute.value.as_str())
    }
}

pub(crate) enum Node<'a> {
    Start(Element),
    End,
    Text(Cow<'a, str>),
    Eof,
}

pub(crate) struct Reader<'a> {
    inner: NsReader<&'a [u8]>,
    part: Part,
    /// Namespace declarations made by each open element.
    bindings: Vec<usize>,
    bound: usize,
    elements: usize,
    /// An empty element's end, still to be reported.
    pending_end: bool,
}

impl<'a> Reader<'a> {
    pub fn new(text: &'a str, part: Part) -> Self {
        let mut inner = NsReader::from_str(text);
        let config = inner.config_mut();
        config.check_end_names = true;
        config.expand_empty_elements = false;
        Self {
            inner,
            part,
            bindings: Vec::new(),
            bound: 0,
            elements: 0,
            pending_end: false,
        }
    }

    fn malformed(&self) -> EpubError {
        EpubError::malformed(self.part)
    }

    pub fn next(&mut self) -> Result<Node<'a>, EpubError> {
        if self.pending_end {
            self.pending_end = false;
            self.close();
            return Ok(Node::End);
        }
        loop {
            let event = self.inner.read_event().map_err(|_| self.malformed())?;
            return match event {
                Event::Start(start) => self.open(&start).map(Node::Start),
                Event::Empty(start) => {
                    let element = self.open(&start)?;
                    self.pending_end = true;
                    Ok(Node::Start(element))
                }
                Event::End(_) => {
                    if self.bindings.is_empty() {
                        return Err(self.malformed());
                    }
                    self.close();
                    Ok(Node::End)
                }
                Event::Text(text) => {
                    let text = text.xml10_content().map_err(|_| self.malformed())?;
                    Ok(Node::Text(text))
                }
                Event::CData(data) => {
                    let data = data.decode().map_err(|_| self.malformed())?;
                    Ok(Node::Text(data))
                }
                Event::GeneralRef(reference) => {
                    if let Some(character) =
                        reference.resolve_char_ref().map_err(|_| self.malformed())?
                    {
                        return Ok(Node::Text(Cow::Owned(character.to_string())));
                    }
                    let name = reference.decode().map_err(|_| self.malformed())?;
                    // A DTD is never read, so only XML's own entities exist.
                    resolve_predefined_entity(&name)
                        .map(|text| Node::Text(Cow::Borrowed(text)))
                        .ok_or_else(|| self.malformed())
                }
                Event::Eof => {
                    if self.bindings.is_empty() && self.elements > 0 {
                        Ok(Node::Eof)
                    } else {
                        Err(self.malformed())
                    }
                }
                Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => continue,
            };
        }
    }

    fn close(&mut self) {
        if let Some(declared) = self.bindings.pop() {
            self.bound -= declared;
        }
    }

    fn open(&mut self, start: &BytesStart) -> Result<Element, EpubError> {
        let part = self.part;
        self.elements += 1;
        if self.elements > MAX_ELEMENTS {
            return Err(Refusal::TooManyElements {
                part,
                limit: MAX_ELEMENTS,
            }
            .into());
        }
        if self.bindings.len() >= MAX_DEPTH {
            return Err(Refusal::TooDeep {
                part,
                limit: MAX_DEPTH,
            }
            .into());
        }

        let mut declared = 0;
        let mut raw = Vec::new();
        for (index, attribute) in start.attributes().with_checks(true).enumerate() {
            if index >= MAX_ATTRIBUTES {
                return Err(Refusal::TooManyAttributes {
                    part,
                    limit: MAX_ATTRIBUTES,
                }
                .into());
            }
            let attribute = attribute.map_err(|_| self.malformed())?;
            let key = attribute.key;
            if key.as_namespace_binding().is_some() {
                declared += 1;
                continue;
            }
            if attribute.value.len() > MAX_VALUE_BYTES {
                return Err(Refusal::ValueTooLong {
                    part,
                    limit: MAX_VALUE_BYTES,
                }
                .into());
            }
            let value = attribute
                .decode_and_unescape_value(self.inner.decoder())
                .map_err(|_| self.malformed())?
                .into_owned();
            raw.push((key.as_ref().to_vec(), value));
        }
        if self.bound + declared > MAX_NAMESPACE_BINDINGS {
            return Err(Refusal::TooManyNamespaces {
                part,
                limit: MAX_NAMESPACE_BINDINGS,
            }
            .into());
        }
        self.bindings.push(declared);
        self.bound += declared;

        let (resolved, local) = self.inner.resolve_element(start.name());
        let namespace = namespace_of(resolved, start.name().as_ref());
        let local = utf8(local.as_ref()).ok_or_else(|| self.malformed())?;
        let mut attributes = Vec::with_capacity(raw.len());
        for (key, value) in raw {
            let name = quick_xml::name::QName(&key);
            let (resolved, local) = self.inner.resolve_attribute(name);
            attributes.push(Attribute {
                namespace: namespace_of(resolved, &key),
                local: utf8(local.as_ref()).ok_or_else(|| self.malformed())?,
                value,
            });
        }
        Ok(Element {
            namespace,
            local,
            attributes,
        })
    }
}

/// The namespace a name resolved to. Books in the wild use `dc:` and `opf:`
/// without declaring them; those two prefixes keep their usual meaning.
fn namespace_of(resolved: ResolveResult, qualified: &[u8]) -> Option<String> {
    match resolved {
        ResolveResult::Bound(namespace) => utf8(namespace.as_ref()),
        ResolveResult::Unbound => None,
        ResolveResult::Unknown(_) => match qualified.split(|byte| *byte == b':').next() {
            Some(b"dc") => Some(DC_NS.to_string()),
            Some(b"opf") => Some(OPF_NS.to_string()),
            _ => None,
        },
    }
}

fn utf8(bytes: &[u8]) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

/// The document as UTF-8: a BOM, then the XML declaration's encoding, decide;
/// UTF-8 is assumed without either (XML 1.0 Appendix F).
pub(crate) fn decode(bytes: &[u8], part: Part) -> Result<Cow<'_, str>, EpubError> {
    let malformed = || EpubError::malformed(part);
    if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling_and_without_replacement(&bytes[bom..])
            .ok_or_else(malformed);
    }
    let encoding = match bytes {
        [0x00, b'<', ..] => encoding_rs::UTF_16BE,
        [b'<', 0x00, ..] => encoding_rs::UTF_16LE,
        _ => declared_encoding(bytes).unwrap_or(encoding_rs::UTF_8),
    };
    encoding
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or_else(malformed)
}

/// The `encoding` named by an XML declaration at the start of `bytes`, for
/// ASCII-compatible encodings.
fn declared_encoding(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let declaration = bytes.strip_prefix(b"<?xml")?;
    let end = declaration.windows(2).position(|pair| pair == b"?>")?;
    let declaration = std::str::from_utf8(&declaration[..end]).ok()?;
    let (_, rest) = declaration.split_once("encoding")?;
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let label = rest[1..].split(quote).next()?;
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())?;
    // A declaration readable as ASCII can't be UTF-16 without a BOM.
    (encoding != encoding_rs::UTF_16LE && encoding != encoding_rs::UTF_16BE).then_some(encoding)
}
