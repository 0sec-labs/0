

/**
 * Cache for the resolved Azure region, keyed by base URL. The region is
 * probed once per process (per endpoint) and reused thereafter — see
 * {@link probeAzureRegion}.
 */
export const azureRegionCache = new Map<string, string>();

/**
 * Probe the Azure OpenAI endpoint once for its deployment region.
 *
 * Azure surfaces the physical region of a resource in the `x-ms-region`
 * response header (e.g. "eastus2"). The URL itself never reveals this —
 * two `*.openai.azure.com` endpoints can live in completely different
 * geographies — so this probe is the only reliable way to tell an
 * operator which data-residency jurisdiction their traffic lands in.
 *
 * The probe issues a single cheap request to `${baseUrl}/models`, reads
 * the header, and caches the result per base URL for the rest of the
 * process. It never throws: on any failure (network error, HTTP error,
 * missing header) the function resolves to "unknown" so startup logging
 * stays a no-op in adverse conditions.
 *
 * Test hook: `ZERO_REGION_OVERRIDE` short-circuits the probe entirely.
 * Set it to force a specific region string without hitting the network —
 * this keeps unit tests and air-gapped CI runs deterministic.
 */
export async function probeAzureRegion(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // ZERO_REGION_OVERRIDE: lets tests (and operators running offline)
  // force a specific region string without touching the network.
  const override = process.env["ZERO_REGION_OVERRIDE"];
  if (override && override.trim().length > 0) {
    return override.trim();
  }

  const cached = azureRegionCache.get(baseUrl);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { "api-key": apiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    // Azure returns x-ms-region even on 401/403 — the header is set by the
    // front door before authentication, so a missing key still reveals the
    // resource geography. We accept any response that has the header.
    const region = res.headers.get("x-ms-region");
    const resolved = region && region.trim().length > 0
      ? prettyRegion(region.trim())
      : "unknown";
    azureRegionCache.set(baseUrl, resolved);
    return resolved;
  } catch {
    azureRegionCache.set(baseUrl, "unknown");
    return "unknown";
  }
}

/** Convert Azure's lowercase region codes into a human-readable label. */
export function prettyRegion(code: string): string {
  const map: Record<string, string> = {
    eastus: "East US",
    eastus2: "East US 2",
    westus: "West US",
    westus2: "West US 2",
    westus3: "West US 3",
    centralus: "Central US",
    northcentralus: "North Central US",
    southcentralus: "South Central US",
    westcentralus: "West Central US",
    canadaeast: "Canada East",
    canadacentral: "Canada Central",
    brazilsouth: "Brazil South",
    northeurope: "North Europe",
    westeurope: "West Europe",
    uksouth: "UK South",
    ukwest: "UK West",
    francecentral: "France Central",
    germanywestcentral: "Germany West Central",
    switzerlandnorth: "Switzerland North",
    norwayeast: "Norway East",
    swedencentral: "Sweden Central",
    polandcentral: "Poland Central",
    italynorth: "Italy North",
    eastasia: "East Asia",
    southeastasia: "Southeast Asia",
    japaneast: "Japan East",
    japanwest: "Japan West",
    koreacentral: "Korea Central",
    australiaeast: "Australia East",
    centralindia: "Central India",
    southindia: "South India",
    uaenorth: "UAE North",
    southafricanorth: "South Africa North",
  };
  return map[code.toLowerCase()] ?? code;
}

/** Reset the region cache. Test-only — do not call from production code. */
export function __resetAzureRegionCacheForTests(): void {
  azureRegionCache.clear();
}
