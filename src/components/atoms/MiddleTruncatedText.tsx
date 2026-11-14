import clsx from "clsx";
import { useMiddleTruncation } from "@/lib/hooks/use-middle-truncation";
import styles from "./MiddleTruncatedText.module.css";

interface MiddleTruncatedTextProps {
	text: string;
	className?: string;
}

/** One line of text shortened in the middle to fit, whole in its tooltip. */
export const MiddleTruncatedText = ({
	text,
	className,
}: MiddleTruncatedTextProps) => {
	const [ref, shown] = useMiddleTruncation<HTMLSpanElement>(text);
	return (
		<span
			ref={ref}
			className={clsx(styles.text, className)}
			title={shown === text ? undefined : text}
		>
			{shown === text ? (
				text
			) : (
				<>
					<span aria-hidden="true">{shown}</span>
					<span className={styles.whole}>{text}</span>
				</>
			)}
		</span>
	);
};
