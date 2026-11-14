/**
 * Copy text to the clipboard. `navigator.clipboard` only exists on secure origins
 * (https / localhost), so fall back to a hidden textarea + execCommand elsewhere
 * (e.g. the app opened over a LAN IP).
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or document not focused: try the legacy path below.
    }
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "-1000px";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Couldn't copy to clipboard");
  } finally {
    el.remove();
  }
}
