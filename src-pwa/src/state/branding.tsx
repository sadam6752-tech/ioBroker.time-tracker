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
 * readable. The second block is darker — it is still light enough for the dark text, but a chosen shade stays
 * visible when a background picture is set, because the colour tints the veil in front of the picture.
 * Any other colour can be typed as a hex value — the field is right next to the suggestions.
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
	// darker shades, from here on
	"#d9e0ea",
	"#c8d6e6",
	"#b7cbe2",
	"#c6d8c9",
	"#b9d3bd",
	"#d6c8e6",
	"#e2d3be",
	"#dcc4c2",
] as const;

/**
 * Turns a hex colour into `rgba()`.
 *
 * The veil in front of a background picture needs a transparency, and a hex colour cannot carry one.
 *
 * @param color - colour as `#rgb` or `#rrggbb`
 * @param alpha - opacity between `0` and `1`
 * @returns the colour as `rgba(...)`, or the input when it is not a hex value
 */
export function withAlpha(color: string, alpha: number): string {
	const hex = color.trim().replace(/^#/, "");
	const full = hex.length === 3 ? [...hex].map(part => part + part).join("") : hex;
	if (!/^[0-9a-f]{6}$/i.test(full)) {
		return color;
	}
	const value = Number.parseInt(full, 16);
	return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

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
 * A veil lies over the picture, so text stays readable on any image. The veil takes the configured colour, so a
 * chosen shade is visible although a picture is set; without a colour it stays white.
 *
 * @param branding - branding of the installation
 * @returns the CSS properties for the background
 */
export function backgroundStyle(branding: Branding): Record<string, unknown> {
	if (branding.backgroundUrl) {
		const veil = withAlpha(branding.color ?? "#ffffff", 0.75);
		return {
			backgroundImage: `linear-gradient(${veil}, ${veil}), url("${branding.backgroundUrl}")`,
			backgroundSize: "cover",
			backgroundPosition: "center",
			backgroundColor: branding.color ?? undefined,
		};
	}
	return branding.color ? { backgroundColor: branding.color } : {};
}
