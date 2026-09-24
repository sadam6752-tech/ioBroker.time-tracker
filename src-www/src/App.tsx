/**
 * App shell of the web app: routing, providers and the login guard.
 *
 * Navigation is a plain client side router; the server delivers `index.html` for unknown paths (see the static
 * handler of the adapter), so a reload on `/month` works as well.
 */

import CssBaseline from "@mui/material/CssBaseline";
import { useState } from "react";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Box, CircularProgress } from "@mui/material";
import { Absences } from "./screens/Absences";
import { Admin } from "./screens/Admin";
import { Dashboard } from "./screens/Dashboard";
import { Login } from "./screens/Login";
import { Month } from "./screens/Month";
import { PasswordChange } from "./screens/PasswordChange";
import { Presence } from "./screens/Presence";
import { Profile } from "./screens/Profile";
import { Reports } from "./screens/Reports";
import { Statistics } from "./screens/Statistics";
import { Sync } from "./screens/Sync";
import { TagScan } from "./screens/TagScan";
import { Terminal } from "./screens/Terminal";
import { SessionProvider, useSession } from "./state/session";
import { BrandingProvider, backgroundStyle, useBranding } from "./state/branding";
import { SyncProvider } from "./offline/useSync";
import { theme } from "./theme";

/** Shared query client: figures are refreshed on demand, errors are shown by the screens. */
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			refetchOnWindowFocus: true,
			staleTime: 30_000,
		},
	},
});

/**
 * Decides between login screen and the app.
 *
 * @returns the routed application
 */
function Routed(): React.JSX.Element {
	const { session, checking } = useSession();

	if (checking && !session) {
		return (
			<Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
				<CircularProgress />
			</Box>
		);
	}

	if (!session) {
		return (
			<Routes>
				<Route
					path="*"
					element={<Login />}
				/>
			</Routes>
		);
	}

	if (session.user.mustChangePw) {
		// the start password of the first administrator (and a password taken over from the old system) opens the
		// door exactly once, so every route leads to the password change until a new password is stored
		return (
			<Routes>
				<Route
					path="*"
					element={<PasswordChange />}
				/>
			</Routes>
		);
	}

	return (
		<Routes>
			<Route
				path="/"
				element={<Dashboard />}
			/>
			<Route
				path="/month"
				element={<Month />}
			/>
			<Route
				path="/reports"
				element={<Reports />}
			/>
			<Route
				path="/statistics"
				element={<Statistics />}
			/>
			<Route
				path="/absences"
				element={<Absences />}
			/>
			<Route
				path="/sync"
				element={<Sync />}
			/>
			<Route
				path="/profile"
				element={<Profile />}
			/>
			<Route
				path="/admin"
				element={<Admin />}
			/>
			<Route
				path="*"
				element={
					<Navigate
						to="/"
						replace
					/>
				}
			/>
		</Routes>
	);
}

/**
 * Entry point of the routing.
 *
 * The kiosk terminal and the presence screen authenticate with their own device token instead of a user session,
 * so their routes live outside the login guard of `Routed`.
 *
 * @returns the screen the URL asks for
 */
function Root(): React.JSX.Element {
	// a badge link (`?tag=…`) is redeemed by its own screen: the tag proves itself, so no session is needed.
	// The check runs once — the screen takes the token out of the address bar afterwards.
	const [scanned] = useState(() => new URLSearchParams(window.location.search).has("tag"));

	if (scanned) {
		return <TagScan />;
	}

	return (
		<Routes>
			<Route
				path="/terminal"
				element={<Terminal />}
			/>
			<Route
				path="/presence"
				element={<Presence />}
			/>
			<Route
				path="*"
				element={<Routed />}
			/>
		</Routes>
	);
}

/**
 * Paints the background of the installation and holds the application.
 *
 * @returns the application on the branded background
 */
function Shell(): React.JSX.Element {
	const branding = useBranding();

	return (
		<Box sx={{ minHeight: "100vh", ...backgroundStyle(branding) }}>
			<Root />
		</Box>
	);
}

/**
 * Root component of the web app.
 *
 * @returns the application
 */
export function App(): React.JSX.Element {
	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			<QueryClientProvider client={queryClient}>
				<SessionProvider>
					<SyncProvider>
						<BrowserRouter>
							<BrandingProvider>
								<Shell />
							</BrandingProvider>
						</BrowserRouter>
					</SyncProvider>
				</SessionProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}
