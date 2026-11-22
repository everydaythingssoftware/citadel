// Keep the exiting cover mounted until its animation ends so its size is preserved.
export const reviewCovers = <TItem extends { key: string }>(
	items: TItem[],
	departing?: { item: TItem; index: number },
) => {
	const visible = items.map((item, position) => ({ item, position }));
	if (!departing || items.some((item) => item.key === departing.item.key))
		return visible;

	const { item, index } = departing;
	return [
		...visible.slice(0, index),
		{ item, position: undefined },
		...visible.slice(index),
	];
};
