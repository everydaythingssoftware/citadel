import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { useVisibleViewport } from "@/lib/hooks/use-visible-viewport";
import { ViewportDebug } from "./ViewportDebug";

const meta: Meta<typeof ViewportDebug> = {
	component: ViewportDebug,
	args: {
		viewport: {
			top: 0,
			height: 380,
			touch: true,
			keyboard: true,
			cramped: true,
		},
		innerHeight: 659,
		screenHeight: 852,
		focused: "input#title",
	},
};

export default meta;
type Story = StoryObj<typeof ViewportDebug>;

/** Static: an iPhone with the keyboard up. */
export const KeyboardUp: Story = {};

const Live = () => {
	const viewport = useVisibleViewport();
	const [, rerender] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => rerender((value) => value + 1), 500);
		return () => clearInterval(timer);
	}, []);
	return (
		<div style={{ paddingTop: 120 }}>
			<input placeholder="Focus me" style={{ fontSize: 16, padding: 8 }} />
			<ViewportDebug
				viewport={viewport}
				innerHeight={window.innerHeight}
				screenHeight={window.screen.height}
				focused={document.activeElement?.tagName.toLowerCase() ?? "none"}
			/>
		</div>
	);
};

/** Interactive: this browser's own readings; focus the field to see "keyboard". */
export const ThisBrowser: Story = { render: () => <Live /> };
