import type { LocalFile } from "./types";

/** A file by path, named by its final component on any OS. */
export const localFile = (path: string): LocalFile => ({
	path,
	name: path.split(/[\\/]/).pop() || path,
});
