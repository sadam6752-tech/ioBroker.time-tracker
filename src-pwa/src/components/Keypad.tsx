/**
 * Numeric keypad for the kiosk terminal and the presence screen.
 *
 * Both screens stand in workshops and on shop floors where there is no keyboard at all — and the on-screen
 * keyboard of the operating system does not show up in kiosk mode. The pad is therefore part of the app: it hands
 * single digits and the backspace to the caller, which keeps the value in its own state.
 *
 * The buttons refuse the focus (`onMouseDown` is prevented), so the numeric keyboard of a tablet does not open on
 * top of the pad.
 */

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import BackspaceOutlinedIcon from "@mui/icons-material/BackspaceOutlined";
import { useTranslation } from "react-i18next";

/** Cells of the pad in reading order; the empty entry keeps the zero under the second column. */
const CELLS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"];

/**
 * Shows the keypad.
 *
 * @param props - where the input goes
 * @param props.onDigit - called with the pressed digit
 * @param props.onBackspace - called when the last digit has to be removed
 * @param props.disabled - true while the caller is busy
 * @returns the keypad
 */
export function Keypad({
	onDigit,
	onBackspace,
	disabled = false,
}: {
	onDigit: (digit: string) => void;
	onBackspace: () => void;
	disabled?: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();

	/**
	 * Keeps the button from taking the focus.
	 *
	 * @param event - mouse event of the press
	 */
	const keepFocus = (event: React.MouseEvent): void => event.preventDefault();

	return (
		<Box
			sx={{
				display: "grid",
				gridTemplateColumns: "repeat(3, 1fr)",
				gap: 1,
				width: "100%",
				maxWidth: 260,
			}}
		>
			{CELLS.map(digit =>
				digit === "" ? (
					<Box key="blank" />
				) : (
					<Button
						key={digit}
						variant="outlined"
						size="large"
						disabled={disabled}
						aria-label={digit}
						onMouseDown={keepFocus}
						onClick={() => onDigit(digit)}
						sx={{ minHeight: 56, fontSize: "1.4rem" }}
					>
						{digit}
					</Button>
				),
			)}
			<Button
				variant="outlined"
				size="large"
				disabled={disabled}
				aria-label={t("keypad.backspace")}
				onMouseDown={keepFocus}
				onClick={onBackspace}
				sx={{ minHeight: 56 }}
			>
				<BackspaceOutlinedIcon />
			</Button>
		</Box>
	);
}
