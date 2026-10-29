import clsx from "clsx";
import styles from "./UpdateBadge.module.css";

export interface UpdateBadgeProps {
	className?: string;
}

/** Red dot: a Citadel update is waiting. */
export const UpdateBadge = ({ className }: UpdateBadgeProps) => (
	<span className={clsx(styles.badge, className)} aria-hidden="true" />
);
