# Express discovery notes

## Where routes live

- Route registrations: `app.get(...)`, `app.post(...)`, `app.put(...)`,
  `app.patch(...)`, `app.delete(...)`, `app.all(...)`, and `app.use(...)` for
  mounted routers.
- Routers: `express.Router()` instances, typically in `routes/` or `api/`
  directories, mounted with `app.use('/prefix', router)`.
- Route modules may register handlers inline or import them from
  `controllers/` or `handlers/`.

## How to trace a route

1. Find the app entry file (`app.js`, `server.js`, `src/index.ts`) and list
   every `app.use` mount, in order.
2. For each mounted router, collect its `router.get/post/...` registrations.
3. Follow each handler into `controllers/` or `handlers/`.
4. Note the middleware array between the path and the handler.

## Authentication and permissions

- Auth is middleware: `authenticate`, `requireAuth`, Passport strategies, or
  `app.use(authMiddleware)` applied globally before routers.
- Per-route auth appears as `router.get('/x', auth, handler)`.
- Permissions are role or scope middleware (`requireRole('admin')`,
  `requirePermission('orders:write')`) or inline checks inside handlers.
- Global `app.use` middleware applies to everything registered after it; the
  order of registration is the order of execution.

## Schemas and validators

- Validator middleware: `express-validator` chains, Joi, Zod, or JSON Schema
  validators, applied per route or globally.
- Models: Mongoose, Sequelize, or Prisma schemas describe persistence, not
  necessarily the wire contract.
- Prefer validator middleware and TypeScript DTO types over model files when
  inferring request and response shapes.

## Multipart fields

- `multer` middleware declares fields: `upload.single('file')`,
  `upload.array('files')`, or `upload.fields([{ name: 'avatar' }])`.
- Read field names from the multer calls, not from route comments.

## Dynamic-route pitfalls

- `:param` segments (`/orders/:id`) need explicit parameter schemas.
- `*` and regex routes (`app.get('*', ...)`) and catch-all `app.use`
  handlers can swallow routes; note them as dynamic or uncovered.
- Route order matters: an earlier catch-all can shadow later routes.
- Mounted router prefixes combine with inner paths; record the full path.

## Ambiguous authorization

- When a route's effective middleware chain depends on `app.use` ordering, or
  auth is applied conditionally inside a handler, record `authStatus:
"unresolved"` and lower the operation's confidence instead of guessing.
- Note the reason in `review-report.json` under `auth.unresolved` and
  `coverage.uncoveredRoutes` or `warnings`.
