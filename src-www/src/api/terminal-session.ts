/**
 * Terminal sessions of the kiosk screens.
 *
 * A terminal session lives for minutes only (the server allows 15), while the **device token** is the long lived
 * credential. A screen that hangs in a workshop therefore has to look after itself: it sends a heartbeat to keep the
 * session alive and, when a call comes back because the session is gone, it asks for a new one with the stored device
 * token and repeats the call once. That is what lets such a screen run for weeks without anybody touching it —
 * browsers throttle timers in the background, so a heartbeat alone is not enough.
 */

import { ApiError, api, type TerminalSessionResult } from "./client";

/**
 * Tells whether an error means "this terminal session is not valid any more".
 *
 * @param error - error of an API call
 * @returns true when a fresh session would help
 */
export function isTerminalSessionExpired(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.status === 401 &&
		(error.code === "no_session" || error.code === "invalid_credentials")
	);
}

/**
 * Exchanges the device token for a fresh terminal session.
 *
 * @param deviceToken - long lived token of the device
 * @returns the new session
 */
export function renewTerminalSession(deviceToken: string): Promise<TerminalSessionResult> {
	return api.terminalSession(deviceToken);
}

/**
 * Runs a call with the session and repeats it once with a fresh session after that expired.
 *
 * @param args - token, session, call and the callback that stores the renewed session
 * @param args.deviceToken - long lived token of the device
 * @param args.session - session to use
 * @param args.call - request to run
 * @param args.onRenewed - called with the fresh session, so the caller can keep using it
 * @returns the answer of the call
 */
export async function withFreshSession<T>(args: {
	deviceToken: string;
	session: TerminalSessionResult;
	call: (session: TerminalSessionResult) => Promise<T>;
	onRenewed?: (session: TerminalSessionResult) => void;
}): Promise<T> {
	try {
		return await args.call(args.session);
	} catch (error) {
		if (!isTerminalSessionExpired(error)) {
			throw error;
		}
		const renewed = await renewTerminalSession(args.deviceToken);
		args.onRenewed?.(renewed);
		return args.call(renewed);
	}
}
