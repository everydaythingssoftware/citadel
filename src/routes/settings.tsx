import { createFileRoute } from "@tanstack/react-router";
import {
	SettingsPage,
	settingsSectionId,
} from "@/components/organisms/SettingsPage";
import {
	BROWSER_SETTINGS_SECTIONS,
	SettingsSectionContent,
} from "@/components/organisms/SettingsPanes";
import { SettingsWindow } from "@/components/pages/SettingsWindow";
import { usePlatform } from "@/lib/platform/context";
import { SettingsSection } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings")({
	component: Settings,
});

/** The desktop app opens Settings in its own window; the web shows a page. */
function Settings() {
	const platform = usePlatform();
	return platform.capabilities.supportsNativeWindows ? (
		<SettingsWindow />
	) : (
		<SettingsPage
			sections={BROWSER_SETTINGS_SECTIONS}
			renderSection={(section) => (
				<SettingsSectionContent
					section={section}
					onManageKeys={() =>
						document
							.getElementById(settingsSectionId(SettingsSection.account))
							?.scrollIntoView({ block: "start" })
					}
				/>
			)}
		/>
	);
}
