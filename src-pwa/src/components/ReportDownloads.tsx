/**
 * Download buttons for the monthly work time statement.
 *
 * The API serves the statement as a file (Excel or PDF) and needs the session token for it, so a plain link
 * would not work: the file is fetched with the token and handed to the browser as a blob.
 */

import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import GridOnIcon from "@mui/icons-material/GridOn";
import TableChartIcon from "@mui/icons-material/TableChart";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ErrorAlert } from "./feedback";

/**
 * Hands a blob to the browser as a download.
 *
 * @param blob - content of the file
 * @param fileName - name the browser should use
 */
export function saveBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	link.remove();
	// the blob stays alive until the object URL is released
	URL.revokeObjectURL(url);
}

/**
 * Shows the two download buttons of a month.
 *
 * @param props - month and presentation
 * @param props.year - four digit year
 * @param props.month - month, 1 to 12
 * @param props.userId - employee whose statement is downloaded; omitted for the own account
 * @param props.compact - true for icon buttons (lists), false for labelled buttons
 * @returns buttons and an error message when the export fails
 */
export function ReportDownloads({
	year,
	month,
	userId,
	compact = false,
}: {
	year: number;
	month: number;
	userId?: number;
	compact?: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();
	const [busy, setBusy] = useState<"xls" | "pdf" | "csv" | null>(null);
	const [error, setError] = useState<unknown>(null);

	/**
	 * Downloads one format of the statement.
	 *
	 * @param kind - file format
	 */
	const download = async (kind: "xls" | "pdf" | "csv"): Promise<void> => {
		setBusy(kind);
		setError(null);
		try {
			const file = await api.downloadReport(kind, year, month, userId);
			saveBlob(file.blob, file.fileName);
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(null);
		}
	};

	const label = (kind: "xls" | "pdf" | "csv"): string =>
		t(kind === "xls" ? "report.xls" : kind === "pdf" ? "report.pdf" : "report.csv");

	if (compact) {
		return (
			<>
				<Stack
					direction="row"
					spacing={0.5}
					alignItems="center"
				>
					{busy !== null && <CircularProgress size={16} />}
					<IconButton
						size="small"
						title={label("xls")}
						disabled={busy !== null}
						onClick={() => void download("xls")}
					>
						<GridOnIcon fontSize="small" />
					</IconButton>
					<IconButton
						size="small"
						title={label("pdf")}
						disabled={busy !== null}
						onClick={() => void download("pdf")}
					>
						<PictureAsPdfIcon fontSize="small" />
					</IconButton>
					<IconButton
						size="small"
						title={label("csv")}
						disabled={busy !== null}
						onClick={() => void download("csv")}
					>
						<TableChartIcon fontSize="small" />
					</IconButton>
				</Stack>
				<ErrorAlert error={error} />
			</>
		);
	}

	return (
		<>
			<Stack
				direction="row"
				spacing={1}
				alignItems="center"
			>
				<Button
					size="small"
					variant="outlined"
					startIcon={<GridOnIcon />}
					disabled={busy !== null}
					onClick={() => void download("xls")}
				>
					{label("xls")}
				</Button>
				<Button
					size="small"
					variant="outlined"
					startIcon={<PictureAsPdfIcon />}
					disabled={busy !== null}
					onClick={() => void download("pdf")}
				>
					{label("pdf")}
				</Button>
				<Button
					size="small"
					variant="outlined"
					startIcon={<TableChartIcon />}
					disabled={busy !== null}
					onClick={() => void download("csv")}
				>
					{label("csv")}
				</Button>
				{busy !== null && <CircularProgress size={18} />}
			</Stack>
			<ErrorAlert error={error} />
		</>
	);
}
