import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type BrowserSession,
	createBrowserSession,
	type SessionInfo,
	type SetupStatus,
	ServerUnreachableError,
	WrongAddressError,
} from "@/lib/services/session";

export type BrowserSessionState =
	| { status: "checking" }
	| { status: "unreachable"; error: string }
	/** The server answered, but with an error it can't get past, such as a
	 * database it can't open. */
	| { status: "unwell"; error: string }
	/** Opened at an address the server isn't set up for. */
	| { status: "wrongAddress"; error: string }
	/** A fresh server: nobody can sign in until the administrator exists. */
	| {
			status: "needsAdministrator";
			error: string | null;
			pending: boolean;
	  }
	| {
			status: "signedOut";
			setup: SetupStatus;
			error: string | null;
			pending: boolean;
	  }
	| { status: "signedIn"; session: SessionInfo; setup: SetupStatus };

export interface BrowserSessionControls {
	username: string;
	/** May administer the server; sees update notices. */
	administrator: boolean;
	signOut: () => Promise<void>;
}

/** Present only in browser builds once a user is signed in. */
export const BrowserSessionContext =
	createContext<BrowserSessionControls | null>(null);

export const useBrowserSessionControls = () =>
	useContext(BrowserSessionContext);

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Session state machine for the browser gate. */
export const useBrowserSession = (
	service: BrowserSession = createBrowserSession(window.location.origin),
	reload: () => void = () => window.location.assign("/"),
) => {
	const [session] = useState(() => service);
	const [reloadPage] = useState(() => reload);
	const [state, setState] = useState<BrowserSessionState>({
		status: "checking",
	});

	const refresh = useCallback(async () => {
		try {
			const setup = await session.setupStatus();
			if (!setup.administratorExists) {
				setState({
					status: "needsAdministrator",
					error: null,
					pending: false,
				});
				return;
			}
			const current = await session.current();
			setState(
				current
					? { status: "signedIn", session: current, setup }
					: { status: "signedOut", setup, error: null, pending: false },
			);
		} catch (error) {
			setState(
				error instanceof WrongAddressError
					? { status: "wrongAddress", error: error.message }
					: error instanceof ServerUnreachableError
						? { status: "unreachable", error: message(error) }
						: { status: "unwell", error: message(error) },
			);
		}
	}, [session]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const signIn = useCallback(
		async (username: string, password: string) => {
			setState((previous) =>
				previous.status === "signedOut"
					? { ...previous, error: null, pending: true }
					: previous,
			);
			try {
				const signedIn = await session.signIn(username, password);
				const setup = await session.setupStatus();
				setState({ status: "signedIn", session: signedIn, setup });
			} catch (error) {
				setState((previous) =>
					previous.status === "signedOut"
						? { ...previous, error: message(error), pending: false }
						: previous,
				);
			}
		},
		[session],
	);

	const createAdministrator = useCallback(
		async (setupCode: string, username: string, password: string) => {
			setState((previous) =>
				previous.status === "needsAdministrator"
					? { ...previous, error: null, pending: true }
					: previous,
			);
			try {
				const signedIn = await session.createAdministrator(
					setupCode,
					username,
					password,
				);
				const setup = await session.setupStatus();
				setState({ status: "signedIn", session: signedIn, setup });
			} catch (error) {
				setState((previous) =>
					previous.status === "needsAdministrator"
						? { ...previous, error: message(error), pending: false }
						: previous,
				);
			}
		},
		[session],
	);

	// A full reload drops every in-memory cache of the previous user's library.
	const signOut = useCallback(async () => {
		await session.signOut();
		reloadPage();
	}, [session, reloadPage]);

	const controls = useMemo<BrowserSessionControls | null>(
		() =>
			state.status === "signedIn"
				? {
						username: state.session.user.username,
						administrator: state.session.administrator,
						signOut,
					}
				: null,
		[state, signOut],
	);

	return { state, refresh, signIn, createAdministrator, signOut, controls };
};
