# NestJS discovery notes

## Where routes live

- Controllers: classes decorated with `@Controller('prefix')`; methods carry
  `@Get(':id')`, `@Post()`, and similar decorators, usually in
  `src/**/controllers/` or alongside modules.
- Modules (`@Module({ controllers, providers })`) declare which controllers
  are active; a controller not listed in a module is not routed.
- A global prefix (`app.setGlobalPrefix('api')`) applies to every controller
  route.

## How to trace a route

1. Read the root module (`AppModule`) and follow imported feature modules.
2. For each module, collect its controllers and their decorator paths.
3. Combine global prefix, controller prefix, and method path.
4. Follow handler dependencies to services for behavior.

## Authentication and permissions

- Guards: `@UseGuards(AuthGuard)` at the method or controller level; global
  guards registered with `APP_GUARD` apply to every route.
- Passport strategies (`@nestjs/passport`) and JWT guards implement auth.
- Permissions use custom guards plus metadata decorators such as `@Roles(...)`
  read through `Reflector`.
- Guard evaluation order: global guards first, then controller, then method.

## Schemas and validators

- DTOs in `dto/` folders with `class-validator` decorators (`@IsString()`,
  `@IsInt()`) and `class-transformer` serialization.
- `ValidationPipe` enforces DTOs globally or per controller or method.
- `@nestjs/swagger` decorators enrich DTOs with API metadata.

## Multipart fields

- `FileInterceptor('fieldName')` / `FilesInterceptor('fieldName')` declare
  upload fields; the field name is the interceptor argument.
- `@UploadedFile()` / `@UploadedFiles()` receive the parsed files.

## Dynamic-route pitfalls

- `@Param('id')` values arrive as strings; note conversion requirements.
- Method-level `@Get(':id')` combined with controller `@Controller('orders')`
  yields `/orders/:id`; check both decorators.
- Wildcards in route paths and dynamic module imports can hide routes.
- Guards inherited from a base class or a global `APP_GUARD` are easy to
  miss.

## Ambiguous authorization

- If the effective guard is unclear (global vs controller vs method, or
  guards read from metadata you cannot resolve), record `authStatus:
"unresolved"` and lower confidence.
- Note the guard chain and any `@Roles` metadata in `review-report.json`.
