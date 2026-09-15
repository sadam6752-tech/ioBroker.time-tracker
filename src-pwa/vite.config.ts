/**
 * Build configuration of the web app.
 *
 * The build writes straight into `www/` of the adapter package, which is what the adapter serves on its own
 * port (see `src/lib/web/static.ts`). All asset URLs are relative (`base: "./"`), so the app also works when it
 * is mounted below a sub path (for example as a web extension of a `web` instance).
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const API_PREFIX = "/api/";

export default defineConfig({
	base: "./",
	// `@mui/icons-material` 5.x ships every icon twice: as CommonJS (`Menu.js`) and as ES module (`esm/Menu.js`).
	// The bundler resolves the CommonJS file for the deep path, and depending on the interop the default export
	// arrives wrapped in a module object — React then reports "element type is invalid … got: object". Resolving
	// the ES module variant keeps the plain `import MenuIcon from "@mui/icons-material/Menu"` working.
	resolve: {
		alias: [{ find: /^@mui\/icons-material\/(?!esm\/)(.+)$/, replacement: "@mui/icons-material/esm/$1.js" }],
	},
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			// the app icons are generated from the master logo (tools/make-pwa-icons.mjs); nothing has to be
			// added here, `globPatterns` below precaches every image of the build
			manifest: {
				name: "Zeiterfassung",
				short_name: "Zeiterfassung",
				description: "Time tracking: punch in and out, month and reports",
				lang: "de",
				start_url: "./",
				scope: "./",
				display: "standalone",
				background_color: "#ffffff",
				theme_color: "#1976d2",
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
				// the API must always reach the network; only the app shell is served from the cache
				navigateFallback: "index.html",
				navigateFallbackDenylist: [new RegExp(`^${API_PREFIX}`)],
				navigateFallbackAllowlist: [/^\/$/],
				cleanupOutdatedCaches: true,
				clientsClaim: true,
			},
			devOptions: { enabled: false },
		}),
	],
	server: {
		port: 5173,
		// during development the API runs on the adapter instance; the key has to be computed, otherwise the
		// literal text `API_PREFIX` would be matched and the proxy would never apply (every `/api/…` call would
		// fall back to the app shell — which is what broke the login in the dev server)
		proxy: {
			[API_PREFIX]: {
				target: "http://127.0.0.1:8082",
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: "../www",
		emptyOutDir: true,
		sourcemap: true,
	},
});
