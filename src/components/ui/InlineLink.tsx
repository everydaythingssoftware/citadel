import clsx from "clsx";
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { usePlatform } from "@/lib/platform/context";
import styles from "./InlineLink.module.css";

export interface InlineLinkProps
	extends AnchorHTMLAttributes<HTMLAnchorElement> {
	href: string;
	/** Opens in the user's browser and carries a ↗ to say so. */
	isExternal?: boolean;
}

/** A link inside running text. */
export const InlineLink = ({
	href,
	isExternal = false,
	className,
	children,
	onClick,
	...rest
}: InlineLinkProps) => {
	const platform = usePlatform();
	const openExternally = (event: MouseEvent<HTMLAnchorElement>) => {
		onClick?.(event);
		if (event.defaultPrevented) return;
		event.preventDefault();
		void platform.fileOpener.openPath(href);
	};

	return (
		<a
			href={href}
			className={clsx(styles.link, className)}
			{...(isExternal
				? {
						target: "_blank",
						rel: "noopener noreferrer",
						onClick: openExternally,
					}
				: { onClick })}
			{...rest}
		>
			{children}
			{isExternal && (
				<>
					<span className={styles.externalGlyph} aria-hidden="true">
						↗
					</span>
					<span className={styles.visuallyHidden}> (opens in browser)</span>
				</>
			)}
		</a>
	);
};
