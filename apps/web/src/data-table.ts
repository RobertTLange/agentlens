export interface DataTableRow {
  field: string;
  value: string;
}

export function dataTableRows(value: unknown, field = "$"): DataTableRow[] {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length) return entries.flatMap(([key, child]) => dataTableRows(child, Array.isArray(value) ? `${field}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${field}.${key}` : `${field}[${JSON.stringify(key)}]`));
  }
  return [{ field, value: typeof value === "string" ? value : JSON.stringify(value) ?? String(value) }];
}
