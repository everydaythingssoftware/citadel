import { Link, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import DOMPurify from "dompurify";
import {
	type CSSProperties,
	Fragment,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Identifier, LibraryBook } from "@/bindings";
import { BookCover } from "@/components/atoms/BookCover";
import { EditGlyph } from "@/components/icons/EditGlyph";
import { GlyphOpenExternal } from "@/components/icons/RowGlyphs";
import { FileTiles, FinishedButton } from "@/components/molecules/BookActions";
import { Button } from "@/components/ui";
import buttonStyles from "@/components/ui/Button.module.css";
import { safeAsyncEventHandler } from "@/lib/async";
import { bookFormatRows, remoteBookDownloads } from "@/lib/book-downloads";
import { backdropColors } from "@/lib/cover-palette";
import { BOOK_BACKDROP, useBookBackdrop } from "@/lib/hooks/use-book-backdrop";
import { useCoverPalette } from "@/lib/hooks/use-cover-palette";
import { languageNameForCode } from "@/lib/languages";
import { usePlatform } from "@/lib/platform/context";
import { formatSeriesIndex } from "@/lib/series";
import {
	useLibraryActions,
	useLibraryStore,
	useSeriesList,
} from "@/stores/library/store";
import styles from "./BookDrawer.module.css";

interface BookDrawerProps {
	book: LibraryBook;
	onClose: () => void;
}

/**
 * The book at a glance: cover and title over a wash of the cover's own
 * colours, what you can do with it right under the title, then what it's
 * about, its tags, files and details.
 */
export const BookDrawer = ({ book, onClose }: BookDrawerProps) => {
	const coverUrl = book.cover_image?.url ?? null;
	const palette = useCoverPalette(coverUrl);
	const [backdrop] = useBookBackdrop();
	const colors = palette ? backdropColors(palette) : null;
	const washStyle = colors
		? ({
				"--wash-1-light": colors.light[0],
				"--wash-2-light": colors.light[1],
				"--wash-1-dark": colors.dark[0],
				"--wash-2-dark": colors.dark[1],
			} as CSSProperties)
		: undefined;
	const [isRead, setIsRead] = useState(book.is_read);
	useEffect(() => setIsRead(book.is_read), [book.is_read]);

	return (
		<article className={styles.drawer} style={washStyle}>
			<header className={styles.hero} data-backdrop={backdrop}>
				<div className={styles.backdrop} aria-hidden="true">
					{backdrop === BOOK_BACKDROP.blurredCover && coverUrl && (
						<img className={styles.blur} src={coverUrl} alt="" />
					)}
				</div>
				<div className={styles.cover}>
					<BookCover book={book} disableFade fluid />
					{isRead && (
						<span className={styles.coverCheck} title="Finished">
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4.5 8.25 7 10.6 11.5 5.8" />
							</svg>
						</span>
					)}
				</div>
				<div className={styles.heading}>
					<h2 className={styles.title}>{book.title}</h2>
					<Byline book={book} onClose={onClose} />
					<BookActionsRow
						book={book}
						isRead={isRead}
						onReadChange={setIsRead}
					/>
				</div>
			</header>
			<div className={styles.body}>
				<Description html={book.description} />
				{book.tag_list.length > 0 && (
					<section className={styles.section}>
						<h3 className={styles.sectionTitle}>Tags</h3>
						<ul className={styles.tags}>
							{book.tag_list.map((tag) => (
								<li key={tag} className={styles.tag}>
									{tag}
								</li>
							))}
						</ul>
					</section>
				)}
				<Files book={book} />
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
		<div className={styles.byline}>
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
		</div>
	);
};

const readOnlyUpdate = (isRead: boolean) => ({
	author_id_list: null,
	tag_list: null,
	title: null,
	timestamp: null,
	publication_date: null,
	is_read: isRead,
	description: null,
	series: null,
	series_index: null,
	language_list: null,
});

const BookActionsRow = ({
	book,
	isRead,
	onReadChange,
}: {
	book: LibraryBook;
	isRead: boolean;
	onReadChange: (isRead: boolean) => void;
}) => {
	const platform = usePlatform();
	const navigate = useNavigate();
	const actions = useLibraryActions();
	const canEdit = useLibraryStore((state) => state.library?.readOnly === false);
	const localFile = book.file_list.find((file) => "Local" in file);
	const canRead =
		platform.capabilities.canOpenLocalPaths && localFile !== undefined;
	const download = remoteBookDownloads(book.file_list)[0];

	const markRead = (next: boolean) => {
		onReadChange(next);
		actions.updateBook(book.id, readOnlyUpdate(next)).catch(() => {
			onReadChange(!next);
		});
	};

	return (
		<div className={styles.actions}>
			{canRead && localFile && "Local" in localFile ? (
				<Button
					variant="primary"
					data-drawer-initial-focus=""
					onClick={safeAsyncEventHandler(() =>
						platform.fileOpener.openPath(localFile.Local.path),
					)}
				>
					Read
				</Button>
			) : (
				download && (
					<a
						className={clsx(
							buttonStyles.button,
							buttonStyles.primary,
							styles.download,
						)}
						href={download.url}
						download
						data-drawer-initial-focus=""
					>
						Download
					</a>
				)
			)}
			{canEdit && (
				<FinishedButton isRead={isRead} onReadChange={markRead} tone="ink" />
			)}
			{canEdit && (
				<Button
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

const Description = ({ html }: { html: string | null }) => {
	const textRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const element = textRef.current;
		if (!element) return;
		const measure = () => {
			if (!expanded)
				setOverflows(element.scrollHeight > element.clientHeight + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [expanded]);
	if (html === null || html.trim().length === 0) return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Description</h3>
			<div
				ref={textRef}
				className={clsx("description-html", styles.description)}
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
				</Button>
			)}
		</section>
	);
};

const Files = ({ book }: { book: LibraryBook }) => {
	const rows = bookFormatRows(book.file_list);
	if (rows.length === 0) return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Files</h3>
			<FileTiles rows={rows} />
		</section>
	);
};

const IDENTIFIERS: Record<
	string,
	{ name: string; url?: (value: string) => string }
> = {
	isbn: { name: "ISBN" },
	goodreads: {
		name: "Goodreads",
		url: (value) => `https://www.goodreads.com/book/show/${value}`,
	},
	amazon: {
		name: "Amazon",
		url: (value) => `https://www.amazon.com/dp/${value}`,
	},
	asin: {
		name: "Amazon",
		url: (value) => `https://www.amazon.com/dp/${value}`,
	},
	"mobi-asin": {
		name: "Amazon",
		url: (value) => `https://www.amazon.com/dp/${value}`,
	},
	google: {
		name: "Google Books",
		url: (value) => `https://books.google.com/books?id=${value}`,
	},
	uri: { name: "Link", url: (value) => value },
	url: { name: "Link", url: (value) => value },
};

const Details = ({ book }: { book: LibraryBook }) => {
	const languages = book.language_list.map(languageNameForCode).join(", ");
	if (languages.length === 0 && book.identifier_list.length === 0) return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Details</h3>
			<dl className={styles.details}>
				{languages.length > 0 && (
					<>
						<dt>Language</dt>
						<dd>{languages}</dd>
					</>
				)}
				{book.identifier_list.map((identifier) => (
					<IdentifierRow key={identifier.label} identifier={identifier} />
				))}
			</dl>
		</section>
	);
};

const IdentifierRow = ({ identifier }: { identifier: Identifier }) => {
	const platform = usePlatform();
	const known = IDENTIFIERS[identifier.label.toLowerCase()];
	const url = known?.url?.(identifier.value);
	return (
		<>
			<dt>{known?.name ?? identifier.label.toUpperCase()}</dt>
			<dd className={styles.identifier}>
				{url ? (
					<a
						className={styles.link}
						href={url}
						target="_blank"
						rel="noreferrer"
					>
						{identifier.value}
						<GlyphOpenExternal className={styles.openGlyph} />
					</a>
				) : (
					<span className={styles.value}>{identifier.value}</span>
				)}
				{!url && platform.capabilities.canCopyToClipboard && (
					<Button
						variant="subtle"
						className={styles.copy}
						onClick={safeAsyncEventHandler(() =>
							platform.clipboard.writeText(identifier.value),
						)}
					>
						Copy
					</Button>
				)}
			</dd>
		</>
	);
};
