import { useEffect } from "react";

import { NamedCountList } from "@/components/organisms/NamedCountList";
import {
	useLibraryActions,
	useLibraryReady,
	usePublishers,
	usePublishersLoading,
} from "@/stores/library/store";

const PUBLISHER_NOUN = ["publisher", "publishers"] as const;

export const Publishers = () => {
	// Loaded on first visit (clb_query_list_publishers), sorted by name with
	// book counts, and refreshed by the store after mutations.
	const publishers = usePublishers();
	const loading = usePublishersLoading();
	const { loadPublishers } = useLibraryActions();
	const libraryReady = useLibraryReady();

	// Waits for the library: on a cold start this page can mount before the
	// library opens, and the store's loader is a no-op until then.
	useEffect(() => {
		if (libraryReady && publishers === null && !loading) void loadPublishers();
	}, [libraryReady, publishers, loading, loadPublishers]);

	if (publishers === null) {
		return null;
	}

	return (
		<NamedCountList
			items={publishers}
			kind="publishers"
			noun={PUBLISHER_NOUN}
			toSearch={(publisher) => ({
				publisher_id: publisher.id,
				from: "publishers",
			})}
		/>
	);
};
