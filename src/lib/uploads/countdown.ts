/** The last part of the review window, when the countdown asks for attention. */
const URGENT_FRACTION = 0.25;

export interface Countdown {
	/** In the last part of the review window, but not yet over. */
	urgent: boolean;
	/** "Drafts kept until 3:40 pm tomorrow": why the deadline matters. */
	description: string;
}

const DAY = 24 * 60 * 60_000;

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
	const expired = remainingMs === 0;
	return {
		urgent: !expired && remainingMs / windowMs < URGENT_FRACTION,
		description: expired
			? "These drafts have expired"
			: `Drafts kept until ${describeDeadline(deadline, now, locale)}`,
	};
};
