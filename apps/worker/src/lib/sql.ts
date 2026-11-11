// D1 rejects a query with more than 100 bound parameters, so any `inArray` or
// multi-row insert over a caller-supplied list must be fed in chunks below it.
export const SQL_VARS_LIMIT = 100;

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
