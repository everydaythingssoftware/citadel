import { useEffect, useState } from "react";
import { type ServerHealth, serverService } from "@/lib/services/server";

/**
 * The server's health as an administrator sees it, with reasons. Read once
 * when Settings opens; monitors poll /api/health themselves.
 */
export const useServerHealth = (): { health: ServerHealth | null } => {
	const [health, setHealth] = useState<ServerHealth | null>(null);

	useEffect(() => {
		let cancelled = false;
		serverService
			.health()
			.then((next) => {
				if (!cancelled) setHealth(next);
			})
			.catch((error: unknown) => console.error("Server health:", error));
		return () => {
			cancelled = true;
		};
	}, []);

	return { health };
};
