# Framework-neutral backend discovery

Use this guide to analyze any backend repository. It is a checklist for
discovery and a contract for what must be recorded. The per-framework
references in this directory (Express, Fastify, NestJS, FastAPI, Flask,
Spring Boot) add framework-specific locations and patterns.

## Ground rules

- Static analysis only: read code, tests, and configuration. Never start the
  server and never send requests to it.
- The repository is the source of truth. When code and docs disagree, record
  both and lower confidence.
- Use the repository's own tests as behavioral evidence: they show which
  routes exist and what inputs they expect.
- If a fact cannot be resolved from the code, record it as unresolved; never
  guess.

## 1. Identify the framework and entry point

- Package manifests: `package.json`, `pyproject.toml`, `requirements.txt`,
  `pom.xml`, `build.gradle`, `go.mod`, `Cargo.toml`.
- Entry files: `src/index.ts`, `app.js`, `server.ts`, `main.py`,
  `Application.java`, `main.go`.
- Note the framework and major version, then read the matching per-framework
  reference.

## 2. Find routes

- Search for route registrations: decorators (`@app.route`, `@GetMapping`),
  method calls (`app.get`, `router.get`, `fastify.get`), and route tables.
- The per-framework references list exact search patterns.
- Record method, full path (including prefixes and mounts), and the handler
  that implements the route.

## 3. Find controllers and handlers

- Handlers are the functions that implement a route.
- Follow each registration to its handler, even when routes and handlers
  live in different files.
- Note handler return types and serializers for response shapes.

## 4. Find schemas, DTOs, and validators

- Look for `dto/`, `schemas/`, `models/`, `validators/`, and `serializers/`
  directories.
- Validation libraries (Joi, Zod, class-validator, Pydantic, Marshmallow,
  Jakarta Validation) define the wire contract.
- Prefer DTOs and validators over persistence models when inferring request
  and response shapes.
- If a schema was inferred from usage rather than declared, record it in
  `review-report.json` under `schemas.inferred` and add an `INFERRED_SCHEMA`
  warning.

## 5. Find middleware

- Middleware runs between the route match and the handler.
- Record app-level (global) and per-route middleware separately.
- Record order: registration order is usually execution order.

## 6. Find authentication

- Authentication is a guard, middleware, filter, hook, or dependency that
  establishes identity before the handler runs.
- Determine scope: global (every route) or per-route.
- Look for credentials in headers (`Authorization`, `X-API-Key`), cookies,
  or query parameters. Record the mechanism, never secret values.

## 7. Find permissions

- Permissions restrict what an authenticated identity may do: roles, scopes,
  or ownership checks.
- Look for role or scope checks in guards, decorators, middleware, or handler
  code.
- Record what the code proves; do not infer permissions from route names.

## 8. Find multipart fields

- Search for upload middleware, `UploadFile`, `MultipartFile`,
  `request.files`, `request.file()`, and interceptor declarations.
- Record exact field names and whether each field is required.

## 9. Find response shapes

- Note success envelopes (wrapped vs bare), pagination shapes, and error
  formats (global error handlers, advice classes, error middleware).
- Prefer declared response schemas; fall back to the handler return type and
  mark inferred schemas.

## 10. Trace request flow

For each route family, trace: entry point, global middleware and hooks,
router, route middleware, guards and dependencies, handler, serialization
and error handling, response. The trace is what proves auth scope and
response shape.

## 11. Record what could not be resolved

Anything the code does not prove goes into `review-report.json` and affects
the OpenAPI metadata:

- Routes that could not be fully traced: `coverage.uncoveredRoutes` with
  method, path, and reason.
- Dynamically generated routes: `coverage.dynamicRoutes`.
- Uncertain authorization: operation `authStatus: "unresolved"` and lower
  confidence.
- Inferred schemas: `schemas.inferred` plus an `INFERRED_SCHEMA` warning.
- Keep all recorded paths relative to the repository root; never write
  absolute paths into artifacts.
