import { type CatalogEntry, type Finding } from "./validate-pipeline";
export declare const actsOnTheWorld: (entry: CatalogEntry | undefined) => boolean;
export declare function readsDataFindings(yaml: string, catalog: CatalogEntry[]): Finding[];
