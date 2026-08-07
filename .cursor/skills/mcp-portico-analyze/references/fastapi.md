# FastAPI discovery notes

## Where routes live

- Route decorators: `@app.get/post/put/patch/delete(...)` on the app, or
  `@router.get(...)` on `APIRouter` instances.
- Routers are included with `app.include_router(router, prefix='/api',
tags=[...])`; the prefix combines with every route path.
- Files typically live in `app/routes/`, `app/api/`, or `main.py`.

## How to trace a route

1. Find the app factory (`create_app`, `main.py`) and list every
   `include_router` call, noting each prefix.
2. Collect `@router` and `@app` decorators per file.
3. Combine router prefix and decorator path; note the HTTP method.
4. Read the handler signature: path, query, and body parameters plus
   dependencies reveal the input contract.

## Authentication and permissions

- Auth is dependency-based: `Depends(get_current_user)`,
  `Depends(HTTPBearer())`, or `OAuth2PasswordBearer`.
- Dependencies can be declared on a route, on an `APIRouter`
  (`router = APIRouter(dependencies=[...])`), or globally on the app.
- Permissions are custom dependencies such as `require_role('admin')` or
  checks inside the handler after the current user is loaded.

## Schemas and validators

- Pydantic models (`BaseModel`) define request and response bodies; use them
  as the schema source.
- Typed parameters (`item_id: int`, `q: str | None`) define path and query
  parameters; `Body`, `Query`, `Path`, and `Form` functions add metadata.

## Multipart fields

- `UploadFile` and `File(...)` parameters declare file fields; `Form(...)`
  declares text fields in the same multipart request.
- Field names are the parameter names unless `File(alias=...)` is used.

## Dynamic-route pitfalls

- Path parameters use `{item_id}`; FastAPI converts them via type
  annotations.
- Path converters such as `{path:path}` can swallow routes.
- Routes registered in loops or conditionals (common with dynamic routers)
  are easy to miss; search decorator calls inside loops.
- Dependency overrides in tests (`app.dependency_overrides`) do not reflect
  production behavior.

## Ambiguous authorization

- When a router has no explicit dependencies but a parent app or included
  router adds them, or a dependency conditionally applies, record
  `authStatus: "unresolved"` and lower confidence.
- List the dependency chain in `review-report.json`.
