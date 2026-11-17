import { Button } from "@/components/ui";
import { useAddBook } from "@/lib/hooks/use-add-book";

export const AddBookButton = () => {
	const { startAddBook, canAddBook } = useAddBook();

	if (!canAddBook) {
		return null;
	}

	return (
		<Button variant="default" aria-label="Add Book" onClick={startAddBook}>
			<svg
				width="13"
				height="13"
				viewBox="0 0 15 15"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M7.5 2v11M2 7.5h11"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round"
				/>
			</svg>
			Add Book…
		</Button>
	);
};
