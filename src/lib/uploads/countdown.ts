/** The last part of the review window, when the hourglass asks for attention. */
export const URGENT_FRACTION = 0.25;

export interface Countdown {
	remainingMs: number;
	/** 1 with the whole review window left, 0 at the deadline. */
	fraction: number;
	urgent: boolean;
	expired: boolean;
	/** "23 h left", "40 min left". */
	short: string;
	/** "Add or skip by 3:40 pm tomorrow, or it'll be discarded". */
	description: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (date: Date): number =>
	new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "3:40 pm today", "9:05 am tomorrow", "11:00 am on Fri 6 Nov". */
export const describeDeadline = (
	deadline: Date,
	now: Date,
	locale?: string,
): string => {
	const time = deadline.toLocaleTimeString(locale, {
		hour: "numeric",
		minute: "2-digit",
	});
	const days = Math.round((startOfDay(deadline) - startOfDay(now)) / DAY);
	if (days <= 0) return `${time} today`;
	if (days === 1) return `${time} tomorrow`;
	const date = deadline.toLocaleDateString(locale, {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
	return `${time} on ${date}`;
};

export const shortRemaining = (remainingMs: number): string => {
	if (remainingMs <= 0) return "Time's up";
	if (remainingMs < HOUR) return `${Math.max(1, Math.ceil(remainingMs / MINUTE))} min left`;
	if (remainingMs < 2 * DAY) return `${Math.floor(remainingMs / HOUR)} h left`;
	return `${Math.floor(remainingMs / DAY)} days left`;
};

/** How much of an upload's review window is left. */
export const countdown = (
	expiresAt: string,
	now: Date,
	windowSeconds: number,
	locale?: string,
): Countdown => {
	const deadline = new Date(expiresAt);
	const remainingMs = Math.max(0, deadline.getTime() - now.getTime());
	const windowMs = Math.max(1, windowSeconds * 1000);
	const fraction = Math.min(1, remainingMs / windowMs);
	const expired = remainingMs === 0;
	return {
		remainingMs,
		fraction,
		urgent: !expired && fraction < URGENT_FRACTION,
		expired,
		short: shortRemaining(remainingMs),
		description: expired
			? "This upload has expired and will be discarded"
			: `Add or skip by ${describeDeadline(deadline, now, locale)}, or it'll be discarded`,
	};
};
