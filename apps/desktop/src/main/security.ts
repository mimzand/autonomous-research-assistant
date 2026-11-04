/**
 * Returns true when a URL belongs to our own renderer: the packaged
 * file:// page, or the electron-vite dev server in development.
 */
export function isAppUrl(url: string, devServerUrl: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) {
    try {
      return parsed.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return parsed.protocol === 'file:';
}
