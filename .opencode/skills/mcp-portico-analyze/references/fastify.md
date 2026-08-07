# Fastify discovery notes

## Where routes live

- Route registration: `fastify.get/post/put/patch/delete(...)` and route
  option objects `fastify.route({ method, url, handler, schema })`.
- Modular registration: `fastify.register(plugin, { prefix: '/api' })`; route
  files export a plugin function that registers routes.
- Encapsulation: every `register` creates a child context with its own hooks
  and decorators.

## How to trace a route

1. Start at the server bootstrap and list every `fastify.register` in order.
2. Note each plugin's `prefix` and open its route registrations.
3. Combine prefix and route `url` into the full path.
4. Record `schema` options; Fastify natively uses JSON Schema for params,
   querystring, body, and response validation.

## Authentication and permissions

- Auth is usually a hook: `onRequest` or `preHandler`, often added via
  `@fastify/jwt` or a custom auth plugin.
- Hooks can be registered at the root (global), inside a plugin (applies to
  that subtree), or per route (`preHandler: auth` in route options).
- Permission checks are hook-based or inline in handlers
  (`request.user.role`).

## Schemas and validators

- Route-level JSON Schema (`schema: { params, querystring, body, response }`)
  is the most reliable source for request and response shapes.
- Type providers (Zod, TypeBox) produce schemas; follow the schema objects,
  not just the types.

## Multipart fields

- `@fastify/multipart` exposes `request.file()`, `request.files()`, and
  `request.parts()`; field names are read in handler code.
- Check `attachFieldsToBody` config, which changes where fields appear.

## Dynamic-route pitfalls

- Wildcard routes (`/*`) and regex URLs can capture paths unintentionally.
- Encapsulation changes hook scope: a root hook may not run in a nested
  plugin if the plugin adds its own.
- Routes registered inside loops or conditionals are easy to miss; search for
  registrations inside `for` and `if` blocks.

## Ambiguous authorization

- If auth depends on hooks added in a parent or sibling plugin, or on
  decorators mutated at runtime, record `authStatus: "unresolved"` and lower
  the operation confidence.
- List the hook path in `review-report.json` warnings so an operator can
  verify.
