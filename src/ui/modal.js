/**
 * MODAL — a small, reusable, promise-based dialog system.
 * ------------------------------------------------------------------
 * Replaces the browser's native alert()/confirm()/prompt() with clean,
 * themed, accessible dialogs. One mount point, one dialog at a time.
 *
 * Public API (all return a Promise):
 *   confirm({ title, message, confirmText, cancelText, danger })  -> boolean
 *   alert({ title, message, confirmText })                        -> true
 *   prompt({ title, message, value, placeholder, confirmText })   -> string | null
 *   open({ title, body, actions, onMount })                       -> any
 *
 * Design notes:
 *   - Promise-based so callers read top-to-bottom (no callback nesting).
 *   - Esc cancels, Enter confirms, overlay click cancels, focus is trapped
 *     to the dialog, and focus returns to the previously focused element.
 *   - Styling lives in styles.css under the `.modal-*` classes.
 */
import { el } from '../utils.js';

let _activeClose = null; // ensures only one dialog is open at a time

function closeActive(result) {
  if (_activeClose) _activeClose(result);
}

/**
 * Low-level opener. `actions` is an array of button descriptors:
 *   { label, value, variant: 'primary'|'danger'|'ghost'|'', isDefault, isCancel }
 * Resolves with the chosen button's `value` (or the value passed to close()).
 */
export function open({ title = '', body = null, actions = [], onMount = null } = {}) {
  closeActive(null); // never stack dialogs

  const previouslyFocused = document.activeElement;

  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay', role: 'presentation' });
    const dialog = el('div', {
      class: 'modal', role: 'dialog', 'aria-modal': 'true',
      'aria-label': typeof title === 'string' ? title : 'Dialog',
    });

    if (title) dialog.appendChild(el('div', { class: 'modal-title' }, title));

    const bodyWrap = el('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyWrap.textContent = body;
    else if (body instanceof Node) bodyWrap.appendChild(body);
    dialog.appendChild(bodyWrap);

    const footer = el('div', { class: 'modal-footer' });
    const buttons = [];
    actions.forEach(a => {
      const cls = `btn${a.variant === 'primary' ? ' btn-primary'
        : a.variant === 'danger' ? ' btn-danger'
        : a.variant === 'ghost' ? ' btn-ghost' : ''}`;
      const btn = el('button', { class: cls, onclick: () => done(a.value) }, a.label);
      if (a.isDefault) btn.dataset.default = '1';
      buttons.push({ btn, descriptor: a });
      footer.appendChild(btn);
    });
    if (actions.length) dialog.appendChild(footer);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Animate in on next frame.
    requestAnimationFrame(() => overlay.classList.add('is-open'));

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('is-open');
      // Remove after the fade-out transition.
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 160);
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
      if (_activeClose === done) _activeClose = null;
    }

    function done(result) {
      cleanup();
      resolve(result);
    }
    _activeClose = done;

    // Overlay click (outside the dialog) cancels.
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) {
        const cancel = actions.find(a => a.isCancel);
        done(cancel ? cancel.value : null);
      }
    });

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        const cancel = actions.find(a => a.isCancel);
        done(cancel ? cancel.value : null);
      } else if (e.key === 'Enter') {
        // Enter triggers the default action, unless focus is in a textarea.
        if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
        const def = actions.find(a => a.isDefault);
        if (def) { e.preventDefault(); done(def.value); }
      } else if (e.key === 'Tab') {
        trapFocus(e, dialog);
      }
    }
    document.addEventListener('keydown', onKey, true);

    // Let callers wire up custom body behavior (e.g. input refs).
    const ctx = { dialog, bodyWrap, close: done };
    if (typeof onMount === 'function') onMount(ctx);

    // Initial focus: the default button, or the first focusable element.
    const def = buttons.find(b => b.descriptor.isDefault);
    const firstInput = bodyWrap.querySelector('input, textarea, select');
    (firstInput || (def && def.btn) || (buttons[0] && buttons[0].btn) || dialog).focus();
  });
}

function trapFocus(e, container) {
  const focusables = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

export function confirm({
  title = 'Are you sure?', message = '', confirmText = 'Confirm',
  cancelText = 'Cancel', danger = false,
} = {}) {
  return open({
    title,
    body: message,
    actions: [
      { label: cancelText, value: false, variant: 'ghost', isCancel: true },
      { label: confirmText, value: true, variant: danger ? 'danger' : 'primary', isDefault: true },
    ],
  });
}

export function alert({ title = 'Notice', message = '', confirmText = 'OK' } = {}) {
  return open({
    title,
    body: message,
    actions: [{ label: confirmText, value: true, variant: 'primary', isDefault: true, isCancel: true }],
  }).then(() => true);
}

export function prompt({
  title = '', message = '', value = '', placeholder = '',
  confirmText = 'Save', cancelText = 'Cancel',
} = {}) {
  let input;
  const body = el('div');
  if (message) body.appendChild(el('div', { class: 'modal-message' }, message));
  input = el('input', { type: 'text', value, placeholder });
  body.appendChild(input);

  return open({
    title,
    body,
    onMount: ({ close }) => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    },
    actions: [
      { label: cancelText, value: '\u0000CANCEL', variant: 'ghost', isCancel: true },
      { label: confirmText, value: '\u0000CONFIRM', variant: 'primary', isDefault: true },
    ],
  }).then(res => {
    if (res === '\u0000CONFIRM') return input.value;
    return null; // cancelled
  });
}
