import { isDesktop } from "@/lib/platform/runtime";
import { tauriMetadataService } from "./tauri";
import { webMetadataService } from "./web";
export type {
	CredentialHome,
	MetadataService,
	ProviderAvailability,
} from "./types";
export { CREDENTIAL_HOME } from "./types";
export const metadataService = isDesktop
	? tauriMetadataService
	: webMetadataService;
