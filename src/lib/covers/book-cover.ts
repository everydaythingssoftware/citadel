import type { CoverThumbnail, LibraryBook } from "@/bindings";
import { formatAuthorList } from "@/lib/authors";

export const bookCoverProps = (book: LibraryBook, thumb?: CoverThumbnail) => ({
	src: thumb?.url ?? book.cover_image?.url,
	title: book.title,
	authors: formatAuthorList(book.author_list),
	sizeHint: thumb,
	finished: book.is_read,
});
