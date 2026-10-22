// Progress window for "Capture all previews" (opened and closed by the background worker).
import { KEY, MESSAGE } from './utils/constants.js';
import { localizePage, loadLang, uiLang } from './utils/i18n.js';
import { translate } from './utils/translations.js';
import { ybit } from './utils/ybit.js';
import { applyAccent } from './utils/accent.js';
import { getPreferences } from './utils/store.js';

await loadLang();
applyAccent((await getPreferences().catch(() => ({}))).accent);
localizePage();
document.title = translate('sweepPageTitle');
document.getElementById('ybit').append(ybit('happy', 2));

const message = document.getElementById('msg');
const fill = document.getElementById('fill');
const bar = document.querySelector('.bar');
const left = document.getElementById('left');

// "About 2 min left": the average time per tab so far, times the tabs still to go. Nothing before the first is done.
function timeLeft(progress) {
  const rest = progress.total - progress.done;
  if (!(progress.done > 0 && rest > 0 && progress.startedAt > 0)) return '';
  const seconds = Math.max(1, Math.ceil(((Date.now() - progress.startedAt) / progress.done) * rest / 1000));
  const [count, unit] = seconds < 60 ? [seconds, 'second'] : [Math.ceil(seconds / 60), 'minute'];
  return translate('sweepLeft', { time: new Intl.NumberFormat(uiLang(), { style: 'unit', unit, unitDisplay: 'short' }).format(count) });
}

function show(progress) {
  const estimate = progress && progress.running ? timeLeft(progress) : '';
  left.textContent = estimate;
  left.hidden = !estimate;
  if (!progress || !progress.running) { message.textContent = translate('sweepDone'); fill.style.width = '100%'; return; }
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  message.textContent = translate('sweepTabOf', { current: Math.min(progress.done + 1, progress.total), total: progress.total });
  fill.style.width = percent + '%';
  bar.setAttribute('aria-valuenow', String(percent));
}
chrome.storage.session.get(KEY.SWEEP).then((stored) => show(stored[KEY.SWEEP]));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes[KEY.SWEEP]) show(changes[KEY.SWEEP].newValue); });
document.getElementById('cancel').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MESSAGE.SWEEP_CANCEL }).catch(() => {});
  message.textContent = translate('sweepStopping');
});
