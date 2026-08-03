import { CATALOG_CHECKSUM_EXCLUDE, canonicalize, checksum } from './canonical';
import { isSupportedContentType } from './content';
import type {
  Catalog,
  CatalogBody,
  CatalogOperation,
  CatalogParameter,
  CatalogResponse,
  CatalogValidationIssue,
} from './types';

const SAFE_PATH_PATTERN = /^\/[^\s?#]*$/;

/**
 * Semantic validation for compiled catalogs, layered on top of JSON Schema
 * validation. These checks enforce fail-closed behavior that a JSON Schema
 * cannot express: unsafe paths, undeclared path parameters, unresolved
 * security schemes, unsupported content types, and checksum integrity.
 */
export function validateCatalog(catalog: Catalog): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];

  for (const [operationId, operation] of Object.entries(catalog.operations)) {
    issues.push(...validateOperationPath(operationId, operation));
    issues.push(...validateContentTypes(operationId, operation));
  }

  issues.push(...validateSecurityReferences(catalog));
  issues.push(...validateChecksum(catalog));

  return issues;
}

function issue(code: string, message: string): CatalogValidationIssue {
  return { code, message };
}

function validateOperationPath(
  operationId: string,
  operation: CatalogOperation,
): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  const { path } = operation;

  if (!path.startsWith('/')) {
    issues.push(
      issue('UNSAFE_PATH', `operation ${operationId}: path must start with "/"`),
    );
  }
  if (!SAFE_PATH_PATTERN.test(path)) {
    issues.push(
      issue(
        'UNSAFE_PATH',
        `operation ${operationId}: path contains whitespace, query fragments, or fragment markers`,
      ),
    );
  }
  if (path.split('/').includes('..')) {
    issues.push(issue('UNSAFE_PATH', `operation ${operationId}: path contains ".."`));
  }

  const templateParams = extractTemplateParams(path);
  if (templateParams === undefined) {
    issues.push(
      issue('UNSAFE_PATH', `operation ${operationId}: unbalanced "{" or "}" in path`),
    );
    return issues;
  }

  const declared = new Set(
    (operation.request?.parameters?.path ?? []).map((parameter) => parameter.name),
  );
  for (const param of templateParams) {
    if (!declared.has(param)) {
      issues.push(
        issue(
          'UNDECLARED_PATH_PARAMETER',
          `operation ${operationId}: path parameter "{${param}}" has no declaration in request.parameters.path`,
        ),
      );
    }
  }
  for (const name of declared) {
    if (!templateParams.includes(name)) {
      issues.push(
        issue(
          'UNUSED_PATH_PARAMETER',
          `operation ${operationId}: path parameter "${name}" is declared but not present in the path`,
        ),
      );
    }
  }

  return issues;
}

function extractTemplateParams(path: string): string[] | undefined {
  const params: string[] = [];
  let depth = 0;
  for (const character of path) {
    if (character === '{') {
      depth += 1;
      if (depth > 1) return undefined;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) return undefined;
    }
  }
  if (depth !== 0) return undefined;
  const matches = path.matchAll(/\{([^{}]+)\}/g);
  for (const match of matches) {
    const name = match[1] ?? '';
    if (name === '') return undefined;
    params.push(name);
  }
  return params;
}

function validateContentTypes(
  operationId: string,
  operation: CatalogOperation,
): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  const body = operation.request?.body;
  if (body !== undefined) {
    issues.push(...validateBody(operationId, body));
  }
  for (const parameter of Object.values(operation.request?.parameters ?? {}).flat()) {
    issues.push(...validateParameter(operationId, parameter));
  }
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    issues.push(...validateResponse(operationId, status, response));
  }
  return issues;
}

function validateBody(
  operationId: string,
  body: CatalogBody,
): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  for (const contentType of body.contentTypes) {
    if (!isSupportedContentType(contentType)) {
      issues.push(
        issue(
          'UNSUPPORTED_CONTENT_TYPE',
          `operation ${operationId}: unsupported request content type "${contentType}"`,
        ),
      );
    }
  }
  return issues;
}

function validateParameter(
  operationId: string,
  parameter: CatalogParameter,
): CatalogValidationIssue[] {
  if (parameter.in === 'path' && !parameter.required) {
    return [
      issue(
        'INVALID_PARAMETER',
        `operation ${operationId}: path parameter "${parameter.name}" must be required`,
      ),
    ];
  }
  return [];
}

function validateResponse(
  operationId: string,
  status: string,
  response: CatalogResponse,
): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  if (!/^\d{3}$/.test(status) && status !== 'default') {
    issues.push(
      issue(
        'INVALID_RESPONSE_STATUS',
        `operation ${operationId}: invalid response status "${status}"`,
      ),
    );
  }
  for (const contentType of response.contentTypes ?? []) {
    if (!isSupportedContentType(contentType)) {
      issues.push(
        issue(
          'UNSUPPORTED_CONTENT_TYPE',
          `operation ${operationId}: unsupported response content type "${contentType}"`,
        ),
      );
    }
  }
  return issues;
}

function validateSecurityReferences(catalog: Catalog): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  for (const [operationId, operation] of Object.entries(catalog.operations)) {
    for (const alternative of operation.security) {
      for (const schemeName of alternative) {
        if (catalog.securitySchemes[schemeName] === undefined) {
          issues.push(
            issue(
              'UNRESOLVED_SECURITY_SCHEME',
              `operation ${operationId}: security scheme "${schemeName}" is not defined in the catalog`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function validateChecksum(catalog: Catalog): CatalogValidationIssue[] {
  if (catalog.checksum === undefined || catalog.checksum === '') return [];
  const expected = checksum(catalog, CATALOG_CHECKSUM_EXCLUDE);
  if (expected !== catalog.checksum) {
    return [
      issue(
        'CHECKSUM_MISMATCH',
        `catalog checksum ${catalog.checksum} does not match content (expected ${expected})`,
      ),
    ];
  }
  return [];
}

export function canonicalCatalog(catalog: Catalog): string {
  return canonicalize(catalog, CATALOG_CHECKSUM_EXCLUDE);
}
