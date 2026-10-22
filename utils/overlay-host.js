// The overlay host: the code that puts the switcher over a page, in an iframe. background.js injects it into
// web pages with chrome.scripting.executeScript({ func: overlayHost }), so both functions must stay self-contained: no imports, no outside variables, everything through arguments
// (executeScript sends only the function's source text).
//
// Runs *inside the web page* (content-script isolated world). Page scripts
// can't see these variables, but they CAN see and restyle the iframe element,
// so: the iframe URL carries nothing sensitive - the one-time launch token is handed
// to the frame with postMessage, addressed to the extension's own origin (if
// the page swaps the frame for something else, the token isn't delivered);
// and the switcher refuses clicks while it's hidden or covered.
// Re-running it replaces the previous overlay cleanly.
// Runs inside the page (isolated world, shared with hotkey.js). One overlay host per page:
//   'standby': prepare an invisible, inert switcher frame ahead of time, so opening only has to read the
//              tabs: its page, code, language and styles are already loaded (switcher.js getLaunch);
//   'launch':  show the switcher with launch `token`, in the prepared frame (or a new one, used as soon as
//              it has loaded). Closing hides it at once and loads a fresh prepared frame for next time.
//              `shotPending`: the background is still taking the page's screenshot (for its card): the frame
//              stays invisible until it says it has ('shot-taken', same token), or SHOT_WAIT ms at most
//              (the background throws away a screenshot that took longer, so it can never picture the overlay).
// A page hidden for STANDBY_DROP_MILLISECONDS drops its prepared frame (memory); the background prepares one again
// when the tab is shown. The frame stays invisible and click-through until the switcher reports it has
// drawn (READY), so a page that blocks it is never left covered by an empty frame.
export function overlayHost(sourceUrl, extensionOrigin, FRAME, mode, token, hold, dropMilliseconds, label = 'Tabazing', shotPending = false) {
  const SHOT_WAIT = 500;
  let host = window.__tabazingOverlay;
  if (host && (!host.launch || !host.frame.isConnected)) { host.cleanup(); host = null; } // an older host, or removed by the page
  if (mode === 'shot-taken') { if (host && host.shotTaken) host.shotTaken(token); return; }
  if (mode === 'standby') { if (!host) create(); return; }
  if (!host || host.active) { if (host) host.cleanup(); host = create(); }
  host.launch(token, hold, shotPending);

  function create() {
    // The shade dims the page behind the switcher: a plain colour (a blur of the whole page cost a full repaint of
    // it on every open, under a switcher that is 90% opaque anyway). It is a separate element *behind* the iframe:
    // a visual effect on the iframe itself would make Chrome report the frame as "not visible", which disables the
    // switcher's clickjacking guard.
    const base = [
      'all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
      'border:0', 'margin:0', 'padding:0', 'z-index:2147483647', 'opacity:0', 'pointer-events:none',
    ];
    const shade = document.createElement('div');
    shade.dataset.testid = 'overlay-shade';
    shade.style.cssText = [...base, 'background:rgba(0,0,0,.55)'].join(';');
    const frame = document.createElement('iframe');
    frame.dataset.testid = 'overlay-frame';
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('allow', 'clipboard-write'); // "Copy links" (the page's own policy can still refuse; the switcher falls back)
    frame.setAttribute('aria-label', label); // what screen readers call the switcher (in the user's language)
    frame.style.cssText = [...base, 'background:transparent', 'color-scheme:normal'].join(';');

    let session = null; // { token, hold, previousFocus, sent, shown, released } while open
    let dropTimer = null;
    const hostHandle = { frame, ready: false, active: false, launch, cleanup, shotTaken };

    const post = (message) => { try { frame.contentWindow.postMessage(message, extensionOrigin); } catch {} };
    const sendLaunch = () => { if (session && hostHandle.ready && !session.sent) { session.sent = true; post({ tabazing: FRAME.LAUNCH, token: session.token }); } };
    // Alt+Q / Alt+W work like Alt+Tab: letting go of Alt switches to the selected tab. Until the switcher
    // has the focus that key-up reaches this page, so it is passed on once the switcher has drawn.
    const tellReleased = () => { if (session && session.hold && session.shown && session.released) post({ tabazing: FRAME.RELEASED }); };
    // Hidden means not rendered at all (visibility), so a prepared frame and its shade cost the page nothing.
    const setShown = (on) => {
      for (const element of [shade, frame]) { // the top layer: shade first, so the frame is above it
        try { if (on && !element.matches(':popover-open')) element.showPopover(); else if (!on && element.matches(':popover-open')) element.hidePopover(); } catch {}
      }
      for (const element of [shade, frame]) { // at once both ways: no fade (it only made opening look slower)
        element.style.visibility = on ? 'visible' : 'hidden';
        element.style.opacity = on ? '1' : '0';
      }
      frame.style.pointerEvents = on ? 'auto' : 'none';
    };
    const dormant = () => { frame.inert = true; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); };
    const freshFrame = () => { hostHandle.ready = false; frame.src = sourceUrl + '?standby=' + Date.now(); };

    function launch(token, hold, shotPending) {
      clearTimeout(dropTimer);
      const hotkey = window.__tabazingHotkey;
      session = {
        token, hold: !!hold, previousFocus: document.activeElement, sent: false, shown: false, drawn: false, light: false,
        shotPending: !!shotPending, shotTimer: shotPending ? setTimeout(() => shotTaken(token), SHOT_WAIT) : null,
        released: !!hold && !!hotkey && typeof hotkey.altState === 'function' && hotkey.altState() === 'up', // a quick tap already over
      };
      hostHandle.active = true;
      frame.inert = false;
      frame.tabIndex = 0;
      frame.removeAttribute('aria-hidden');
      frame.focus();
      sendLaunch();
    }
    // Shown once the switcher has drawn (READY) and the page's screenshot is taken.
    function reveal() {
      if (!session || session.shown || !session.drawn || session.shotPending) return;
      shade.style.background = session.light ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.55)';
      session.shown = true; setShown(true); frame.focus(); tellReleased();
    }
    function shotTaken(forToken) {
      if (!session || session.token !== forToken) return;
      clearTimeout(session.shotTimer);
      session.shotPending = false;
      reveal();
    }
    // Closed (or the tab was hidden): hide at once, give the page its focus back, prepare a fresh frame.
    function finishSession() {
      if (session) clearTimeout(session.shotTimer);
      const previousFocus = session && session.previousFocus;
      session = null;
      hostHandle.active = false;
      setShown(false);
      dormant();
      try { if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true }); } catch {}
      freshFrame();
    }
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || !event.data || typeof event.data.tabazing !== 'string') return;
      const messageType = event.data.tabazing;
      if (messageType === FRAME.STANDBY) { hostHandle.ready = true; sendLaunch(); }
      else if (messageType === FRAME.READY && session) { session.drawn = true; session.light = !!event.data.light; reveal(); }
      else if (messageType === FRAME.CLOSE) finishSession();
    };
    const onKeyUp = (event) => { if (event.isTrusted && event.key === 'Alt' && session && session.hold) { session.released = true; tellReleased(); } };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (hostHandle.active) finishSession();
        clearTimeout(dropTimer);
        dropTimer = setTimeout(() => { if (document.hidden && !hostHandle.active) cleanup(); }, dropMilliseconds);
      } else clearTimeout(dropTimer);
    };
    function cleanup() {
      clearTimeout(dropTimer);
      window.removeEventListener('message', onMessage, true);
      window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
      frame.remove();
      shade.remove();
      if (window.__tabazingOverlay === hostHandle) delete window.__tabazingOverlay;
      if (session) { try { if (session.previousFocus && session.previousFocus.focus) session.previousFocus.focus({ preventScroll: true }); } catch {} }
      session = null;
      hostHandle.active = false;
    }

    window.addEventListener('message', onMessage, true);
    window.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    setShown(false);
    dormant();
    freshFrame();
    shade.popover = frame.popover = 'manual';
    document.documentElement.append(shade, frame);
    window.__tabazingOverlay = hostHandle;
    return hostHandle;
  }
}
export function removeOverlay() {
  if (window.__tabazingOverlay) window.__tabazingOverlay.cleanup();
}
