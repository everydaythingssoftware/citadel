import { NamedCountList } from "@/components/organisms/NamedCountList";
import { useSeriesList, useSeriesLoading } from "@/stores/library/store";

const SERIES_NOUN = ["series", "series"] as const;

export const Series = () => {
	// The store's series list (clb_query_list_series) arrives sorted by name
	// with book counts; no need to derive it from the full book list.
	const seriesList = useSeriesList();
	const loadingSeries = useSeriesLoading();

	if (loadingSeries) {
		return null;
	}

	return (
		<NamedCountList
			items={seriesList}
			kind="series"
			noun={SERIES_NOUN}
			toSearch={(series) => ({ series_id: series.id, from: "series" })}
		/>
	);
};
