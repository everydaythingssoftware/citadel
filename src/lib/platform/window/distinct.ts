/** Passes a value on only when it differs from the last one passed on. */
export const distinct = <TValue>(
	handler: (value: TValue) => void,
): ((value: TValue) => void) => {
	let last: { value: TValue } | null = null;
	return (value) => {
		if (last !== null && Object.is(last.value, value)) return;
		last = { value };
		handler(value);
	};
};
