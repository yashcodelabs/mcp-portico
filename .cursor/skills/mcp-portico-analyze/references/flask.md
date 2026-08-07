# Flask discovery notes

## Where routes live

- View functions decorated with `@app.route('/path', methods=['GET',
'POST'])` or `@blueprint.route(...)` on `Blueprint` instances.
- Blueprints are registered with `app.register_blueprint(bp,
url_prefix='/api')`; the prefix combines with every route.
- `MethodView` classes map HTTP methods to `get`/`post`/... methods.

## How to trace a route

1. Find the app factory and list every `register_blueprint` call with its
   `url_prefix`.
2. Collect `@app.route` and `@blueprint.route` decorators per module.
3. Combine prefix and decorator path; note the allowed methods.
4. Follow the view function into services and models for behavior.

## Authentication and permissions

- Auth decorators: `@login_required` (Flask-Login), `@jwt_required()`
  (Flask-JWT-Extended), or custom decorators wrapping the view.
- App-wide hooks: `@app.before_request` runs for every request;
  `@blueprint.before_request` runs only for that blueprint's routes.
- Permissions: Flask-Security `@roles_required(...)` and
  `@permissions_required(...)`, custom decorators, or inline checks.

## Schemas and validators

- Marshmallow schemas, `webargs` parsers, WTForms, or Pydantic models define
  request and response shapes.
- Check `request.json`, `request.args`, and `request.form` usage in the view
  to see which fields are actually read.

## Multipart fields

- Files arrive in `request.files` (Werkzeug `FileStorage`); field names are
  the form field names.
- `request.form` holds the non-file fields of a multipart request.

## Dynamic-route pitfalls

- Converters: `<int:item_id>`, `<uuid:...>`, and the catch-all `<path:path>`
  can capture routes you did not expect.
- Decorator stacking order matters: `@login_required` must sit below
  `@app.route`.
- Blueprint prefixes and app-level `before_request` hooks are easy to miss
  when reading a single view.

## Ambiguous authorization

- If a route relies on an app-wide or blueprint-wide hook that you cannot
  fully attribute, or auth is applied conditionally inside the view, record
  `authStatus: "unresolved"` and lower confidence.
- Name the hook and its scope in `review-report.json`.
