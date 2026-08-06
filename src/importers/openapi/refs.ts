/**
 * Reference resolution for untrusted OpenAPI/Swagger build inputs.
 *
 * Local `#/...` refs are always resolved. External refs (files or URLs) are
 * denied by default and only loaded after an explicit operator policy allows
 * them; every external document is subject to protocol/host allowlists, DNS
 * and redirect checks, timeouts, and aggregate byte/depth/document limits.
 * Runtime connection credentials are never used while fetching references.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PorticoError } from '../../shared/errors';
import {
  assertDestinationAllowed,
  assertDestinationDnsAllowed,
  defaultNetworkPolicy,
} from '../../security/network';
import { isRedirectStatus } from '../../security/redirects';
import type { NetworkPolicy } from '../../registry/types';
import { parseDocumentText } from './parse';
import type { ImportFormat, ImportLimits, RemoteRefPolicy } from './types';
import { decodePointerToken, isPlainObject, requiredString } from './util';

export interface LoadedDocument {
  /** Stable identity: absolute file path or final URL. */
  key: string;
  /** Directory for relative file refs (file-based documents only). */
  dir?: string;
  /** Absolute URL for http(s)-based documents. */
  url?: URL;
  data: unknown;
  bytes: number;
  isRoot: boolean;
}

export interface ResolvedRef {
  doc: LoadedDocument;
  /** Normalized JSON pointer, '' for the whole document. */
  pointer: string;
  value: unknown;
}

export interface Located {
  value: unknown;
  doc: LoadedDocument;
}

const MAX_REDIRECT_HOPS = 5;

export class DocumentStore {
  private readonly documents = new Map<string, LoadedDocument>();
  private totalBytes: number;

  constructor(
    readonly root: LoadedDocument,
    private readonly limits: ImportLimits,
    private readonly remotePolicy: RemoteRefPolicy,
  ) {
    this.documents.set(root.key, root);
    this.totalBytes = root.bytes;
  }

  /**
   * Pre-load the closure of every external document reachable through `$ref`
   * so normalization can resolve references synchronously.
   */
  async loadExternalClosure(): Promise<void> {
    const queue: LoadedDocument[] = [this.root];
    const seen = new Set<string>([this.root.key]);
    while (queue.length > 0) {
      const doc = queue.shift() as LoadedDocument;
      for (const ref of collectRefStrings(doc.data, this.limits.maxRefDepth)) {
        const { target } = splitRef(ref);
        if (target === '') continue;
        const key = this.externalKeyFor(target, doc);
        if (seen.has(key)) continue;
        const loaded = await this.loadExternal(key, target);
        seen.add(key);
        queue.push(loaded);
      }
    }
  }

  private async loadExternal(key: string, target: string): Promise<LoadedDocument> {
    const existing = this.documents.get(key);
    if (existing !== undefined) return existing;
    if (this.documents.size >= this.limits.maxDocuments) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Import exceeds the ${this.limits.maxDocuments}-document external reference limit while loading "${target}".`,
      );
    }
    const loaded =
      key.startsWith('http://') || key.startsWith('https://')
        ? await this.fetchUrl(new URL(key))
        : this.readFile(key);
    this.documents.set(key, loaded);
    this.totalBytes += loaded.bytes;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Import exceeds the ${this.limits.maxTotalBytes}-byte aggregate document limit.`,
      );
    }
    return loaded;
  }

  /** Resolve a `$ref` target to its document key without loading it. */
  externalKeyFor(target: string, from: LoadedDocument): string {
    const trimmed = target.trim();
    if (trimmed === '') return from.key;
    if (looksLikeUrl(trimmed)) {
      const url = this.parseUrl(trimmed, from);
      this.assertUrlAllowed(url);
      return url.toString();
    }
    if (from.url !== undefined) {
      const url = this.parseUrl(trimmed, from);
      this.assertUrlAllowed(url);
      return url.toString();
    }
    this.assertFileRefAllowed();
    const fromDir = from.dir ?? path.dirname(this.root.key);
    const resolved = path.resolve(fromDir, trimmed);
    this.assertFileContained(resolved);
    return resolved;
  }

  document(key: string): LoadedDocument {
    const doc = this.documents.get(key);
    if (doc === undefined) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Reference document "${key}" was not loaded during import.`,
      );
    }
    return doc;
  }

  resolveRef(ref: string, from: LoadedDocument): ResolvedRef {
    const { target, pointer } = splitRef(ref);
    const doc = target === '' ? from : this.document(this.externalKeyFor(target, from));
    return { doc, pointer, value: getPointer(doc.data, pointer, ref) };
  }

  /**
   * Dereference a schema into a self-contained JSON Schema. Referenced
   * definitions are bundled under `$defs` and internal refs are rewritten to
   * `#/$defs/<key>` so recursive schemas terminate deterministically and the
   * compiled catalog carries no external dependencies.
   */
  bundleSchema(schema: unknown, from: LoadedDocument): Record<string, unknown> {
    if (!isPlainObject(schema) && typeof schema !== 'boolean') {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Schema must be an object or boolean, got ${schema === null ? 'null' : typeof schema}.`,
      );
    }
    const existingDefKeys = new Set(
      isPlainObject(schema) && isPlainObject(schema.$defs)
        ? Object.keys(schema.$defs)
        : [],
    );
    const memo = new Map<string, string>();
    const defs = new Map<string, { value: unknown }>();
    let bundleBytes = 0;

    const defKeyFor = (resolved: ResolvedRef): string => {
      const base = sanitizeKey(pointerName(resolved.pointer));
      const prefix = resolved.doc.isRoot ? '' : `${sanitizeKey(resolved.doc.key)}_`;
      let key = `${prefix}${base}`;
      let suffix = 2;
      while (defs.has(key) || existingDefKeys.has(key)) {
        key = `${prefix}${base}_${suffix}`;
        suffix += 1;
      }
      return key;
    };

    const walk = (node: unknown, doc: LoadedDocument, depth: number): unknown => {
      if (depth > this.limits.maxRefDepth) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Schema reference nesting exceeds the ${this.limits.maxRefDepth}-depth limit.`,
        );
      }
      if (Array.isArray(node)) {
        return node.map((item) => walk(item, doc, depth + 1));
      }
      if (!isPlainObject(node)) return node;
      if (typeof node.$ref === 'string') {
        const resolved = this.resolveRef(node.$ref, doc);
        if (!isPlainObject(resolved.value) && typeof resolved.value !== 'boolean') {
          throw new PorticoError(
            'CONFIG_ERROR',
            `Reference "${node.$ref}" resolves to a ${resolved.value === null ? 'null' : typeof resolved.value}, which is not a valid schema.`,
          );
        }
        const memoId = `${resolved.doc.key}\u0000${resolved.pointer}`;
        const existing = memo.get(memoId);
        if (existing !== undefined) {
          return { ...omitRef(node), $ref: `#/$defs/${existing}` };
        }
        if (defs.size >= this.limits.maxSchemaDefs) {
          throw new PorticoError(
            'CONFIG_ERROR',
            `Schema bundling exceeds the ${this.limits.maxSchemaDefs}-definition limit.`,
          );
        }
        const key = defKeyFor(resolved);
        memo.set(memoId, key);
        const entry: { value: unknown } = { value: undefined };
        defs.set(key, entry);
        entry.value = walk(resolved.value, resolved.doc, depth + 1);
        return { ...omitRef(node), $ref: `#/$defs/${key}` };
      }
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value, doc, depth + 1);
      }
      return out;
    };

    const bundled = walk(schema, from, 0);
    if (defs.size === 0) return bundled as Record<string, unknown>;

    const mergedDefs: Record<string, unknown> = {};
    for (const [key, entry] of defs) {
      const serialized = JSON.stringify(entry.value);
      bundleBytes += Buffer.byteLength(serialized, 'utf8');
      if (bundleBytes > this.limits.maxBundleBytes) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Bundled schema exceeds the ${this.limits.maxBundleBytes}-byte expansion limit.`,
        );
      }
      mergedDefs[key] = entry.value;
    }

    const rootObject = bundled as Record<string, unknown>;
    const existing = isPlainObject(rootObject.$defs)
      ? (rootObject.$defs as Record<string, unknown>)
      : {};
    return { ...rootObject, $defs: { ...existing, ...mergedDefs } };
  }

  private networkPolicy(): NetworkPolicy {
    if (this.remotePolicy.kind === 'deny') return defaultNetworkPolicy();
    return {
      allowedProtocols: this.remotePolicy.allowHttp ? ['https', 'http'] : ['https'],
      allowLoopback: this.remotePolicy.allowPrivateNetwork,
      allowLinkLocal: false,
      allowPrivateNetwork: this.remotePolicy.allowPrivateNetwork,
      redirects: 'none',
    };
  }

  private assertUrlAllowed(url: URL): void {
    if (this.remotePolicy.kind !== 'allow' || !this.remotePolicy.urlRefs) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Remote reference "${url}" is not permitted. Enable --allow-remote-refs with an explicit host allowlist to import external references.`,
      );
    }
    const scheme = url.protocol.replace(/:$/, '');
    const allowed =
      scheme === 'https' || (this.remotePolicy.allowHttp && scheme === 'http');
    if (!allowed) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Remote reference "${url}" uses ${scheme.toUpperCase()}, which is not permitted by the import reference policy.`,
      );
    }
    const host = url.hostname.toLowerCase();
    if (!this.remotePolicy.urlHosts.includes(host)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Remote reference host "${url.host}" is not in the import allowlist (${this.remotePolicy.urlHosts.join(', ') || 'none'}).`,
      );
    }
  }

  private parseUrl(target: string, from: LoadedDocument): URL {
    try {
      return new URL(target, from.url);
    } catch (error) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Invalid remote reference URL "${target}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private assertFileRefAllowed(): void {
    if (this.remotePolicy.kind !== 'allow' || !this.remotePolicy.fileRefs) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `File reference outside the root document is not permitted. Enable --allow-file-refs to import relative file references.`,
      );
    }
  }

  private assertFileContained(resolved: string): void {
    const rootDir = path.dirname(path.resolve(this.root.key));
    const relative = path.relative(rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `File reference "${resolved}" escapes the input directory "${rootDir}" and was refused.`,
      );
    }
  }

  private async fetchUrl(url: URL): Promise<LoadedDocument> {
    const policy = this.networkPolicy();
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      assertDestinationAllowed(current, policy, { context: 'load' });
      await assertDestinationDnsAllowed(current, policy, { context: 'load' });
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.limits.timeoutMs),
        });
      } catch (error) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Failed to fetch remote reference "${current}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (isRedirectStatus(response.status)) {
        const location = response.headers.get('location');
        if (location === null || location === '') {
          throw new PorticoError(
            'CONFIG_ERROR',
            `Remote reference "${current}" returned a redirect without a Location header.`,
          );
        }
        current = new URL(location, current);
        this.assertUrlAllowed(current);
        continue;
      }
      if (!response.ok) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Remote reference "${current}" returned HTTP ${response.status}.`,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > this.limits.maxBytesPerDocument) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Remote reference "${current}" is ${buffer.byteLength} bytes, exceeding the ${this.limits.maxBytesPerDocument}-byte per-document limit.`,
        );
      }
      const format = formatForUrl(current, buffer);
      return {
        key: current.toString(),
        url: current,
        data: parseDocumentText(buffer.toString('utf8'), format, current.toString()),
        bytes: buffer.byteLength,
        isRoot: false,
      };
    }
    throw new PorticoError(
      'CONFIG_ERROR',
      `Remote reference "${url}" exceeded ${MAX_REDIRECT_HOPS} redirect hops.`,
    );
  }

  private readFile(resolved: string): LoadedDocument {
    let raw: string;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Failed to read reference file "${resolved}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > this.limits.maxBytesPerDocument) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Reference file "${resolved}" is ${bytes} bytes, exceeding the ${this.limits.maxBytesPerDocument}-byte per-document limit.`,
      );
    }
    const format = formatForFile(resolved, raw);
    return {
      key: resolved,
      dir: path.dirname(resolved),
      data: parseDocumentText(raw, format, resolved),
      bytes,
      isRoot: false,
    };
  }
}

/** Follow a chain of structural `$ref` objects with cycle detection. */
export function derefStructural(store: DocumentStore, located: Located): Located {
  const visited = new Set<string>();
  let current = located;
  while (isPlainObject(current.value) && typeof current.value.$ref === 'string') {
    const resolved = store.resolveRef(current.value.$ref, current.doc);
    const memoId = `${resolved.doc.key}\u0000${resolved.pointer}`;
    if (visited.has(memoId)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Structural $ref cycle detected at "${current.value.$ref}".`,
      );
    }
    visited.add(memoId);
    current = { value: resolved.value, doc: resolved.doc };
  }
  return current;
}

export function splitRef(ref: string): { target: string; pointer: string } {
  requiredString(ref, '$ref');
  const hash = ref.indexOf('#');
  if (hash === -1) return { target: ref, pointer: '' };
  return { target: ref.slice(0, hash), pointer: ref.slice(hash + 1) };
}

function looksLikeUrl(target: string): boolean {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('//')
  );
}

export function getPointer(data: unknown, pointer: string, ref: string): unknown {
  if (pointer === '' || pointer === '#') return data;
  if (!pointer.startsWith('/')) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Reference "${ref}" has an invalid JSON pointer "${pointer}".`,
    );
  }
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => decodePointerToken(token));
  let current: unknown = data;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Reference "${ref}" points into an array with non-numeric token "${token}".`,
        );
      }
      current = current[Number(token)];
    } else if (isPlainObject(current)) {
      current = current[token];
    } else {
      current = undefined;
    }
    if (current === undefined) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Reference "${ref}" does not resolve in the document.`,
      );
    }
  }
  return current;
}

function collectRefStrings(data: unknown, maxDepth: number): string[] {
  const refs: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Document nesting exceeds the ${maxDepth}-depth scan limit.`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') refs.push(item);
      else walk(item, depth + 1);
    }
  };
  walk(data, 0);
  return refs;
}

function omitRef(node: Record<string, unknown>): Record<string, unknown> {
  const siblings = { ...node };
  delete siblings.$ref;
  return siblings;
}

function pointerName(pointer: string): string {
  if (pointer === '' || pointer === '#') return 'root';
  return pointer
    .split('/')
    .filter((token) => token !== '')
    .map((token) => decodePointerToken(token))
    .join('.');
}

function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function formatForUrl(url: URL, buffer: Buffer): ImportFormat {
  const contentType =
    url.pathname.toLowerCase().endsWith('.yaml') ||
    url.pathname.toLowerCase().endsWith('.yml');
  if (contentType) return 'yaml';
  const text = buffer.toString('utf8').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      JSON.parse(buffer.toString('utf8'));
      return 'json';
    } catch {
      // Fall through to YAML.
    }
  }
  return 'yaml';
}

function formatForFile(resolved: string, raw: string): ImportFormat {
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.json') return 'json';
  try {
    JSON.parse(raw);
    return 'json';
  } catch {
    return 'yaml';
  }
}
