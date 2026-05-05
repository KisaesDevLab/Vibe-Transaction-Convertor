// Tiny clipboard helper. Returns a `copy` callback that toasts on
// success/failure. Uses navigator.clipboard when available (HTTPS or
// localhost), with a textarea fallback for older non-secure contexts.

import { useToast } from '../components/Toast';

export const useCopyToClipboard = (): ((text: string, label?: string) => Promise<void>) => {
  const toast = useToast();
  return async (text: string, label = 'Copied') => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts. textarea preserves
        // newlines and avoids the white-flash an input would cause.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast.success(label);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };
};
