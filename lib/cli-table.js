// Plain-text table for CLI list output: a header, a dashed divider, then one
// padded row per record. Each column is { key, label, max }; cells wider than
// max are cut with an ellipsis, and empty values print as '-'.

function tableValue(row, key) {
  const value = row?.[key];
  if (value == null || value === '') return '-';
  return String(value).replace(/\s+/g, ' ');
}

function fitTableCell(value, width) {
  const text = String(value);
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function formatTable(columns, rows) {
  const values = rows.map((row) => columns.map((column) => tableValue(row, column.key)));
  const widths = columns.map((column, index) => Math.min(
    column.max,
    Math.max(column.label.length, ...values.map((row) => row[index].length)),
  ));
  const header = columns.map((column, index) => fitTableCell(column.label, widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = values.map((row) => row.map((value, index) => fitTableCell(value, widths[index])).join('  '));
  return [header, divider, ...body].map((line) => line.trimEnd()).join('\n');
}
