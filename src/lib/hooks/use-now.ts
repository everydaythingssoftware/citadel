import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while mounted. */
export const useNow = (intervalMs = 30_000): Date => {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
};
