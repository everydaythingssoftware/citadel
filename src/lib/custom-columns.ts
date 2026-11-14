import type {
	BookCustomValue,
	CustomColumnDef,
	CustomValueDto,
} from "@/bindings";

/**
 * The label of the Calibre custom column backing the "Finished" switch.
 * It is already written through `BookUpdate.is_read`, so the custom-column
 * editor must not render (and double-write) it.
 */
export const READ_COLUMN_LABEL = "read";

/**
 * The label of the optional Calibre text column that holds a publisher's
 * collection ("Folio junior 899"). Citadel fills it from a metadata lookup
 * only when the library already has it; it never creates it.
 */
export const COLLECTION_COLUMN_LABEL = "collection";

/**
 * A custom-column value as held in the edit form.
 *
 * - bool: `null` (unset) | `"yes"` | `"no"`
 * - int/float: `""` (unset) | number (or an in-progress string from NumberInput)
 * - text/comments/datetime: string (`""` = unset)
 * - text with is_multiple: string[] (`[]` = unset)
 * - enumeration: `null` or `""` (unset) | one of `enum_values`
 */
export type CustomFieldValue = string | number | string[] | null;

/** Columns the editor should render inputs for. */
export const editableCustomColumns = (
	columns: CustomColumnDef[],
): CustomColumnDef[] =>
	columns.filter(
		(column) =>
			column.supported &&
			column.editable &&
			!(column.label === READ_COLUMN_LABEL && column.datatype === "bool"),
	);

/** The form value representing "no value stored" for a column. */
export const emptyFieldValue = (column: CustomColumnDef): CustomFieldValue => {
	switch (column.datatype) {
		case "bool":
		case "enumeration":
			return null;
		case "text":
			return column.is_multiple ? [] : "";
		case "int":
		case "float":
			return "";
		default:
			return "";
	}
};

/** Convert a value DTO from the backend into a form field value. */
export const fieldValueFromDto = (
	column: CustomColumnDef,
	value: CustomValueDto | null,
): CustomFieldValue => {
	if (value === null) {
		return emptyFieldValue(column);
	}
	if ("Bool" in value) {
		return value.Bool ? "yes" : "no";
	}
	if ("Int" in value) {
		return value.Int;
	}
	if ("Float" in value) {
		return value.Float;
	}
	if ("Text" in value) {
		return value.Text;
	}
	if ("TextMultiple" in value) {
		return value.TextMultiple;
	}
	if ("Datetime" in value) {
		// Edit at date-only granularity, in the user's local calendar.
		return localDateOfInstant(value.Datetime) ?? value.Datetime;
	}
	return value.Enumeration;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The LOCAL calendar date (`YYYY-MM-DD`) of an RFC3339 instant, or `null`
 * when the string cannot be parsed.
 */
export const localDateOfInstant = (rfc3339: string): string | null => {
	const parsed = new Date(rfc3339);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(
		parsed.getDate(),
	)}`;
};

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/**
 * Parse a NumberInput value. Uses `Number()` semantics, so trailing garbage
 * (`"12abc"`) is rejected rather than truncated. For int columns, values
 * outside i32 range are rejected. `null` means "not a usable number"; callers
 * must treat that as "no change", never as "clear".
 */
const numberFieldToValue = (
	value: string | number,
	isInt: boolean,
): number | null => {
	const parsed = typeof value === "number" ? value : Number(value.trim());
	if (!Number.isFinite(parsed)) {
		return null;
	}
	if (isInt) {
		const truncated = Math.trunc(parsed);
		return truncated >= I32_MIN && truncated <= I32_MAX ? truncated : null;
	}
	return parsed;
};

/**
 * Whether a form value for an int/float column is non-empty but not a usable
 * number (junk text, out-of-range int). Such input must not be written — and
 * in particular must not clear the stored value.
 */
const isUnusableNumberInput = (
	column: CustomColumnDef,
	value: CustomFieldValue,
): boolean => {
	if (column.datatype !== "int" && column.datatype !== "float") {
		return false;
	}
	if (value === null || Array.isArray(value)) {
		return false;
	}
	if (typeof value === "string" && value.trim() === "") {
		return false; // empty = clear, which is fine
	}
	return numberFieldToValue(value, column.datatype === "int") === null;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * RFC3339 string for the LOCAL midnight of a `YYYY-MM-DD` date, carrying the
 * local UTC offset in effect on that date (DST-safe), matching Calibre's
 * local-midnight-with-offset semantics. `null` when the input is not a
 * date-only string.
 */
export const localMidnightRfc3339 = (date: string): string | null => {
	if (!DATE_ONLY_PATTERN.test(date)) {
		return null;
	}
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(5, 7));
	const day = Number(date.slice(8, 10));
	const midnight = new Date(year, month - 1, day, 0, 0, 0);
	// getTimezoneOffset() is minutes BEHIND UTC (e.g. 480 for UTC-8).
	const offsetMinutes = -midnight.getTimezoneOffset();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absolute = Math.abs(offsetMinutes);
	const offset = `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
	return `${date}T00:00:00${offset}`;
};

/**
 * Convert a form field value into the DTO to send to the backend.
 * `null` means "clear the stored value".
 */
export const dtoFromFieldValue = (
	column: CustomColumnDef,
	value: CustomFieldValue,
): CustomValueDto | null => {
	switch (column.datatype) {
		case "bool": {
			if (value === "yes") return { Bool: true };
			if (value === "no") return { Bool: false };
			return null;
		}
		case "int": {
			if (value === null || Array.isArray(value)) return null;
			if (typeof value === "string" && value.trim() === "") return null;
			const parsed = numberFieldToValue(value, true);
			return parsed === null ? null : { Int: parsed };
		}
		case "float": {
			if (value === null || Array.isArray(value)) return null;
			if (typeof value === "string" && value.trim() === "") return null;
			const parsed = numberFieldToValue(value, false);
			return parsed === null ? null : { Float: parsed };
		}
		case "text": {
			if (column.is_multiple) {
				return Array.isArray(value) && value.length > 0
					? { TextMultiple: value }
					: null;
			}
			return typeof value === "string" && value !== "" ? { Text: value } : null;
		}
		case "comments": {
			return typeof value === "string" && value !== "" ? { Text: value } : null;
		}
		case "datetime": {
			if (typeof value !== "string") return null;
			const trimmed = value.trim();
			if (trimmed === "") return null;
			// Date-only input: send local midnight with the local UTC offset.
			const localMidnight = localMidnightRfc3339(trimmed);
			if (localMidnight !== null) {
				return { Datetime: localMidnight };
			}
			// Pass through; the backend rejects strings that are not RFC3339.
			return { Datetime: trimmed };
		}
		case "enumeration": {
			return typeof value === "string" && value !== ""
				? { Enumeration: value }
				: null;
		}
		default:
			return null;
	}
};

/** Form field values for the given columns, keyed by column id. */
export const buildCustomFieldValues = (
	columns: CustomColumnDef[],
	values: BookCustomValue[],
): Record<string, CustomFieldValue> => {
	const valueByColumnId = new Map(
		values.map((bookValue) => [bookValue.column_id, bookValue.value]),
	);
	return Object.fromEntries(
		columns.map((column) => [
			String(column.column_id),
			fieldValueFromDto(column, valueByColumnId.get(column.column_id) ?? null),
		]),
	);
};

export interface CustomValueChange {
	columnId: number;
	value: CustomValueDto | null;
}

/**
 * Compare two datetime strings by the instant they denote, so a round-tripped
 * unchanged date (e.g. re-serialized with a different offset) is not reported
 * as a change. Falls back to string equality when either side fails to parse.
 */
const datetimesEqual = (a: string, b: string): boolean => {
	const aMs = new Date(a).getTime();
	const bMs = new Date(b).getTime();
	if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
		return a === b;
	}
	return aMs === bMs;
};

const dtosEqual = (
	a: CustomValueDto | null,
	b: CustomValueDto | null,
): boolean => {
	if (a !== null && b !== null && "Datetime" in a && "Datetime" in b) {
		return datetimesEqual(a.Datetime, b.Datetime);
	}
	return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * The set of columns whose effective value differs between two form
 * snapshots, with the DTO to write for each.
 *
 * Columns whose `after` value is unusable number input (junk text,
 * out-of-range int) are treated as unchanged: a junk paste must not silently
 * clear a stored value.
 */
export const diffCustomValues = (
	columns: CustomColumnDef[],
	before: Record<string, CustomFieldValue>,
	after: Record<string, CustomFieldValue>,
): CustomValueChange[] => {
	const changes: CustomValueChange[] = [];
	for (const column of columns) {
		const key = String(column.column_id);
		const afterValue = after[key] ?? emptyFieldValue(column);
		if (isUnusableNumberInput(column, afterValue)) {
			continue;
		}
		const beforeDto = dtoFromFieldValue(
			column,
			before[key] ?? emptyFieldValue(column),
		);
		const afterDto = dtoFromFieldValue(column, afterValue);
		if (!dtosEqual(beforeDto, afterDto)) {
			changes.push({ columnId: column.column_id, value: afterDto });
		}
	}
	return changes;
};
