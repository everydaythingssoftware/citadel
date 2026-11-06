import { useState } from "react";
import classes from "@/components/organisms/SettingsPanes.module.css";
import { Button, TextInput } from "@/components/ui";
import {
	CREDENTIAL_BUSY,
	type ProviderCredentialController,
} from "@/lib/hooks/use-provider-credentials";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import type { ProviderId } from "@/lib/metadata-providers/types";

const formatDate = (date: Date): string =>
	date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

/** A keyed provider's status line when the server keeps the user's key. */
export const serverKeyStatus = ({
	saved,
	loading,
}: ProviderCredentialController): string =>
	loading
		? "Checking…"
		: !saved
			? "Requires setup"
			: saved.needsReentry
				? "Enter your key again"
				: saved.accountName
					? `Connected as ${saved.accountName}`
					: "Key saved";

interface ServerProviderKeyProps {
	id: ProviderId;
	controller: ProviderCredentialController;
}

/** The signed-in user's key for one provider: a field to add it, or its details. */
export const ServerProviderKey = ({
	id,
	controller,
}: ServerProviderKeyProps) => {
	const descriptor = getDescriptor(id);
	const { saved, loading, busy, notice } = controller;
	const [draft, setDraft] = useState("");
	const working = busy !== CREDENTIAL_BUSY.idle;
	const showForm = !saved || saved.needsReentry;

	return (
		<>
			{saved && !saved.needsReentry && (
				<p className={classes.rowDescription}>
					Added {formatDate(saved.createdAt)}
					{saved.verifiedAt &&
						` · last checked ${formatDate(saved.verifiedAt)}`}
				</p>
			)}
			{saved?.needsReentry && (
				<p className={classes.inlineNote} data-tone="error">
					This server can no longer read your saved key. Enter it again to keep
					using {descriptor.displayName}.
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
						variant="default"
						disabled={working}
						onClick={() => void controller.remove()}
					>
						{busy === CREDENTIAL_BUSY.removing ? "Removing…" : "Remove"}
					</Button>
					<Button
						variant="default"
						disabled={working}
						onClick={() => void controller.test()}
					>
						{busy === CREDENTIAL_BUSY.testing ? "Testing…" : "Test"}
					</Button>
				</div>
			)}
			{notice && (
				<p className={classes.inlineNote} data-tone={notice.tone} role="status">
					{notice.message}
				</p>
			)}
		</>
	);
};
