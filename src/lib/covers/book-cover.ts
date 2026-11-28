import type { CoverThumbnail, LibraryBook } from "@/bindings";
import { formatAuthorList } from "@/lib/authors";
import { isPdfOnly } from "@/lib/pdf-only";

export const bookCoverProps = (book: LibraryBook, thumb?: CoverThumbnail) => ({
	src: thumb?.url ?? book.cover_image?.url,
	title: book.title,
	authors: formatAuthorList(book.author_list),
	sizeHint: thumb,
	coverColors: thumb?.cover_colors,
	finished: book.is_read,
	flat: isPdfOnly(book.file_list),
});
