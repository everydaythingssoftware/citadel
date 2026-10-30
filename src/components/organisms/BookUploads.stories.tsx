import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo } from "react";
import { createWebPlatform } from "@/lib/platform/create";
import { PlatformProvider } from "@/lib/platform/context";
import type { Library } from "@/lib/services/library";
import { createFakeUploads } from "@/lib/uploads/fake-uploads";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { useUploadsStore } from "@/stores/uploads/store";
import { BookUploads, UploadToolbarStatus } from "./BookUploads";

const pause = (ms: number) => () =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A library whose only working part is its uploads; everything else is empty. */
const uploadOnlyLibrary = (uploads: Library["uploads"]): Library =>
	new Proxy(
		{ readOnly: true, bookDeletion: "permanent", uploads } as Partial<Library>,
		{
			get: (target, property) =>
				property in target
					? target[property as keyof Library]
					: async () =>
							property === "queryBooks" ? { items: [], total: 0 } : [],
		},
	) as Library;

const Wired = () => {
	const platform = useMemo(createWebPlatform, []);
	const fake = useMemo(
		() =>
			createFakeUploads({
				limits: { chunkBytes: 256 * 1024, reviewSeconds: 600 },
				chunkDelay: pause(200),
				readDelay: pause(1000),
				withCovers: false,
			}),
		[],
	);
	useEffect(() => {
		const before = useLibraryStore.getState();
		useLibraryStore.setState({
			library: uploadOnlyLibrary(fake.uploads),
			libraryState: LibraryState.ready,
		});
		return () => {
			useUploadsStore.getState().connect(undefined, () => {});
			useLibraryStore.setState({
				library: before.library,
				libraryState: before.libraryState,
			});
		};
	}, [fake]);
	return (
		<PlatformProvider value={platform}>
			<div
				style={{
					display: "grid",
					gap: 12,
					alignContent: "start",
					color: "var(--ctd-ink)",
				}}
			>
				<div style={{ display: "flex", gap: 12, alignItems: "center" }}>
					<UploadToolbarStatus />
					<span style={{ fontSize: 13 }}>
						Drag book files (EPUB, MOBI, AZW3, PDF, TXT) from your computer
						anywhere onto this page.
					</span>
				</div>
				<BookUploads />
			</div>
		</PlatformProvider>
	);
};

const meta: Meta = {
	title: "organisms/BookUploads",
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/**
 * Interactive: the app's real drop overlay, sheet and toolbar status, wired
 * to a library whose uploads go to an in-memory server.
 */
export const DropBooks: Story = { render: () => <Wired /> };
