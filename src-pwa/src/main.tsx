/**
 * Entry point of the web app.
 *
 * The service worker (Workbox) is registered by `vite-plugin-pwa`; it caches the app shell, so the app starts
 * offline and queues punches until the API is reachable again.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./i18n";

// check for a new version when the app comes back to the foreground
registerSW({ immediate: true });

const container = document.getElementById("root");
if (!container) {
	throw new Error("index.html does not contain #root");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
