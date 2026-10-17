// Progress window for "Capture all previews" (opened and closed by the background worker).
import { KEY, MSG } from './lib/constants.js';
import { localizePage, loadLang } from './lib/i18n.js';
import { getTranslation } from './lib/translations.js';
import { ybit } from './lib/ybit.js';
import { applyAccent } from './lib/accent.js';
import { getPrefs } from './lib/store.js';

await loadLang();
applyAccent((await getPrefs().catch(() => ({}))).accent);
localizePage();
document.title = getTranslation('sweepPageTitle');
document.getElementById('ybit').append(ybit('happy', 2));

const msg = document.getElementById('msg');
const fill = document.getElementById('fill');
const bar = document.querySelector('.bar');

function show(p) {
  if (!p || !p.running) { msg.textContent = getTranslation('sweepDone'); fill.style.width = '100%'; return; }
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  msg.textContent = getTranslation('sweepTabOf', { current: Math.min(p.done + 1, p.total), total: p.total });
  fill.style.width = pct + '%';
  bar.setAttribute('aria-valuenow', String(pct));
}
chrome.storage.session.get(KEY.SWEEP).then((o) => show(o[KEY.SWEEP]));
chrome.storage.onChanged.addListener((c, area) => { if (area === 'session' && c[KEY.SWEEP]) show(c[KEY.SWEEP].newValue); });
document.getElementById('cancel').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.SWEEP_CANCEL }).catch(() => {});
  msg.textContent = getTranslation('sweepStopping');
});
