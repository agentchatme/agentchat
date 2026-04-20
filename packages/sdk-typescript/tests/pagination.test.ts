import { describe, it, expect, vi } from 'vitest'
import { paginate } from '../src/pagination.js'

describe('paginate', () => {
  it('yields all items across pages', async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => {
      const all = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }))
      const slice = all.slice(offset, offset + limit)
      return { items: slice, total: all.length, limit, offset }
    })

    const out: number[] = []
    for await (const item of paginate(fetchPage, { pageSize: 3 })) {
      out.push(item.id)
    }
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('stops at `max`', async () => {
    const fetchPage = async (offset: number, limit: number) => ({
      items: Array.from({ length: limit }, (_, i) => ({ id: offset + i + 1 })),
      total: 1_000_000,
      limit,
      offset,
    })
    const out: number[] = []
    for await (const item of paginate(fetchPage, { pageSize: 5, max: 7 })) {
      out.push(item.id)
    }
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('stops on an empty page', async () => {
    const fetchPage = async (offset: number, limit: number) => ({
      items: offset === 0 ? [{ id: 1 }] : [],
      total: 1,
      limit,
      offset,
    })
    const out: number[] = []
    for await (const item of paginate(fetchPage)) {
      out.push(item.id)
    }
    expect(out).toEqual([1])
  })

  it('supports early break', async () => {
    const fetchPage = async (offset: number, limit: number) => ({
      items: Array.from({ length: limit }, (_, i) => ({ id: offset + i })),
      total: 1_000_000,
      limit,
      offset,
    })
    const out: number[] = []
    for await (const item of paginate(fetchPage, { pageSize: 10 })) {
      if (item.id >= 3) break
      out.push(item.id)
    }
    expect(out).toEqual([0, 1, 2])
  })

  it('accepts a custom start offset', async () => {
    const fetchPage = async (offset: number, limit: number) => ({
      items: Array.from({ length: limit }, (_, i) => ({ id: offset + i })),
      total: 20,
      limit,
      offset,
    })
    const out: number[] = []
    for await (const item of paginate(fetchPage, { pageSize: 5, start: 10 })) {
      out.push(item.id)
    }
    expect(out[0]).toBe(10)
    expect(out.at(-1)).toBe(19)
  })
})
