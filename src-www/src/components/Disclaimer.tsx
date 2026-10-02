/**
 * The liability notice: a short, quiet paragraph on the sign-in page and in the profile.
 * The full text (English and German) is the chapter “Disclaimer” of the README.
 */

import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

/**
 * Shows the liability notice in the language of the display.
 *
 * @returns the paragraph
 */
export function Disclaimer(): React.JSX.Element {
	const { t } = useTranslation();
	return (
		<Typography
			id="app-disclaimer"
			variant="caption"
			color="text.secondary"
			component="p"
			sx={{ mt: 2, mb: 0 }}
		>
			{t("app.disclaimer")}
		</Typography>
	);
}
