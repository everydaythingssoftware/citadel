import { Link, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import DOMPurify from "dompurify";
import {
	type CSSProperties,
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Identifier, LibraryBook } from "@/bindings";
import { BookCover } from "@/components/atoms/BookCover";
import { EditGlyph } from "@/components/icons/EditGlyph";
import { TablerCopy } from "@/components/icons/TablerCopy";
import { BookFileList } from "@/components/molecules/BookFileList";
import {
	Button,
	ContextMenu,
	Drawer,
	DrawerPlacement,
	Tooltip,
} from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import {
	identifierDisplayName,
	identifierUrl,
	sortIdentifiers,
} from "@/lib/book-identifiers";
import { backdropColors } from "@/lib/cover-palette";
import { useBookDrawerResize } from "@/lib/hooks/use-book-drawer-resize";
import { useBookFiles } from "@/lib/hooks/use-book-files";
import { useCoverPalette } from "@/lib/hooks/use-cover-palette";
import { useScrolled } from "@/lib/hooks/use-scrolled";
import { languageNameForCode } from "@/lib/languages";
import { usePlatform } from "@/lib/platform/context";
import { formatSeriesIndex } from "@/lib/series";
import {
	useLibraryActions,
	useLibraryStore,
	useSeriesList,
	useTags,
} from "@/stores/library/store";
import styles from "./BookDrawer.module.css";

interface BookDrawerProps {
	book: LibraryBook;
	onClose: () => void;
}

interface BookDetailsDrawerProps {
	/** The book to show; kept while the drawer slides closed. */
	book: LibraryBook | null;
	open: boolean;
	onClose: () => void;
	/** The grid: focus goes back there on close. */
	returnFocusRef: RefObject<HTMLElement | null>;
	/** Places the drawer in its page. */
	className?: string;
}

/**
 * The details drawer as the Books page mounts it: an inspector inside the
 * content panel, as wide as the user last left it.
 */
export const BookDetailsDrawer = ({
	book,
	open,
	onClose,
	returnFocusRef,
	className,
}: BookDetailsDrawerProps) => {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [content, setContent] = useState<HTMLDivElement | null>(null);
	const attachContent = useCallback((element: HTMLDivElement | null) => {
		contentRef.current = element;
		setContent(element);
	}, []);
	const resize = useBookDrawerResize(content);
	return (
		<Drawer
			placement={DrawerPlacement.panel}
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			width={resize.width}
			bleed
			className={className}
			contentRef={attachContent}
			resizeHandleProps={resize.handleProps}
			onOpenAutoFocus={(event) => {
				// Opened from the grid, the grid keeps focus so arrows move on
				// through the books; from a menu, land on the primary action.
				event.preventDefault();
				if (returnFocusRef.current?.contains(document.activeElement)) return;
				contentRef.current
					?.querySelector<HTMLElement>("[data-drawer-initial-focus]")
					?.focus();
			}}
			onCloseAutoFocus={(event) => {
				// No Dialog.Trigger to return focus to: hand it to the grid,
				// unless the user has already moved on (into the search field).
				event.preventDefault();
				const focused = document.activeElement;
				if (
					focused === null ||
					focused === document.body ||
					contentRef.current?.contains(focused)
				)
					returnFocusRef.current?.focus();
			}}
		>
			{book && <BookDrawer book={book} onClose={onClose} />}
		</Drawer>
	);
};

/**
 * The book at a glance: cover and title over a wash of the cover's own
 * colours with what you can do right under the title, then what it's
 * about, its tags, files and details.
 */
export const BookDrawer = ({ book, onClose }: BookDrawerProps) => {
	const files = useBookFiles(book.file_list);
	const coverUrl = book.cover_image?.url ?? null;
	const palette = useCoverPalette(coverUrl);
	const colors = palette ? backdropColors(palette) : null;
	const bodyRef = useRef<HTMLDivElement>(null);
	const drawerRef = useRef<HTMLElement>(null);
	const scrolled = useScrolled(bodyRef);
	// Another book starts at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: book.id is the trigger.
	useLayoutEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
		drawerRef.current?.scrollTo({ top: 0 });
	}, [book.id]);
	const washStyle = colors
		? ({
				"--wash-1-light": colors.light[0],
				"--wash-2-light": colors.light[1],
				"--wash-1-dark": colors.dark[0],
				"--wash-2-dark": colors.dark[1],
			} as CSSProperties)
		: undefined;

	return (
		<article
			ref={drawerRef}
			className={styles.drawer}
			style={washStyle}
			data-scrolled={scrolled || undefined}
			onKeyDown={(event: KeyboardEvent) => files.onKeyDown(event)}
		>
			<header className={styles.hero}>
				<div className={styles.backdrop} aria-hidden="true" />
				<div className={styles.cover}>
					<BookCover book={book} disableFade fluid />
					{book.is_read && (
						<span className={styles.seal} role="img" aria-label="Finished">
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4.25 8.4 6.9 10.9 11.75 5.6" />
							</svg>
						</span>
					)}
				</div>
				<div className={styles.heading}>
					<h2 className={styles.title} data-selectable="">
						{book.title}
					</h2>
					<Byline book={book} onClose={onClose} />
					<Actions book={book} className={styles.actions} />
				</div>
			</header>
			<Actions book={book} className={styles.phoneActions} />
			<div ref={bodyRef} className={clsx(styles.body, "ctd-scroller")}>
				<Description html={book.description} />
				<Tags book={book} onClose={onClose} />
				<Files files={files} />
				<Details book={book} />
			</div>
		</article>
	);
};

const joinNames = (count: number, index: number): string => {
	if (index === 0) return "";
	return index === count - 1 ? " and " : ", ";
};

const Byline = ({ book, onClose }: BookDrawerProps) => {
	// Books carry only their series NAME; LibraryBookQuery filters on the id,
	// which comes from the store's series list.
	const seriesList = useSeriesList();
	const seriesId =
		book.series !== null
			? seriesList.find((series) => series.name === book.series)?.id
			: undefined;
	return (
		<>
			{book.author_list.length > 0 && (
				<p className={styles.authors}>
					by{" "}
					{book.author_list.map((author, index) => (
						<Fragment key={author.id}>
							{joinNames(book.author_list.length, index)}
							<Link
								to="/"
								search={{ author_id: author.id }}
								onClick={onClose}
								className={styles.link}
							>
								{author.name}
							</Link>
						</Fragment>
					))}
				</p>
			)}
			{book.series !== null && (
				<p className={styles.series}>
					{book.series_index !== null
						? `Book ${formatSeriesIndex(book.series_index)} of `
						: "Part of "}
					{seriesId !== undefined ? (
						<Link
							to="/"
							search={{ series_id: seriesId }}
							onClick={onClose}
							className={styles.link}
						>
							{book.series}
						</Link>
					) : (
						book.series
					)}
				</p>
			)}
		</>
	);
};

/**
 * Open and Edit. Open opens the book in its default app on the desktop; a
 * browser gets each file's own download button under Files instead.
 */
const Actions = ({
	book,
	className,
}: {
	book: LibraryBook;
	className?: string;
}) => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const canEdit = useLibraryStore((state) => state.library?.readOnly === false);
	const localFile = book.file_list.find((file) => "Local" in file);
	const localPath =
		platform.capabilities.canOpenLocalPaths &&
		localFile !== undefined &&
		"Local" in localFile
			? localFile.Local.path
			: null;
	if (localPath === null && !canEdit) return null;

	return (
		<div className={className}>
			{localPath !== null && (
				<Button
					variant="primary"
					data-drawer-initial-focus=""
					onClick={safeAsyncEventHandler(() =>
						platform.fileOpener.openPath(localPath),
					)}
				>
					<BookGlyph />
					Open
				</Button>
			)}
			{canEdit && (
				<Button
					data-drawer-initial-focus={localPath === null ? "" : undefined}
					onClick={() =>
						void navigate({
							to: "/books/$bookId",
							params: { bookId: book.id },
						})
					}
				>
					<EditGlyph />
					Edit
				</Button>
			)}
		</div>
	);
};

const BookGlyph = () => (
	<svg
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.3"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M8 4.2C6.6 3.2 4.7 2.9 2.5 3.2v9c2.2-.3 4.1 0 5.5 1 1.4-1 3.3-1.3 5.5-1v-9c-2.2-.3-4.1 0-5.5 1Zm0 0v9" />
	</svg>
);

const Chevron = ({ up }: { up: boolean }) => (
	<svg
		viewBox="0 0 10 10"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		style={up ? { transform: "rotate(180deg)" } : undefined}
	>
		<path d="M2.5 3.75 5 6.25l2.5-2.5" />
	</svg>
);

const Description = ({ html }: { html: string | null }) => {
	const textRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const element = textRef.current;
		if (!element || expanded) return;
		const measure = () =>
			setOverflows(element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [expanded]);
	if (html === null || html.trim().length === 0) return null;
	return (
		<section className={styles.description}>
			<div
				ref={textRef}
				className={clsx("description-html", styles.descriptionText)}
				data-selectable=""
				data-clamped={(!expanded && overflows) || undefined}
				data-expanded={expanded || undefined}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify
				dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
			/>
			{(overflows || expanded) && (
				<Button
					variant="subtle"
					className={styles.more}
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "Less" : "More"}
					<Chevron up={expanded} />
				</Button>
			)}
		</section>
	);
};

const Tags = ({ book, onClose }: BookDrawerProps) => {
	const tags = useTags();
	const actions = useLibraryActions();
	useEffect(() => {
		if (tags === null && book.tag_list.length > 0) void actions.loadTags();
	}, [tags, book.tag_list.length, actions]);
	if (book.tag_list.length === 0) return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Tags</h3>
			<ul className={styles.tags}>
				{book.tag_list.map((name) => {
					const id = tags?.find((tag) => tag.name === name)?.id;
					return (
						<li key={name}>
							{id !== undefined ? (
								<Link
									to="/"
									search={{ tag_id: id }}
									onClick={onClose}
									className={styles.tag}
								>
									{name}
								</Link>
							) : (
								<span className={styles.tag}>{name}</span>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
};

const Files = ({ files }: { files: ReturnType<typeof useBookFiles> }) => {
	const platform = usePlatform();
	if (files.rows.length === 0) return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Files</h3>
			<BookFileList
				rows={files.rows}
				os={platform.os}
				fileManagerName={platform.fileOpener.fileManagerName}
				canReveal={platform.capabilities.canRevealInFileManager}
				onCommand={files.onCommand}
				onCancelDownload={files.onCancelDownload}
				onContextMenu={files.onContextMenu}
			/>
			<ContextMenu
				menu={files.contextMenu.menu}
				onClose={files.contextMenu.close}
			/>
		</section>
	);
};

const formatAdded = (iso: string): string | null => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
};

const seriesText = (book: LibraryBook): string | null => {
	if (book.series === null) return null;
	return book.series_index !== null
		? `${book.series}, book ${formatSeriesIndex(book.series_index)}`
		: book.series;
};

const Details = ({ book }: { book: LibraryBook }) => {
	const added = formatAdded(book.added_at);
	const languages = book.language_list.map(languageNameForCode).join(", ");
	const series = seriesText(book);
	if (
		added === null &&
		languages.length === 0 &&
		series === null &&
		book.identifier_list.length === 0
	)
		return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Details</h3>
			<dl className={styles.details}>
				{added !== null && <DetailRow label="Added">{added}</DetailRow>}
				{languages.length > 0 && (
					<DetailRow label="Language">{languages}</DetailRow>
				)}
				{series !== null && <DetailRow label="Series">{series}</DetailRow>}
				{sortIdentifiers(book.identifier_list).map((identifier) => (
					<IdentifierRow key={identifier.label} identifier={identifier} />
				))}
			</dl>
		</section>
	);
};

const DetailRow = ({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) => (
	<div className={styles.detail}>
		<dt>{label}</dt>
		<dd>{children}</dd>
	</div>
);

const IdentifierRow = ({ identifier }: { identifier: Identifier }) => {
	const platform = usePlatform();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const name = identifierDisplayName(identifier.label);
	const url = identifierUrl(identifier);
	return (
		<DetailRow label={name}>
			{url ? (
				<a
					className={styles.external}
					href={url}
					target="_blank"
					rel="noreferrer"
					title={`Open on ${name}`}
				>
					<span className={styles.value} data-selectable="">
						{identifier.value}
					</span>
					<svg
						className={styles.arrow}
						viewBox="0 0 12 12"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" />
					</svg>
				</a>
			) : (
				<span className={styles.value} data-selectable="">
					{identifier.value}
				</span>
			)}
			{!url && platform.capabilities.canCopyToClipboard && (
				<Tooltip label={copied ? "Copied" : `Copy ${name}`} openDelay={200}>
					<button
						type="button"
						className={styles.copy}
						aria-label={`Copy ${name}`}
						data-copied={copied || undefined}
						onClick={safeAsyncEventHandler(async () => {
							await platform.clipboard.writeText(identifier.value);
							setCopied(true);
						})}
					>
						{copied ? <CopiedGlyph /> : <TablerCopy />}
					</button>
				</Tooltip>
			)}
		</DetailRow>
	);
};

const CopiedGlyph = () => (
	<svg
		viewBox="0 0 12 12"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M2.5 6.25 5 8.5l4.5-5" />
	</svg>
);
