import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/organisms/SettingsPage";
import {
	browserSettingsSections,
	SettingsSectionContent,
} from "@/components/organisms/SettingsPanes";
import { SettingsWindow } from "@/components/pages/SettingsWindow";
import { useBrowserSessionControls } from "@/lib/hooks/use-browser-session";
import { usePlatform } from "@/lib/platform/context";

export const Route = createFileRoute("/settings")({
	component: Settings,
});

/** The desktop app opens Settings in its own window; the web shows a page. */
function Settings() {
	const platform = usePlatform();
	const administrator = useBrowserSessionControls()?.administrator ?? false;
	return platform.capabilities.supportsNativeWindows ? (
		<SettingsWindow />
	) : (
		<SettingsPage
			sections={browserSettingsSections(administrator)}
			renderSection={(section) => <SettingsSectionContent section={section} />}
		/>
	);
}
