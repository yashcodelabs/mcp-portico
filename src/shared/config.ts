import os from 'node:os';
import path from 'node:path';

import { CONFIG_HOME_DIR, envName } from './brand';

/**
 * Config home directory, e.g. ~/.config/mcp-portico.
 *
 * Resolved at call time so tests and tools can override the environment.
 */
export function mcpPorticoHome(): string {
  const override = process.env[envName('CONFIG_HOME')];
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.config', CONFIG_HOME_DIR);
}

export function mcpPorticoConfigFile(): string {
  return path.join(mcpPorticoHome(), 'config.json');
}

export function mcpPorticoDataDir(): string {
  return path.join(mcpPorticoHome(), 'data');
}

export function mcpPorticoLogDir(): string {
  return path.join(mcpPorticoHome(), 'logs');
}
