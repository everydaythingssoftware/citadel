import type { SwitchStage } from "@/lib/library-switch/machine";
import styles from "./LibrarySwitchCurtain.module.css";

/**
 * Full-window curtain for library switches: pure renderer of the machine's
 * stage. Behavior (store watching, timers, toasts) lives in
 * `use-library-switch.ts`; App calls the hook and passes the stage down.
 */
export const LibrarySwitchCurtain = ({ stage }: { stage: SwitchStage }) => {
	if (stage.id === "idle") return null;

	return (
		<div className={styles.curtain} data-stage={stage.id} role="status">
			<p className={styles.title}>Opening ‘{stage.name}’</p>
			<div
				className={styles.track}
				role="progressbar"
				aria-label={`Opening ${stage.name}`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(stage.progress)}
			>
				<div className={styles.fill} style={{ width: `${stage.progress}%` }} />
			</div>
		</div>
	);
};
