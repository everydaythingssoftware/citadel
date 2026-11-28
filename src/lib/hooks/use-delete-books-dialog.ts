import {
	deleteBooksCopy,
	deleteBooksDialogTitle,
} from "@/lib/delete-book-title";
import { usePlatform } from "@/lib/platform/context";
import { BookDeletion } from "@/lib/services/library";
import { forgetDeletedBooks } from "@/stores/book-selection/store";
import {
	setDeleteBooksState,
	useDeleteBooksStore,
} from "@/stores/delete-books/store";
import { useLibraryStore } from "@/stores/library/store";

const IDLE = { step: "idle" } as const;

const confirmDelete = async () => {
	const state = useDeleteBooksStore.getState();
	if (state.step !== "confirm") return;
	const ids = state.books.map((book) => book.id);
	const count = ids.length;
	setDeleteBooksState(IDLE);
	try {
		const outcome = await useLibraryStore.getState().actions.deleteBooks(ids);
		forgetDeletedBooks(ids);
		if (outcome.folder_failures.length > 0)
			setDeleteBooksState({
				step: "problem",
				count,
				problem: { kind: "files", paths: outcome.folder_failures },
			});
	} catch (cause) {
		setDeleteBooksState({
			step: "problem",
			count,
			problem: {
				kind: "error",
				message: cause instanceof Error ? cause.message : String(cause),
			},
		});
	}
};

const closeStep = (step: "confirm" | "problem") => () => {
	if (useDeleteBooksStore.getState().step === step) setDeleteBooksState(IDLE);
};

/** The one confirmation a delete from the grid asks for (ADR 0014). */
export const useDeleteBooksDialog = () => {
	const platform = usePlatform();
	const state = useDeleteBooksStore();
	const deletion = useLibraryStore(
		(library) => library.library?.bookDeletion ?? BookDeletion.trash,
	);
	const books = state.step === "confirm" ? state.books : [];
	const copy = deleteBooksCopy(
		deletion,
		state.step === "problem" ? state.count : books.length,
		platform.os,
	);
	const problem = state.step === "problem" ? state.problem : null;
	return {
		confirmOpen: state.step === "confirm",
		title: deleteBooksDialogTitle(books.map((book) => book.title)),
		copy,
		problemOpen: problem !== null,
		problemTitle:
			problem?.kind === "error" ? "Couldn’t delete books" : copy.failureTitle,
		problemDescription:
			problem?.kind === "error"
				? problem.message
				: `${copy.failureDescription} ${problem?.paths.join(", ") ?? ""}`,
		confirm: () => void confirmDelete(),
		cancel: closeStep("confirm"),
		dismissProblem: closeStep("problem"),
	};
};
