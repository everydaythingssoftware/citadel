//! DTOs bridging libcalibre's custom-column types across the application boundary.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A custom column definition, as exposed to the frontend.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct CustomColumnDef {
    pub column_id: i32,
    /// Lookup name, e.g. `read` (Calibre exposes it as `#read`).
    pub label: String,
    /// Human-readable heading, e.g. `Read`.
    pub name: String,
    /// Raw Calibre datatype string, e.g. `bool`, `text`, `enumeration`.
    pub datatype: String,
    pub is_multiple: bool,
    pub editable: bool,
    /// Whether reading and writing values of this column is supported.
    pub supported: bool,
    /// Allowed values for enumeration columns. Empty for other datatypes.
    pub enum_values: Vec<String>,
}

impl From<&libcalibre::CustomColumn> for CustomColumnDef {
    fn from(column: &libcalibre::CustomColumn) -> Self {
        Self {
            column_id: column.id,
            label: column.label.clone(),
            name: column.name.clone(),
            datatype: column.kind.datatype().to_string(),
            is_multiple: column.is_multiple,
            editable: column.editable,
            supported: column.kind.supports_value_io(),
            enum_values: column.enum_values.clone(),
        }
    }
}

/// A custom-column value crossing the application boundary.
///
/// Mirrors `libcalibre::CustomValue`, except datetimes travel as RFC3339
/// strings and integers as `i32` (specta cannot export `i64` without bigint
/// support).
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Debug, Clone)]
pub enum CustomValueDto {
    Bool(bool),
    Int(i32),
    Float(f64),
    Text(String),
    TextMultiple(Vec<String>),
    /// RFC3339 datetime string, e.g. `2024-01-15T10:30:00+00:00`.
    Datetime(String),
    Enumeration(String),
}

impl TryFrom<libcalibre::CustomValue> for CustomValueDto {
    type Error = String;

    fn try_from(value: libcalibre::CustomValue) -> Result<Self, Self::Error> {
        match value {
            libcalibre::CustomValue::Bool(b) => Ok(Self::Bool(b)),
            libcalibre::CustomValue::Int(i) => i32::try_from(i)
                .map(Self::Int)
                .map_err(|_| format!("integer value {} is out of range", i)),
            libcalibre::CustomValue::Float(f) => Ok(Self::Float(f)),
            libcalibre::CustomValue::Text(s) => Ok(Self::Text(s)),
            libcalibre::CustomValue::TextMultiple(values) => Ok(Self::TextMultiple(values)),
            libcalibre::CustomValue::Datetime(dt) => Ok(Self::Datetime(dt.to_rfc3339())),
            libcalibre::CustomValue::Enumeration(s) => Ok(Self::Enumeration(s)),
            other => Err(format!("unsupported custom value {other:?}")),
        }
    }
}

impl TryFrom<CustomValueDto> for libcalibre::CustomValue {
    type Error = String;

    fn try_from(value: CustomValueDto) -> Result<Self, Self::Error> {
        match value {
            CustomValueDto::Bool(b) => Ok(Self::Bool(b)),
            CustomValueDto::Int(i) => Ok(Self::Int(i64::from(i))),
            CustomValueDto::Float(f) => Ok(Self::Float(f)),
            CustomValueDto::Text(s) => Ok(Self::Text(s)),
            CustomValueDto::TextMultiple(values) => Ok(Self::TextMultiple(values)),
            CustomValueDto::Datetime(raw) => DateTime::parse_from_rfc3339(&raw)
                .map(|dt| Self::Datetime(dt.with_timezone(&Utc)))
                .map_err(|e| format!("invalid RFC3339 datetime '{}': {}", raw, e)),
            CustomValueDto::Enumeration(s) => Ok(Self::Enumeration(s)),
        }
    }
}

/// One book's value for one custom column.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct BookCustomValue {
    pub column_id: i32,
    pub value: CustomValueDto,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn int_out_of_i32_range_yields_err() {
        let too_big = libcalibre::CustomValue::Int(i64::from(i32::MAX) + 1);
        assert!(CustomValueDto::try_from(too_big).is_err());

        let too_small = libcalibre::CustomValue::Int(i64::from(i32::MIN) - 1);
        assert!(CustomValueDto::try_from(too_small).is_err());

        let in_range = libcalibre::CustomValue::Int(i64::from(i32::MAX));
        let dto = CustomValueDto::try_from(in_range).unwrap();
        assert!(matches!(dto, CustomValueDto::Int(i) if i == i32::MAX));
    }

    #[test]
    fn datetime_round_trips_both_directions() {
        // libcalibre -> DTO
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let dto = CustomValueDto::try_from(libcalibre::CustomValue::Datetime(dt)).unwrap();
        let CustomValueDto::Datetime(raw) = &dto else {
            panic!("expected Datetime DTO");
        };
        assert_eq!(raw, "2024-01-15T10:30:00+00:00");

        // DTO -> libcalibre, back to the same instant
        let value = libcalibre::CustomValue::try_from(dto).unwrap();
        assert_eq!(value, libcalibre::CustomValue::Datetime(dt));

        // RFC3339 string with a non-UTC offset normalizes to the same instant
        let offset_dto = CustomValueDto::Datetime("2024-01-15T11:30:00+01:00".to_string());
        let value = libcalibre::CustomValue::try_from(offset_dto).unwrap();
        assert_eq!(value, libcalibre::CustomValue::Datetime(dt));
    }

    #[test]
    fn invalid_datetime_string_yields_err() {
        for raw in ["not a date", "", "2024-01-15", "2024-01-15 10:30:00"] {
            let dto = CustomValueDto::Datetime(raw.to_string());
            assert!(
                libcalibre::CustomValue::try_from(dto).is_err(),
                "'{raw}' should be rejected"
            );
        }
    }
}
