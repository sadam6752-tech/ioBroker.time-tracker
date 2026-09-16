/**
 * Branding of the installation: logo, background and accent colour.
 *
 * The values are public — the sign in screen and the kiosk screens show them before anybody is signed in — so the
 * provider can be mounted above the login guard. Everything is optional: without a configuration the app looks
 * exactly as it did before.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Branding } from "../api/types";

/** Branding that is used when nothing is configured. */
const NONE: Branding = { color: null, logoUrl: null, backgroundUrl: null };

/**
 * Background colours that the settings offer as suggestions.
 *
 * They are deliberately light: the app paints dark text on them, and the white cards of the screens have to stay
 * readable. Any other colour can be typed as a hex value — the field is right next to the suggestions.
 */
export const BRAND_PRESET_COLORS = [
	"#ffffff",
	"#f5f7fa",
	"#eef2f7",
	"#e3f1f5",
	"#e8f1e9",
	"#eef1e4",
	"#eae6f7",
	"#f3ecf7",
	"#f7f0f5",
	"#fdf3e3",
	"#f6ece3",
	"#fdecea",
] as const;

/** Context that carries the branding. */
const BrandingContext = createContext<Branding>(NONE);

/**
 * Loads the branding once and hands it to the app.
 *
 * @param props - children of the provider
 * @param props.children - the application
 * @returns the provider
 */
export function BrandingProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const branding = useQuery({
		queryKey: ["branding"],
		queryFn: () => api.branding(),
		staleTime: 10 * 60 * 1000,
	});

	return <BrandingContext.Provider value={branding.data ?? NONE}>{children}</BrandingContext.Provider>;
}

/**
 * Reads the branding of the installation.
 *
 * @returns the branding, empty when nothing is configured
 */
export function useBranding(): Branding {
	return useContext(BrandingContext);
}

/**
 * Style of the app background: the configured picture, otherwise the configured colour.
 *
 * A light veil lies over the picture, so text stays readable on any image.
 *
 * @param branding - branding of the installation
 * @returns the CSS properties for the background
 */
export function backgroundStyle(branding: Branding): Record<string, unknown> {
	if (branding.backgroundUrl) {
		return {
			backgroundImage: `linear-gradient(rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0.75)), url("${branding.backgroundUrl}")`,
			backgroundSize: "cover",
			backgroundPosition: "center",
			backgroundColor: branding.color ?? undefined,
		};
	}
	return branding.color ? { backgroundColor: branding.color } : {};
}
