import { type CatalogEntry, type Finding } from "./validate-pipeline";
export declare const ONLY_OWN_ADDRESSES = "A routine can mail only your own configured addresses, so it cannot mail anyone else. Ask it to \"mail me\" if the mail is for you.";
export declare function deliveryGap(request: string, catalog: CatalogEntry[]): string | null;
export declare function deliveryFindings(request: string, yaml: string, catalog: CatalogEntry[]): Finding[];
export declare function choosesMailRecipient(yaml: string, catalog: CatalogEntry[]): boolean;
