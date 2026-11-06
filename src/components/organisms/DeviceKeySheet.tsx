import { TablerCopy } from "@/components/icons/TablerCopy";
import classes from "@/components/organisms/DeviceKeySheet.module.css";
import { Button, IconButton, Sheet, TextInput } from "@/components/ui";
import type { DeviceKeySheetView } from "@/lib/hooks/use-device-key-sheet";

interface DeviceKeySheetProps {
	open: boolean;
	view: DeviceKeySheetView | null;
	name: string;
	copied: boolean;
	isActing: boolean;
	error: string | null;
	/** Where readers connect, once sharing is running. */
	address: string | null;
	onNameChange: (name: string) => void;
	onSubmitName: () => void;
	onCopyKey: () => void;
	onClose: () => void;
	onCloseAutoFocus: (event: Event) => void;
}

/** The password can't be shown again, so its step closes only through Done. */
export const DeviceKeySheet = ({
	open,
	view,
	name,
	copied,
	isActing,
	error,
	address,
	onNameChange,
	onSubmitName,
	onCopyKey,
	onClose,
	onCloseAutoFocus,
}: DeviceKeySheetProps) => (
	<Sheet
		open={open}
		onOpenChange={(next) => {
			if (!next) onClose();
		}}
		title={view?.step === "showing" ? view.key.key.name : "Add Device"}
		width={400}
		dismissible={view?.step !== "showing"}
		onOpenAutoFocus={(event) => {
			// Rotating opens straight on this step: focus nothing that a held
			// key could press. Arriving from the naming step lands the same way.
			if (view?.step !== "showing") return;
			event.preventDefault();
			(event.target as HTMLElement).focus();
		}}
		onCloseAutoFocus={onCloseAutoFocus}
	>
		{view?.step === "showing" ? (
			<div className={classes.showing}>
				<dl className={classes.details}>
					<dt className={classes.passwordLabel}>Password</dt>
					<dd>
						<div className={classes.passwordRow}>
							<code className={classes.password}>{view.key.secret}</code>
							<IconButton
								aria-label="Copy password"
								className={copied ? classes.copied : undefined}
								onMouseDown={(event) => event.preventDefault()}
								onClick={onCopyKey}
							>
								{copied ? (
									<svg
										className={classes.check}
										aria-hidden="true"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.5"
										strokeLinecap="round"
									>
										<path d="M4 12.5l5 5L20 6.5" />
									</svg>
								) : (
									<TablerCopy />
								)}
							</IconButton>
							<span className={classes.visuallyHidden} aria-live="polite">
								{copied ? "Copied" : ""}
							</span>
						</div>
						<p className={classes.note}>
							This password will only be shown once.
						</p>
					</dd>
					<dt>Address</dt>
					<dd className={address ? classes.value : classes.pending}>
						{address ?? "Not sharing yet"}
					</dd>
					<dt>Username</dt>
					<dd className={classes.value}>{view.key.username}</dd>
				</dl>
				<div className={classes.actions}>
					<Button variant="primary" onClick={onClose}>
						Done
					</Button>
				</div>
			</div>
		) : (
			<form
				className={classes.stack}
				onSubmit={(event) => {
					event.preventDefault();
					onSubmitName();
				}}
			>
				<TextInput
					autoFocus
					label="Device"
					placeholder="e.g. Kobo, KOReader on phone"
					error={error}
					value={name}
					spellCheck={false}
					onChange={(event) => onNameChange(event.currentTarget.value)}
				/>
				<div className={classes.actions}>
					<Button onClick={onClose}>Cancel</Button>
					<Button
						type="submit"
						variant="primary"
						disabled={isActing || !name.trim()}
					>
						Add
					</Button>
				</div>
			</form>
		)}
	</Sheet>
);
