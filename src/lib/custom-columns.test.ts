import { describe, expect, it } from "vitest";
import type { CustomColumnDef } from "@/bindings";
import {
	buildCustomFieldValues,
	diffCustomValues,
	dtoFromFieldValue,
	editableCustomColumns,
	fieldValueFromDto,
} from "./custom-columns";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local calendar date of an instant, via the same Date APIs the code uses. */
const localDate = (date: Date) =>
	`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** Local UTC offset (`±HH:MM`) in effect at local midnight of y-m-d. */
const localOffsetAtMidnight = (year: number, month: number, day: number) => {
	const minutes = -new Date(year, month - 1, day, 0, 0, 0).getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	const absolute = Math.abs(minutes);
	return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
};

const column = (overrides: Partial<CustomColumnDef>): CustomColumnDef => ({
	column_id: 1,
	label: "mycolumn",
	name: "My Column",
	datatype: "text",
	is_multiple: false,
	editable: true,
	supported: true,
	enum_values: [],
	...overrides,
});

describe("editableCustomColumns", () => {
	it("keeps only supported, editable columns", () => {
		const columns = [
			column({ column_id: 1, label: "rating", supported: false }),
			column({ column_id: 2, label: "notes", editable: false }),
			column({ column_id: 3, label: "mood" }),
		];

		expect(editableCustomColumns(columns).map((c) => c.column_id)).toEqual([3]);
	});

	it("excludes the bool read column, which is written through BookUpdate", () => {
		const columns = [
			column({ column_id: 1, label: "read", datatype: "bool" }),
			column({ column_id: 2, label: "mood" }),
		];

		expect(editableCustomColumns(columns).map((c) => c.column_id)).toEqual([2]);
	});

	it("keeps non-bool columns that happen to be labelled read", () => {
		const columns = [
			column({ column_id: 1, label: "read", datatype: "datetime" }),
			column({ column_id: 2, label: "read", datatype: "bool" }),
		];

		expect(editableCustomColumns(columns).map((c) => c.column_id)).toEqual([1]);
	});
});

describe("fieldValueFromDto", () => {
	it("maps missing values to the column's empty value", () => {
		expect(fieldValueFromDto(column({ datatype: "bool" }), null)).toBeNull();
		expect(fieldValueFromDto(column({ datatype: "int" }), null)).toBe("");
		expect(fieldValueFromDto(column({ datatype: "text" }), null)).toBe("");
		expect(
			fieldValueFromDto(column({ datatype: "text", is_multiple: true }), null),
		).toEqual([]);
		expect(
			fieldValueFromDto(column({ datatype: "enumeration" }), null),
		).toBeNull();
	});

	it("maps booleans to yes/no", () => {
		const bool = column({ datatype: "bool" });
		expect(fieldValueFromDto(bool, { Bool: true })).toBe("yes");
		expect(fieldValueFromDto(bool, { Bool: false })).toBe("no");
	});

	it("maps numbers, text, and lists through unchanged", () => {
		expect(fieldValueFromDto(column({ datatype: "int" }), { Int: 42 })).toBe(
			42,
		);
		expect(
			fieldValueFromDto(column({ datatype: "float" }), { Float: 3.5 }),
		).toBe(3.5);
		expect(
			fieldValueFromDto(column({ datatype: "text" }), { Text: "hello" }),
		).toBe("hello");
		expect(
			fieldValueFromDto(column({ datatype: "text", is_multiple: true }), {
				TextMultiple: ["a", "b"],
			}),
		).toEqual(["a", "b"]);
		expect(
			fieldValueFromDto(column({ datatype: "enumeration" }), {
				Enumeration: "good",
			}),
		).toBe("good");
	});

	it("maps datetimes to the LOCAL calendar date for editing", () => {
		const raw = "2024-01-15T10:30:00+00:00";
		expect(
			fieldValueFromDto(column({ datatype: "datetime" }), { Datetime: raw }),
		).toBe(localDate(new Date(raw)));

		// An instant near the UTC day boundary must land on the local date,
		// not the UTC one.
		const nearBoundary = "2024-01-15T00:10:00+00:00";
		expect(
			fieldValueFromDto(column({ datatype: "datetime" }), {
				Datetime: nearBoundary,
			}),
		).toBe(localDate(new Date(nearBoundary)));
	});

	it("falls back to the raw string for unparseable datetimes", () => {
		expect(
			fieldValueFromDto(column({ datatype: "datetime" }), {
				Datetime: "not a date",
			}),
		).toBe("not a date");
	});
});

describe("dtoFromFieldValue", () => {
	it("maps empty values to null (clear)", () => {
		expect(dtoFromFieldValue(column({ datatype: "bool" }), null)).toBeNull();
		expect(dtoFromFieldValue(column({ datatype: "int" }), "")).toBeNull();
		expect(dtoFromFieldValue(column({ datatype: "float" }), "")).toBeNull();
		expect(dtoFromFieldValue(column({ datatype: "text" }), "")).toBeNull();
		expect(
			dtoFromFieldValue(column({ datatype: "text", is_multiple: true }), []),
		).toBeNull();
		expect(dtoFromFieldValue(column({ datatype: "comments" }), "")).toBeNull();
		expect(
			dtoFromFieldValue(column({ datatype: "datetime" }), "  "),
		).toBeNull();
		expect(
			dtoFromFieldValue(column({ datatype: "enumeration" }), null),
		).toBeNull();
		expect(
			dtoFromFieldValue(column({ datatype: "enumeration" }), ""),
		).toBeNull();
	});

	it("maps yes/no to booleans", () => {
		const bool = column({ datatype: "bool" });
		expect(dtoFromFieldValue(bool, "yes")).toEqual({ Bool: true });
		expect(dtoFromFieldValue(bool, "no")).toEqual({ Bool: false });
	});

	it("truncates int values and parses in-progress number strings", () => {
		const int = column({ datatype: "int" });
		expect(dtoFromFieldValue(int, 7)).toEqual({ Int: 7 });
		expect(dtoFromFieldValue(int, 7.9)).toEqual({ Int: 7 });
		expect(dtoFromFieldValue(int, "12")).toEqual({ Int: 12 });
		expect(dtoFromFieldValue(int, "-")).toBeNull();

		const float = column({ datatype: "float" });
		expect(dtoFromFieldValue(float, 2.25)).toEqual({ Float: 2.25 });
		expect(dtoFromFieldValue(float, "2.5")).toEqual({ Float: 2.5 });
	});

	it("rejects number strings with trailing garbage", () => {
		expect(dtoFromFieldValue(column({ datatype: "int" }), "12abc")).toBeNull();
		expect(dtoFromFieldValue(column({ datatype: "float" }), "2.5x")).toBeNull();
	});

	it("rejects int values outside i32 range", () => {
		const int = column({ datatype: "int" });
		expect(dtoFromFieldValue(int, "2147483648")).toBeNull();
		expect(dtoFromFieldValue(int, "-2147483649")).toBeNull();
		expect(dtoFromFieldValue(int, "2147483647")).toEqual({ Int: 2147483647 });
		expect(dtoFromFieldValue(int, "-2147483648")).toEqual({
			Int: -2147483648,
		});
	});

	it("maps text by multiplicity, and comments to Text", () => {
		expect(dtoFromFieldValue(column({ datatype: "text" }), "hi")).toEqual({
			Text: "hi",
		});
		expect(
			dtoFromFieldValue(column({ datatype: "text", is_multiple: true }), [
				"a",
				"b",
			]),
		).toEqual({ TextMultiple: ["a", "b"] });
		expect(dtoFromFieldValue(column({ datatype: "comments" }), "note")).toEqual(
			{ Text: "note" },
		);
	});

	it("sends LOCAL midnight with the local offset for date-only input", () => {
		expect(
			dtoFromFieldValue(column({ datatype: "datetime" }), "2024-01-15"),
		).toEqual({
			Datetime: `2024-01-15T00:00:00${localOffsetAtMidnight(2024, 1, 15)}`,
		});

		// DST-safe: the offset is derived from the entered date itself.
		expect(
			dtoFromFieldValue(column({ datatype: "datetime" }), "2024-07-15"),
		).toEqual({
			Datetime: `2024-07-15T00:00:00${localOffsetAtMidnight(2024, 7, 15)}`,
		});
	});

	it("writes a local midnight that parses back to the same calendar date", () => {
		const dto = dtoFromFieldValue(
			column({ datatype: "datetime" }),
			"2024-01-15",
		);
		if (dto === null || !("Datetime" in dto)) {
			throw new Error("expected a Datetime DTO");
		}
		expect(localDate(new Date(dto.Datetime))).toBe("2024-01-15");
	});

	it("passes full datetime strings through for backend validation", () => {
		expect(
			dtoFromFieldValue(
				column({ datatype: "datetime" }),
				"2024-01-15T10:30:00+00:00",
			),
		).toEqual({ Datetime: "2024-01-15T10:30:00+00:00" });
	});

	it("maps enumeration selections", () => {
		expect(
			dtoFromFieldValue(
				column({ datatype: "enumeration", enum_values: ["good", "bad"] }),
				"good",
			),
		).toEqual({ Enumeration: "good" });
	});
});

describe("buildCustomFieldValues", () => {
	it("keys values by column id and fills gaps with empty values", () => {
		const columns = [
			column({ column_id: 1, datatype: "bool" }),
			column({ column_id: 2, datatype: "text" }),
		];

		expect(
			buildCustomFieldValues(columns, [
				{ column_id: 2, value: { Text: "hello" } },
			]),
		).toEqual({ "1": null, "2": "hello" });
	});
});

describe("diffCustomValues", () => {
	const columns = [
		column({ column_id: 1, datatype: "bool" }),
		column({ column_id: 2, datatype: "text" }),
		column({ column_id: 3, datatype: "datetime" }),
	];

	it("returns only the columns whose effective value changed", () => {
		const before = { "1": null, "2": "old", "3": "2024-01-15" };
		const after = { "1": "yes", "2": "old", "3": "2024-01-15" };

		expect(diffCustomValues(columns, before, after)).toEqual([
			{ columnId: 1, value: { Bool: true } },
		]);
	});

	it("emits null when a value is cleared", () => {
		const before = { "1": "yes", "2": "old", "3": "2024-01-15" };
		const after = { "1": "yes", "2": "", "3": "2024-01-15" };

		expect(diffCustomValues(columns, before, after)).toEqual([
			{ columnId: 2, value: null },
		]);
	});

	it("treats missing keys as the column's empty value", () => {
		expect(diffCustomValues(columns, {}, { "1": null, "2": "" })).toEqual([]);
	});

	it("does not report equivalent number strings as changes", () => {
		const int = [column({ column_id: 4, datatype: "int" })];
		expect(diffCustomValues(int, { "4": 12 }, { "4": "12" })).toEqual([]);
	});

	it("treats unusable number input as no change, never as clear", () => {
		const int = [column({ column_id: 4, datatype: "int" })];
		// Trailing garbage: no write
		expect(diffCustomValues(int, { "4": 5 }, { "4": "12abc" })).toEqual([]);
		// Out-of-range int: no write
		expect(diffCustomValues(int, { "4": 5 }, { "4": "2147483648" })).toEqual(
			[],
		);
		// Empty string: explicit clear
		expect(diffCustomValues(int, { "4": 5 }, { "4": "" })).toEqual([
			{ columnId: 4, value: null },
		]);
		// Valid input: write
		expect(diffCustomValues(int, { "4": 5 }, { "4": "12" })).toEqual([
			{ columnId: 4, value: { Int: 12 } },
		]);

		const float = [column({ column_id: 5, datatype: "float" })];
		expect(diffCustomValues(float, { "5": 1.5 }, { "5": "2.5x" })).toEqual([]);
		expect(diffCustomValues(float, { "5": 1.5 }, { "5": "2.5" })).toEqual([
			{ columnId: 5, value: { Float: 2.5 } },
		]);
	});

	it("compares datetimes by instant, not by string", () => {
		const dt = [column({ column_id: 6, datatype: "datetime" })];
		// Same instant spelled with different offsets: no change.
		expect(
			diffCustomValues(
				dt,
				{ "6": "2024-01-15T00:00:00+00:00" },
				{ "6": "2024-01-15T01:00:00+01:00" },
			),
		).toEqual([]);
		// Different instants: a change.
		expect(
			diffCustomValues(
				dt,
				{ "6": "2024-01-15T00:00:00+00:00" },
				{ "6": "2024-01-16T00:00:00+00:00" },
			),
		).toEqual([
			{ columnId: 6, value: { Datetime: "2024-01-16T00:00:00+00:00" } },
		]);
	});

	it("does not write when a stored date round-trips unchanged", () => {
		const dtColumn = column({ column_id: 6, datatype: "datetime" });
		// A previously saved local-midnight value comes back from the backend…
		const stored = dtoFromFieldValue(dtColumn, "2024-01-15");
		if (stored === null || !("Datetime" in stored)) {
			throw new Error("expected a Datetime DTO");
		}
		// …is rendered as a local date, and saved again without edits.
		const field = fieldValueFromDto(dtColumn, stored);
		expect(field).toBe("2024-01-15");
		expect(
			diffCustomValues([dtColumn], { "6": field }, { "6": field }),
		).toEqual([]);
	});
});
