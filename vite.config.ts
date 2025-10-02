import { defineConfig } from "vite";

export default defineConfig({
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	server: {
		port: 1420,
		// 2. tauri expects a fixed port, fail if that port is not available
		strictPort: true,
		watch: {
			// 3. tell vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
});
