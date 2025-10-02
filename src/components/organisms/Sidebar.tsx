import {
	type ImportableBookMetadata,
	type LibraryAuthor,
	commands,
} from "@/bindings";
import { LibraryState, useLibrary } from "@/lib/contexts/library";
import { useSettings } from "@/lib/contexts/settings";
import {
	commitAddBook,
	pickLibrary,
	promptToAddBook,
} from "@/lib/services/library";
import {
	type LibraryPath,
	createSettingsLibrary,
	setActiveLibrary,
	settings,
} from "@/stores/settings";
import { Button, Divider, Modal, NavLink, Stack, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Link, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	AddBookForm,
	title as addBookFormTitle,
} from "../molecules/AddBookForm";
import { SwitchLibraryForm } from "../molecules/SwitchLibraryForm";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { addBookByDragDrop } from "@/lib/services/library/_internal/addBook";
const appWindow = getCurrentWebviewWindow()

export const Sidebar = () => {
	const { library, state, eventEmitter } = useLibrary();
	const { set, subscribe } = useSettings();
	const { location } = useRouterState();

	const [metadata, setMetadata] = useState<ImportableBookMetadata | null>();
	const [activeLibraryId, setActiveLibraryId] = useState<string>();
	const [authorList, setAuthorList] = useState<string[]>([]);
	const [libraries, setLibraries] = useState<LibraryPath[]>([]);

	const [
		isAddBookModalOpen,
		{ close: closeAddBookModal, open: openAddBookModal },
	] = useDisclosure(false);
	const [
		isSwitchLibraryModalOpen,
		{ close: closeSwitchLibraryModal, open: openSwitchLibraryModal },
	] = useDisclosure(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;

		const setupFileDropListener = async () => {
			unlisten = await appWindow.onFileDropEvent((event) => {
				if (!library) return;

				void (async () => {
					if (event.payload.type === "drop") {
						const metadataList = await addBookByDragDrop(
							library,
							event.payload.paths,
						);
						const firstItem = metadataList[0];
						if (firstItem) {
							setMetadata(firstItem);
							openAddBookModal();
						}
					}
				})();
			});
		};

		void setupFileDropListener();

		return () => {
			if (unlisten) {
				unlisten();
			}
		};
	}, [library, openAddBookModal]);

	useEffect(() => {
		void (async () => {
			setAuthorList(
				((await library?.listAuthors()) ?? [])
					.sort(sortAuthors)
					.map((author) => author.name),
			);
		})();
	}, [library]);
	useEffect(() => {
		return subscribe((update) => {
			setLibraries(update.libraryPaths);
			const activeLibrary = update.libraryPaths.find(
				(library) => library.id === update.activeLibraryId,
			);
			if (activeLibrary) {
				setActiveLibraryId(activeLibrary.id);
			}
		});
	}, [subscribe]);

	const selectAndEditBookFile = useCallback(() => {
		if (state !== LibraryState.ready) return;

		promptToAddBook(library)
			.then((importableMetadata) => {
				if (importableMetadata) {
					setMetadata(importableMetadata);
					openAddBookModal();
				}
			})
			.catch((failure) => {
				console.error("failed to import new book: ", failure);
			});
	}, [library, state, openAddBookModal]);

	const switchLibrary = useCallback(() => {
		openSwitchLibraryModal();
	}, [openSwitchLibraryModal]);

	const addBookByMetadataWithEffects = (form: AddBookForm) => {
		if (!metadata || state !== LibraryState.ready) return;
		const editedMetadata: ImportableBookMetadata = {
			...metadata,
			title: form.title,
			author_names: form.authorList,
		};
		commitAddBook(library, editedMetadata, eventEmitter)
			.then(() => {
				closeAddBookModal();
				setMetadata(null);
			})
			.catch((error) => {
				console.error("Failed to add book to database", error);
			});
	};
	const addNewLibraryByPath = useCallback(
		async (form: SwitchLibraryForm) => {
			const isPathValidLibrary = await commands.clbQueryIsPathValidLibrary(
				form.libraryPath,
			);

			if (isPathValidLibrary) {
				const newLibraryId = await createSettingsLibrary(
					settings,
					form.libraryPath,
				);
				await setActiveLibrary(settings, newLibraryId);
				closeSwitchLibraryModal();
			} else {
				// TODO: You could create a new library, if you like.
				console.error("Invalid library path selected");
			}
		},
		[closeSwitchLibraryModal],
	);
	const selectExistingLibrary = useCallback(
		async (id: string) => {
			await set("activeLibraryId", id);
			closeSwitchLibraryModal();
		},
		[closeSwitchLibraryModal, set],
	);
	const shelves = useMemo(() => {
		return [
			{
				title: "All books",
				path: "/",
				isActive: () => location.pathname === "/",
			},
		];
	}, [location]);

	if (state !== LibraryState.ready) {
		return null;
	}

	if (activeLibraryId === undefined) {
		return <p>Something went wrong!</p>;
	}

	return (
		<>
			{metadata && (
				<AddBookModalPure
					isOpen={isAddBookModalOpen}
					onClose={closeAddBookModal}
					metadata={metadata}
					onSubmitHandler={addBookByMetadataWithEffects}
					authorNameList={authorList}
				/>
			)}
			<SwitchLibraryPathModalPure
				isOpen={isSwitchLibraryModalOpen}
				onClose={closeSwitchLibraryModal}
			>
				<SwitchLibraryForm
					currentLibraryId={activeLibraryId}
					libraries={libraries}
					onSubmit={(form) => void addNewLibraryByPath(form)}
					selectExistingLibrary={selectExistingLibrary}
					selectNewLibrary={pickLibrary}
				/>
			</SwitchLibraryPathModalPure>
			<SidebarPure
				addBookHandler={selectAndEditBookFile}
				switchLibraryHandler={switchLibrary}
				shelves={shelves}
			/>
		</>
	);
};

interface AddBookModalProps {
	isOpen: boolean;
	onClose: () => void;
	metadata: ImportableBookMetadata;
	onSubmitHandler: (form: AddBookForm) => void;
	authorNameList: string[];
}

const AddBookModalPure = ({
	isOpen,
	onClose,
	metadata,
	onSubmitHandler,
	authorNameList,
}: AddBookModalProps) => {
	return (
		<Modal.Root opened={isOpen} onClose={onClose} size={"lg"}>
			<Modal.Overlay blur={3} backgroundOpacity={0.35} />
			<Modal.Content>
				<Modal.Header>
					<Modal.Title>{addBookFormTitle}</Modal.Title>
					<Modal.CloseButton />
				</Modal.Header>
				<Modal.Body>
					<AddBookForm
						initial={{
							authorList: metadata?.author_names ?? [],
							title: metadata?.title ?? "",
						}}
						authorList={authorNameList}
						fileName={metadata?.path ?? ""}
						hideTitle={true}
						onSubmit={onSubmitHandler}
					/>
				</Modal.Body>
			</Modal.Content>
		</Modal.Root>
	);
};

interface SwitchLibraryPathModalPureProps {
	isOpen: boolean;
	onClose: () => void;
	children: React.ReactNode;
}

const SwitchLibraryPathModalPure = ({
	isOpen,
	onClose,
	children,
}: SwitchLibraryPathModalPureProps) => {
	return (
		<Modal.Root opened={isOpen} onClose={onClose} size={"lg"}>
			<Modal.Overlay blur={3} backgroundOpacity={0.35} />
			<Modal.Content>
				<Modal.Header>
					<Modal.Title>Switch library</Modal.Title>
					<Modal.CloseButton />
				</Modal.Header>
				<Modal.Body>{children}</Modal.Body>
			</Modal.Content>
		</Modal.Root>
	);
};

const sortAuthors = (a: LibraryAuthor, b: LibraryAuthor) => {
	return a.sortable_name.localeCompare(b.sortable_name);
};

interface SidebarPureProps {
	addBookHandler: () => void;
	switchLibraryHandler: () => void;
	shelves: {
		title: string;
		path: string;
		isActive: () => boolean;
	}[];
}

const SidebarPure = ({
	addBookHandler,
	switchLibraryHandler,
	shelves,
}: SidebarPureProps) => {
	return (
		<>
			<Stack>
				<Title order={5}>My library</Title>
				<Button variant="filled" onPointerDown={addBookHandler}>
					⊕ Add book
				</Button>
				<Button variant="outline" onPointerDown={switchLibraryHandler}>
					Switch library
				</Button>
				<NavLink
					label="Authors"
					component={Link}
					to="/authors"
					active={location.pathname === "/authors"}
				/>
			</Stack>
			<Divider my="md" />
			<Stack>
				<Title order={5}>Shelves</Title>
				{shelves.map(({ title, path, isActive }) => (
					<NavLink
						key={path}
						label={title}
						component={Link}
						to={path}
						active={isActive()}
					/>
				))}
			</Stack>
		</>
	);
};
