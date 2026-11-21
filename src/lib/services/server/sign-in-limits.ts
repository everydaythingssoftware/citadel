import type { SignInLimits } from "./types";

const counted = (count: number, one: string, many: string) =>
	`${count} ${count === 1 ? one : many}`;

/**
 * What the sign-in limits are doing right now, in a sentence or two: who is
 * refused, and who is slowed down and who isn't.
 */
export const signInLimitsSummary = ({
	bannedAddresses,
	bannedBlocks,
	slowedUsernames,
}: SignInLimits): string => {
	const refused = [
		bannedAddresses > 0 && counted(bannedAddresses, "address", "addresses"),
		bannedBlocks > 0 && counted(bannedBlocks, "network", "networks"),
	].filter((part): part is string => typeof part === "string");
	const sentences = [
		refused.length > 0 &&
			`${refused.join(" and ")} ${
				bannedAddresses + bannedBlocks === 1 ? "is" : "are"
			} refused for too many wrong sign-ins.`,
		slowedUsernames > 0 &&
			`${counted(slowedUsernames, "username is", "usernames are")} being slowed down on new devices; browsers and readers that signed in before aren’t affected.`,
	].filter((part): part is string => typeof part === "string");
	return sentences.length > 0
		? sentences.join(" ")
		: "Nobody is being refused or slowed down for wrong sign-ins.";
};
