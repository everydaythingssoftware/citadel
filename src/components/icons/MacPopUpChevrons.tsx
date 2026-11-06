/**
 * The AppKit pop-up button affordance: stacked up/down chevrons pinned to the
 * control's right edge, drawn plain in secondary ink as current macOS does.
 */
export const MacPopUpChevrons = () => (
	<span
		aria-hidden="true"
		style={{
			width: 16,
			height: 16,
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			flexShrink: 0,
		}}
	>
		<svg
			width="8"
			height="11"
			viewBox="0 0 8 11"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M1 4L4 1.25 7 4M1 7l3 2.75L7 7"
				stroke="var(--ctd-ink-soft)"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	</span>
);
