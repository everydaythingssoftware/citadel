/** The sections of the web app's Settings page. */
export const SettingsSection = {
	general: "general",
	metadata: "metadata",
	shortcuts: "shortcuts",
} as const;
export type TSettingsSection =
	(typeof SettingsSection)[keyof typeof SettingsSection];

export const SETTINGS_SECTION_LABELS: Record<TSettingsSection, string> = {
	general: "General",
	metadata: "Sources",
	shortcuts: "Keyboard shortcuts",
};
