// ==UserScript==
// @name         YouTube Background Play (Firefox fix port)
// @namespace    https://vgpnk-holdings-llc.github.io/
// @version      1.0.0
// @description  Keeps YouTube (and YouTube Music) playing when the tab is hidden or the screen is locked. Port of the "YouTube Background Playback" Firefox fix for userscript managers (Dguard).
// @author       VeigaPunk
// @match        *://*.youtube.com/*
// @match        *://*.youtube-nocookie.com/*
// @match        *://music.youtube.com/*
// @grant        none
// @run-at       document-start
// @inject-into  page
// @license      MIT
// @downloadURL  https://github.com/AdguardTeam/Userscripts/raw/master/youtubeBackgroundPlay/youtube-background-play.user.js
// @updateURL    https://github.com/AdguardTeam/Userscripts/raw/master/youtubeBackgroundPlay/youtube-background-play.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * 1. Spoof the Page Visibility API
   *    Make the page believe it is ALWAYS visible and focused.
   * --------------------------------------------------------------- */
  const spoofProps = {
    hidden: false,
    webkitHidden: false,
    mozHidden: false,
    msHidden: false,
    visibilityState: 'visible',
    webkitVisibilityState: 'visible',
    hasFocus: true,
  };

  for (const [prop, value] of Object.entries(spoofProps)) {
    try {
      if (prop === 'hasFocus') {
        Document.prototype.hasFocus = () => true;
        continue;
      }
      Object.defineProperty(Document.prototype, prop, {
        get: () => value,
        configurable: true,
      });
    } catch (e) { /* older engines: fall through */ }
  }

  // Extra safety on the instance itself
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  } catch (e) { /* noop */ }

  /* ---------------------------------------------------------------
   * 2. Neutralize visibility / focus events
   *    Intercept listener registration so site handlers never fire
   *    on hidden-state transitions, and kill the events outright.
   * --------------------------------------------------------------- */
  const BLOCKED_EVENTS = new Set([
    'visibilitychange',
    'webkitvisibilitychange',
    'mozvisibilitychange',
    'blur',
    'focusout',
    'pagehide',
    'freeze',
  ]);

  // Kill the events at capture phase before site code sees them
  for (const type of BLOCKED_EVENTS) {
    window.addEventListener(type, (e) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
    }, true);
    document.addEventListener(type, (e) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
    }, true);
  }

  // Wrap addEventListener so listeners registered for blocked events
  // are silently swallowed (YouTube registers its pause logic this way)
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options, ...rest) {
    if (BLOCKED_EVENTS.has(type) && (this === document || this === window)) {
      return; // swallow
    }
    return origAdd.call(this, type, listener, options, ...rest);
  };

  /* ---------------------------------------------------------------
   * 3. Block synthetic "pause" requests driven by visibility state
   *    YouTube calls player.pauseVideo() via its internal API when it
   *    thinks the tab went hidden. Filter those calls when hidden.
   * --------------------------------------------------------------- */
  const isUserGesture = () => {
    // A pause within ~1.5s of a real user interaction is legit
    return (Date.now() - (window.__ytbg_lastGesture || 0)) < 1500;
  };

  for (const t of ['pointerdown', 'keydown', 'touchstart', 'click']) {
    window.addEventListener(t, () => { window.__ytbg_lastGesture = Date.now(); }, true);
  }

  const wrapPause = (proto) => {
    if (!proto || typeof proto.pauseVideo !== 'function') return;
    const orig = proto.pauseVideo;
    proto.pauseVideo = function (...args) {
      if (document.hidden !== false && !isUserGesture()) {
        return; // programmatic pause while "hidden" → ignore
      }
      // With visibility spoofed document.hidden is always false,
      // so gate purely on the gesture heuristic:
      if (!isUserGesture() && window.__ytbg_blockPause === true) {
        return;
      }
      return orig.apply(this, args);
    };
  };

  // Detect transitions to hidden via the real (unspoofed) signal:
  // we can't read document.hidden anymore, so use the page lifecycle —
  // we simply enable pause-blocking permanently; legit pauses come with
  // a user gesture and pass through.
  window.__ytbg_blockPause = true;

  // Hook the movie_player prototype once it exists
  const hookPlayer = () => {
    const player = document.getElementById('movie_player');
    if (player) {
      wrapPause(Object.getPrototypeOf(player));
      return true;
    }
    return false;
  };
  if (!hookPlayer()) {
    const obs = new MutationObserver(() => {
      if (hookPlayer()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------
   * 4. HTMLMediaElement pause() guard (belt & suspenders)
   * --------------------------------------------------------------- */
  const origMediaPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function (...args) {
    if (!isUserGesture()) {
      return; // ignore programmatic pause without user gesture
    }
    return origMediaPause.apply(this, args);
  };

  /* ---------------------------------------------------------------
   * 5. Media Session: keep lock-screen controls alive & resume
   * --------------------------------------------------------------- */
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('pause', () => {
        // Treat lock-screen "pause" as legit only on real gesture;
        // otherwise keep playing.
        if (isUserGesture()) {
          const v = document.querySelector('video');
          if (v) origMediaPause.call(v);
        }
      });
    } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------------
   * 6. Block sendBeacon / heartbeat telemetry that pauses idle watch
   *    (YouTube "Are you still watching?" style triggers)
   * --------------------------------------------------------------- */
  const origBeacon = Navigator.prototype.sendBeacon;
  Navigator.prototype.sendBeacon = function (url, data, ...rest) {
    if (typeof url === 'string' && /\/(player_)?heartbeat|watchtime|pause/i.test(url)) {
      return true; // pretend it sent
    }
    return origBeacon.call(this, url, data, ...rest);
  };

  console.debug('[yt-bg] background playback fix active');
})();
