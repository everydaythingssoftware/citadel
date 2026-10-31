import clsx from "clsx";
import { useId } from "react";
import styles from "./Hourglass.module.css";

export const HourglassStyle = {
	/** A kitchen-timer dial whose wedge winds down clockwise. */
	timer: "timer",
	/** An hourglass whose sand drains from the top bulb into the bottom. */
	sand: "sand",
	/** A ring that empties clockwise. */
	ring: "ring",
	/** A thin bar that shortens. */
	bar: "bar",
} as const;
export type THourglassStyle =
	(typeof HourglassStyle)[keyof typeof HourglassStyle];

export interface HourglassProps {
	/** 1 with the whole review window left, 0 at the deadline. */
	fraction: number;
	/** In the last stretch: drawn in brass, gently pulsing. */
	urgent?: boolean;
	variant?: THourglassStyle;
	/** Height in px (the bar's width is four times this). */
	size?: number;
	/** Spoken description, e.g. "Add or skip by 3:40 pm tomorrow". */
	label: string;
	className?: string;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const Sand = ({ fraction }: { fraction: number }) => {
	const id = useId();
	// Bulbs span y 2–11 (top) and 13–22 (bottom) in a 16×24 box.
	const top = 9 * fraction;
	const bottom = 9 * (1 - fraction);
	return (
		<svg viewBox="0 0 16 24" aria-hidden="true">
			<defs>
				<clipPath id={`${id}-top`}>
					<path d="M3 2h10c0 4-3 6.5-5 9-2-2.5-5-5-5-9Z" />
				</clipPath>
				<clipPath id={`${id}-bottom`}>
					<path d="M3 22h10c0-4-3-6.5-5-9-2 2.5-5 5-5 9Z" />
				</clipPath>
			</defs>
			<rect
				className={styles.sand}
				x="0"
				y={11 - top}
				width="16"
				height={top}
				clipPath={`url(#${id}-top)`}
			/>
			<rect
				className={styles.sand}
				x="0"
				y={22 - bottom}
				width="16"
				height={bottom}
				clipPath={`url(#${id}-bottom)`}
			/>
			{fraction > 0 && fraction < 1 && (
				<line
					className={styles.stream}
					x1="8"
					y1="11"
					x2="8"
					y2={22 - bottom}
				/>
			)}
			<path
				className={styles.frame}
				d="M2 1.5h12M2 22.5h12M3 2c0 4 3 6.5 5 10-2 3.5-5 6-5 10M13 2c0 4-3 6.5-5 10 2 3.5 5 6 5 10"
			/>
		</svg>
	);
};

/** The wedge of a dial from 12 o'clock, clockwise, for `fraction` of a turn. */
const wedge = (fraction: number, radius: number): string => {
	const angle = fraction * 2 * Math.PI;
	const x = 12 + radius * Math.sin(angle);
	const y = 12 - radius * Math.cos(angle);
	const large = fraction > 0.5 ? 1 : 0;
	return `M12 12V${12 - radius}A${radius} ${radius} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
};

const Timer = ({ fraction }: { fraction: number }) => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<circle className={styles.dial} cx="12" cy="13" r="9.5" />
		<path className={styles.knob} d="M10 1.75h4" />
		<g transform="translate(0 1)">
			{fraction >= 0.999 ? (
				<circle className={styles.wedge} cx="12" cy="12" r="6.5" />
			) : (
				fraction > 0 && (
					<path className={styles.wedge} d={wedge(fraction, 6.5)} />
				)
			)}
		</g>
	</svg>
);

const Ring = ({ fraction }: { fraction: number }) => {
	const circumference = 2 * Math.PI * 9;
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<circle className={styles.track} cx="12" cy="12" r="9" />
			<circle
				className={styles.arc}
				cx="12"
				cy="12"
				r="9"
				strokeDasharray={`${circumference * fraction} ${circumference}`}
				transform="rotate(-90 12 12)"
			/>
		</svg>
	);
};

/** How much of a ready book's review window is left, at a glance. */
export const Hourglass = ({
	fraction,
	urgent = false,
	variant = HourglassStyle.timer,
	size = 18,
	label,
	className,
}: HourglassProps) => {
	const value = clamp(fraction);
	return (
		<span
			role="img"
			aria-label={label}
			className={clsx(
				styles.hourglass,
				styles[variant],
				urgent && styles.urgent,
				className,
			)}
			style={
				variant === HourglassStyle.bar
					? { width: size * 4, height: Math.max(3, size / 6) }
					: {
							width: variant === HourglassStyle.sand ? (size * 2) / 3 : size,
							height: size,
						}
			}
		>
			{variant === HourglassStyle.timer && <Timer fraction={value} />}
			{variant === HourglassStyle.sand && <Sand fraction={value} />}
			{variant === HourglassStyle.ring && <Ring fraction={value} />}
			{variant === HourglassStyle.bar && (
				<span className={styles.barFill} style={{ width: `${value * 100}%` }} />
			)}
		</span>
	);
};
