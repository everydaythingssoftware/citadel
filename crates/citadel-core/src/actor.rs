/// Who a library write is performed for. Hosts supply it: the server from the
/// signed-in session, the desktop app as its local user. Non-exhaustive so
/// non-human actors (imports, integrations) can be added without breaking hosts.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum Actor {
    /// A Citadel user, by opaque user ID.
    User { id: String },
}
