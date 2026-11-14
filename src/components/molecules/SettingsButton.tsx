import clsx from "clsx";
import { F7Gear } from "@/components/icons/F7Gear";
import { IconButton, Tooltip } from "@/components/ui";
import styles from "./SettingsButton.module.css";

export interface SettingsButtonProps {
	onClick: () => void;
	/** Settings is the page showing (web, where Settings is a page). */
	active?: boolean;
	className?: string;
}

/**
 * The sidebar gear, on the web and on Windows and Linux. The Mac opens
 * Settings with ⌘, and from the app menu instead.
 */
export const SettingsButton = ({
	onClick,
	active = false,
	className,
}: SettingsButtonProps) => (
	<Tooltip label="Settings">
		<IconButton
			aria-label="Settings"
			className={clsx(styles.button, className)}
			data-active={active || undefined}
			aria-current={active ? "page" : undefined}
			onClick={onClick}
		>
			{/* F7Gear hardcodes width/height 56; size it to fit the button. */}
			<F7Gear width={16} height={16} />
		</IconButton>
	</Tooltip>
);
