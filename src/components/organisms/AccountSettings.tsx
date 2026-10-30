import { useState } from "react";
import classes from "@/components/organisms/SettingsPanes.module.css";
import { Button, TextInput } from "@/components/ui";
import {
	CREDENTIAL_BUSY,
	type ProviderCredentialController,
	useProviderCredential,
} from "@/lib/hooks/use-provider-credentials";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import type { ProviderId } from "@/lib/metadata-providers/types";

const formatDate = (date: Date): string =>
	date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

interface ProviderKeyRowProps {
	id: ProviderId;
	controller: ProviderCredentialController;
}

/** One provider's key: who it belongs to, or a field to add one. */
export const ProviderKeyRow = ({ id, controller }: ProviderKeyRowProps) => {
	const descriptor = getDescriptor(id);
	const { saved, loading, busy, notice } = controller;
	const [draft, setDraft] = useState("");
	const working = busy !== CREDENTIAL_BUSY.idle;
	const showForm = !saved || saved.needsReentry;

	const status = loading
		? "Checking…"
		: !saved
			? "Not set up"
			: saved.needsReentry
				? "Enter your key again"
				: saved.accountName
					? `Connected as ${saved.accountName}`
					: "Connected";

	return (
		<div className={classes.providerRow}>
			<div className={classes.providerHeader}>
				<div className={classes.rowLabels}>
					<span className={classes.rowLabel}>{descriptor.displayName}</span>
					<span className={classes.rowDescription}>{status}</span>
				</div>
			</div>
			<div className={classes.providerBody} data-flush="true">
				<p className={classes.rowDescription}>{descriptor.blurb}</p>
				{saved && !saved.needsReentry && (
					<p className={classes.rowDescription}>
						Added {formatDate(saved.createdAt)}
						{saved.verifiedAt &&
							` · last checked ${formatDate(saved.verifiedAt)}`}
					</p>
				)}
				{saved?.needsReentry && (
					<p className={classes.inlineNote} data-tone="error">
						This server can no longer read your saved key. Enter it again to
						keep using {descriptor.displayName}.
					</p>
				)}
				{showForm ? (
					<form
						className={classes.keyForm}
						onSubmit={(event) => {
							event.preventDefault();
							void controller.save(draft).then((ok) => {
								if (ok) setDraft("");
							});
						}}
					>
						<TextInput
							className={classes.keyInput}
							type="password"
							autoComplete="off"
							placeholder="API key"
							aria-label={`${descriptor.displayName} API key`}
							value={draft}
							onChange={(event) => setDraft(event.currentTarget.value)}
						/>
						<div className={classes.rowActions}>
							<Button
								size="sm"
								variant="primary"
								type="submit"
								disabled={!draft.trim() || working || loading}
							>
								{busy === CREDENTIAL_BUSY.saving ? "Checking…" : "Save"}
							</Button>
						</div>
					</form>
				) : (
					<div className={classes.rowActions}>
						<Button
							size="sm"
							variant="default"
							disabled={working}
							onClick={() => void controller.remove()}
						>
							{busy === CREDENTIAL_BUSY.removing ? "Removing…" : "Remove"}
						</Button>
						<Button
							size="sm"
							variant="default"
							disabled={working}
							onClick={() => void controller.test()}
						>
							{busy === CREDENTIAL_BUSY.testing ? "Testing…" : "Test"}
						</Button>
					</div>
				)}
				{notice && (
					<p
						className={classes.inlineNote}
						data-tone={notice.tone}
						role="status"
					>
						{notice.message}
					</p>
				)}
			</div>
		</div>
	);
};

/** The signed-in user's own settings on this Citadel server. */
export const AccountSettings = () => {
	const hardcover = useProviderCredential("hardcover");
	return (
		<div className={classes.groups}>
			<div>
				<h4 className={classes.groupTitle}>Metadata providers</h4>
				<p className={classes.paneNote}>
					Some sources need your own account. Citadel checks each key with the
					provider, keeps it encrypted on this server for your lookups only, and
					never shows it again.
				</p>
				<div className={classes.group}>
					<ProviderKeyRow id="hardcover" controller={hardcover} />
				</div>
			</div>
		</div>
	);
};
