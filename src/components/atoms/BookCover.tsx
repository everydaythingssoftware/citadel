import { type HTMLAttributes, useState } from "react";
import type { CoverThumbnail, LibraryBook } from "@/bindings";
import { formatAuthorList } from "@/lib/authors";
import { resolveCoverLoad } from "@/lib/cover-load";
import { devFlag } from "@/lib/dev-flags";
import { selectByStringHash } from "@/lib/hash-string";
import { shortenToChars } from "$lib/domain/book";

import img1Url from "../../assets/1.jpg";
import img2Url from "../../assets/2.jpg";
import img3Url from "../../assets/3.jpg";
import img4Url from "../../assets/4.jpg";
import img5Url from "../../assets/5.jpg";
import { MotifCover } from "./MotifCover";

type LibraryBookWithCoverImage = LibraryBook & {
	cover_image: NonNullable<LibraryBook["cover_image"]>;
};

const spineBackground = `
  var(--ctd-cover-spine-bg)
`;

/**
 * Cap on a fluid cover's height (the grid's "shelf" height). Real covers keep
 * their aspect ratio inside a box of `100% of the cell × FLUID_MAX_HEIGHT`.
 */
const FLUID_MAX_HEIGHT_PX = 230;
// Placeholder art keeps the classic 133:200 book proportions.
const PLACEHOLDER_RATIO = 133 / 200;

/**
 * Dimming scrim for finished books; fades in/out over 100ms like the old
 * Mantine Transition + Overlay pair (80% alpha of the overlay token).
 */
const ReadOverlay = ({ visible }: { visible: boolean }) => (
	<div
		aria-hidden="true"
		style={{
			position: "absolute",
			inset: 0,
			zIndex: 2,
			pointerEvents: "none",
			backgroundColor:
				"color-mix(in srgb, var(--ctd-cover-overlay) 80%, transparent)",
			opacity: visible ? 1 : 0,
			transition: "opacity 100ms ease",
		}}
	/>
);

const BookCoverUsingImage = ({
	book,
	disableFade,
	fluid,
	thumb,
	...props
}: {
	book: LibraryBookWithCoverImage;
	disableFade: boolean;
	fluid: boolean;
	thumb?: CoverThumbnail;
} & HTMLAttributes<HTMLDivElement>) => {
	const [isHovering, setIsHovering] = useState(false);
	// A cover can fail without an `error` event: an asset:// URL outside the
	// asset scope "loads" at 0×0, which would render a zero-height cell and
	// collapse the virtualized grid's row measurement. Either failure mode
	// falls back to the same placeholder treatment as books with no cover,
	// whose fixed aspect ratio keeps the cell dimensions stable.
	const [coverFailed, setCoverFailed] = useState(false);

	if (coverFailed) {
		return (
			<BookCoverWithPlaceholder
				book={book}
				disableFade={disableFade}
				fluid={fluid}
				{...props}
			/>
		);
	}

	return (
		<div
			style={{
				// In fluid mode the wrapper shrink-wraps the constrained image
				// so the radius/shadow/spine hug the cover exactly.
				...(fluid
					? { display: "inline-block", maxWidth: "100%" }
					: { width: "133px" }),
				position: "relative",
				borderRadius: "4px",
				overflow: "hidden",
				transition: "transform 180ms ease, box-shadow 180ms ease",
				boxShadow: "var(--ctd-cover-shadow)",
				transform: isHovering ? "translateY(-2px)" : "translateY(0px)",
			}}
			{...props}
			onPointerOver={() => {
				setIsHovering(true);
			}}
			onPointerLeave={() => {
				setIsHovering(false);
			}}
		>
			<img
				src={thumb?.url ?? book.cover_image.url}
				alt={book.title}
				// Reserve the exact box from the thumbnail's known dimensions so
				// the row height is right before the image decodes (no shelf
				// shift on mount).
				width={thumb?.width}
				height={thumb?.height}
				// Skip incremental paint: whole frames only (no half-decoded
				// scanline strips during fast scroll).
				decoding="async"
				onError={() => {
					setCoverFailed(true);
				}}
				onLoad={(event) => {
					if (resolveCoverLoad(event.currentTarget) === "failed") {
						setCoverFailed(true);
					}
				}}
				style={{
					...(fluid
						? {
								// Fit inside the cell width and the shelf-height cap,
								// preserving the real cover's aspect ratio (no crop,
								// no stretch).
								maxWidth: "100%",
								maxHeight: `${FLUID_MAX_HEIGHT_PX}px`,
								width: "auto",
								height: "auto",
							}
						: { width: "133px", height: "auto" }),
					display: "block",
				}}
			/>
			<div
				style={{
					position: "absolute",
					inset: 0,
					background: spineBackground,
					pointerEvents: "none",
					zIndex: 1,
				}}
			/>
			<ReadOverlay visible={book.is_read && !isHovering && !disableFade} />
		</div>
	);
};

export type PlaceholderStyle = "paintings" | "patterns";

const BookCoverWithPlaceholder = ({
	book,
	disableFade,
	fluid,
	placeholder = devFlag("placeholderCovers"),
	...props
}: {
	book: LibraryBook;
	disableFade: boolean;
	fluid: boolean;
	placeholder?: PlaceholderStyle;
} & HTMLAttributes<HTMLDivElement>) => {
	const [isHovering, setIsHovering] = useState(false);

	const imgUrl = selectByStringHash(
		[img1Url, img2Url, img3Url, img4Url, img5Url],
		book.title,
	);

	return (
		<div
			style={{
				// Same box as real covers: the 133:200 ratio turns the height cap
				// into a width cap. With explicit width and height (non-fluid)
				// the aspect-ratio is simply ignored.
				aspectRatio: String(fluid ? PLACEHOLDER_RATIO : 9 / 6),
				height: fluid ? undefined : 200,
				width: fluid ? "100%" : 133,
				maxWidth: fluid
					? `${FLUID_MAX_HEIGHT_PX * PLACEHOLDER_RATIO}px`
					: undefined,
				position: "relative",
			}}
			onPointerOver={() => {
				setIsHovering(true);
			}}
			onPointerLeave={() => {
				setIsHovering(false);
			}}
		>
			<div
				{...props}
				style={{
					width: fluid ? "100%" : "133px",
					height: fluid ? "100%" : "200px",
					display: "grid",
					gridTemplateAreas: "overlap",
					borderRadius: "4px",
					overflow: "hidden",
					transition: "transform 180ms ease, box-shadow 180ms ease",
					boxShadow: "var(--ctd-cover-shadow)",
					transform: isHovering ? "translateY(-2px)" : "translateY(0px)",
					position: "relative",
				}}
			>
				{placeholder === "patterns" ? (
					<MotifCover
						seed={book.title}
						spine={false}
						style={{
							width: "inherit",
							height: "inherit",
							gridArea: "overlap",
							borderRadius: 0,
							aspectRatio: "auto",
						}}
					/>
				) : (
					<img
						alt="App-provided placeholder cover."
						src={imgUrl}
						style={{
							width: "inherit",
							height: "inherit",
							gridArea: "overlap",
							filter: "brightness(0.7)",
						}}
					/>
				)}
				<div
					style={{
						height: "100%",
						width: "auto",
						display: "flex",
						flexDirection: "column",
						alignContent: "flex-start",
						justifyContent: "flex-end",
						gridArea: "overlap",
						padding: "0.3rem 0.3rem 0.3rem calc(0.3rem + 6px)",
						zIndex: 1,
					}}
				>
					<div
						style={{
							fontSize: "1.125rem",
							fontWeight: "bolder",
							color: "var(--ctd-cover-title)",
							fontFamily:
								'"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
							letterSpacing: "0.01em",
							lineHeight: 1.15,
							textShadow: "var(--ctd-cover-title-shadow)",
						}}
					>
						{shortenToChars(book.title, 36)}
					</div>
					<div
						style={{
							fontSize: "0.875rem",
							color: "var(--ctd-cover-author)",
							textShadow: "var(--ctd-cover-author-shadow)",
							lineHeight: 1.2,
						}}
					>
						{formatAuthorList(book.author_list)}
					</div>
				</div>
				<div
					style={{
						gridArea: "overlap",
						width: fluid ? "100%" : "133px",
						height: fluid ? "100%" : "200px",
						background: spineBackground,
						pointerEvents: "none",
						zIndex: 2,
					}}
				/>
				<ReadOverlay visible={book.is_read && !isHovering && !disableFade} />
			</div>
		</div>
	);
};

export const BookCover = ({
	book,
	disableFade = false,
	fluid = false,
	thumb,
	placeholder,
	...props
}: {
	book: LibraryBook;
	disableFade?: boolean;
	/**
	 * Art for books without a cover; defaults to the `placeholderCovers`
	 * developer flag while the choice is open.
	 */
	placeholder?: PlaceholderStyle;
	/**
	 * Size to the parent (width ≤ 100%, height ≤ ~230px, aspect ratio kept)
	 * instead of the fixed 133px column used in the details drawer.
	 */
	fluid?: boolean;
	/**
	 * Grid-sized thumbnail for this book's cover. When set, the small image
	 * is rendered instead of the full-resolution cover, and its dimensions
	 * reserve the exact row height.
	 */
	thumb?: CoverThumbnail;
} & HTMLAttributes<HTMLDivElement>) => {
	if (book.cover_image?.url !== undefined) {
		return (
			<BookCoverUsingImage
				// Remounting on URL change resets the failed-cover fallback state
				// when a book gains a (new) cover or its thumbnail arrives.
				key={thumb?.url ?? book.cover_image.url}
				// @ts-expect-error `cover_image` obviously exists
				book={book}
				disableFade={disableFade}
				fluid={fluid}
				thumb={thumb}
				{...props}
			/>
		);
	}

	return (
		<BookCoverWithPlaceholder
			book={book}
			disableFade={disableFade}
			fluid={fluid}
			placeholder={placeholder}
			{...props}
		/>
	);
};
