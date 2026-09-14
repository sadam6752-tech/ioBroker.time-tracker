/**
 * Labels of the downloadable reports.
 *
 * The reports are generated in the language of the employee (`users.locale`, falling back to the instance
 * language), because a work time statement is a document for that person, not for the administrator who
 * clicked the export. The set is deliberately small and stable: a report has a fixed layout, so new texts
 * have to be added here (and in every language) instead of being composed at runtime.
 */

/** Labels of a monthly report. */
export interface ReportLabels {
	/** Title of the document */
	title: string;
	/** "Employee" */
	employee: string;
	/** "Period" */
	period: string;
	/** "Created" */
	created: string;
	/** Column "Date" */
	date: string;
	/** Column "In" */
	timeIn: string;
	/** Column "Out" */
	timeOut: string;
	/** Column "Worked" */
	worked: string;
	/** Column "Break" */
	breaks: string;
	/** Column "Target" */
	target: string;
	/** Column "Balance" */
	balance: string;
	/** Column "Absence" */
	absence: string;
	/** Column "Note" */
	note: string;
	/** Marked when the last punch has no counterpart */
	openEntry: string;
	/** Marked when the day is a public holiday */
	holiday: string;
	/** Totals row */
	total: string;
	/** Number of counted days */
	days: string;
	/** Section heading of the absences */
	absences: string;
	/** Column "From" */
	from: string;
	/** Column "To" */
	to: string;
	/** Column "Portion" */
	portion: string;
	/** Portion value for a whole day */
	fullDay: string;
	/** Portion value for a half day */
	halfDay: string;
	/** Signature line of the employee */
	signatureEmployee: string;
	/** Signature line of the manager */
	signatureManager: string;
}

/** All labels in English. */
const EN: ReportLabels = {
	title: "Work time statement",
	employee: "Employee",
	period: "Period",
	created: "Created",
	date: "Date",
	timeIn: "In",
	timeOut: "Out",
	worked: "Worked",
	breaks: "Break",
	target: "Target",
	balance: "Balance",
	absence: "Absence",
	note: "Note",
	openEntry: "open",
	holiday: "holiday",
	total: "Total",
	days: "Days",
	absences: "Absences",
	from: "From",
	to: "To",
	portion: "Portion",
	fullDay: "whole day",
	halfDay: "half day",
	signatureEmployee: "Signature employee",
	signatureManager: "Signature manager",
};

/** All labels in French. */
const FR: ReportLabels = {
	title: "Relevé des heures",
	employee: "Collaborateur",
	period: "Période",
	created: "Créé le",
	date: "Date",
	timeIn: "Début",
	timeOut: "Fin",
	worked: "Travaillé",
	breaks: "Pause",
	target: "Objectif",
	balance: "Solde",
	absence: "Absence",
	note: "Remarque",
	openEntry: "ouvert",
	holiday: "jour férié",
	total: "Total",
	days: "Jours",
	absences: "Absences",
	from: "Du",
	to: "Au",
	portion: "Part",
	fullDay: "journée entière",
	halfDay: "demi-journée",
	signatureEmployee: "Signature du collaborateur",
	signatureManager: "Signature du responsable",
};

/** All labels in Italian. */
const IT: ReportLabels = {
	title: "Estratto ore",
	employee: "Collaboratore",
	period: "Periodo",
	created: "Creato",
	date: "Data",
	timeIn: "Inizio",
	timeOut: "Fine",
	worked: "Lavorato",
	breaks: "Pausa",
	target: "Obiettivo",
	balance: "Saldo",
	absence: "Assenza",
	note: "Nota",
	openEntry: "aperto",
	holiday: "giorno festivo",
	total: "Totale",
	days: "Giorni",
	absences: "Assenze",
	from: "Dal",
	to: "Al",
	portion: "Quota",
	fullDay: "giornata intera",
	halfDay: "mezza giornata",
	signatureEmployee: "Firma collaboratore",
	signatureManager: "Firma responsabile",
};

/** All labels in Spanish. */
const ES: ReportLabels = {
	title: "Registro de horas",
	employee: "Empleado",
	period: "Período",
	created: "Creado",
	date: "Fecha",
	timeIn: "Entrada",
	timeOut: "Salida",
	worked: "Trabajado",
	breaks: "Pausa",
	target: "Objetivo",
	balance: "Saldo",
	absence: "Ausencia",
	note: "Nota",
	openEntry: "abierto",
	holiday: "festivo",
	total: "Total",
	days: "Días",
	absences: "Ausencias",
	from: "Desde",
	to: "Hasta",
	portion: "Parte",
	fullDay: "día completo",
	halfDay: "medio día",
	signatureEmployee: "Firma del empleado",
	signatureManager: "Firma del responsable",
};

/** All labels in Portuguese. */
const PT: ReportLabels = {
	title: "Extrato de horas",
	employee: "Colaborador",
	period: "Período",
	created: "Criado",
	date: "Data",
	timeIn: "Entrada",
	timeOut: "Saída",
	worked: "Trabalhado",
	breaks: "Pausa",
	target: "Meta",
	balance: "Saldo",
	absence: "Ausência",
	note: "Nota",
	openEntry: "aberto",
	holiday: "feriado",
	total: "Total",
	days: "Dias",
	absences: "Ausências",
	from: "De",
	to: "Até",
	portion: "Parte",
	fullDay: "dia inteiro",
	halfDay: "meio dia",
	signatureEmployee: "Assinatura do colaborador",
	signatureManager: "Assinatura do responsável",
};

/** All labels in German. */
const DE: ReportLabels = {
	title: "Stundennachweis",
	employee: "Mitarbeiter",
	period: "Zeitraum",
	created: "Erstellt",
	date: "Datum",
	timeIn: "Von",
	timeOut: "Bis",
	worked: "Arbeitszeit",
	breaks: "Pause",
	target: "Soll",
	balance: "Saldo",
	absence: "Abwesenheit",
	note: "Hinweis",
	openEntry: "offen",
	holiday: "Feiertag",
	total: "Summe",
	days: "Tage",
	absences: "Abwesenheiten",
	from: "Von",
	to: "Bis",
	portion: "Anteil",
	fullDay: "ganzer Tag",
	halfDay: "halber Tag",
	signatureEmployee: "Unterschrift Mitarbeiter",
	signatureManager: "Unterschrift Vorgesetzter",
};

/** All labels in Dutch. */
const NL: ReportLabels = {
	title: "Urenoverzicht",
	employee: "Medewerker",
	period: "Periode",
	created: "Aangemaakt",
	date: "Datum",
	timeIn: "Van",
	timeOut: "Tot",
	worked: "Gewerkt",
	breaks: "Pauze",
	target: "Doel",
	balance: "Saldo",
	absence: "Afwezigheid",
	note: "Opmerking",
	openEntry: "open",
	holiday: "feestdag",
	total: "Totaal",
	days: "Dagen",
	absences: "Afwezigheden",
	from: "Van",
	to: "Tot",
	portion: "Deel",
	fullDay: "hele dag",
	halfDay: "halve dag",
	signatureEmployee: "Handtekening medewerker",
	signatureManager: "Handtekening leidinggevende",
};

/** All labels in Polish. */
const PL: ReportLabels = {
	title: "Ewidencja czasu pracy",
	employee: "Pracownik",
	period: "Okres",
	created: "Utworzono",
	date: "Data",
	timeIn: "Od",
	timeOut: "Do",
	worked: "Przepracowano",
	breaks: "Przerwa",
	target: "Norma",
	balance: "Saldo",
	absence: "Nieobecność",
	note: "Uwaga",
	openEntry: "otwarte",
	holiday: "święto",
	total: "Razem",
	days: "Dni",
	absences: "Nieobecności",
	from: "Od",
	to: "Do",
	portion: "Część",
	fullDay: "cały dzień",
	halfDay: "pół dnia",
	signatureEmployee: "Podpis pracownika",
	signatureManager: "Podpis przełożonego",
};

/** All labels in Russian. */
const RU: ReportLabels = {
	title: "Табель учёта рабочего времени",
	employee: "Сотрудник",
	period: "Период",
	created: "Создано",
	date: "Дата",
	timeIn: "Начало",
	timeOut: "Окончание",
	worked: "Отработано",
	breaks: "Перерыв",
	target: "Норма",
	balance: "Сальдо",
	absence: "Отсутствие",
	note: "Примечание",
	openEntry: "открыто",
	holiday: "праздник",
	total: "Итого",
	days: "Дни",
	absences: "Отсутствия",
	from: "С",
	to: "По",
	portion: "Доля",
	fullDay: "полный день",
	halfDay: "полдня",
	signatureEmployee: "Подпись сотрудника",
	signatureManager: "Подпись руководителя",
};

/** All labels in Ukrainian. */
const UK: ReportLabels = {
	title: "Табель обліку робочого часу",
	employee: "Співробітник",
	period: "Період",
	created: "Створено",
	date: "Дата",
	timeIn: "Початок",
	timeOut: "Закінчення",
	worked: "Відпрацьовано",
	breaks: "Перерва",
	target: "Норма",
	balance: "Сальдо",
	absence: "Відсутність",
	note: "Примітка",
	openEntry: "відкрито",
	holiday: "свято",
	total: "Разом",
	days: "Дні",
	absences: "Відсутності",
	from: "З",
	to: "По",
	portion: "Частка",
	fullDay: "повний день",
	halfDay: "півдня",
	signatureEmployee: "Підпис співробітника",
	signatureManager: "Підпис керівника",
};

/** All labels in Chinese (simplified). */
const ZH_CN: ReportLabels = {
	title: "工时记录表",
	employee: "员工",
	period: "期间",
	created: "创建时间",
	date: "日期",
	timeIn: "上班",
	timeOut: "下班",
	worked: "工作时间",
	breaks: "休息",
	target: "应出勤",
	balance: "差额",
	absence: "缺勤",
	note: "备注",
	openEntry: "未结束",
	holiday: "节假日",
	total: "合计",
	days: "天数",
	absences: "缺勤记录",
	from: "从",
	to: "到",
	portion: "比例",
	fullDay: "全天",
	halfDay: "半天",
	signatureEmployee: "员工签名",
	signatureManager: "主管签名",
};

/** All labels by language key (ioBroker language set). */
export const REPORT_LABELS: Record<string, ReportLabels> = {
	en: EN,
	de: DE,
	ru: RU,
	pt: PT,
	nl: NL,
	fr: FR,
	it: IT,
	es: ES,
	pl: PL,
	uk: UK,
	"zh-cn": ZH_CN,
};

/**
 * Picks the labels of a locale.
 *
 * The locale of a user is a full tag (`de-CH`, `pt-BR`), so the language part is used; an unknown language
 * falls back to English. Reports must never fail because of a missing translation.
 *
 * @param locale - locale of the employee, e.g. `de-CH`
 * @returns labels and the language key they came from
 */
export function reportLabels(locale: string): { labels: ReportLabels; language: string } {
	const normalized = (locale ?? "").trim().toLowerCase().replace(/_/g, "-");
	// Chinese is the only language with a region in the ioBroker set
	const language = normalized.startsWith("zh") ? "zh-cn" : normalized.split("-")[0];
	const labels = REPORT_LABELS[language] ?? EN;
	return { labels, language: REPORT_LABELS[language] ? language : "en" };
}
