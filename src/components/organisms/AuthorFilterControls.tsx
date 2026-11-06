import { Checkbox, SearchField, Select } from "@/components/ui";
import {
	type AuthorSortOrderValue,
	sortOrderOptions,
	type UseAuthorFiltersReturn,
} from "@/lib/hooks/use-author-filters";

interface AuthorFilterControlsProps {
	filters: UseAuthorFiltersReturn["filters"];
	onSearchChange: (term: string) => void;
	onSortOrderChange: (order: AuthorSortOrderValue) => void;
	onShowOnlyAuthorsWithoutBooksChange: (show: boolean) => void;
}

export const AuthorFilterControls = ({
	filters,
	onSearchChange,
	onSortOrderChange,
	onShowOnlyAuthorsWithoutBooksChange,
}: AuthorFilterControlsProps) => {
	return (
		<div
			style={{
				display: "flex",
				width: "100%",
				minWidth: 100,
				alignItems: "center",
				flexWrap: "wrap",
				gap: 12,
			}}
		>
			<SearchField
				placeholder="Search authors"
				value={filters.searchTerm}
				onChange={(event) => onSearchChange(event.currentTarget.value)}
				style={{ flex: "1 1 220px", maxWidth: 320 }}
			/>

			<Select
				width={150}
				aria-label="Sort order"
				placeholder="Sort Order"
				options={sortOrderOptions}
				value={filters.sortOrder}
				onChange={(value) => onSortOrderChange(value as AuthorSortOrderValue)}
			/>

			<Checkbox
				label="Without books only"
				checked={filters.showOnlyAuthorsWithoutBooks}
				onCheckedChange={onShowOnlyAuthorsWithoutBooksChange}
			/>
		</div>
	);
};
