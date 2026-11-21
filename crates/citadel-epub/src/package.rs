//! The package document (EPUB 3.3 §5): its metadata, and the manifest only
//! as far as finding the cover. Fields follow Readium's metadata mapping
//! (readium/architecture, `streamer/parser/metadata.md`).
use std::collections::HashMap;

use crate::{
    error::{EpubError, Part, Refusal, Unreadable},
    limits::{MAX_METADATA_ITEMS, MAX_VALUE_BYTES},
    paths,
    xml::{self, Element, Node, Reader, DC_NS, OPF_NS},
};

/// What a package document says about its publication. Whitespace in text
/// values is collapsed, and empty values are left out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Package {
    /// The archive path of the package document.
    pub path: String,
    /// `package@version`, such as `3.0` or `2.0`.
    pub version: Option<String>,
    /// The `dc:identifier` that `package@unique-identifier` names, or the
    /// first one when it names none.
    pub identifier: Option<String>,
    /// Every `dc:identifier`, in document order.
    pub identifiers: Vec<String>,
    /// The `dc:title` refined with `title-type` `main`, or the first.
    pub title: Option<String>,
    /// The main title's `file-as` refinement, or else `calibre:title_sort`.
    pub title_sort: Option<String>,
    /// `dc:creator`s, in document order.
    pub creators: Vec<Contributor>,
    /// `dc:contributor`s, in document order.
    pub contributors: Vec<Contributor>,
    /// `dc:language`s; the first is the primary language.
    pub languages: Vec<String>,
    /// The first `dc:publisher`.
    pub publisher: Option<String>,
    /// `dc:subject`s, in document order.
    pub subjects: Vec<String>,
    /// The first `dc:description`.
    pub description: Option<String>,
    /// The publication date as written: a `dc:date` with `opf:event`
    /// `publication`, or else the first `dc:date` without an event.
    pub published: Option<String>,
    /// The cover image: the manifest item with the `cover-image` property,
    /// or else the one an EPUB 2 `<meta name="cover">` names.
    pub cover: Option<Resource>,
}

impl Package {
    /// The publication's authors (Readium): creators with no role, an
    /// unrecognised role or `aut`, and contributors with `aut`.
    pub fn authors(&self) -> impl Iterator<Item = &Contributor> {
        let creators = self.creators.iter().filter(|creator| {
            creator.roles.is_empty()
                || creator
                    .roles
                    .iter()
                    .any(|role| role == "aut" || !KNOWN_ROLES.contains(&role.as_str()))
        });
        let contributors = self
            .contributors
            .iter()
            .filter(|contributor| contributor.roles.iter().any(|role| role == "aut"));
        creators.chain(contributors)
    }

    /// The primary language.
    pub fn language(&self) -> Option<&str> {
        self.languages.first().map(String::as_str)
    }
}

/// The MARC relator codes Readium maps to a role other than author.
const KNOWN_ROLES: [&str; 8] = ["aut", "pbl", "trl", "edt", "ill", "art", "clr", "nrt"];

/// A creator or contributor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contributor {
    pub name: String,
    /// The `file-as` refinement (EPUB 3) or `opf:file-as` (EPUB 2).
    pub sort_as: Option<String>,
    /// Lowercase MARC relator codes from `role` refinements (EPUB 3) or
    /// `opf:role` (EPUB 2).
    pub roles: Vec<String>,
}

/// A file in the container.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resource {
    /// The archive entry, resolved against the package document.
    pub path: String,
    pub media_type: Option<String>,
}

struct DcItem {
    element: String,
    id: Option<String>,
    value: String,
    file_as: Option<String>,
    role: Option<String>,
    event: Option<String>,
}

struct Meta {
    property: Option<String>,
    refines: Option<String>,
    scheme: Option<String>,
    name: Option<String>,
    content: Option<String>,
    value: String,
}

struct ManifestItem {
    id: Option<String>,
    href: String,
    media_type: Option<String>,
    cover_image: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Package,
    Metadata,
    Manifest,
    Captured,
    Other,
}

enum Captured {
    Dc(DcItem),
    Meta(Meta),
}

fn in_opf(element: &Element, local: &str) -> bool {
    element.local == local && matches!(element.namespace.as_deref(), Some(OPF_NS) | None)
}

fn owned(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

struct Document {
    version: Option<String>,
    unique_identifier: Option<String>,
    dc: Vec<DcItem>,
    metas: Vec<Meta>,
    manifest: Vec<ManifestItem>,
}

fn read_document(text: &str) -> Result<Document, EpubError> {
    let mut reader = Reader::new(text, Part::Package);
    let mut document = Document {
        version: None,
        unique_identifier: None,
        dc: Vec::new(),
        metas: Vec::new(),
        manifest: Vec::new(),
    };
    let mut open: Vec<Kind> = Vec::new();
    let mut captured: Option<(Captured, String)> = None;
    let mut items = 0usize;
    let mut has_spine = false;
    let malformed = || EpubError::malformed(Part::Package);

    loop {
        match reader.next()? {
            Node::Start(element) => {
                let kind = match open.last().copied() {
                    None if in_opf(&element, "package") => {
                        document.version = owned(element.attribute("version"));
                        document.unique_identifier = owned(element.attribute("unique-identifier"));
                        Kind::Package
                    }
                    None => return Err(malformed()),
                    Some(Kind::Package) if in_opf(&element, "metadata") => Kind::Metadata,
                    Some(Kind::Package) if in_opf(&element, "manifest") => Kind::Manifest,
                    Some(Kind::Package) if in_opf(&element, "spine") => {
                        has_spine = true;
                        Kind::Other
                    }
                    // OEBPS 1.2 wraps metadata in `dc-metadata` and `x-metadata`.
                    Some(Kind::Metadata)
                        if in_opf(&element, "dc-metadata") || in_opf(&element, "x-metadata") =>
                    {
                        Kind::Metadata
                    }
                    Some(Kind::Metadata)
                        if element.namespace.as_deref() == Some(DC_NS)
                            || in_opf(&element, "meta") =>
                    {
                        items += 1;
                        if items > MAX_METADATA_ITEMS {
                            return Err(Refusal::TooManyMetadataItems {
                                limit: MAX_METADATA_ITEMS,
                            }
                            .into());
                        }
                        captured = Some((capture(&element), String::new()));
                        Kind::Captured
                    }
                    Some(Kind::Manifest) if in_opf(&element, "item") => {
                        if let Some(href) = element.attribute("href") {
                            document.manifest.push(ManifestItem {
                                id: owned(element.attribute("id")),
                                href: href.to_string(),
                                media_type: owned(element.attribute("media-type")),
                                cover_image: element.attribute("properties").is_some_and(
                                    |properties| {
                                        properties
                                            .split_ascii_whitespace()
                                            .any(|p| p == "cover-image")
                                    },
                                ),
                            });
                        }
                        Kind::Other
                    }
                    Some(_) => Kind::Other,
                };
                open.push(kind);
            }
            Node::Text(text) => {
                if let Some((_, value)) = captured.as_mut() {
                    if value.len() + text.len() > MAX_VALUE_BYTES {
                        return Err(Refusal::ValueTooLong {
                            part: Part::Package,
                            limit: MAX_VALUE_BYTES,
                        }
                        .into());
                    }
                    value.push_str(&text);
                }
            }
            Node::End => {
                if open.pop() == Some(Kind::Captured) {
                    if let Some((item, value)) = captured.take() {
                        // Reading Systems collapse whitespace in metadata
                        // (EPUB Reading Systems 3.3 §4.2.2).
                        let value = value.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
                        match item {
                            Captured::Dc(item) => document.dc.push(DcItem { value, ..item }),
                            Captured::Meta(meta) => document.metas.push(Meta { value, ..meta }),
                        }
                    }
                }
            }
            Node::Eof => break,
        }
    }
    if !has_spine {
        return Err(EpubError::Unreadable(Unreadable::MissingSpine));
    }
    Ok(document)
}

fn capture(element: &Element) -> Captured {
    if element.namespace.as_deref() == Some(DC_NS) {
        Captured::Dc(DcItem {
            element: element.local.clone(),
            id: owned(element.attribute("id")),
            value: String::new(),
            file_as: owned(element.attribute_in(OPF_NS, "file-as")),
            role: owned(element.attribute_in(OPF_NS, "role")),
            event: owned(element.attribute_in(OPF_NS, "event")),
        })
    } else {
        Captured::Meta(Meta {
            property: owned(element.attribute("property")),
            refines: owned(element.attribute("refines")),
            scheme: owned(element.attribute("scheme")),
            name: owned(element.attribute("name")),
            content: owned(element.attribute("content")),
            value: String::new(),
        })
    }
}

/// Reads the package document at `path`; `exists` says whether the archive
/// has an entry, to resolve the cover's path.
pub(crate) fn parse(
    bytes: &[u8],
    path: String,
    exists: impl Fn(&str) -> bool,
) -> Result<Package, EpubError> {
    let text = xml::decode(bytes, Part::Package)?;
    let document = read_document(&text)?;

    let mut refinements: HashMap<&str, Vec<&Meta>> = HashMap::new();
    for meta in &document.metas {
        if let Some(target) = meta.refines.as_deref() {
            let id = target.strip_prefix('#').unwrap_or(target);
            refinements.entry(id).or_default().push(meta);
        }
    }
    let refined = |item: &DcItem, property: &str| -> Vec<&Meta> {
        item.id
            .as_deref()
            .and_then(|id| refinements.get(id))
            .map(|metas| {
                metas
                    .iter()
                    .copied()
                    .filter(|meta| {
                        meta.property.as_deref() == Some(property) && !meta.value.is_empty()
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let elements = |name: &'static str| {
        document
            .dc
            .iter()
            .filter(move |item| item.element == name && !item.value.is_empty())
    };
    let values = |name: &'static str| elements(name).map(|item| item.value.clone()).collect();

    let identifier = document
        .unique_identifier
        .as_deref()
        .and_then(|unique| elements("identifier").find(|item| item.id.as_deref() == Some(unique)))
        .or_else(|| elements("identifier").next())
        .map(|item| item.value.clone());

    let main_title = elements("title")
        .find(|item| {
            refined(item, "title-type")
                .iter()
                .any(|meta| meta.value.eq_ignore_ascii_case("main"))
        })
        .or_else(|| elements("title").next());
    let title_sort = main_title
        .and_then(|title| {
            refined(title, "file-as")
                .first()
                .map(|meta| meta.value.clone())
        })
        .or_else(|| {
            document
                .metas
                .iter()
                .find(|meta| meta.name.as_deref() == Some("calibre:title_sort"))
                .and_then(|meta| meta.content.clone())
        });

    let contributor = |item: &DcItem| {
        let mut roles: Vec<String> = refined(item, "role")
            .iter()
            .filter(|meta| {
                meta.scheme
                    .as_deref()
                    .is_none_or(|scheme| scheme == "marc:relators")
            })
            .map(|meta| meta.value.to_ascii_lowercase())
            .collect();
        if roles.is_empty() {
            roles.extend(item.role.as_deref().map(str::to_ascii_lowercase));
        }
        Contributor {
            name: item.value.clone(),
            sort_as: refined(item, "file-as")
                .first()
                .map(|meta| meta.value.clone())
                .or_else(|| item.file_as.clone()),
            roles,
        }
    };

    let published = elements("date")
        .find(|item| {
            item.event
                .as_deref()
                .is_some_and(|event| event.eq_ignore_ascii_case("publication"))
        })
        .or_else(|| elements("date").find(|item| item.event.is_none()))
        .map(|item| item.value.clone());

    let package_dir = paths::parent(&path).to_string();
    let cover = document
        .manifest
        .iter()
        .find(|item| item.cover_image)
        .or_else(|| {
            let id = document
                .metas
                .iter()
                .find(|meta| meta.name.as_deref() == Some("cover") && meta.property.is_none())?
                .content
                .as_deref()?;
            document
                .manifest
                .iter()
                .find(|item| item.id.as_deref() == Some(id))
        })
        .and_then(|item| {
            Some(Resource {
                path: paths::resource(&package_dir, &item.href, &exists)?,
                media_type: item.media_type.clone(),
            })
        });

    Ok(Package {
        version: document.version.clone(),
        identifier,
        identifiers: values("identifier"),
        title: main_title.map(|item| item.value.clone()),
        title_sort,
        creators: elements("creator").map(contributor).collect(),
        contributors: elements("contributor").map(contributor).collect(),
        languages: values("language"),
        publisher: elements("publisher").next().map(|item| item.value.clone()),
        subjects: values("subject"),
        description: elements("description")
            .next()
            .map(|item| item.value.clone()),
        published,
        cover,
        path,
    })
}
