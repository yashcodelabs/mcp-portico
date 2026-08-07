# Spring Boot discovery notes

## Where routes live

- Controllers: `@RestController` / `@Controller` classes in
  `src/main/java/**/controller/` (or `web/`).
- Mappings: `@RequestMapping` on the class combines with `@GetMapping`,
  `@PostMapping`, and similar annotations on methods; `@PathVariable` binds
  path segments.
- Only beans in the component scan are active; check profiles and
  `@ConditionalOn*` annotations.

## How to trace a route

1. Find the application class and note the `@SpringBootApplication` scan
   scope.
2. Collect `@RestController` classes and combine class and method mappings.
3. Follow handler methods to services for behavior and response types.
4. Check `@RestControllerAdvice` and `@ExceptionHandler` for global response
   and error shapes.

## Authentication and permissions

- Security lives in configuration, not controllers: `SecurityFilterChain`
  beans with `authorizeHttpRequests(...)` matchers, JWT or OAuth2 filters,
  and `@EnableMethodSecurity`.
- Method security: `@PreAuthorize("hasRole('ADMIN')")`, `@Secured(...)`, and
  `@RolesAllowed(...)` on controller methods or classes.
- The effective auth for a route is the filter chain that matches its path,
  possibly combined with method-level annotations.

## Schemas and validators

- DTOs: records or classes with `jakarta.validation` annotations
  (`@NotNull`, `@Size`) validated via `@Valid` on `@RequestBody` and
  `@RequestPart`.
- OpenAPI metadata often lives in springdoc annotations on DTOs and
  controllers.

## Multipart fields

- `MultipartFile` parameters and `@RequestPart` declare file fields;
  `@RequestParam` declares text fields.
- Global limits live in `spring.servlet.multipart.*` configuration.

## Dynamic-route pitfalls

- Path variables `{id}` are strings; note conversion and validation.
- Security matcher order matters: the first matching rule wins, so a broad
  `/**` rule can override specific ones.
- Profiles can swap security or controller beans; record the analyzed
  profile in `review-report.json`.
- `@RequestMapping` class and method prefixes combine; check both.

## Ambiguous authorization

- If the filter chain ordering or method-security metadata makes the
  effective rule unclear, record `authStatus: "unresolved"` and lower
  confidence; the security configuration is the source of truth, not the
  controller.
- Describe the relevant matchers and annotations in `review-report.json`.
