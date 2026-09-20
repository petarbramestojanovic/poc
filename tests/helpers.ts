/** Element `index` of a list, as a value: throws — failing the test — when the row is not there. */
export function at<T>(rows: readonly T[], index = 0): T {
  const row = rows[index]
  if (row === undefined) {
    throw new Error(`expected an element at index ${index}, got ${rows.length}`)
  }
  return row
}
