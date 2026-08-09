import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageManifest = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8'),
) as { version?: unknown };

if (
  typeof packageManifest.version !== 'string' ||
  packageManifest.version.length === 0
) {
  throw new Error('package.json must define a non-empty version');
}

/**
 * MCP Portico product identity.
 *
 * These constants are the single source of truth for the user-facing product
 * name, package identifier, environment prefix, client headers, and config
 * home.
 */

export const PRODUCT_NAME = 'MCP Portico';
export const PACKAGE_NAME = 'mcp-portico';
export const BIN_NAME = 'mcp-portico';
export const SERVER_NAME = 'mcp-portico';
export const PRODUCT_VERSION = packageManifest.version;

/** Environment variable prefix, e.g. MCP_PORTICO_BASE_URL. */
export const ENV_PREFIX = 'MCP_PORTICO_';

/** Client-facing header prefix, e.g. x-mcp-portico-tenant. */
export const HEADER_PREFIX = 'x-mcp-portico-';

/** User config home directory name, e.g. ~/.config/mcp-portico. */
export const CONFIG_HOME_DIR = 'mcp-portico';

/** Scratch directory for agent-generated payload files. */
export const SCRATCH_DIR = 'mcp-portico';

export function envName(name: string): string {
  return `${ENV_PREFIX}${name}`;
}

export function headerName(name: string): string {
  return `${HEADER_PREFIX}${name}`;
}
