/**
 * Provider mirror config generator (§6.6 / mirror.go 思路).
 *
 * Generates <deployment>/.terraformrc with network_mirror / filesystem_mirror
 * entries from a list of mirror URLs or paths. Terraform tries mirrors in
 * order, then falls back to the official registry via a direct { exclude }
 * block for providers not covered by the mirror (random, tls, ...).
 *
 * Only huaweicloud is excluded from the direct fallback — the default mirror
 * covers just that provider, so auxiliary providers must still reach the
 * registry.
 *
 * Mirror URL: https://mirrors.huaweicloud.com/terraform/ 
 * is a registry.terraform.io mirror that hosts ONLY the huaweicloud provider.
 * So the include MUST be scoped to huaweicloud; a broader include of all providers
 * would route random/tls to this mirror and fail. The direct { exclude }
 * block then forces huaweicloud to the mirror and lets everything else reach
 * the official registry directly.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_PROVIDER_MIRRORS = ["https://mirrors.huaweicloud.com/terraform/"];

export const HUAWEICLOUD_PROVIDER_MIRRORS = DEFAULT_PROVIDER_MIRRORS;

/**
 * Write <deployment>/.terraformrc with provider mirror config.
 * Does NOT overwrite if the file already exists (user-provided).
 * Returns the path, or null if no file was written.
 */
export async function writeProviderMirrorConfig(
  deployment: string,
  mirrors: string[] = DEFAULT_PROVIDER_MIRRORS,
): Promise<string | null> {
  if (mirrors.length === 0) return null;

  const rcPath = join(deployment, ".terraformrc");
  try {
    const { stat } = await import("node:fs/promises");
    await stat(rcPath);
    return null; // Already exists — don't overwrite.
  } catch {
    // Doesn't exist — proceed.
  }

  const lines: string[] = ["provider_installation {"];
  for (const m of mirrors) {
    const trimmed = m.trim();
    if (!trimmed) continue;
    if (isURL(trimmed)) {
      lines.push(
        `  network_mirror {`,
        `    url = ${JSON.stringify(trimmed)}`,
        `    include = ["registry.terraform.io/huaweicloud/*"]`,
        `  }`,
      );
    } else {
      lines.push(
        `  filesystem_mirror {`,
        `    path = ${JSON.stringify(trimmed)}`,
        `    include = ["registry.terraform.io/huaweicloud/*"]`,
        `  }`,
      );
    }
  }
  // Fallback: official registry for non-huaweicloud providers (random, tls, ...).
  // Only huaweicloud is excluded — the mirror covers just that provider.
  lines.push(`  direct {`, `    exclude = ["registry.terraform.io/huaweicloud/*"]`, `  }`, `}`);

  await writeFile(rcPath, lines.join("\n") + "\n", "utf8");
  return rcPath;
}

function isURL(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}
