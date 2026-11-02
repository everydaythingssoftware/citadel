import type { Meta, StoryObj } from "@storybook/react";
import panes from "@/components/organisms/SettingsPanes.module.css";
import {
	SettingsSection,
	type TSettingsSection,
} from "@/lib/settings-sections";
import { SettingsPage } from "./SettingsPage";

const ROWS: Record<TSettingsSection, string[]> = {
	general: ["Appearance"],
	metadata: [
		"Library of Congress",
		"Deutsche Nationalbibliothek",
		"Open Library",
		"Hardcover",
	],
	account: ["Hardcover API key"],
};

/** Stand-in content: the real sections read the app's stores. */
const Section = ({ section }: { section: TSettingsSection }) => (
	<div className={panes.groups}>
		<div className={panes.group}>
			{ROWS[section].map((row) => (
				<div key={row} className={panes.row}>
					<div className={panes.rowLabels}>
						<span className={panes.rowLabel}>{row}</span>
					</div>
				</div>
			))}
		</div>
	</div>
);

const meta: Meta<typeof SettingsPage> = {
	component: SettingsPage,
	args: {
		sections: Object.values(SettingsSection),
		renderSection: (section) => <Section section={section} />,
	},
	argTypes: {
		renderSection: { table: { disable: true } },
	},
};

export default meta;
type Story = StoryObj<typeof SettingsPage>;

export const AllSections: Story = {};

/** Without provider keys on the server, only General applies. */
export const OnlyGeneral: Story = {
	args: { sections: [SettingsSection.general] },
};
