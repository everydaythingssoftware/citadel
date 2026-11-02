import type { ReactNode } from "react";
import {
	SETTINGS_SECTION_LABELS,
	type TSettingsSection,
} from "@/lib/settings-sections";
import classes from "./SettingsPage.module.css";

export const settingsSectionId = (section: TSettingsSection) =>
	`settings-${section}`;

export interface SettingsPageProps {
	sections: readonly TSettingsSection[];
	renderSection: (section: TSettingsSection) => ReactNode;
}

/**
 * Settings as one page of the web app, inside the sidebar and toolbar: every
 * section under its own heading. The desktop app opens SettingsWindow instead.
 */
export const SettingsPage = ({
	sections,
	renderSection,
}: SettingsPageProps) => {
	const several = sections.length > 1;
	return (
		<div className={classes.page}>
			<h1 className={classes.title}>Settings</h1>
			{sections.map((section) => {
				const id = settingsSectionId(section);
				return (
					<section
						key={section}
						id={id}
						className={classes.section}
						aria-labelledby={several ? `${id}-heading` : undefined}
						aria-label={several ? undefined : SETTINGS_SECTION_LABELS[section]}
					>
						{several && (
							<h2 id={`${id}-heading`} className={classes.sectionTitle}>
								{SETTINGS_SECTION_LABELS[section]}
							</h2>
						)}
						{renderSection(section)}
					</section>
				);
			})}
		</div>
	);
};
