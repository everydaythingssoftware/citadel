use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LibraryErrorCode {
    InvalidArgument,
    Unauthorized,
    RateLimited,
    NotFound,
    Unavailable,
    /// A request body or declared size exceeds a limit.
    TooLarge,
    /// The request conflicts with the resource's current state.
    Conflict,
    /// The server has no room to store more.
    StorageFull,
    Internal,
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct LibraryError {
    pub code: LibraryErrorCode,
    pub message: String,
}

impl LibraryError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: LibraryErrorCode::InvalidArgument,
            message: message.into(),
        }
    }

    pub fn new(code: LibraryErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            code: LibraryErrorCode::Unavailable,
            message: "Library unavailable".into(),
        }
    }
}

impl std::fmt::Display for LibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LibraryError {}

impl From<libcalibre::CalibreError> for LibraryError {
    fn from(error: libcalibre::CalibreError) -> Self {
        use libcalibre::CalibreError;
        let code = match &error {
            CalibreError::BookNotFound(_)
            | CalibreError::AuthorNotFound(_)
            | CalibreError::BookFileNotFound(_, _)
            | CalibreError::BookCoverNotFound(_)
            | CalibreError::CustomColumnNotFound(_) => LibraryErrorCode::NotFound,
            CalibreError::InvalidBookFormat(_)
            | CalibreError::InvalidCustomColumn(_)
            | CalibreError::InvalidCustomValue(_)
            | CalibreError::UnsupportedCustomColumn(_)
            | CalibreError::AuthorHasAssociatedBooks(_) => LibraryErrorCode::InvalidArgument,
            CalibreError::LibraryNotInitialized => LibraryErrorCode::Unavailable,
            _ => LibraryErrorCode::Internal,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
