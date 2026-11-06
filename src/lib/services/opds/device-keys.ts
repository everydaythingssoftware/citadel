import type { DeviceKey } from "@/bindings";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
});

const startOfDay = (date: Date): number =>
	new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const lastUsedLabel = (lastUsed: Date, now: Date): string => {
	const days = Math.round(
		(startOfDay(now) - startOfDay(lastUsed)) / 86_400_000,
	);
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	return DATE_FORMAT.format(lastUsed);
};

export const deviceKeyUsage = (
	key: DeviceKey,
	now: Date = new Date(),
): string => {
	const added = `Added ${DATE_FORMAT.format(new Date(key.createdAt * 1_000))}`;
	return key.lastUsedAt === null
		? `${added} · Never used`
		: `${added} · Last used ${lastUsedLabel(new Date(key.lastUsedAt * 1_000), now)}`;
};
