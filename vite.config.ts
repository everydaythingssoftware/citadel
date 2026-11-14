import { defineConfig } from "vitest/config";
import Icons from "unplugin-icons/vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";

export default defineConfig({
	plugins: [react(), Icons(), TanStackRouterVite()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			$lib: path.resolve(__dirname, "./src/lib"),
		},
	},
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	server: {
		port: 1420,
        proxy: process.env.CITADEL_API_URL ? {"/api": {target: process.env.CITADEL_API_URL, changeOrigin: false}} : undefined,
		// 2. tauri expects a fixed port, fail if that port is not available
		strictPort: true,
		watch: {
			// 3. tell vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
	test: {
		include: ["src/**/*.{test,spec}.{js,ts}", "tools/testing/**/*.test.ts"],
	},
});
