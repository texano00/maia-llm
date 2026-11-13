/**
 * Clipboard write with a fallback.
 *
 * The asynchronous API is refused in some sandboxed contexts; selecting a hidden
 * textarea and using the legacy command keeps "Copy" working there instead of
 * silently doing nothing.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Fall through to the selection trick.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
