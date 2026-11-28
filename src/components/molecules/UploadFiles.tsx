import * as Popover from "@radix-ui/react-popover";
import { MiddleTruncatedText } from "@/components/atoms/MiddleTruncatedText";
import { FileTypeIcon } from "@/components/icons/FileTypeIcon";
import { ChevronDownGlyph } from "@/components/icons/UploadGlyphs";
import { Button } from "@/components/ui";
import type { BookFile } from "@/lib/uploads/queue";
import styles from "./UploadFiles.module.css";

/**
 * A book made of several files says so under its cover: "2 files" opens
 * the files, and splits them into books of their own.
 */
export const UploadFiles = ({
	files,
	onSplit,
}: {
	files: readonly BookFile[];
	onSplit?: () => void;
}) => (
	<div className={styles.anchor}>
		<Popover.Root>
			<Popover.Trigger asChild>
				<button type="button" className={styles.capsule}>
					{files.length} files
					<ChevronDownGlyph className={styles.chevron} aria-hidden />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className={styles.popover}
					side="bottom"
					align="center"
					sideOffset={11}
					collisionPadding={12}
					aria-label="Files"
					// Focus goes to the popover, not its button, so opening it
					// doesn't ring Split as if it were the next thing to do.
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						(event.currentTarget as HTMLElement | null)?.focus();
					}}
				>
					<ul className={styles.rows}>
						{files.map((file) => (
							<li
								key={file.key}
								className={styles.row}
								aria-label={`${file.format}, ${file.fileName}`}
							>
								<FileTypeIcon format={file.format} width={20} height={25} />
								<span className={styles.rowText}>
									<span className={styles.rowFormat}>{file.format}</span>
									<MiddleTruncatedText
										className={styles.rowName}
										text={file.fileName}
									/>
								</span>
							</li>
						))}
					</ul>
					{onSplit && (
						<Popover.Close asChild>
							<Button fullWidth onClick={onSplit}>
								Split into {files.length} Books
							</Button>
						</Popover.Close>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	</div>
);
