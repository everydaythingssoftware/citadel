import type { SVGProps } from "react";

export function TablerRefresh(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="1em"
			height="1em"
			aria-hidden="true"
			viewBox="0 0 24 24"
			{...props}
		>
			<g
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
			>
				<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"></path>
				<path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"></path>
			</g>
		</svg>
	);
}
