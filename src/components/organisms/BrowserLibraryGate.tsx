import type { ReactNode } from "react";
import { SignInForm } from "@/components/molecules/SignInForm";
import { Button, LoadingOverlay } from "@/components/ui";
import { useBrowserLibrary } from "@/lib/hooks/use-browser-library";
import {
	BrowserSessionContext,
	type BrowserSessionControls,
	useBrowserSession,
} from "@/lib/hooks/use-browser-session";
import { LibraryState } from "@/stores/library/store";

const Loading = () => (
	<div style={{ height: "100vh", position: "relative" }}>
		<LoadingOverlay visible />
	</div>
);

interface NoticeProps {
	title: string;
	message: string;
	children: ReactNode;
}

const Notice = ({ title, message, children }: NoticeProps) => (
	<main style={{ padding: "3rem", maxWidth: "40rem", margin: "auto" }}>
		<h1>{title}</h1>
		<p role="alert">{message}</p>
		<div style={{ display: "flex", gap: "0.5rem" }}>{children}</div>
	</main>
);

/** Browser builds sign in before opening the serving origin's library. */
export const BrowserLibraryGate = ({ children }: { children: ReactNode }) => {
	const { state, refresh, signIn, signOut, controls } = useBrowserSession();
	switch (state.status) {
		case "checking":
			return <Loading />;
		case "unreachable":
			return (
				<Notice title="Couldn’t reach Citadel" message={state.error}>
					<Button onClick={() => void refresh()}>Try again</Button>
				</Notice>
			);
		case "signedOut":
			return (
				<SignInForm
					onSubmit={(username, password) => void signIn(username, password)}
					pending={state.pending}
					error={state.error}
				/>
			);
		case "signedIn":
			if (!state.session.libraryAccess || !controls)
				return (
					<Notice
						title="No library to show"
						message={`${state.session.user.username} doesn’t have access to this server’s library yet. Ask the person who runs Citadel to grant it.`}
					>
						<Button onClick={() => void signOut()}>Sign out</Button>
					</Notice>
				);
			return (
				<BrowserSessionContext.Provider value={controls}>
					<SignedInLibrary controls={controls} onRetry={refresh}>
						{children}
					</SignedInLibrary>
				</BrowserSessionContext.Provider>
			);
	}
};

interface SignedInLibraryProps {
	controls: BrowserSessionControls;
	onRetry: () => Promise<void>;
	children: ReactNode;
}

const SignedInLibrary = ({
	controls,
	onRetry,
	children,
}: SignedInLibraryProps) => {
	const { state, error, retry } = useBrowserLibrary();
	if (state === LibraryState.ready) return <>{children}</>;
	if (state === LibraryState.error)
		return (
			<Notice
				title="Couldn’t open your library"
				message={error?.message ?? "The Citadel server could not be reached."}
			>
				<Button
					onClick={async () => {
						// An expired session returns the gate to the sign-in form.
						await onRetry();
						await retry();
					}}
				>
					Try again
				</Button>
				<Button variant="subtle" onClick={() => void controls.signOut()}>
					Sign out
				</Button>
			</Notice>
		);
	return <Loading />;
};
