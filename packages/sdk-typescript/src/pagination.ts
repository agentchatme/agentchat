/**
 * Async iterator that pages through a limit/offset-style endpoint. The
 * `fetchPage(offset, limit)` callback returns the items on that page and
 * the total count; the iterator yields each item and advances the offset
 * until `offset + items.length >= total`. Safe to `break` early.
 *
 * @example
 *   for await (const contact of paginate((off, lim) => client.listContacts({ offset: off, limit: lim }), { pageSize: 100 })) {
 *     console.log(contact.handle)
 *   }
 */
export async function* paginate<T>(
  fetchPage: (offset: number, limit: number) => Promise<{
    items: T[]
    total: number
    limit: number
    offset: number
  }>,
  options?: { pageSize?: number; start?: number; max?: number },
): AsyncGenerator<T, void, void> {
  const pageSize = options?.pageSize ?? 100
  const max = options?.max ?? Number.POSITIVE_INFINITY
  let offset = options?.start ?? 0
  let yielded = 0

  while (yielded < max) {
    const page = await fetchPage(offset, pageSize)
    if (page.items.length === 0) return
    for (const item of page.items) {
      if (yielded >= max) return
      yield item
      yielded++
    }
    offset += page.items.length
    if (offset >= page.total) return
    // Defensive: some servers return `limit` different from what we asked
    // (e.g. capped). Using the actual returned count prevents an infinite
    // loop if the server returns zero items but a non-zero total.
    if (page.items.length === 0) return
  }
}
