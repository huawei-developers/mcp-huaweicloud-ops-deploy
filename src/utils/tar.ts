/**
 * Zip archive extraction (terraform binary download + terraform examples).
 *
 * Uses adm-zip (pure JS, no native compilation) — chosen because:
 *   - terraform binary releases are zip-only.
 *   - terraform examples are bundled as zip to share one extraction path
 *     with the binary download (API definitions are NOT bundled — queried
 *     dynamically via the apiexplorer tool).
 *   - No system `unzip` dependency (sandboxes may lack it; Windows has none).
 *
 * 27MB terraform binary loads into memory — acceptable for a one-time install.
 */

import AdmZip from "adm-zip";

/**
 * Extract a zip archive to a destination directory.
 *
 * NOTE: adm-zip's extractAllTo does NOT preserve unix exec permission bits —
 * extracted files are mode 0666. Callers that need an executable binary (e.g.
 * terraform_install's downloadAndExtract) must chmod it themselves after
 * extraction. This is documented rather than fixed here because not every
 * caller needs exec (data-asset zips don't), and a blanket chmod-all would
 * be wrong for archives mixing executable and non-executable files.
 *
 * @returns the number of files extracted.
 * @throws on read/extract failure (corrupt zip, disk full, permission).
 */
export async function extractArchive(archivePath: string, dest: string): Promise<{ files: number }> {
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  zip.extractAllTo(dest, true);
  return { files: entries.length };
}
