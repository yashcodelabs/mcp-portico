#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_AUTH_MODE, parseAuthMode } from '../auth/binding';
import {
  assertSecretsResolvable,
  collectConnectionSecretRefs,
  defaultSecretResolver,
} from '../auth/secrets';
import { diffCatalogs, formatDiff } from '../catalog/diff';
import { loadCatalog } from '../catalog/load';
import { loadOverlay } from '../catalog/overlay';
import { generatePorticoKey } from '../identity/keys';
import { importOpenApi } from '../importers/openapi/import';
import type { RemoteRefPolicy } from '../importers/openapi/types';
import { envName, PACKAGE_NAME, PRODUCT_NAME, PRODUCT_VERSION } from '../shared/brand';
import { EXIT_CODES, formatCliError, PorticoError, toExitCode } from '../shared/errors';
import { loadRegistryFile, writeRegistryFile } from '../registry/load';
import { buildRegistrySnapshot } from '../registry/snapshot';
import { executeProbe } from '../security/probe';
import { startServer } from './serve';
import { formatUsageSummary } from '../telemetry/format';
import { loadAuditEvents } from '../telemetry/load';
import { summarizeAudit } from '../telemetry/summary';

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError(
      `expected an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

function envOrDefault(name: string, fallback: string): string {
  return process.env[envName(name)] ?? fallback;
}

async function runServe(
  host: string,
  port: number,
  authModeValue: string | undefined,
  registryPath: string | undefined,
): Promise<void> {
  const authMode = parseAuthMode(authModeValue);
  const running = await startServer({ host, port, authMode, registryPath });
  console.log(
    `${PRODUCT_NAME} listening on http://${host}:${running.port} (auth mode: ${authMode})`,
  );
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void running.close().then(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function handleError(error: unknown): void {
  if (error instanceof PorticoError) {
    const details = error.details as
      | { issues?: Array<{ code?: string; instancePath?: string; message: string }> }
      | undefined;
    const issues = details?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      console.error(`error: ${error.code}: ${error.message}`);
      for (const item of issues) {
        const code = item.code ?? item.instancePath ?? 'SCHEMA';
        console.error(`  ${code}: ${item.message}`);
      }
    } else {
      console.error(formatCliError(error));
    }
  } else {
    console.error(formatCliError(error));
  }
  process.exitCode = toExitCode(error);
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function writeFileAtomic(target: string, content: string): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; report the original error.
    }
    throw error;
  }
}

const program = new Command();

program
  .name(PACKAGE_NAME)
  .description(`${PRODUCT_NAME} - a generic, multi-tenant MCP frontend for HTTP APIs`)
  .version(PRODUCT_VERSION);

program
  .command('serve')
  .description('Start the MCP Portico HTTP server (Phase 1: health endpoint only)')
  .option(
    '--host <host>',
    'interface to bind (default 127.0.0.1)',
    envOrDefault('HOST', '127.0.0.1'),
  )
  .option(
    '--port <port>',
    'port to bind (default 3000)',
    parsePort,
    Number(envOrDefault('PORT', '3000')),
  )
  .option(
    '--auth-mode <mode>',
    `Portico client auth mode (default ${DEFAULT_AUTH_MODE})`,
    envOrDefault('AUTH_MODE', DEFAULT_AUTH_MODE),
  )
  .option(
    '--registry <file>',
    'registry file to load and validate at startup (YAML or JSON)',
  )
  .action(
    async (options: {
      host: string;
      port: number;
      authMode: string;
      registry?: string;
    }) => {
      try {
        await runServe(options.host, options.port, options.authMode, options.registry);
      } catch (error) {
        handleError(error);
      }
    },
  );

const registry = program.command('registry').description('Tenant registry management');

registry
  .command('validate <file>')
  .description(
    'Validate a registry file (schema, referential integrity, catalogs, policy)',
  )
  .action(async (file: string) => {
    try {
      const snapshot = buildRegistrySnapshot(file);
      const document = snapshot.document;
      console.log(
        `Valid: ${document.tenants.length} tenant(s), ${document.principals.length} principal(s), ${document.backends.length} backend(s), ${document.connections.length} connection(s), ${snapshot.catalogsByChecksum.size} unique catalog checksum(s).`,
      );
    } catch (error) {
      handleError(error);
    }
  });

const key = program.command('key').description('Portico API key management');

key
  .command('create')
  .description(
    'Generate a Portico API key for a principal and store only its HMAC digest in the registry',
  )
  .requiredOption('--registry <file>', 'registry file to update (YAML or JSON)')
  .requiredOption('--tenant <id>', 'tenant id of the principal')
  .requiredOption('--principal <id>', 'principal id to create the key for')
  .action(async (options: { registry: string; tenant: string; principal: string }) => {
    try {
      const pepper = process.env[envName('KEY_PEPPER')];
      if (pepper === undefined || pepper === '') {
        throw new PorticoError(
          'CONFIG_ERROR',
          'MCP_PORTICO_KEY_PEPPER must be set to create Portico API keys.',
        );
      }
      const loaded = loadRegistryFile(options.registry);
      const principal = loaded.document.principals.find(
        (candidate) => candidate.id === options.principal,
      );
      if (principal === undefined) {
        throw new PorticoError(
          'NOT_FOUND',
          `Principal "${options.principal}" was not found in ${options.registry}.`,
        );
      }
      if (principal.tenantId !== options.tenant) {
        throw new PorticoError(
          'USAGE',
          `Principal "${options.principal}" belongs to tenant "${principal.tenantId}", not "${options.tenant}".`,
        );
      }
      const generated = generatePorticoKey(pepper);
      principal.keyId = generated.keyId;
      principal.keyDigest = generated.digest;
      const originalContent = fs.readFileSync(options.registry, 'utf8');
      writeRegistryFile(options.registry, loaded.document, loaded.format);
      try {
        buildRegistrySnapshot(options.registry);
      } catch (error) {
        try {
          fs.writeFileSync(options.registry, originalContent, 'utf8');
        } catch {
          // Best-effort rollback; report the validation error below.
        }
        throw new PorticoError(
          'CONFIG_ERROR',
          `Refusing to store the new key: the updated registry failed validation. The file was restored.`,
          { cause: error },
        );
      }
      console.log(
        `Updated principal "${options.principal}" in ${options.registry} (key id ${generated.keyId}).`,
      );
      console.log(`Key created - shown once: ${generated.token}`);
    } catch (error) {
      handleError(error);
    }
  });

const connection = program.command('connection').description('Connection operations');

connection
  .command('test <id>')
  .description(
    'Probe a connection under its network and auth policy (operator health check)',
  )
  .requiredOption('--registry <file>', 'registry file (YAML or JSON)')
  .option('--method <method>', 'HTTP method (default GET)', 'GET')
  .option('--path <path>', 'request path (default /)', '/')
  .option('--timeout-ms <ms>', 'probe timeout in milliseconds', parsePositiveInt)
  .action(
    async (
      id: string,
      options: {
        registry: string;
        method: string;
        path: string;
        timeoutMs?: number;
      },
    ) => {
      try {
        const snapshot = buildRegistrySnapshot(options.registry);
        const config = snapshot.connection(id);
        if (config === undefined) {
          throw new PorticoError(
            'NOT_FOUND',
            `Connection "${id}" was not found in ${options.registry}.`,
          );
        }
        await assertSecretsResolvable(
          collectConnectionSecretRefs(config),
          defaultSecretResolver,
        );
        const target = new URL(options.path, config.baseUrl);
        const result = await executeProbe({
          url: target,
          method: options.method,
          auth: config.auth,
          staticHeaders: config.staticHeaders,
          network: config.network ?? {},
          timeoutMs: options.timeoutMs ?? config.policy?.timeoutMs,
          maxResponseBytes: config.policy?.maxResponseBytes,
        });
        console.log(
          `Connection "${id}": ${result.ok ? 'reachable' : 'failed'} (status ${result.status}, ${result.durationMs}ms, ${result.bytes} bytes${result.truncated ? ', truncated' : ''}${result.redirected ? ', redirected' : ''})`,
        );
        console.log(`  final URL: ${result.finalUrl}`);
        if (result.errorCode !== undefined) {
          console.log(`  error: ${result.errorCode}: ${result.message ?? ''}`);
        }
        if (Object.keys(result.headers).length > 0) {
          console.log(`  headers: ${JSON.stringify(result.headers)}`);
        }
        if (!result.ok) process.exitCode = EXIT_CODES.API_ERROR;
      } catch (error) {
        handleError(error);
      }
    },
  );

const usage = program
  .command('usage')
  .description(
    'Usage telemetry (v1: in-memory audit log; nothing is persisted automatically)',
  );

usage
  .command('summary')
  .description(
    'Summarize audit events from a telemetry file (JSON array or JSONL); v1 telemetry is not persisted automatically',
  )
  .option('--file <file>', 'telemetry file with audit events (JSON array or JSONL)')
  .option('--tenant <id>', 'restrict the summary to one tenant')
  .action((options: { file?: string; tenant?: string }) => {
    try {
      if (options.file === undefined) {
        console.log(
          `${PRODUCT_NAME} usage summary\n` +
            'No usage data available: v1 audit telemetry is in-memory only and is never written to disk.\n' +
            'Pass --file <audit.json|audit.jsonl> (JSON array or JSONL of audit events) to summarize them.',
        );
        return;
      }
      const events = loadAuditEvents(options.file);
      const summary = summarizeAudit(events, {
        ...(options.tenant !== undefined ? { tenantId: options.tenant } : {}),
      });
      console.log(formatUsageSummary(summary));
    } catch (error) {
      handleError(error);
    }
  });

const catalog = program
  .command('catalog')
  .description('Catalog compilation and maintenance');

catalog
  .command('import <file>')
  .description(
    'Compile an OpenAPI/Swagger document (2.0, 3.0, 3.1, 3.2; JSON or YAML) into a validated catalog v2 artifact and an import report',
  )
  .requiredOption(
    '--api-id <id>',
    'catalog api id (lowercase letters, digits, hyphens)',
  )
  .requiredOption('--output <file>', 'catalog v2 output path (written atomically)')
  .option('--report <file>', 'import report output path (JSON, written atomically)')
  .option('--overlay <file>', 'policy overlay JSON file to apply during compilation')
  .option(
    '--ai',
    'mark the input as an AI-analysis artifact: read x-mcp-portico metadata and gate low-confidence or unresolved-auth operations as unavailable',
  )
  .option(
    '--allow-file-refs',
    'permit relative file $refs that stay inside the input directory',
  )
  .option(
    '--allow-remote-refs',
    'permit remote http(s) $refs from hosts listed with --remote-host',
  )
  .option(
    '--remote-host <host>',
    'hostname allowed for remote $refs (repeatable)',
    collect,
    [] as string[],
  )
  .option('--allow-http', 'permit http: in addition to https: for remote $refs')
  .option(
    '--allow-private-network',
    'permit private/loopback destinations for remote $refs (dev only)',
  )
  .option('--max-bytes <bytes>', 'per-document size limit in bytes', parsePositiveInt)
  .option('--max-ref-depth <depth>', 'maximum $ref nesting depth', parsePositiveInt)
  .action(
    async (
      file: string,
      options: {
        apiId: string;
        output: string;
        report?: string;
        overlay?: string;
        ai?: boolean;
        allowFileRefs?: boolean;
        allowRemoteRefs?: boolean;
        remoteHost: string[];
        allowHttp?: boolean;
        allowPrivateNetwork?: boolean;
        maxBytes?: number;
        maxRefDepth?: number;
      },
    ) => {
      try {
        const overlay =
          options.overlay === undefined ? undefined : loadOverlay(options.overlay);
        const remoteRefs: RemoteRefPolicy =
          options.allowRemoteRefs === true || options.allowFileRefs === true
            ? {
                kind: 'allow',
                fileRefs: options.allowFileRefs === true,
                urlRefs: options.allowRemoteRefs === true,
                urlHosts: options.remoteHost,
                allowHttp: options.allowHttp === true,
                allowPrivateNetwork: options.allowPrivateNetwork === true,
              }
            : { kind: 'deny' };
        const { catalog, report } = await importOpenApi(file, {
          apiId: options.apiId,
          sourceType: options.ai === true ? 'ai' : 'openapi',
          overlay,
          remoteRefs,
          limits: {
            ...(options.maxBytes !== undefined
              ? { maxBytesPerDocument: options.maxBytes }
              : {}),
            ...(options.maxRefDepth !== undefined
              ? { maxRefDepth: options.maxRefDepth }
              : {}),
          },
        });
        writeFileAtomic(options.output, `${JSON.stringify(catalog, null, 2)}\n`);
        if (options.report !== undefined) {
          writeFileAtomic(options.report, `${JSON.stringify(report, null, 2)}\n`);
        }
        console.log(
          `Imported ${file} as catalog "${report.api.id}" (${report.summary.operations} operation(s), ${report.catalog.available} available, checksum ${catalog.checksum.slice(0, 18)}...).`,
        );
        console.log(`  catalog: ${options.output}`);
        if (options.report !== undefined) {
          console.log(`  report: ${options.report}`);
        }
        for (const warning of catalog.provenance.warnings ?? []) {
          console.warn(`warning: ${warning.code}: ${warning.message}`);
        }
        for (const feature of report.unsupported) {
          console.warn(
            `unsupported: ${feature.code}: ${feature.message}${feature.location !== undefined ? ` (${feature.location})` : ''}`,
          );
        }
        // Self-check: the written artifact must load and validate.
        loadCatalog(options.output);
      } catch (error) {
        handleError(error);
      }
    },
  );

catalog
  .command('validate <file>')
  .description('Validate a catalog v2 file (schema, semantics, and checksum)')
  .action(async (file: string) => {
    try {
      const { catalog: loaded, index } = loadCatalog(file);
      for (const warning of loaded.provenance.warnings ?? []) {
        console.warn(`warning: ${warning.code}: ${warning.message}`);
      }
      console.log(
        `Valid: ${index.ids().length} operation(s), checksum ${loaded.checksum.slice(0, 18)}...`,
      );
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = toExitCode(error);
    }
  });

catalog
  .command('diff <old-catalog> <new-catalog>')
  .description('Compare two catalog v2 files')
  .action(async (oldFile: string, newFile: string) => {
    try {
      const oldCatalog = loadCatalog(oldFile).catalog;
      const newCatalog = loadCatalog(newFile).catalog;
      console.log(formatDiff(diffCatalogs(oldCatalog, newCatalog), oldFile, newFile));
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = toExitCode(error);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exitCode = toExitCode(error);
});
