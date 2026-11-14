/**
 * Small OS capability checks.
 *
 * Kept separate from the Electron code so they can be unit-tested by passing a
 * version string, without starting an Electron app (see test/capture.test.js).
 */

/**
 * Can this Windows version keep a window out of screen capture?
 *
 * Electron's `BrowserWindow.setContentProtection(true)` maps to
 * `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`. That flag was added
 * in Windows 10 version 2004 (build 19041). On older builds the flag is
 * rejected: the call fails and the window stays fully capturable, with no error
 * anywhere. So we check before enabling, instead of showing a setting that
 * quietly does nothing.
 *
 * Windows 11 still reports itself as "10.0.<build>", so the build number is
 * what decides it, not the major version.
 */
export function supportsCaptureExclusion(
  version: string = currentOsVersion(),
  platform: string = process.platform
): boolean {
  if (platform !== "win32") return false;
  const [major, , build] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(build)) return false;
  if (major > 10) return true; // anything newer than Windows 10 supports it
  return major === 10 && build >= 19041;
}

/** `process.getSystemVersion()` exists only inside Electron; fall back to "". */
function currentOsVersion(): string {
  const get = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion;
  return typeof get === "function" ? get() : "";
}
