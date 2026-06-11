/**
 * Offline NVD-lite cache for the SOC demo.
 *
 * ~15 well-known CVEs with honest *approximate* CVSS v3.1 base scores and KEV
 * status. All entries here are CISA KEV-listed, which is fine for the demo.
 * These are illustrative fixtures, not an authoritative NVD mirror — scores
 * are rounded to the commonly-cited value.
 */

export interface CveEntry {
  cvss: number;
  kev: boolean;
  summary: string;
}

export const CVE_CACHE: Record<string, CveEntry> = {
  "CVE-2021-44228": {
    cvss: 10.0,
    kev: true,
    summary: "Log4Shell — Apache Log4j2 JNDI remote code execution via crafted log messages.",
  },
  "CVE-2014-0160": {
    cvss: 7.5,
    kev: true,
    summary: "Heartbleed — OpenSSL TLS heartbeat out-of-bounds read leaking memory (keys, secrets).",
  },
  "CVE-2017-0144": {
    cvss: 8.1,
    kev: true,
    summary: "EternalBlue — Windows SMBv1 remote code execution (WannaCry/NotPetya propagation).",
  },
  "CVE-2023-4966": {
    cvss: 9.4,
    kev: true,
    summary: "Citrix Bleed — NetScaler ADC/Gateway sensitive-memory disclosure enabling session hijack.",
  },
  "CVE-2023-34362": {
    cvss: 9.8,
    kev: true,
    summary: "MOVEit Transfer SQL injection enabling remote code execution (Cl0p mass exploitation).",
  },
  "CVE-2024-6387": {
    cvss: 8.1,
    kev: true,
    summary: "regreSSHion — OpenSSH sshd signal-handler race condition allowing unauthenticated RCE.",
  },
  "CVE-2024-3094": {
    cvss: 10.0,
    kev: true,
    summary: "XZ Utils (liblzma) backdoor in 5.6.0/5.6.1 enabling SSH authentication bypass.",
  },
  "CVE-2014-6271": {
    cvss: 9.8,
    kev: true,
    summary: "Shellshock — GNU Bash function-definition parsing allows arbitrary command execution.",
  },
  "CVE-2019-0708": {
    cvss: 9.8,
    kev: true,
    summary: "BlueKeep — Windows RDP pre-auth remote code execution (wormable).",
  },
  "CVE-2021-26855": {
    cvss: 9.8,
    kev: true,
    summary: "ProxyLogon — Microsoft Exchange SSRF, chained to RCE (HAFNIUM campaign).",
  },
  "CVE-2022-22965": {
    cvss: 9.8,
    kev: true,
    summary: "Spring4Shell — Spring Framework data-binding remote code execution on JDK 9+.",
  },
  "CVE-2022-30190": {
    cvss: 7.8,
    kev: true,
    summary: "Follina — MSDT remote code execution via crafted Office documents.",
  },
  "CVE-2022-26134": {
    cvss: 9.8,
    kev: true,
    summary: "Atlassian Confluence OGNL injection enabling unauthenticated remote code execution.",
  },
  "CVE-2023-27350": {
    cvss: 9.8,
    kev: true,
    summary: "PaperCut MF/NG authentication bypass enabling remote code execution.",
  },
  "CVE-2024-1709": {
    cvss: 10.0,
    kev: true,
    summary: "ConnectWise ScreenConnect authentication bypass via path traversal (admin takeover).",
  },
};

/** CVSS base score → qualitative severity band (NVD v3.1 ranges). */
export function severityFor(cvss: number): string {
  if (cvss >= 9.0) return "CRITICAL";
  if (cvss >= 7.0) return "HIGH";
  if (cvss >= 4.0) return "MEDIUM";
  if (cvss > 0.0) return "LOW";
  return "NONE";
}
