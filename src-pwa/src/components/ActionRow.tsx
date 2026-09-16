/**
 * A row of a list whose actions never cover its text.
 *
 * MUI's `secondaryAction` only keeps room for one small icon. Two text buttons — the employees and the terminals
 * of the administration, for example — are wider than that and are laid over the name on a phone. This row keeps
 * the text and the actions in one wrapping flex line instead: on a wide screen the actions sit on the right, on a
 * narrow one they move below the text.
 */

import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import type { ReactNode } from "react";

/**
 * Shows one row of a list.
 *
 * @param props - content and actions of the row
 * @param props.primary - main line of the row
 * @param props.secondary - second line of the row
 * @param props.children - actions of the row
 * @returns the row
 */
export function ActionRow({
	primary,
	secondary,
	children,
}: {
	primary: ReactNode;
	secondary?: ReactNode;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<ListItem
			divider
			sx={{ flexWrap: "wrap", alignItems: "center", columnGap: 1, rowGap: 0.5 }}
		>
			<ListItemText
				sx={{ flex: "1 1 10rem", minWidth: 0 }}
				primary={primary}
				secondary={secondary}
			/>
			<Stack
				direction="row"
				spacing={1}
				alignItems="center"
				sx={{ ml: "auto", flexShrink: 0 }}
			>
				{children}
			</Stack>
		</ListItem>
	);
}
