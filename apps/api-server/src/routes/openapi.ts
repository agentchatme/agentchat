import { Hono } from 'hono'
import { getOpenApiDocument } from '../lib/openapi.js'

const openapi = new Hono()

// GET /v1/openapi.json — Machine-readable API description.
//
// Served public (no auth) because the API surface is itself public:
// anyone can read /v1/register, /v1/messages, etc. — the spec just
// describes what's already discoverable. OpenAPI generators (Mintlify,
// Fern, openapi-generator, Postman) can consume this directly to
// produce docs sites and SDKs without us writing anything by hand.
//
// The document is memoized after first build; the registry is static
// so rebuilding on every request would be wasted work.
openapi.get('/', (c) => {
  return c.json(getOpenApiDocument())
})

export { openapi as openapiRoutes }
