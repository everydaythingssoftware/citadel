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
} from "@/lib/services/session";

export type BrowserSessionState =
	| { status: "checking" }
	| { status: "unreachable"; error: string }
	| { status: "signedOut"; error: string | null; pending: boolean }
	| { status: "signedIn"; session: SessionInfo };

export interface BrowserSessionControls {
	username: string;
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
			const current = await session.current();
			setState(
				current
					? { status: "signedIn", session: current }
					: { status: "signedOut", error: null, pending: false },
			);
		} catch (error) {
			setState({ status: "unreachable", error: message(error) });
		}
	}, [session]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const signIn = useCallback(
		async (username: string, password: string) => {
			setState({ status: "signedOut", error: null, pending: true });
			try {
				setState({
					status: "signedIn",
					session: await session.signIn(username, password),
				});
			} catch (error) {
				setState({
					status: "signedOut",
					error: message(error),
					pending: false,
				});
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
				? { username: state.session.user.username, signOut }
				: null,
		[state, signOut],
	);

	return { state, refresh, signIn, signOut, controls };
};
