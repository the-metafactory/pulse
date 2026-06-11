/**
 * MaxMind-lite — a tiny offline GeoIP/ASN table for the SOC demo.
 *
 * These are illustrative single-IP entries chosen to be recognizable to the
 * NREN audience (SWITCH, common hosting providers, an obvious scanner). They
 * are demo fixtures, not authoritative GeoIP data.
 */

export interface GeoIpEntry {
  country: string;
  asn: number;
  as_org: string;
}

export const GEOIP_TABLE: Record<string, GeoIpEntry> = {
  // SWITCH (the Swiss NREN) — AS559, CH.
  "130.59.1.1": { country: "CH", asn: 559, as_org: "SWITCH" },
  // Hetzner Online, Germany.
  "88.198.1.1": { country: "DE", asn: 24940, as_org: "Hetzner Online GmbH" },
  // OVH, France.
  "51.255.1.1": { country: "FR", asn: 16276, as_org: "OVH SAS" },
  // Cloudflare anycast (the 1.1.1.1 resolver), US-registered.
  "1.1.1.1": { country: "US", asn: 13335, as_org: "Cloudflare, Inc." },
  // Residential-looking Swisscom (CH) end-user line.
  "85.0.1.1": { country: "CH", asn: 3303, as_org: "Swisscom (Schweiz) AG" },
  // Censys research scanner, US.
  "162.142.125.1": { country: "US", asn: 398324, as_org: "Censys, Inc." },
  // Shadowserver scanner, NL.
  "184.105.247.1": { country: "NL", asn: 6939, as_org: "Hurricane Electric (Shadowserver scan source)" },
  // A second SWITCH-range host, for owner-lookup cross-referencing.
  "130.59.10.20": { country: "CH", asn: 559, as_org: "SWITCH" },
};
