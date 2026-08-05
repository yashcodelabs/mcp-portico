import type {
  Catalog,
  CatalogOperation,
  ConfirmationPolicy,
  SecurityScheme,
} from '../catalog/types';
import { assertStaticHeadersSafe } from '../security/headers';
import { assertConnectionBaseUrlAllowed } from '../security/network';
import type {
  Backend,
  Connection,
  ConnectionPolicy,
  PrincipalRecord,
  RegistryDocument,
} from './types';

/**
 * Semantic registry validation, layered on top of JSON Schema validation.
 *
 * These checks enforce the multi-tenant authorization invariants: unique
 * IDs, complete referential integrity, backend scope and ownership,
 * checksum-pinned catalogs, monotonic connection policy, auth/catalog
 * compatibility, and safe destinations.
 */

export interface RegistryValidationIssue {
  code: string;
  message: string;
}

export interface RegistryValidationContext {
  /** Resolve a backend's catalogRef to a validated catalog; throws on failure. */
  loadCatalog(catalogRef: string): Catalog;
}

const CONFIRMATION_LEVELS: ConfirmationPolicy[] = [
  'never',
  'write',
  'destructive',
  'always',
];
const CONFIRMATION_SEVERITY: Record<ConfirmationPolicy, number> = Object.fromEntries(
  CONFIRMATION_LEVELS.map((level, index) => [level, index]),
) as Record<ConfirmationPolicy, number>;

function issue(code: string, message: string): RegistryValidationIssue {
  return { code, message };
}

export function validateRegistryDocument(
  document: RegistryDocument,
  context: RegistryValidationContext,
): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  const tenants = new Map(document.tenants.map((tenant) => [tenant.id, tenant]));
  const principals = new Map(
    document.principals.map((principal) => [principal.id, principal]),
  );
  const backends = new Map(document.backends.map((backend) => [backend.id, backend]));
  const connections = new Map(
    document.connections.map((connection) => [connection.id, connection]),
  );

  issues.push(...checkDuplicateIds(document));

  for (const principal of document.principals) {
    if (!tenants.has(principal.tenantId)) {
      issues.push(
        issue(
          'UNKNOWN_TENANT',
          `principal "${principal.id}" references unknown tenant "${principal.tenantId}"`,
        ),
      );
    }
    for (const connectionId of principal.allowedConnectionIds) {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        issues.push(
          issue(
            'UNKNOWN_CONNECTION',
            `principal "${principal.id}" allowlist references unknown connection "${connectionId}"`,
          ),
        );
      } else if (connection.tenantId !== principal.tenantId) {
        issues.push(
          issue(
            'CROSS_TENANT_ALLOWLIST',
            `principal "${principal.id}" of tenant "${principal.tenantId}" allowlists connection "${connectionId}" owned by tenant "${connection.tenantId}"`,
          ),
        );
      }
    }
  }

  for (const backend of document.backends) {
    issues.push(...validateBackendScope(backend, tenants));
    if (backend.ownerTenantId !== undefined && !tenants.has(backend.ownerTenantId)) {
      issues.push(
        issue(
          'UNKNOWN_OWNER',
          `backend "${backend.id}" references unknown owner tenant "${backend.ownerTenantId}"`,
        ),
      );
    }
    try {
      const catalog = context.loadCatalog(backend.catalogRef);
      if (catalog.checksum !== backend.catalogChecksum) {
        issues.push(
          issue(
            'CATALOG_CHECKSUM_MISMATCH',
            `backend "${backend.id}" pins checksum ${backend.catalogChecksum} but catalog "${backend.catalogRef}" has checksum ${catalog.checksum}`,
          ),
        );
      }
      for (const connection of document.connections) {
        if (connection.backendId === backend.id) {
          issues.push(...validateConnectionPolicy(connection, catalog));
          issues.push(...validateAuthCompatibility(connection, catalog));
        }
      }
    } catch (error) {
      issues.push(
        issue(
          'CATALOG_LOAD_FAILED',
          `backend "${backend.id}" catalog "${backend.catalogRef}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  for (const connection of document.connections) {
    if (!tenants.has(connection.tenantId)) {
      issues.push(
        issue(
          'UNKNOWN_TENANT',
          `connection "${connection.id}" references unknown tenant "${connection.tenantId}"`,
        ),
      );
    }
    const backend = backends.get(connection.backendId);
    if (backend === undefined) {
      issues.push(
        issue(
          'UNKNOWN_BACKEND',
          `connection "${connection.id}" references unknown backend "${connection.backendId}"`,
        ),
      );
    } else if (
      backend.scope === 'tenant' &&
      backend.ownerTenantId !== connection.tenantId
    ) {
      issues.push(
        issue(
          'CROSS_TENANT_BACKEND',
          `connection "${connection.id}" of tenant "${connection.tenantId}" references tenant-scoped backend "${connection.backendId}" owned by tenant "${backend.ownerTenantId ?? '?'}"`,
        ),
      );
    }
    issues.push(...validateStaticHeaders(connection));
    issues.push(...validateDestination(connection, context));
  }

  return issues;
}

function checkDuplicateIds(document: RegistryDocument): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  const namespaces: Array<[string, string[]]> = [
    ['tenant', document.tenants.map((tenant) => tenant.id)],
    ['principal', document.principals.map((principal) => principal.id)],
    ['backend', document.backends.map((backend) => backend.id)],
    ['connection', document.connections.map((connection) => connection.id)],
  ];
  for (const [label, ids] of namespaces) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        issues.push(issue('DUPLICATE_ID', `duplicate ${label} id "${id}"`));
      }
      seen.add(id);
    }
  }
  return issues;
}

function validateBackendScope(
  backend: Backend,
  tenants: Map<string, unknown>,
): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  if (backend.scope === 'global' && backend.ownerTenantId !== undefined) {
    issues.push(
      issue(
        'GLOBAL_BACKEND_WITH_OWNER',
        `global backend "${backend.id}" must not set ownerTenantId`,
      ),
    );
  }
  if (backend.scope === 'tenant') {
    if (backend.ownerTenantId === undefined) {
      issues.push(
        issue(
          'TENANT_BACKEND_WITHOUT_OWNER',
          `tenant-scoped backend "${backend.id}" requires ownerTenantId`,
        ),
      );
    } else if (!tenants.has(backend.ownerTenantId)) {
      issues.push(
        issue(
          'UNKNOWN_OWNER',
          `tenant-scoped backend "${backend.id}" references unknown owner tenant "${backend.ownerTenantId}"`,
        ),
      );
    }
  }
  return issues;
}

function validateStaticHeaders(connection: Connection): RegistryValidationIssue[] {
  return assertStaticHeadersSafe(connection.staticHeaders).map((message) =>
    issue('UNSAFE_STATIC_HEADER', `connection "${connection.id}": ${message}`),
  );
}

function validateDestination(
  connection: Connection,
  context: RegistryValidationContext,
): RegistryValidationIssue[] {
  try {
    assertConnectionBaseUrlAllowed(connection.baseUrl, connection.network ?? {}, {
      context: 'load',
    });
    return [];
  } catch (error) {
    return [
      issue(
        'UNSAFE_DESTINATION',
        `connection "${connection.id}": ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }
}

function validateConnectionPolicy(
  connection: Connection,
  catalog: Catalog,
): RegistryValidationIssue[] {
  const policy = connection.policy;
  if (policy === undefined) return [];
  const issues: RegistryValidationIssue[] = [];
  const operations = Object.values(catalog.operations);

  for (const operationId of policy.disabledOperations ?? []) {
    if (catalog.operations[operationId] === undefined) {
      issues.push(
        issue(
          'UNKNOWN_OPERATION',
          `connection "${connection.id}" disables unknown operation "${operationId}"; connection policy cannot add operations`,
        ),
      );
    }
  }

  if (policy.confirmation !== undefined && operations.length > 0) {
    const strictest = Math.max(
      ...operations.map((operation) => CONFIRMATION_SEVERITY[operation.confirmation]),
    );
    if (CONFIRMATION_SEVERITY[policy.confirmation] < strictest) {
      issues.push(
        issue(
          'NON_MONOTONIC_POLICY',
          `connection "${connection.id}" confirmation "${policy.confirmation}" is weaker than the catalog's strictest requirement ("${CONFIRMATION_LEVELS[strictest] ?? '?'}"); connection policy cannot relax confirmation`,
        ),
      );
    }
  }

  type NumericLimitField =
    'timeoutMs' | 'maxRequestBytes' | 'maxResponseBytes' | 'maxConcurrency';
  const limitFields: Array<[NumericLimitField, NumericLimitField]> = [
    ['timeoutMs', 'timeoutMs'],
    ['maxRequestBytes', 'maxRequestBytes'],
    ['maxResponseBytes', 'maxResponseBytes'],
    ['maxConcurrency', 'maxConcurrency'],
  ];
  for (const [policyField, catalogField] of limitFields) {
    const policyValue = policy[policyField];
    if (policyValue === undefined || operations.length === 0) continue;
    const catalogMinimum = Math.min(
      ...operations.map((operation) =>
        typeof operation[catalogField] === 'number'
          ? (operation[catalogField] as number)
          : Infinity,
      ),
    );
    if (policyValue > catalogMinimum) {
      issues.push(
        issue(
          'NON_MONOTONIC_POLICY',
          `connection "${connection.id}" ${String(policyField)} ${policyValue} exceeds the strictest catalog limit (${catalogMinimum}); connection policy cannot raise catalog limits`,
        ),
      );
    }
  }

  if (policy.allowedContentTypes !== undefined && operations.length > 0) {
    const knownContentTypes = new Set<string>();
    for (const operation of operations) {
      for (const contentType of operation.request?.body?.contentTypes ?? []) {
        knownContentTypes.add(contentType);
      }
      for (const response of Object.values(operation.responses ?? {})) {
        for (const contentType of response.contentTypes ?? []) {
          knownContentTypes.add(contentType);
        }
      }
    }
    for (const contentType of policy.allowedContentTypes) {
      if (!knownContentTypes.has(contentType)) {
        issues.push(
          issue(
            'NON_MONOTONIC_POLICY',
            `connection "${connection.id}" allowedContentTypes "${contentType}" does not exist in the catalog; connection policy cannot introduce new content types`,
          ),
        );
      }
    }
  }

  return issues;
}

function validateAuthCompatibility(
  connection: Connection,
  catalog: Catalog,
): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  for (const [operationId, operation] of Object.entries(catalog.operations)) {
    if (!operation.available) continue;
    if (operation.security.length === 0) continue;
    const satisfiable = operation.security.some((alternative) =>
      alternative.every((schemeName) => {
        const scheme = catalog.securitySchemes[schemeName];
        return scheme !== undefined && connectionSatisfiesScheme(connection, scheme);
      }),
    );
    if (!satisfiable) {
      issues.push(
        issue(
          'AUTH_INCOMPATIBLE',
          `connection "${connection.id}" auth type "${connection.auth.type}" cannot satisfy the security requirements of available operation "${operationId}"`,
        ),
      );
    }
  }
  return issues;
}

function connectionSatisfiesScheme(
  connection: Connection,
  scheme: SecurityScheme,
): boolean {
  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'bearer') return connection.auth.type === 'bearer';
      if (scheme.scheme === 'basic') return connection.auth.type === 'basic';
      return false;
    case 'apiKey':
      return connection.auth.type === 'apiKey';
    case 'oauth2':
    case 'openIdConnect':
    case 'mutualTLS':
      return false;
  }
}

export function formatRegistryIssues(issues: RegistryValidationIssue[]): string {
  return issues.map((item) => `${item.code}: ${item.message}`).join('\n');
}
