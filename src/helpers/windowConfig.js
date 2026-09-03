'use strict';
// Pill window geometry and float behaviour. The overlay knowledge here is
// lifted from OpenWhispr's src/helpers/windowConfig.js (MIT,
// github.com/openwhispr/openwhispr) -- three of its scars are load-bearing and
// called out inline.
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const SIZES = {
  collapsed: { width: 232, height: 46 },
  expanded: { width: 420, height: 500 },
};
const MARGIN = 24;

/** Keep a window's whole frame inside one display's work area. Displays of
 *  different sizes leave dead space beside the smaller one, and a window parked
 *  there is invisible even though the window server still reports it on screen.
 *  Clamp to the work area -- never floor at zero, a display above or left of the
 *  primary has a negative origin. */
const clampToWorkArea = (bounds, display) => {
  const wa = display.workArea || display.bounds;
  return {
    ...bounds,
    x: Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - bounds.width)),
    y: Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - bounds.height)),
  };
};

/** Float above everything, on every Space, including over fullscreen apps. */
const applyAlwaysOnTop = (win) => {
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // Without this, setVisibleOnAllWorkspaces flips the process to accessory
      // type and Dock/Command-Tab behaviour silently changes.
      skipTransformProcessType: true,
    });
    win.setFullScreenable(false);
  } else if (process.platform === 'win32') {
    win.setAlwaysOnTop(true, 'pop-up-menu');
  } else {
    win.setAlwaysOnTop(true, 'screen-saver');
  }
};

function createPillWindow() {
  const win = new BrowserWindow({
    ...SIZES.collapsed,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,
    // ponytail: focusable stays true -- the pill owns a reply input, so the
    // non-focusable overlay trick OpenWhispr uses would make it untypable.
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The waveform is a rAF loop in a window that is usually unfocused; a
      // throttled renderer stutters it.
      backgroundThrottling: false,
    },
  });

  applyAlwaysOnTop(win);

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  win.setBounds(clampToWorkArea({
    x: wa.x + wa.width - SIZES.collapsed.width - MARGIN,
    y: wa.y + MARGIN,
    ...SIZES.collapsed,
  }, display));

  return win;
}

/** Grow down-and-left so the pill's top-right corner never moves. */
function resizePill(win, expanded) {
  const b = win.getBounds();
  const size = expanded ? SIZES.expanded : SIZES.collapsed;
  const display = screen.getDisplayMatching(b);
  win.setBounds(clampToWorkArea(
    { x: b.x + b.width - size.width, y: b.y, ...size },
    display
  ));
}

module.exports = { SIZES, createPillWindow, resizePill, clampToWorkArea, applyAlwaysOnTop };
