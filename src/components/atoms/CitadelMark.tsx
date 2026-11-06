import icon from "@/assets/citadel-icon.png";

interface CitadelMarkProps {
	size?: number;
}

/** The app icon, for the cards that introduce Citadel (sign-in, setup). */
export const CitadelMark = ({ size = 56 }: CitadelMarkProps) => (
	<img
		src={icon}
		width={size}
		height={size}
		alt=""
		draggable={false}
		style={{ display: "block" }}
	/>
);
