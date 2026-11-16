import type { ReactNode } from "react";
import { AdministratorSetupForm } from "@/components/molecules/AdministratorSetupForm";
import { SignInForm } from "@/components/molecules/SignInForm";
import { Button, LoadingOverlay } from "@/components/ui";
import { useBrowserLibrary } from "@/lib/hooks/use-browser-library";
import {
	BrowserSessionContext,
	type BrowserSessionControls,
	useBrowserSession,
} from "@/lib/hooks/use-browser-session";
import type { SessionInfo, SetupStatus } from "@/lib/services/session";
import { LibraryState } from "@/stores/library/store";
import { WebSetupFlow } from "./WebSetupFlow";

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

/** Why a signed-in reader can't see books yet, in their terms. */
const readerNotice = (
	session: SessionInfo,
	setup: SetupStatus,
): { title: string; message: string } => {
	if (!setup.libraryConfigured)
		return {
			title: "Citadel isn’t set up yet",
			message:
				"This server has no library yet. Ask the administrator to choose one.",
		};
	if (!setup.libraryAvailable)
		return {
			title: "Your library isn’t available",
			message:
				"The server can’t reach its library right now. The administrator can see why and bring it back.",
		};
	return {
		title: "No library to show",
		message: `${session.user.username} doesn’t have access to this server’s library yet. Ask the person who runs Citadel to grant it.`,
	};
};

/** Browser builds sign in before opening the serving origin's library. */
export const BrowserLibraryGate = ({ children }: { children: ReactNode }) => {
	const { state, refresh, signIn, createAdministrator, signOut, controls } =
		useBrowserSession();
	switch (state.status) {
		case "checking":
			return <Loading />;
		case "unreachable":
			return (
				<Notice title="Couldn’t reach Citadel" message={state.error}>
					<Button onClick={() => void refresh()}>Try Again</Button>
				</Notice>
			);
		case "unwell":
			return (
				<Notice title="Citadel needs attention" message={state.error}>
					<Button onClick={() => void refresh()}>Try Again</Button>
				</Notice>
			);
		case "wrongAddress":
			return (
				<Notice
					title="Citadel isn’t set up for this address"
					message={state.error}
				>
					<Button onClick={() => void refresh()}>Try Again</Button>
				</Notice>
			);
		case "needsAdministrator":
			return (
				<AdministratorSetupForm
					onSubmit={(code, username, password) =>
						void createAdministrator(code, username, password)
					}
					pending={state.pending}
					error={state.error}
				/>
			);
		case "signedOut":
			return (
				<SignInForm
					onSubmit={(username, password) => void signIn(username, password)}
					pending={state.pending}
					error={state.error}
				/>
			);
		case "signedIn": {
			const { session, setup } = state;
			// Administrators finish setup here; the library gate waits for them.
			if (
				session.administrator &&
				(!setup.libraryConfigured || !setup.libraryAvailable)
			)
				return <WebSetupFlow onFinished={() => void refresh()} />;
			if (!session.libraryAccess || !controls) {
				const notice = readerNotice(session, setup);
				return (
					<Notice title={notice.title} message={notice.message}>
						<Button onClick={() => void refresh()}>Check Again</Button>
						<Button variant="subtle" onClick={() => void signOut()}>
							Sign Out
						</Button>
					</Notice>
				);
			}
			return (
				<BrowserSessionContext.Provider value={controls}>
					<SignedInLibrary controls={controls} onRetry={refresh}>
						{children}
					</SignedInLibrary>
				</BrowserSessionContext.Provider>
			);
		}
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
					Try Again
				</Button>
				<Button variant="subtle" onClick={() => void controls.signOut()}>
					Sign Out
				</Button>
			</Notice>
		);
	return <Loading />;
};
