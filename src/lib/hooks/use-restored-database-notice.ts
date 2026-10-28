import { useEffect } from "react";
import { toast } from "@/components/ui";
import {
	formatBackupDate,
	RESTORED_NOTICE,
} from "@/lib/database-recovery/copy";
import { usePlatform } from "@/lib/platform/context";

/** Says once, after the window shows, that startup restored a backup. */
export const useRestoredDatabaseNotice = (shown: boolean) => {
	const platform = usePlatform();
	useEffect(() => {
		if (!shown) return;
		void platform.recovery.restored().then((backup) => {
			if (!backup) return;
			toast.show({
				id: "database-restored",
				title: RESTORED_NOTICE.title,
				message: RESTORED_NOTICE.message(formatBackupDate(backup.createdAt)),
				duration: 20000,
			});
		});
	}, [shown, platform]);
};
