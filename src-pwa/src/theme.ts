/**
 * MUI theme of the web app: compact spacing, touch friendly controls (the app is used on phones).
 */

import { createTheme } from "@mui/material/styles";

/** Theme used by the app. */
export const theme = createTheme({
	palette: {
		mode: "light",
		primary: { main: "#1976d2" },
		secondary: { main: "#00897b" },
	},
	shape: { borderRadius: 10 },
	components: {
		MuiButton: {
			defaultProps: { disableElevation: true },
			styleOverrides: { root: { textTransform: "none", minHeight: 44 } },
		},
		MuiCard: { styleOverrides: { root: { border: "1px solid rgba(0,0,0,0.08)" } } },
	},
});
