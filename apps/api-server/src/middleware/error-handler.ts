import type { ErrorHandler } from 'hono'

export const errorHandler: ErrorHandler = (err, c) => {
  console.error('Unhandled error:', err)
  return c.json(
    {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
    500,
  )
}
