import clsx from "clsx";
import { UpdateBadge } from "@/components/atoms/UpdateBadge";
import { F7Gear } from "@/components/icons/F7Gear";
import { IconButton, Tooltip } from "@/components/ui";
import styles from "./SettingsButton.module.css";

export interface SettingsButtonProps {
	/** Version of a pending update; badges the gear when set. */
	updateVersion: string | null;
	onClick: () => void;
	className?: string;
}

/** The sidebar gear. A green ↑ badge marks a waiting Citadel update. */
export const SettingsButton = ({
	updateVersion,
	onClick,
	className,
}: SettingsButtonProps) => {
	const button = (
		<IconButton
			aria-label={
				updateVersion
					? `Settings, update available: ${updateVersion}`
					: "Settings"
			}
			className={clsx(styles.button, className)}
			onClick={onClick}
		>
			{/* F7Gear hardcodes width/height 56; size it to fit the button. */}
			<F7Gear
				width={18}
				height={18}
				className={updateVersion ? styles.gearCutout : undefined}
			/>
			{updateVersion && <UpdateBadge className={styles.badge} />}
		</IconButton>
	);

	return updateVersion ? (
		<Tooltip label={`Update available: ${updateVersion}`}>{button}</Tooltip>
	) : (
		button
	);
};
