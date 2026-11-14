/**
 * Device token of the kiosk screens (terminal and presence board).
 *
 * The address of such a screen carries the token in its path: `/terminal/<token>/`, `/presence/<token>/`. iOS saves
 * a page to the home screen with the start URL of its manifest and drops the query, so a link `/terminal?token=…`
 * started from the home screen without its token (and the installed app has a storage of its own, the token
 * remembered by Safari is not there). With the app below the path of the token, its manifest (`start_url: "./"`)
 * points at that path. The server sends links of the older form to the new one; the query is still read here.
 */

/** The two kiosk screens. */
export type KioskScreen = "terminal" | "presence";

/**
 * Reads the token from the path of the page.
 *
 * @param screen - the kiosk screen
 * @param pathname - path of the page (defaults to the current one)
 * @returns the token or `null` when the path carries none
 */
export function tokenFromPath(screen: KioskScreen, pathname: string = window.location.pathname): string | null {
	const match = new RegExp(`^/${screen}/([A-Za-z0-9_-]+)/?$`).exec(pathname);
	return match ? match[1] : null;
}

/**
 * Reads the device token of this device: the address wins (path, then the query of older links), otherwise the
 * remembered one. A token of the address is remembered for the next start.
 *
 * @param screen - the kiosk screen
 * @param storageKey - where the token is remembered
 * @returns the token or `null` when this device was never set up
 */
export function readDeviceToken(screen: KioskScreen, storageKey: string): string | null {
	const fromAddress = tokenFromPath(screen) ?? new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
	if (fromAddress) {
		try {
			window.localStorage.setItem(storageKey, fromAddress);
		} catch {
			// a kiosk may forbid storage; the address still carries the token for this session
		}
		return fromAddress;
	}
	try {
		return window.localStorage.getItem(storageKey);
	} catch {
		return null;
	}
}

/**
 * Takes a forgotten token out of the address bar, so that a reload does not bring it back.
 *
 * @param screen - the kiosk screen
 */
export function dropTokenFromAddress(screen: KioskScreen): void {
	if (tokenFromPath(screen) !== null || new URLSearchParams(window.location.search).has("token")) {
		window.history.replaceState(window.history.state, "", `/${screen}`);
	}
}

/**
 * The address a kiosk screen is opened with.
 *
 * @param origin - origin of the server
 * @param screen - the kiosk screen
 * @param token - the device token
 * @returns the address, e.g. `https://host:8092/terminal/<token>/`
 */
export function kioskAddress(origin: string, screen: KioskScreen, token: string): string {
	return `${origin}/${screen}/${encodeURIComponent(token)}/`;
}
