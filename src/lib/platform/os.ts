export type OperatingSystem =
	| "macos"
	| "windows"
	| "linux"
	| "ios"
	| "android"
	| "other";

export interface OperatingSystemHints {
	/** `navigator.userAgentData.platform`, where the browser has it. */
	platform?: string;
	userAgent: string;
	maxTouchPoints: number;
}

const fromPlatformName = (platform: string): OperatingSystem | null => {
	const name = platform.toLowerCase();
	if (name === "macos") return "macos";
	if (name === "windows") return "windows";
	if (name === "android") return "android";
	if (name === "ios") return "ios";
	if (name === "linux" || name === "chrome os" || name === "chromeos")
		return "linux";
	return null;
};

const fromUserAgent = (
	userAgent: string,
	maxTouchPoints: number,
): OperatingSystem => {
	if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
	// iPadOS Safari asks for desktop sites as a Mac; only touch gives it away.
	if (/Macintosh|Mac OS X/.test(userAgent))
		return maxTouchPoints > 1 ? "ios" : "macos";
	if (/Android/.test(userAgent)) return "android";
	if (/Windows/.test(userAgent)) return "windows";
	if (/Linux|X11|CrOS/.test(userAgent)) return "linux";
	return "other";
};

export const operatingSystemFrom = ({
	platform,
	userAgent,
	maxTouchPoints,
}: OperatingSystemHints): OperatingSystem => {
	const named = platform ? fromPlatformName(platform) : null;
	if (named === "macos" && maxTouchPoints > 1) return "ios";
	return named ?? fromUserAgent(userAgent, maxTouchPoints);
};

interface NavigatorWithUserAgentData extends Navigator {
	userAgentData?: { platform?: string };
}

export const detectOperatingSystem = (): OperatingSystem => {
	if (typeof navigator === "undefined") return "other";
	const nav = navigator as NavigatorWithUserAgentData;
	return operatingSystemFrom({
		platform: nav.userAgentData?.platform,
		userAgent: nav.userAgent,
		maxTouchPoints: nav.maxTouchPoints ?? 0,
	});
};
