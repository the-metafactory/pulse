/**
 * CMDB/NetDB-lite — the NREN-specific ownership fixture for the SOC demo.
 *
 * Maps demo IPs to the responsible organizational unit and a NOC contact, the
 * way a real NREN would resolve an address against its asset inventory. Some
 * IPs intentionally overlap with the GeoIP fixture (A_LOOKUP_GEOIP_ASN) so a
 * flow can chain geo + owner on the same address; the two blocks are otherwise
 * independent. Contacts are illustrative example-org addresses, not real.
 */

export interface OwnerEntry {
  ou: string;
  contact: string;
}

export const OWNER_TABLE: Record<string, OwnerEntry> = {
  // Shared with the GeoIP SWITCH entries.
  "130.59.1.1": { ou: "SWITCH — Infrastructure", contact: "noc@switch.example.ch" },
  "130.59.10.20": { ou: "SWITCH — Infrastructure", contact: "noc@switch.example.ch" },
  // Member institutions on their delegated ranges.
  "82.130.64.10": { ou: "ETH Zürich — Informatikdienste", contact: "noc@ethz.example.ch" },
  "130.92.10.5": { ou: "Uni Bern — IT Services", contact: "soc@unibe.example.ch" },
  "129.132.20.7": { ou: "ETH Zürich — Informatikdienste", contact: "noc@ethz.example.ch" },
  "152.88.5.3": { ou: "Uni Bern — IT Services", contact: "soc@unibe.example.ch" },
};
