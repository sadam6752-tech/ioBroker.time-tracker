/**
 * Session state of the web app.
 *
 * The provider owns the login state: it verifies a stored session on start, keeps the permissions of the caller
 * (the server decides, the UI only hides what would be refused anyway) and switches the language to the one the
 * user has configured in the adapter.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import i18n, { normaliseLanguage } from "../i18n";
import { api, ApiError, type StoredSession } from "../api/client";
import type { SessionUser } from "../api/types";

/** Session context value. */
export interface SessionState {
	/** Current session or `null` when nobody is signed in */
	session: StoredSession | null;
	/** Permissions of the caller */
	permissions: string[];
	/** True while the stored session is being verified */
	checking: boolean;
	/** Signs in and stores the session */
	signIn(login: string, password: string): Promise<void>;
	/** Signs out */
	signOut(): Promise<void>;
	/** Re-reads the session from the server */
	refresh(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Provides the session to the app.
 *
 * @param props - children and an optional client (tests)
 * @param props.children - React children
 * @returns the provider
 */
export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [session, setSession] = useState<StoredSession | null>(() => api.session());
	const [permissions, setPermissions] = useState<string[]>([]);
	const [checking, setChecking] = useState(session !== null);

	/**
	 * Applies the language of the user.
	 *
	 * @param user - user from the session
	 */
	const applyLanguage = useCallback((user: SessionUser | null): void => {
		if (!user) {
			return;
		}
		const language = normaliseLanguage(user.language);
		if (i18n.language !== language) {
			void i18n.changeLanguage(language);
		}
	}, []);

	/** Verifies the stored session and reads the permissions. */
	const refresh = useCallback(async (): Promise<void> => {
		if (!api.session()) {
			setSession(null);
			setPermissions([]);
			setChecking(false);
			return;
		}
		try {
			const result = await api.me();
			setPermissions(result.permissions ?? []);
			if (result.user) {
				applyLanguage(result.user);
				setSession(current => (current ? { ...current, user: result.user as SessionUser } : current));
			}
		} catch (error) {
			if (error instanceof ApiError && (error.status === 401 || error.status === 0)) {
				// an expired session or an unreachable server: keep the local state, the next action will fail
				if (error.status === 401) {
					setSession(null);
					setPermissions([]);
				}
			}
		} finally {
			setChecking(false);
		}
	}, [applyLanguage]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const signIn = useCallback(
		async (login: string, password: string): Promise<void> => {
			const stored = await api.login(login, password);
			applyLanguage(stored.user);
			setSession(stored);
			await refresh();
		},
		[applyLanguage, refresh],
	);

	const signOut = useCallback(async (): Promise<void> => {
		await api.logout();
		setSession(null);
		setPermissions([]);
	}, []);

	const value = useMemo<SessionState>(
		() => ({ session, permissions, checking, signIn, signOut, refresh }),
		[session, permissions, checking, signIn, signOut, refresh],
	);

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Reads the session context.
 *
 * @returns session state
 */
export function useSession(): SessionState {
	const value = useContext(SessionContext);
	if (!value) {
		throw new Error("useSession must be used inside a SessionProvider");
	}
	return value;
}

/**
 * Checks whether the caller has a permission.
 *
 * @param permissions - permissions of the caller
 * @param required - required permission
 * @returns true when the permission is granted
 */
export function hasPermission(permissions: string[], required: string): boolean {
	return permissions.includes(required);
}
