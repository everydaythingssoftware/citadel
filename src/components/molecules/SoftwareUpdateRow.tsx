import { Button, InlineLink, ProgressBar, Spinner } from "@/components/ui";
import {
	type SoftwareUpdateControl,
	type SoftwareUpdateState,
	softwareUpdateRowView,
} from "@/lib/updates/software-update";
import styles from "./SoftwareUpdateRow.module.css";

export interface SoftwareUpdateRowProps {
	state: SoftwareUpdateState;
	onCheck: () => void;
	onUpdateNow: () => void;
	onLater: () => void;
	onRestartNow: () => void;
}

/**
 * Settings → General: one row that shows the update state, for the desktop
 * app or, in the browser, the server.
 */
export const SoftwareUpdateRow = ({
	state,
	...handlers
}: SoftwareUpdateRowProps) => {
	const { label, description, detail, controls } = softwareUpdateRowView(state);

	return (
		// Keyed by the label so the row fades in only when its text changes.
		// Steps that keep the text (checking) swap their
		// controls in place.
		<div key={label} className={styles.enter}>
			<div className={styles.row}>
				<span className={styles.labels}>
					<span className={styles.label}>{label}</span>
					{description && (
						<span className={styles.description}>{description}</span>
					)}
					{detail && <span className={styles.detail}>{detail}</span>}
				</span>
				<div className={styles.controls}>
					{controls.map((control) => (
						<Control key={control.kind} control={control} {...handlers} />
					))}
				</div>
			</div>
		</div>
	);
};

const Control = ({
	control,
	onCheck,
	onUpdateNow,
	onLater,
	onRestartNow,
}: Omit<SoftwareUpdateRowProps, "state"> & {
	control: SoftwareUpdateControl;
}) => {
	switch (control.kind) {
		case "check":
			return (
				<>
					{control.checking && (
						<Spinner size={14} aria-label="Checking for updates" />
					)}
					<Button size="sm" disabled={control.checking} onClick={onCheck}>
						Check for Updates
					</Button>
				</>
			);
		case "later":
			return (
				<Button size="sm" onClick={onLater}>
					Later
				</Button>
			);
		case "updateNow":
			return (
				<Button size="sm" variant="primary" onClick={onUpdateNow}>
					Update Now
				</Button>
			);
		case "progress":
			return (
				<ProgressBar
					className={styles.progress}
					value={control.value}
					aria-label={`Downloading Citadel ${control.version}`}
				/>
			);
		case "restartNow":
			return (
				<Button size="sm" variant="primary" onClick={onRestartNow}>
					Restart Now
				</Button>
			);
		case "retryCheck":
			return (
				<Button size="sm" onClick={onCheck}>
					Try Again
				</Button>
			);
		case "retryUpdate":
			return (
				<Button size="sm" onClick={onUpdateNow}>
					Try Again
				</Button>
			);
		case "releaseNotes":
			return (
				<InlineLink href={control.url} isExternal className={styles.link}>
					Release notes
				</InlineLink>
			);
	}
};
