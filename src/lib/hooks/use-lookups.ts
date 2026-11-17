import { useCallback, useEffect, useState } from "react";
import { none, type Option, some } from "@/lib/option";

/**
 * Asks `look` about each key and keeps the answers for the current keys:
 * none for a key until its answer arrives. `keys` and `look` should be
 * stable: a new list asks about each of its keys again.
 */
export const useLookups = <T>(
	keys: readonly string[],
	look: (key: string) => Promise<T>,
): ((key: string) => Option<T>) => {
	const [answers, setAnswers] = useState<ReadonlyMap<string, T>>(new Map());

	useEffect(() => {
		let live = true;
		setAnswers(
			(previous) =>
				new Map([...previous].filter(([key]) => keys.includes(key))),
		);
		for (const key of keys)
			void look(key).then((answer) => {
				if (live) setAnswers((previous) => new Map(previous).set(key, answer));
			});
		return () => {
			live = false;
		};
	}, [keys, look]);

	return useCallback(
		(key: string) => {
			const answer = answers.get(key);
			return answer === undefined ? none() : some(answer);
		},
		[answers],
	);
};
