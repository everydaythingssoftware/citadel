import type { Meta, StoryObj } from "@storybook/react";
import { useMemo } from "react";
import { createWebPlatform } from "@/lib/platform/create";
import { PlatformProvider } from "@/lib/platform/context";
import {
	SettingsSection,
	type TSettingsSection,
} from "@/lib/settings-sections";
import { SettingsPage } from "./SettingsPage";
import { SettingsSectionContent } from "./SettingsPanes";

/** The real sections, as the web app renders them, over the browser platform. */
const WithPlatform = ({ sections }: { sections: TSettingsSection[] }) => {
	const platform = useMemo(createWebPlatform, []);
	return (
		<PlatformProvider value={platform}>
			<SettingsPage
				sections={sections}
				renderSection={(section) => (
					<SettingsSectionContent section={section} />
				)}
			/>
		</PlatformProvider>
	);
};

const meta: Meta = {
	title: "Components/Organisms/SettingsPage",
	parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

export const AllSections: Story = {
	render: () => <WithPlatform sections={Object.values(SettingsSection)} />,
};

/** Without provider keys on the server, only General applies. */
export const OnlyGeneral: Story = {
	render: () => <WithPlatform sections={[SettingsSection.general]} />,
};
