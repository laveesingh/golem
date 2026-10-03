export function issueKeys(report) {
  return report.issues
    .flatMap((issue) =>
      Object.entries(issue).flatMap(([kind, items]) =>
        kind !== 'file' && Array.isArray(items)
          ? items.map((item) =>
              [issue.file, kind, item.namespace ?? '', item.name].join('|'),
            )
          : [],
      ),
    )
    .sort();
}
export function addedDebt(current, baseline) {
  const allowed = new Map();
  for (const key of baseline) allowed.set(key, (allowed.get(key) ?? 0) + 1);
  return current.filter((key) => {
    const count = allowed.get(key) ?? 0;
    if (!count) return true;
    allowed.set(key, count - 1);
    return false;
  });
}
