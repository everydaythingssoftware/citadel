/**
 * Pure decision policy for the library-switch curtain shell
 * (`use-library-switch.ts`): given a settings path change, decide how the
 * curtain should react. The store runs its own matching policy in
 * `initialize` (a switch back to the confirmed library drops the pending
 * shadow); both sides key off the same signal — target path vs the store's
 * confirmed path — so the shell never arms for a switch the store cancels.
 */

export type CurtainSwitchDecision =
	| { kind: "ignore" }
	| { kind: "cancel" }
	| { kind: "arm-deadline" }
	| { kind: "show-immediately" };

export interface CurtainSwitchInput {
	/** The machine is showing a curtain (arming, working, or revealing). */
	curtainUp: boolean;
	/** The library store was ready before this path change. */
	wasReady: boolean;
	/** Absolute path the settings store now points at. */
	targetPath: string;
	/** Path of the store's confirmed (flipped) generation; null before the
	 * first successful open. */
	confirmedPath: string | null;
}

export const decideCurtainSwitch = (
	input: CurtainSwitchInput,
): CurtainSwitchDecision => {
	if (!input.wasReady && !input.curtainUp) return { kind: "ignore" };
	if (
		input.confirmedPath !== null &&
		input.targetPath === input.confirmedPath
	) {
		return { kind: "cancel" };
	}
	return input.curtainUp
		? { kind: "show-immediately" }
		: { kind: "arm-deadline" };
};
