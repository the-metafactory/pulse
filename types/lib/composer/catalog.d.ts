import type { CatalogEntry } from "./validate-pipeline";
export declare function buildCatalog(blocksDir: string): Promise<CatalogEntry[]>;
export declare function loadInstalledCatalog(): Promise<CatalogEntry[]>;
