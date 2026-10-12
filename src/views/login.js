// ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
// Shown only when Supabase is configured and no one is signed in.
import { el } from '../utils.js';
import { signIn } from '../auth/auth.js';

export function renderLogin(onSuccess) {
  const wrap = el('div', { class: 'login-wrap' });
  const card = el('div', { class: 'login-card' });
  card.innerHTML = `
    <img src="public/logo.png" alt="logo" style="height:36px;margin-bottom:16px" onerror="this.style.display='none'" />
    <h1 style="font-size:20px;margin-bottom:4px">Resume Screener Tool</h1>
    <p class="muted" style="margin-bottom:20px">Sign in to continue</p>
  `;
  const form = el('form');
  form.innerHTML = `
    <div class="form-group"><label>Email</label><input id="lg-email" type="email" autocomplete="username" required /></div>
    <div class="form-group"><label>Password</label><input id="lg-pass" type="password" autocomplete="current-password" required /></div>
    <div id="lg-error" class="banner banner-warn" style="display:none"></div>
    <button class="btn btn-primary" id="lg-submit" style="width:100%;justify-content:center;margin-top:4px">Sign in</button>
  `;
  const err = form.querySelector('#lg-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('#lg-email').value.trim();
    const pass = form.querySelector('#lg-pass').value;
    const btn = form.querySelector('#lg-submit');
    err.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await signIn(email, pass);
      onSuccess();
    } catch (ex) {
      err.textContent = ex.message || 'Sign in failed.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
  card.appendChild(form);
  wrap.appendChild(card);
  return wrap;
}
