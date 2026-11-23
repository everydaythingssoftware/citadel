import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Books } from "@/components/pages/Books";
import { drillSourceFrom, type TDrillSource } from "@/lib/drill-down";

interface BookSearch {
	/** Only books by this author (LibraryAuthor id). */
	author_id?: string;
	/** Only books in this series (LibrarySeries id). */
	series_id?: number;
	/** Only books with this tag (LibraryTag id). */
	tag_id?: number;
	/** Only books from this publisher (LibraryPublisher id). */
	publisher_id?: number;
	/** The list page these books were drilled into from, for the way back. */
	from?: TDrillSource;
}

const integerParam = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : undefined;
};

export const Route = createFileRoute("/")({
	component: Index,
	validateSearch: (search: Record<string, unknown>): BookSearch => {
		// validate and parse the search params into a typed state
		return {
			author_id:
				typeof search.author_id === "string" ? search.author_id : undefined,
			series_id: integerParam(search.series_id),
			tag_id: integerParam(search.tag_id),
			publisher_id: integerParam(search.publisher_id),
			from: drillSourceFrom(search.from),
		};
	},
});

function Index() {
	const { author_id, series_id, tag_id, publisher_id, from } = useSearch({
		from: "/",
	});
	return (
		<Books
			author_id={author_id}
			series_id={series_id}
			tag_id={tag_id}
			publisher_id={publisher_id}
			from={from}
		/>
	);
}
