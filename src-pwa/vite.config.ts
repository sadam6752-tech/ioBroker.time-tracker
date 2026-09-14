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
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["favicon.svg"],
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
		// during development the API runs on the adapter instance
		proxy: {
			API_PREFIX: {
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
