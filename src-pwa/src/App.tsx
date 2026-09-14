/**
 * App shell of the web app: routing, providers and the login guard.
 *
 * Navigation is a plain client side router; the server delivers `index.html` for unknown paths (see the static
 * handler of the adapter), so a reload on `/month` works as well.
 */

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Box, CircularProgress } from "@mui/material";
import { Absences } from "./screens/Absences";
import { Dashboard } from "./screens/Dashboard";
import { Login } from "./screens/Login";
import { Month } from "./screens/Month";
import { Profile } from "./screens/Profile";
import { Reports } from "./screens/Reports";
import { Sync } from "./screens/Sync";
import { SessionProvider, useSession } from "./state/session";
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
							<Routed />
						</BrowserRouter>
					</SyncProvider>
				</SessionProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}
