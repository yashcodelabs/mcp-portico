import type { Catalog, CatalogOperation, RiskLevel } from './types';

/**
 * Immutable runtime index over a compiled catalog. Operation lookup is
 * keyed by stable operation ID; tag and risk views are precomputed.
 */
export class CatalogIndex {
  private readonly byId = new Map<string, CatalogOperation>();
  private readonly tagIndex = new Map<string, string[]>();
  private readonly riskIndex = new Map<RiskLevel, string[]>();
  private readonly sortedIds: string[];

  constructor(catalog: Catalog) {
    for (const [operationId, operation] of Object.entries(catalog.operations)) {
      this.byId.set(operationId, operation);
      for (const tag of operation.tags ?? []) {
        const entries = this.tagIndex.get(tag) ?? [];
        entries.push(operationId);
        this.tagIndex.set(tag, entries);
      }
      const riskEntries = this.riskIndex.get(operation.risk) ?? [];
      riskEntries.push(operationId);
      this.riskIndex.set(operation.risk, riskEntries);
    }
    this.sortedIds = [...this.byId.keys()].sort();
  }

  get(operationId: string): CatalogOperation | undefined {
    return this.byId.get(operationId);
  }

  has(operationId: string): boolean {
    return this.byId.has(operationId);
  }

  ids(): string[] {
    return [...this.sortedIds];
  }

  all(): CatalogOperation[] {
    return this.sortedIds.map((id) => this.byId.get(id) as CatalogOperation);
  }

  byTag(tag: string): string[] {
    return [...(this.tagIndex.get(tag) ?? [])].sort();
  }

  byRisk(risk: RiskLevel): string[] {
    return [...(this.riskIndex.get(risk) ?? [])].sort();
  }

  enabledIds(): string[] {
    return this.sortedIds.filter(
      (id) => (this.byId.get(id) as CatalogOperation).enabled,
    );
  }
}
