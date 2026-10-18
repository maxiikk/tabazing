// The overlay host: the code that puts the switcher over a page, in an iframe. Used two ways:
//   - background.js injects it into web pages with chrome.scripting.executeScript({ func: overlayHost });
//   - the New Tab page (newtab.js), which no script can be injected into, imports and calls it itself.
// So both functions must stay self-contained: no imports, no outside variables, everything through arguments
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
// A page hidden for STANDBY_DROP_MS drops its prepared frame (memory); the background prepares one again
// when the tab is shown (the New Tab page prepares its own). The frame stays invisible and click-through until the switcher reports it has
// drawn (READY), so a page that blocks it is never left covered by an empty frame.
export function overlayHost(src, extOrigin, FRAME, mode, token, hold, dropMs, label = 'Tabazing') {
  let host = window.__tabazingOverlay;
  if (host && (!host.launch || !host.frame.isConnected)) { host.cleanup(); host = null; } // an older host, or removed by the page
  if (mode === 'standby') { if (!host) create(); return; }
  if (!host || host.active) { if (host) host.cleanup(); host = create(); }
  host.launch(token, hold);

  function create() {
    // The blur sits on a separate element *behind* the iframe. Putting it on the iframe itself would make
    // Chrome report the frame as "not visible" (a visual effect on an ancestor), which disables the
    // switcher's clickjacking guard.
    const base = [
      'all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
      'border:0', 'margin:0', 'padding:0', 'z-index:2147483647', 'opacity:0', 'pointer-events:none',
    ];
    const shade = document.createElement('div');
    shade.dataset.testid = 'overlay-shade';
    shade.style.cssText = [...base,
      'backdrop-filter:blur(18px) brightness(.45) saturate(1.2)',
      '-webkit-backdrop-filter:blur(18px) brightness(.45) saturate(1.2)',
    ].join(';');
    const frame = document.createElement('iframe');
    frame.dataset.testid = 'overlay-frame';
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('allow', 'clipboard-write'); // "Copy links" (the page's own policy can still refuse; the switcher falls back)
    frame.setAttribute('aria-label', label); // what screen readers call the switcher (in the user's language)
    frame.style.cssText = [...base, 'background:transparent', 'color-scheme:normal'].join(';');

    let session = null; // { token, hold, prevFocus, sent, shown, released } while open
    let dropTimer = null;
    const h = { frame, ready: false, active: false, launch, cleanup };

    const post = (msg) => { try { frame.contentWindow.postMessage(msg, extOrigin); } catch {} };
    const sendLaunch = () => { if (session && h.ready && !session.sent) { session.sent = true; post({ tabazing: FRAME.LAUNCH, token: session.token }); } };
    // Alt+Q / Alt+W work like Alt+Tab: letting go of Alt switches to the selected tab. Until the switcher
    // has the focus that key-up reaches this page, so it is passed on once the switcher has drawn.
    const tellReleased = () => { if (session && session.hold && session.shown && session.released) post({ tabazing: FRAME.RELEASED }); };
    // Hidden means not rendered at all (visibility), so a prepared frame and its blur cost the page nothing.
    const setShown = (on) => {
      for (const el of [shade, frame]) { // the top layer: shade first, so the frame is above it
        try { if (on && !el.matches(':popover-open')) el.showPopover(); else if (!on && el.matches(':popover-open')) el.hidePopover(); } catch {}
      }
      for (const el of [shade, frame]) {
        el.style.transition = on ? 'opacity .12s ease' : 'none'; // fades in (switcher.css, .intro), goes at once
        el.style.visibility = on ? 'visible' : 'hidden';
        el.style.opacity = on ? '1' : '0';
      }
      frame.style.pointerEvents = on ? 'auto' : 'none';
    };
    const dormant = () => { frame.inert = true; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); };
    const freshFrame = () => { h.ready = false; frame.src = src + '?standby=' + Date.now(); };

    function launch(tk, hd) {
      clearTimeout(dropTimer);
      const hk = window.__tabazingHotkey;
      session = {
        token: tk, hold: !!hd, prevFocus: document.activeElement, sent: false, shown: false,
        released: !!hd && !!hk && typeof hk.altState === 'function' && hk.altState() === 'up', // a quick tap already over
      };
      h.active = true;
      frame.inert = false;
      frame.tabIndex = 0;
      frame.removeAttribute('aria-hidden');
      frame.focus();
      sendLaunch();
    }
    // Closed (or the tab was hidden): hide at once, give the page its focus back, prepare a fresh frame.
    function finishSession() {
      const prevFocus = session && session.prevFocus;
      session = null;
      h.active = false;
      setShown(false);
      dormant();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch {}
      freshFrame();
    }
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data.tabazing !== 'string') return;
      const m = e.data.tabazing;
      if (m === FRAME.STANDBY) { h.ready = true; sendLaunch(); }
      else if (m === FRAME.READY && session) {
        const f = e.data.light ? 'blur(18px) brightness(1.06) saturate(1.1)' : 'blur(18px) brightness(.45) saturate(1.2)';
        shade.style.backdropFilter = shade.style.webkitBackdropFilter = f;
        if (!session.shown) { session.shown = true; setShown(true); frame.focus(); tellReleased(); }
      }
      else if (m === FRAME.CLOSE) finishSession();
    };
    const onKeyUp = (e) => { if (e.isTrusted && e.key === 'Alt' && session && session.hold) { session.released = true; tellReleased(); } };
    const onVis = () => {
      if (document.hidden) {
        if (h.active) finishSession();
        clearTimeout(dropTimer);
        dropTimer = setTimeout(() => { if (document.hidden && !h.active) cleanup(); }, dropMs);
      } else clearTimeout(dropTimer);
    };
    function cleanup() {
      clearTimeout(dropTimer);
      window.removeEventListener('message', onMsg, true);
      window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('visibilitychange', onVis, true);
      frame.remove();
      shade.remove();
      if (window.__tabazingOverlay === h) delete window.__tabazingOverlay;
      if (session) { try { if (session.prevFocus && session.prevFocus.focus) session.prevFocus.focus({ preventScroll: true }); } catch {} }
      session = null;
      h.active = false;
    }

    window.addEventListener('message', onMsg, true);
    window.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', onVis, true);
    setShown(false);
    dormant();
    freshFrame();
    shade.popover = frame.popover = 'manual';
    document.documentElement.append(shade, frame);
    window.__tabazingOverlay = h;
    return h;
  }
}
export function removeOverlay() {
  if (window.__tabazingOverlay) window.__tabazingOverlay.cleanup();
}
