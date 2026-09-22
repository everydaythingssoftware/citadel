import type { Meta, StoryObj } from "@storybook/react";
import { type ReactElement, useLayoutEffect } from "react";
import type { SwitchStage } from "@/lib/library-switch/machine";
import { LibrarySwitchCurtain } from "./LibrarySwitchCurtain";

const LIBRARY_NAME = "Fiction";

const arming: SwitchStage = { id: "arming", name: LIBRARY_NAME, progress: 0 };
const working = (progress: number): SwitchStage => ({
	id: "working",
	name: LIBRARY_NAME,
	progress,
});
const revealing: SwitchStage = {
	id: "revealing",
	name: LIBRARY_NAME,
	progress: 100,
};

/** Pins data-theme to dark for the story, restoring whatever preceded it. */
const withDarkTheme = (Story: () => ReactElement) => {
	useLayoutEffect(() => {
		const root = document.documentElement;
		const previous = root.getAttribute("data-theme");
		root.setAttribute("data-theme", "dark");
		return () => {
			if (previous === null) root.removeAttribute("data-theme");
			else root.setAttribute("data-theme", previous);
		};
	}, []);
	return <Story />;
};

/**
 * The revealing stage's stylesheet fade-out runs 320ms and lands at opacity
 * 0, which would leave this story showing a blank canvas; freeze the curtain
 * animation so the state stays visible.
 */
const withFrozenCurtainAnimation = (Story: () => ReactElement) => (
	<>
		<style>{`[role="status"][data-stage] { animation-play-state: paused !important; }`}</style>
		<Story />
	</>
);

const meta: Meta<typeof LibrarySwitchCurtain> = {
	component: LibrarySwitchCurtain,
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Arming: Story = {
	render: () => <LibrarySwitchCurtain stage={arming} />,
};

export const WorkingStart: Story = {
	render: () => <LibrarySwitchCurtain stage={working(0)} />,
};

export const WorkingMid: Story = {
	render: () => <LibrarySwitchCurtain stage={working(45)} />,
};

export const WorkingNearEnd: Story = {
	render: () => <LibrarySwitchCurtain stage={working(90)} />,
};

export const Revealing: Story = {
	decorators: [withFrozenCurtainAnimation],
	render: () => <LibrarySwitchCurtain stage={revealing} />,
};

export const DarkWorkingMid: Story = {
	decorators: [withDarkTheme],
	render: () => <LibrarySwitchCurtain stage={working(45)} />,
};
