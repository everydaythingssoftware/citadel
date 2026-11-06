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
import { TablerCopy } from "@/components/icons/TablerCopy";
import { FileTiles } from "@/components/molecules/BookActions";
import { Button, Tooltip } from "@/components/ui";
import buttonStyles from "@/components/ui/Button.module.css";
import { safeAsyncEventHandler } from "@/lib/async";
import { bookFormatRows, remoteBookDownloads } from "@/lib/book-downloads";
import { backdropColors } from "@/lib/cover-palette";
import { useCoverPalette } from "@/lib/hooks/use-cover-palette";
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

/**
 * The book at a glance: cover and title over a wash of the cover's own
 * colours with what you can do right under the title, then what it's
 * about, its tags, files and details.
 */
export const BookDrawer = ({ book, onClose }: BookDrawerProps) => {
	const coverUrl = book.cover_image?.url ?? null;
	const palette = useCoverPalette(coverUrl);
	const colors = palette ? backdropColors(palette) : null;
	const washStyle = colors
		? ({
				"--wash-1-light": colors.light[0],
				"--wash-2-light": colors.light[1],
				"--wash-1-dark": colors.dark[0],
				"--wash-2-dark": colors.dark[1],
			} as CSSProperties)
		: undefined;

	return (
		<article className={styles.drawer} style={washStyle}>
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
					<h2 className={styles.title}>{book.title}</h2>
					<Byline book={book} onClose={onClose} />
					<Actions book={book} className={styles.actions} />
				</div>
			</header>
			<Actions book={book} className={styles.phoneActions} />
			<div className={styles.body}>
				<Description html={book.description} />
				<Tags book={book} onClose={onClose} />
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

/** Read (desktop) or Download (web), and Edit. Finished lives in the editor. */
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
	const download = remoteBookDownloads(book.file_list)[0];

	return (
		<div className={className}>
			{localPath !== null ? (
				<Button
					variant="primary"
					data-drawer-initial-focus=""
					onClick={safeAsyncEventHandler(() =>
						platform.fileOpener.openPath(localPath),
					)}
				>
					<BookGlyph />
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

const amazon = (value: string) => `https://www.amazon.com/dp/${value}`;

const IDENTIFIERS: Record<
	string,
	{ name: string; url?: (value: string) => string }
> = {
	isbn: { name: "ISBN" },
	goodreads: {
		name: "Goodreads",
		url: (value) => `https://www.goodreads.com/book/show/${value}`,
	},
	amazon: { name: "Amazon", url: amazon },
	asin: { name: "Amazon", url: amazon },
	"mobi-asin": { name: "Amazon", url: amazon },
	google: {
		name: "Google Books",
		url: (value) => `https://books.google.com/books?id=${value}`,
	},
	uri: { name: "Link", url: (value) => value },
	url: { name: "Link", url: (value) => value },
};

/** ISBN first, then the sites in the order above, then anything else. */
const IDENTIFIER_ORDER = Object.keys(IDENTIFIERS);
const identifierRank = (identifier: Identifier): number => {
	const rank = IDENTIFIER_ORDER.indexOf(identifier.label.toLowerCase());
	return rank === -1 ? IDENTIFIER_ORDER.length : rank;
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

const Details = ({ book }: { book: LibraryBook }) => {
	const added = formatAdded(book.added_at);
	const languages = book.language_list.map(languageNameForCode).join(", ");
	if (
		added === null &&
		languages.length === 0 &&
		book.identifier_list.length === 0
	)
		return null;
	return (
		<section className={styles.section}>
			<h3 className={styles.sectionTitle}>Details</h3>
			<dl className={styles.details}>
				{added !== null && (
					<>
						<dt>Added</dt>
						<dd>{added}</dd>
					</>
				)}
				{languages.length > 0 && (
					<>
						<dt>Language</dt>
						<dd>{languages}</dd>
					</>
				)}
				{book.identifier_list
					.slice()
					.sort((a, b) => identifierRank(a) - identifierRank(b))
					.map((identifier) => (
						<IdentifierRow key={identifier.label} identifier={identifier} />
					))}
			</dl>
		</section>
	);
};

const IdentifierRow = ({ identifier }: { identifier: Identifier }) => {
	const platform = usePlatform();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const known = IDENTIFIERS[identifier.label.toLowerCase()];
	const name = known?.name ?? identifier.label.toUpperCase();
	const url = known?.url?.(identifier.value);
	return (
		<>
			<dt>{name}</dt>
			<dd>
				{url ? (
					<a
						className={styles.external}
						href={url}
						target="_blank"
						rel="noreferrer"
						title={`Open on ${name}`}
					>
						<span className={styles.value}>{identifier.value}</span>
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
					<span className={styles.value}>{identifier.value}</span>
				)}
				{!url && platform.capabilities.canCopyToClipboard && (
					<Tooltip label={copied ? "Copied" : `Copy ${name}`} openDelay={200}>
						<button
							type="button"
							className={styles.copy}
							aria-label={`Copy ${name}`}
							onClick={safeAsyncEventHandler(async () => {
								await platform.clipboard.writeText(identifier.value);
								setCopied(true);
							})}
						>
							<TablerCopy />
						</button>
					</Tooltip>
				)}
			</dd>
		</>
	);
};
