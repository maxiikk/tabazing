// Progress window for "Capture all previews" (opened and closed by the background worker).
import { KEY, MSG } from './utils/constants.js';
import { localizePage, loadLang, uiLang } from './utils/i18n.js';
import { t } from './utils/translations.js';
import { ybit } from './utils/ybit.js';
import { applyAccent } from './utils/accent.js';
import { getPrefs } from './utils/store.js';

await loadLang();
applyAccent((await getPrefs().catch(() => ({}))).accent);
localizePage();
document.title = t('sweepPageTitle');
document.getElementById('ybit').append(ybit('happy', 2));

const msg = document.getElementById('msg');
const fill = document.getElementById('fill');
const bar = document.querySelector('.bar');
const left = document.getElementById('left');

// "About 2 min left": the average time per tab so far, times the tabs still to go. Nothing before the first is done.
function timeLeft(p) {
  const rest = p.total - p.done;
  if (!(p.done > 0 && rest > 0 && p.startedAt > 0)) return '';
  const s = Math.max(1, Math.ceil(((Date.now() - p.startedAt) / p.done) * rest / 1000));
  const [n, unit] = s < 60 ? [s, 'second'] : [Math.ceil(s / 60), 'minute'];
  return t('sweepLeft', { time: new Intl.NumberFormat(uiLang(), { style: 'unit', unit, unitDisplay: 'short' }).format(n) });
}

function show(p) {
  const est = p && p.running ? timeLeft(p) : '';
  left.textContent = est;
  left.hidden = !est;
  if (!p || !p.running) { msg.textContent = t('sweepDone'); fill.style.width = '100%'; return; }
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  msg.textContent = t('sweepTabOf', { current: Math.min(p.done + 1, p.total), total: p.total });
  fill.style.width = pct + '%';
  bar.setAttribute('aria-valuenow', String(pct));
}
chrome.storage.session.get(KEY.SWEEP).then((o) => show(o[KEY.SWEEP]));
chrome.storage.onChanged.addListener((c, area) => { if (area === 'session' && c[KEY.SWEEP]) show(c[KEY.SWEEP].newValue); });
document.getElementById('cancel').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.SWEEP_CANCEL }).catch(() => {});
  msg.textContent = t('sweepStopping');
});
