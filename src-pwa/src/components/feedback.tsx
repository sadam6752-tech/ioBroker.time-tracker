/**
 * Small helpers that turn API problems into translatable texts and show them uniformly.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";

/**
 * Maps the stable error code of a problem document onto a translation key.
 *
 * @param error - error thrown by the API client
 * @returns translation key
 */
export function errorKey(error: unknown): string {
	if (error instanceof ApiError) {
		return `error.${error.code}`;
	}
	return "error.unknown_error";
}

/**
 * Shows the message of an error (or nothing).
 *
 * @param props - error and optional severity
 * @param props.error - error to show
 * @param props.severity - MUI severity, default `error`
 * @returns alert or `null`
 */
export function ErrorAlert({
	error,
	severity = "error",
}: {
	error: unknown;
	severity?: "error" | "warning" | "info" | "success";
}): React.JSX.Element | null {
	const { t } = useTranslation();
	if (!error) {
		return null;
	}
	const key = errorKey(error);
	const translated = t(key);
	return (
		<Alert
			severity={severity}
			sx={{ mb: 2 }}
		>
			{translated === key ? t("error.unknown_error") : translated}
		</Alert>
	);
}

/**
 * Centered loading indicator.
 *
 * @returns spinner
 */
export function Loading(): React.JSX.Element {
	const { t } = useTranslation();
	return (
		<Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 2, py: 6 }}>
			<CircularProgress size={22} />
			{t("common.loading")}
		</Box>
	);
}

/**
 * Card-like section used by the screens.
 *
 * @param props - title and content
 * @param props.title - heading
 * @param props.children - content
 * @param props.actions - optional actions on the right
 * @returns the section
 */
export function Section({
	title,
	children,
	actions,
}: {
	title: string;
	children: ReactNode;
	actions?: ReactNode;
}): React.JSX.Element {
	return (
		<Box sx={{ mb: 3 }}>
			<Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
				<Box
					component="h2"
					sx={{ fontSize: "1.05rem", fontWeight: 600, m: 0 }}
				>
					{title}
				</Box>
				{actions}
			</Box>
			{children}
		</Box>
	);
}
