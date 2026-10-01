/**
 * Administration: EmployeePicker (split out of `Admin.tsx`).
 */

import { type AdminUser } from "../../api/types";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";

/**
 * Picks the employees of a terminal.
 *
 * @param props - employees, current selection and handler
 * @param props.users - employees to choose from
 * @param props.chosen - selected ids (an empty list means “all employees”)
 * @param props.onChange - called with the new selection
 * @returns the list of switches
 */
export function EmployeePicker({
	users,
	chosen,
	onChange,
}: {
	users: AdminUser[];
	chosen: number[];
	onChange: (ids: number[]) => void;
}): React.JSX.Element {
	return (
		<Box sx={{ maxHeight: 240, overflowY: "auto" }}>
			<Stack spacing={0.5}>
				{users.map(user => (
					<Stack
						key={user.id}
						direction="row"
						spacing={1}
						sx={{ alignItems: "center" }}
					>
						<Switch
							checked={chosen.includes(user.id)}
							inputProps={{ "aria-label": user.displayName }}
							onChange={(_event, checked) =>
								onChange(
									checked ? [...new Set([...chosen, user.id])] : chosen.filter(id => id !== user.id),
								)
							}
						/>
						<Typography>{user.displayName}</Typography>
					</Stack>
				))}
			</Stack>
		</Box>
	);
}
