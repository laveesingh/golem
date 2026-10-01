// JSON-schema contract fixture comparison. No current-PR self-baseline.
export function contractRemovals(before, after, location = '$') {
  const removed = [];
  if (!before || typeof before !== 'object') return removed;
  if (!after || typeof after !== 'object') return [location];
  for (const key of Object.keys(before.properties ?? {})) {
    if (!(key in (after.properties ?? {})))
      removed.push(`${location}.properties.${key}`);
    else
      removed.push(
        ...contractRemovals(
          before.properties[key],
          after.properties[key],
          `${location}.properties.${key}`,
        ),
      );
  }
  for (const key of Object.keys(before.paths ?? {})) {
    if (!(key in (after.paths ?? {}))) removed.push(`${location}.paths.${key}`);
    else
      for (const method of Object.keys(before.paths[key]))
        if (!(method in after.paths[key]))
          removed.push(`${location}.paths.${key}.${method}`);
  }
  if (Array.isArray(before.enum))
    for (const value of before.enum)
      if (!(after.enum ?? []).includes(value))
        removed.push(`${location}.enum:${JSON.stringify(value)}`);
  if (
    before.type !== undefined &&
    JSON.stringify(before.type) !== JSON.stringify(after.type)
  )
    removed.push(`${location}.type`);
  return removed;
}
