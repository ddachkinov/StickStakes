/**
 * Send something to the group chat. Uses the native share sheet where it
 * exists — which on a phone is the whole point — and falls back to the
 * clipboard everywhere else.
 *
 * Both paths can fail benignly: the user can dismiss the sheet, and clipboard
 * access needs a secure context. Callers get a short status string to show
 * rather than an exception to handle.
 */
export async function share(text: string, url?: string): Promise<string> {
  const payload: ShareData = { text, ...(url ? { url } : {}) };

  if (navigator.share) {
    try {
      await navigator.share(payload);
      return "Shared";
    } catch (error) {
      // AbortError just means they closed the sheet; say nothing.
      if (error instanceof DOMException && error.name === "AbortError") return "";
      // Anything else: fall through and try the clipboard instead.
    }
  }

  const full = url ? `${text}\n${url}` : text;
  try {
    await navigator.clipboard.writeText(full);
    return "Copied";
  } catch {
    return "Couldn't copy — select and copy manually";
  }
}
