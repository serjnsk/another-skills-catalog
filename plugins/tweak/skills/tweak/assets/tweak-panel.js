/*!
 * Tweak panel — live design tweaks for HTML prototypes.
 * Injected by tweak_server.py at serve time; it never lives in your page source.
 *
 * Model: every change is kept as data (global scales, colour remaps, per-element
 * overrides). The live page is re-rendered from the ORIGINAL source + that data,
 * and "bake" applies the very same data to the raw file and writes it back.
 */
(() => {
  'use strict';
  if (window.__tweakPanel) return;
  window.__tweakPanel = true;

  const ownScript = document.currentScript;
  const pagePath = (() => {
    let p = decodeURIComponent(location.pathname);
    if (p.endsWith('/')) p += 'index.html';
    return p;
  })();
  const LS_KEY = 'tweak:v1:' + pagePath;
  const rawURL = p => '/__tweak/raw' + p.split('/').map(encodeURIComponent).join('/');

  const blank = () => ({ scale: { type: 1, space: 1, radius: 1 }, colors: {}, els: {} });
  const BLANK = JSON.stringify(blank());
  let state = blank();
  let saved = BLANK;
  const undoStack = [];

  let rawHTML = '';
  let srcDoc = null;
  const srcStyles = [];         // { el, orig, index } — <style> blocks that exist in the source file
  const linked = [];            // { link, media, url, path, orig, style } — local stylesheets
  const styleOrig = new Map();  // live element -> original style attribute (null = had none)
  let palette = [];

  // ───────────────────────── CSS rewriting ─────────────────────────

  const RULE = /([^{}]*)\{([^{}]*)\}/g;
  const DECL = /(^|[;{\s])(--[\w-]+|-?[a-zA-Z][\w-]*)(\s*:)([^;]*)/g;
  const LEN = /(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))(px|rem)\b/g;
  const COLOR = /url\([^)]*\)|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|rgba?\([^)]*\)/g;

  const SPACE_PROP = /^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap)$/;
  const RADIUS_PROP = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
  const TYPE_VAR = /^--(?:[\w-]*[-_])?(?:font|fs|text|type|heading|title)(?:[-_\d]|$)/i;
  const RADIUS_VAR = /^--(?:[\w-]*[-_])?(?:radius|rounded|round|corner|br|r)(?:[-_\d]|$)/i;
  const SPACE_VAR = /^--(?:[\w-]*[-_])?(?:space|spacing|spacer|sp|gap|gutter|pad|padding|margin|inset|s)(?:[-_\d]|$)/i;

  function walkCSS(css, inline, fn) {
    const decls = (body, sel) =>
      body.replace(DECL, (m, pre, prop, colon, val) => pre + prop + colon + fn(prop.toLowerCase(), val, sel));
    return inline ? decls(css, '') : css.replace(RULE, (m, sel, body) => sel + '{' + decls(body, sel) + '}');
  }

  // font-size on html/:root drives rem — scaling it too would double-scale rem values
  const isRootSel = sel => sel.replace(/\/\*[\s\S]*?\*\//g, '').split(';').pop()
    .split(',').some(s => /^(html|:root)$/i.test(s.trim()));

  const round = (n, unit) => { const f = unit === 'px' ? 10 : 1000; return String(Math.round(n * f) / f); };
  const scaleLen = (v, k) => v.replace(LEN, (m, n, u) => round(parseFloat(n) * k, u) + u);

  function parseColor(tok) {
    let r, g, b, a = 1;
    if (tok[0] === '#') {
      let h = tok.slice(1);
      if (h.length <= 4) h = [...h].map(c => c + c).join('');
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else {
      const parts = tok.slice(tok.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const ch = s => (s.endsWith('%') ? parseFloat(s) * 2.55 : parseFloat(s));
      [r, g, b] = parts.slice(0, 3).map(ch);
      if (parts[3] != null) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if ([r, g, b, a].some(Number.isNaN)) return null;
    }
    const hx = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return { key: '#' + hx(r) + hx(g) + hx(b), a };
  }

  function formatColor(hex, a) {
    if (a >= 0.999) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${+a.toFixed(3)})`;
  }

  // Colour families: a remap of #2f6fdb also moves rgba(47,111,219,.1) and keeps its alpha.
  const mapColors = v => v.replace(COLOR, tok => {
    if (tok[0] === 'u' || tok[0] === 'U') return tok;
    const c = parseColor(tok);
    const to = c && state.colors[c.key];
    return to ? formatColor(to, c.a) : tok;
  });

  function rewriteValue(prop, val, sel) {
    const S = state.scale;
    let k = 1;
    if (prop.startsWith('--')) {
      if (TYPE_VAR.test(prop)) k = S.type;
      else if (RADIUS_VAR.test(prop)) k = S.radius;
      else if (SPACE_VAR.test(prop)) k = S.space;
    } else if (prop === 'font-size' || prop === 'font') {
      if (!isRootSel(sel)) k = S.type;
    } else if (RADIUS_PROP.test(prop)) k = S.radius;
    else if (SPACE_PROP.test(prop)) k = S.space;
    let v = k !== 1 ? scaleLen(val, k) : val;
    if (hasColorMap()) v = mapColors(v);
    return v;
  }

  const hasColorMap = () => Object.keys(state.colors).length > 0;
  const isActive = () => state.scale.type !== 1 || state.scale.space !== 1 || state.scale.radius !== 1 || hasColorMap();
  const rewriteCSS = (css, inline) => (isActive() ? walkCSS(css, inline, rewriteValue) : css);

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  function setDecls(str, decls) {
    let s = str || '';
    for (const [p, v] of Object.entries(decls)) {
      s = s.replace(new RegExp('(^|;)\\s*' + escapeRe(p) + '\\s*:[^;]*', 'gi'), '$1');
      s = s.replace(/;\s*;/g, ';').replace(/^\s*;/, '').trim();
      if (s && !s.endsWith(';')) s += ';';
      s += (s ? ' ' : '') + p + ': ' + v + ';';
    }
    return s;
  }

  const rebase = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) =>
    /^(data:|[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u) ? m : `url(${q}${new URL(u, base).href}${q})`);

  // ───────────────────────── element identity ─────────────────────────

  function pathOf(el) {
    const path = [];
    while (el && el !== document.body) {
      const parent = el.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, el));
      el = parent;
    }
    return el === document.body ? path : null;
  }
  const keyOf = path => (path.length ? path.join('.') : 'body');
  const depthOf = key => (key === 'body' ? 0 : key.split('.').length);

  function resolve(doc, sel) {
    let el = doc.body;
    for (const i of sel.path) el = el && el.children[i];
    if (el && el.tagName === sel.tag) return el;
    if (sel.id) {
      const alt = doc.getElementById(sel.id);
      if (alt && alt.tagName === sel.tag) return alt;
    }
    return null;
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  }
  const snippet = el => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 36 ? t.slice(0, 36) + '…' : t;
  };

  function entryFor(el, create) {
    const path = pathOf(el);
    if (!path) return null;
    const key = keyOf(path);
    if (!state.els[key] && create) {
      state.els[key] = { sel: { path, tag: el.tagName, id: el.id || '', label: describe(el), text: snippet(el) }, style: {}, html: null, hidden: false };
    }
    return state.els[key] || null;
  }

  function prune() {
    for (const [k, e] of Object.entries(state.els)) {
      if (!e.hidden && e.html == null && !Object.keys(e.style).length) delete state.els[k];
    }
  }

  const isOurs = el => el === host || el === ownScript;

  function captureStyleAttrs() {
    for (const el of document.querySelectorAll('[style]')) {
      if (!styleOrig.has(el) && !isOurs(el)) styleOrig.set(el, el.getAttribute('style'));
    }
  }

  const originalHTML = sel => { const el = srcDoc && resolve(srcDoc, sel); return el ? el.innerHTML : null; };

  // Text edits replace innerHTML, so they are applied/reverted explicitly (shallow first).
  function syncText(prev, next) {
    const keys = new Set([...Object.keys(prev.els), ...Object.keys(next.els)]);
    [...keys].sort((a, b) => depthOf(a) - depthOf(b)).forEach(k => {
      const a = prev.els[k] ? prev.els[k].html : null;
      const b = next.els[k] ? next.els[k].html : null;
      if (a === b) return;
      const sel = (next.els[k] || prev.els[k]).sel;
      const el = resolve(document, sel);
      const html = b != null ? b : originalHTML(sel);
      if (el && html != null) el.innerHTML = html;
    });
    captureStyleAttrs();
  }

  // Recorded HTML must hold the source-level style attributes of descendants, not the live rewritten ones.
  function cleanHTML(el) {
    const clone = el.cloneNode(true);
    const copy = clone.querySelectorAll('*');
    el.querySelectorAll('*').forEach((n, i) => {
      if (!styleOrig.has(n)) return;
      const o = styleOrig.get(n);
      if (o == null) copy[i].removeAttribute('style'); else copy[i].setAttribute('style', o);
    });
    return clone.innerHTML;
  }

  // ───────────────────────── live rendering ─────────────────────────

  function applyStyles() {
    for (const s of srcStyles) {
      const t = rewriteCSS(s.orig);
      if (s.el.textContent !== t) s.el.textContent = t;
    }
    for (const l of linked) {
      const t = rewriteCSS(l.orig);
      if (t === l.orig) {
        if (l.style.isConnected) {
          l.style.remove();
          if (l.media == null) l.link.removeAttribute('media'); else l.link.setAttribute('media', l.media);
        }
      } else {
        if (!l.style.isConnected) l.link.after(l.style);
        const r = rebase(t, l.url);
        if (l.style.textContent !== r) l.style.textContent = r;
        l.link.setAttribute('media', 'not all');
      }
    }
    const over = new Map();
    for (const e of Object.values(state.els)) {
      const el = resolve(document, e.sel);
      if (!el) continue;
      over.set(el, e);
      if (!styleOrig.has(el)) styleOrig.set(el, el.getAttribute('style'));
    }
    for (const [el, orig] of styleOrig) {
      if (!el.isConnected) { styleOrig.delete(el); continue; }
      let s = orig == null ? '' : rewriteCSS(orig, true);
      const e = over.get(el);
      if (e) s = setDecls(s, e.hidden ? { ...e.style, display: 'none !important' } : e.style);
      if (orig == null && !s) { if (el.hasAttribute('style')) el.removeAttribute('style'); }
      else if (el.getAttribute('style') !== s) el.setAttribute('style', s);
    }
    drawBoxes();
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyStyles(); }); };

  // ───────────────────────── history & persistence ─────────────────────────

  function persist() {
    try { saved === BLANK ? localStorage.removeItem(LS_KEY) : localStorage.setItem(LS_KEY, saved); } catch (e) { /* storage blocked */ }
  }

  function commit() {
    prune();
    const now = JSON.stringify(state);
    if (now === saved) return;
    undoStack.push(saved);
    if (undoStack.length > 300) undoStack.shift();
    saved = now;
    persist();
    renderMeta();
  }

  function setState(next) {
    const prev = state;
    state = next;
    syncText(prev, state);
    applyStyles();
    if (selected && !selected.isConnected) selected = null;
    renderAll();
  }

  function undo() {
    if (!undoStack.length) return;
    if (editing) finishEdit(false);
    const prevSaved = undoStack.pop();
    setState(JSON.parse(prevSaved));
    saved = prevSaved;
    persist();
    renderMeta();
  }

  function resetAll() {
    if (editing) finishEdit(false);
    setState(blank());
    commit();
    toast('Все правки сброшены · ⌘Z — вернуть');
  }

  // ───────────────────────── UI ─────────────────────────

  const GLOBALS = [
    ['type', 'Шрифт', 50, 200],
    ['space', 'Отступы', 0, 300],
    ['radius', 'Скругление', 0, 300],
  ];
  const EL_SLIDERS = [
    ['fs', 'Размер текста', ['font-size'], 6, 120, cs => cs.fontSize],
    ['py', 'Внутр. отступ ↕', ['padding-top', 'padding-bottom'], 0, 120, cs => (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) / 2],
    ['px', 'Внутр. отступ ↔', ['padding-left', 'padding-right'], 0, 120, cs => (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) / 2],
    ['mt', 'Отступ сверху', ['margin-top'], 0, 160, cs => cs.marginTop],
    ['mb', 'Отступ снизу', ['margin-bottom'], 0, 160, cs => cs.marginBottom],
    ['br', 'Скругление', ['border-radius'], 0, 80, cs => cs.borderTopLeftRadius],
  ];
  const WEIGHTS = [300, 400, 500, 600, 700, 800];
  const ALIGNS = [['left', 'Слева'], ['center', 'Центр'], ['right', 'Справа']];

  const CSS = `
:host{all:initial;position:fixed;left:0;top:0;z-index:2147483647}
*{box-sizing:border-box}
[hidden]{display:none!important}
.panel{color-scheme:dark;position:fixed;top:16px;right:16px;width:292px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#242424;color:#ececec;border:1px solid #3a3a3a;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;overflow:hidden;user-select:none;-webkit-user-select:none}
.hd{display:flex;align-items:center;gap:4px;padding:12px 10px 8px 16px;cursor:grab}
.hd b{flex:1;font-size:16px;font-weight:650;letter-spacing:-.01em}
.icon{width:26px;height:26px;border:0;background:transparent;color:#9a9a9a;border-radius:7px;cursor:pointer;font:15px/1 inherit;display:grid;place-items:center;padding:0}
.icon:hover:not(:disabled){background:#333;color:#fff}
.icon:disabled{opacity:.3;cursor:default}
.body{overflow:auto;padding:0 16px 6px;overscroll-behavior:contain}
.sec{padding:12px 0;border-top:1px solid #333}
.sec:first-child{border-top:0;padding-top:4px}
h4{margin:0 0 6px;font-size:13px;font-weight:600;color:#fff;display:flex;gap:6px}
h4 small{color:#888;font-weight:400}
.row{margin:8px 0 10px}
.lbl{display:flex;justify-content:space-between;color:#a8a8a8;margin-bottom:5px}
.lbl output{color:#eee;font-variant-numeric:tabular-nums}
input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:18px;margin:0;background:transparent;cursor:pointer;--p:50%}
input[type=range]:focus{outline:none}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(#b5b5b5,#b5b5b5) 0/var(--p) 100% no-repeat,#474747}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;margin-top:-7px;border-radius:50%;background:#f3f3f3;box-shadow:0 1px 4px rgba(0,0,0,.5)}
input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:#474747}
input[type=range]::-moz-range-progress{height:4px;border-radius:2px;background:#b5b5b5}
input[type=range]::-moz-range-thumb{width:18px;height:18px;border:0;border-radius:50%;background:#f3f3f3}
button{font:inherit;color:inherit}
.btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid #444;background:#2c2c2c;color:#eee;cursor:pointer;white-space:nowrap}
.btn:hover:not(:disabled){background:#353535}
.btn.on{background:#3b3f47;border-color:#8b919c;color:#fff}
.btn.primary{background:#f3f3f3;border-color:#f3f3f3;color:#1a1a1a;font-weight:600}
.btn.primary:hover:not(:disabled){background:#fff}
.btn:disabled{opacity:.45;cursor:default}
.wide{width:100%}
.seg{display:flex;gap:4px;margin:8px 0}
.seg .btn{flex:1;height:28px;padding:0;font-size:12px}
.sw-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px}
.sw{position:relative;aspect-ratio:1;border-radius:7px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);cursor:pointer}
.sw input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0}
.sw.changed::after{content:"";position:absolute;right:-3px;top:-3px;width:9px;height:9px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #242424}
.hint{color:#858585;font-size:11.5px;margin-top:7px}
.empty{color:#858585;font-size:12px}
.crumb{display:flex;align-items:center;gap:4px;background:#1b1b1b;border-radius:8px;padding:4px 4px 4px 10px;margin:10px 0 4px}
.crumb code{flex:1;min-width:0;font:12px/1.4 ui-monospace,Menlo,monospace;color:#9cc4ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.colors2{display:flex;gap:10px;align-items:center;margin:10px 0 6px}
.cpick{display:flex;align-items:center;gap:7px;color:#a8a8a8;flex:1}
.chip{position:relative;width:30px;height:22px;border-radius:6px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
.chip input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0}
.chip.none{background:repeating-conic-gradient(#555 0 25%,#333 0 50%) 0 0/8px 8px!important}
.actions{display:flex;gap:6px;margin-top:10px}
.actions .btn{flex:1;padding:0 6px}
.hid{display:flex;align-items:center;gap:8px;padding:3px 0;color:#bbb}
.hid span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hid .btn{height:26px;font-size:12px;padding:0 10px}
.ft{display:flex;align-items:center;gap:6px;padding:12px 12px 12px 16px;border-top:1px solid #333}
.ft .sp{flex:1}
.link{white-space:nowrap;background:none;border:0;color:#9a9a9a;cursor:pointer;padding:4px 0}
.link:hover{color:#fff}
.min .body,.min .ft{display:none}
.fab{position:fixed;right:16px;bottom:16px;height:36px;padding:0 14px;border-radius:18px;border:1px solid #444;background:#242424;color:#eee;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.box{position:fixed;left:0;top:0;pointer-events:none;display:none;border-radius:2px}
.hover{outline:1.5px dashed #4c8dff;background:rgba(76,141,255,.07)}
.selb{outline:2px solid #4c8dff;outline-offset:1px}
.selb.editing{outline-color:#ffb020}
.tag{position:absolute;left:-3px;bottom:100%;margin-bottom:5px;background:#4c8dff;color:#fff;font:11px/1 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:4px;white-space:nowrap}
.tag.inside{bottom:auto;top:3px;left:3px;margin:0}
.editing .tag{background:#ffb020;color:#111}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,90vw);background:#111;color:#fff;padding:10px 14px;border-radius:10px;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
`;

  const range = (attrs, min, max, value) =>
    `<input type="range" min="${min}" max="${max}" step="1" value="${value}" ${attrs}>`;

  const host = document.createElement('tweak-panel');
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>${CSS}</style>
<div class="panel">
  <div class="hd"><b>Tweaks</b>
    <button class="icon" data-act="min" title="Свернуть">–</button>
    <button class="icon" data-act="close" title="Скрыть панель (Alt+T)">✕</button>
  </div>
  <div class="body">
    <div class="sec">
      <h4>Общее</h4>
      ${GLOBALS.map(([k, label, min, max]) => `<div class="row"><div class="lbl"><span>${label}</span><output data-gout="${k}">100%</output></div>${range(`data-g="${k}" title="Двойной клик — 100%"`, min, max, 100)}</div>`).join('')}
    </div>
    <div class="sec">
      <h4>Цвета</h4>
      <div class="sw-grid" data-palette></div>
      <div class="hint">Клик — заменить цвет по всей странице · правый клик — вернуть</div>
    </div>
    <div class="sec">
      <h4>Элемент</h4>
      <button class="btn wide" data-act="pick">◎ Выбрать элемент</button>
      <div class="hint" data-elhint>Клик — выбрать · двойной клик — править текст · Delete — скрыть · Esc — выйти</div>
      <div data-el hidden>
        <div class="crumb"><code data-eltag></code><button class="icon" data-act="parent" title="Выбрать родителя">↑</button></div>
        ${EL_SLIDERS.slice(0, 1).map(elSlider).join('')}
        <div class="seg">${WEIGHTS.map(w => `<button class="btn" data-act="weight" data-v="${w}" style="font-weight:${w}">${w}</button>`).join('')}</div>
        <div class="seg">${ALIGNS.map(([v, l]) => `<button class="btn" data-act="align" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="colors2">
          <label class="cpick"><span class="chip" data-chip="color"><input type="color" data-ec="color"></span>Текст</label>
          <label class="cpick"><span class="chip" data-chip="background"><input type="color" data-ec="background"></span>Фон</label>
          <button class="icon" data-act="bgclear" title="Убрать заливку фона">∅</button>
        </div>
        ${EL_SLIDERS.slice(1).map(elSlider).join('')}
        <div class="actions">
          <button class="btn" data-act="text">✎ Текст</button>
          <button class="btn" data-act="hide">Скрыть</button>
          <button class="btn" data-act="elreset">Сброс</button>
        </div>
      </div>
    </div>
    <div class="sec" data-hidsec hidden>
      <h4>Скрытые <small data-hidcount></small></h4>
      <div data-hidlist></div>
      <div class="hint">При сохранении скрытые элементы удаляются из файла</div>
    </div>
  </div>
  <div class="ft">
    <button class="link" data-act="reset">Сбросить всё</button>
    <button class="icon" data-act="undo" title="Отменить (⌘Z)">↶</button>
    <span class="sp"></span>
    <button class="btn primary" data-act="bake">Сохранить в файл</button>
  </div>
</div>
<button class="fab" data-act="open" hidden>Tweaks</button>
<div class="box hover"></div>
<div class="box selb"><span class="tag"></span></div>
<div class="toast"></div>`;

  function elSlider([k, label, , min, max]) {
    return `<div class="row"><div class="lbl"><span>${label}</span><output data-esout="${k}"></output></div>${range(`data-es="${k}"`, min, max, min)}</div>`;
  }

  const $ = s => ui.querySelector(s);
  const $$ = s => [...ui.querySelectorAll(s)];
  const panel = $('.panel');
  const hoverBox = $('.box.hover');
  const selBox = $('.box.selb');
  const selTag = $('.tag');
  const toastEl = $('.toast');

  let picking = false;
  let hovered = null;
  let selected = null;
  let editing = null;
  let ready = false;

  function setRange(input, v) {
    input.value = v;
    const min = +input.min, max = +input.max;
    input.style.setProperty('--p', ((Math.min(max, Math.max(min, v)) - min) / (max - min) * 100) + '%');
  }

  let toastTimer = 0;
  function toast(msg, ms = 3200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function renderGlobals() {
    for (const [k] of GLOBALS) {
      const pct = Math.round(state.scale[k] * 100);
      setRange($(`[data-g="${k}"]`), pct);
      $(`[data-gout="${k}"]`).textContent = pct + '%';
    }
  }

  function renderPalette() {
    const grid = $('[data-palette]');
    grid.textContent = '';
    if (!palette.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'В CSS страницы не найдено цветов';
      grid.appendChild(p);
      return;
    }
    for (const c of palette) {
      const cur = state.colors[c.key] || c.key;
      const sw = document.createElement('label');
      sw.className = 'sw' + (state.colors[c.key] ? ' changed' : '');
      sw.style.background = cur;
      sw.title = (c.name ? c.name + ' · ' : '') + c.key + (state.colors[c.key] ? ' → ' + cur : '') + ` · ${c.n}×`;
      sw.dataset.key = c.key;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = cur;
      input.dataset.pal = c.key;
      sw.appendChild(input);
      grid.appendChild(sw);
    }
  }

  function renderEl() {
    const box = $('[data-el]');
    $('[data-act="pick"]').classList.toggle('on', picking);
    $('[data-act="pick"]').textContent = picking ? '◉ Выбор включён · Esc — выйти' : '◎ Выбрать элемент';
    $('[data-elhint]').hidden = !!selected;
    box.hidden = !selected;
    if (!selected) return;
    const e = entryFor(selected, false);
    $('[data-eltag]').textContent = describe(selected) + (snippet(selected) ? '  “' + snippet(selected) + '”' : '');
    const cs = getComputedStyle(selected);
    for (const [k, , , min, max, read] of EL_SLIDERS) {
      const v = Math.round(parseFloat(read(cs)) || 0);
      const input = $(`[data-es="${k}"]`);
      input.max = Math.max(max, v * 2);
      input.min = Math.min(min, v);
      setRange(input, v);
      $(`[data-esout="${k}"]`).textContent = v + 'px';
    }
    const w = +cs.fontWeight;
    $$('[data-act="weight"]').forEach(b => b.classList.toggle('on', +b.dataset.v === w));
    $$('[data-act="align"]').forEach(b => b.classList.toggle('on', b.dataset.v === cs.textAlign || (b.dataset.v === 'left' && cs.textAlign === 'start')));
    const col = parseColor(cs.color);
    const bg = parseColor(cs.backgroundColor);
    const ci = $('[data-ec="color"]');
    const bi = $('[data-ec="background"]');
    ci.value = col ? col.key : '#000000';
    $('[data-chip="color"]').style.background = ci.value;
    const noBg = !bg || bg.a === 0;
    bi.value = noBg ? '#ffffff' : bg.key;
    $('[data-chip="background"]').style.background = noBg ? '' : bi.value;
    $('[data-chip="background"]').classList.toggle('none', noBg);
    $('[data-act="bgclear"]').disabled = !(e && e.style.background);
    $('[data-act="text"]').textContent = editing ? '✓ Готово' : '✎ Текст';
    $('[data-act="elreset"]').disabled = !e;
  }

  function renderHidden() {
    const hidden = Object.entries(state.els).filter(([, e]) => e.hidden);
    $('[data-hidsec]').hidden = !hidden.length;
    $('[data-hidcount]').textContent = hidden.length ? '· ' + hidden.length : '';
    const list = $('[data-hidlist]');
    list.textContent = '';
    for (const [key, e] of hidden) {
      const row = document.createElement('div');
      row.className = 'hid';
      const label = document.createElement('span');
      label.textContent = e.sel.label + (e.sel.text ? ' “' + e.sel.text + '”' : '');
      label.title = label.textContent;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Вернуть';
      btn.dataset.act = 'unhide';
      btn.dataset.key = key;
      row.append(label, btn);
      list.appendChild(row);
    }
  }

  function renderMeta() {
    $('[data-act="undo"]').disabled = !undoStack.length;
    renderHidden();
  }

  function renderAll() {
    renderGlobals();
    renderPalette();
    renderEl();
    renderMeta();
    drawBoxes();
  }

  // ─── overlay boxes ───
  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return null; }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = 'none'; return null; }
    box.style.display = 'block';
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    return r;
  }
  function drawBoxes() {
    place(hoverBox, picking && hovered !== selected ? hovered : null);
    const r = place(selBox, selected);
    selBox.classList.toggle('editing', !!editing);
    if (r) {
      selTag.textContent = editing ? 'правка текста · Enter — готово · Esc — отмена' : describe(selected);
      selTag.classList.toggle('inside', r.top < 26);
    }
  }

  // ─── picking ───
  const cursorStyle = document.createElement('style');
  cursorStyle.textContent = '*{cursor:crosshair!important}';

  function setPicking(on) {
    picking = on;
    if (on) document.head.appendChild(cursorStyle); else cursorStyle.remove();
    if (!on) hovered = null;
    renderEl();
    drawBoxes();
  }

  function normalizeTarget(t) {
    if (!(t instanceof Element) || isOurs(t)) return null;
    if (t instanceof SVGElement && t.tagName.toLowerCase() !== 'svg') t = t.closest('svg') || t;
    if (t === document.documentElement || t === document.head || !document.body.contains(t)) return document.body;
    return t;
  }

  function select(el) {
    if (editing && editing.el !== el) finishEdit(true);
    selected = el;
    renderEl();
    drawBoxes();
  }

  const inUI = e => e.composedPath().includes(host);
  const insideEditing = e => editing && editing.el.contains(e.target);

  window.addEventListener('mousemove', e => {
    if (!picking) return;
    hovered = inUI(e) ? null : normalizeTarget(e.target);
    drawBoxes();
  }, true);

  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']) {
    window.addEventListener(type, e => {
      if (!picking || inUI(e) || insideEditing(e)) return;
      if (type !== 'touchstart') e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }

  window.addEventListener('click', e => {
    if (!picking || inUI(e) || insideEditing(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = normalizeTarget(e.target);
    if (t) select(t);
  }, true);

  window.addEventListener('dblclick', e => {
    if (!picking || inUI(e) || insideEditing(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = normalizeTarget(e.target);
    if (!t || t === document.body) return;
    select(t);
    startEdit(t);
  }, true);

  window.addEventListener('keydown', e => {
    if (!ready) return;
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
      e.stopImmediatePropagation();
      return;
    }
    if (e.altKey && e.code === 'KeyT') { e.preventDefault(); togglePanel(); return; }
    const t = e.composedPath()[0];
    const typing = t && t.nodeType === 1 && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
      (t.tagName === 'INPUT' && !/^(range|color|button|checkbox|radio)$/.test(t.type)));
    if (typing) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === 'KeyZ') {
      if (undoStack.length) { e.preventDefault(); e.stopImmediatePropagation(); undo(); }
      return;
    }
    if (e.key === 'Escape') {
      if (picking) setPicking(false); else if (selected) select(null);
      return;
    }
    if (picking && selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideSelected();
    }
  }, true);

  const redraw = () => { if (selected || hovered) requestAnimationFrame(drawBoxes); };
  window.addEventListener('scroll', redraw, { capture: true, passive: true });
  window.addEventListener('resize', redraw);

  // ─── text editing ───
  // Only text-bearing elements (text plus inline children); editing a card container would wipe its layout.
  const canEditText = el => el !== document.body && el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    !!el.textContent.trim() && [...el.children].every(c => c.tagName === 'BR' || getComputedStyle(c).display.startsWith('inline'));

  function startEdit(el) {
    if (editing) finishEdit(true);
    if (!canEditText(el)) { toast('Здесь нет простого текста — выберите сам заголовок или абзац (↑ / клик точнее)'); return; }
    editing = { el, before: el.innerHTML, attr: el.getAttribute('contenteditable'), plain: !el.children.length, nodes: new Set(el.querySelectorAll('*')) };
    el.setAttribute('contenteditable', 'plaintext-only');
    if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
    el.focus({ preventScroll: true });
    // select everything: typing replaces the text, a click places the caret
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.addEventListener('blur', onEditBlur);
    el.addEventListener('input', drawBoxes);
    renderEl();
    drawBoxes();
  }

  function onEditBlur() {
    // clicks on the panel shouldn't lose the edit; commit it
    if (editing) finishEdit(true);
  }

  // Browsers "helpfully" keep typing style as <font>/<span style>; strip what the edit added.
  function tidyEdited({ el, plain, nodes }) {
    if (plain) {
      const lines = el.innerText.replace(/\n$/, '').split('\n');
      el.textContent = '';
      lines.forEach((line, i) => {
        if (i) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
      return;
    }
    for (const n of [...el.querySelectorAll('font, span')]) if (!nodes.has(n)) n.replaceWith(...n.childNodes);
    el.normalize();
  }

  function finishEdit(keep) {
    const ed = editing;
    const { el, before, attr } = ed;
    editing = null;
    el.removeEventListener('blur', onEditBlur);
    el.removeEventListener('input', drawBoxes);
    if (keep && el.innerHTML !== before) tidyEdited(ed);
    if (attr == null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', attr);
    const sel = getSelection();
    if (sel && el.contains(sel.anchorNode)) sel.removeAllRanges();
    if (!keep) {
      el.innerHTML = before;
      captureStyleAttrs();
      applyStyles();
    } else if (el.innerHTML !== before) {
      const e = entryFor(el, true);
      if (e) {
        e.html = cleanHTML(el);
        if (e.html === originalHTML(e.sel)) e.html = null;
        commit();
      }
    }
    renderEl();
    drawBoxes();
  }

  // ─── element actions ───
  function hideSelected() {
    if (!selected || selected === document.body) return;
    const e = entryFor(selected, true);
    if (!e) return;
    e.sel.text = snippet(selected);
    e.hidden = true;
    selected = null;
    applyStyles();
    commit();
    renderEl();
    toast('Скрыто · ⌘Z — вернуть');
  }

  function setElStyle(props, value, live) {
    if (!selected) return;
    const e = entryFor(selected, true);
    if (!e) return;
    for (const p of props) {
      if (value == null) delete e.style[p]; else e.style[p] = value;
    }
    if (live) schedule(); else { applyStyles(); commit(); renderEl(); }
  }

  function togglePanel(show) {
    const visible = show != null ? show : panel.hidden;
    panel.hidden = !visible;
    $('.fab').hidden = visible;
    if (!visible && picking) setPicking(false);
  }

  // ─── panel events ───
  // keep focus (and an in-progress text edit) where it is when panel buttons are pressed
  ui.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

  ui.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const v = b.dataset.v;
    switch (b.dataset.act) {
      case 'min': panel.classList.toggle('min'); break;
      case 'close': togglePanel(false); break;
      case 'open': togglePanel(true); break;
      case 'pick': setPicking(!picking); break;
      case 'parent':
        if (selected && selected !== document.body) select(normalizeTarget(selected.parentElement));
        break;
      case 'weight': setElStyle(['font-weight'], v); break;
      case 'align': setElStyle(['text-align'], v); break;
      case 'bgclear': setElStyle(['background'], null); break;
      case 'text':
        if (editing) finishEdit(true); else if (selected && selected !== document.body) startEdit(selected);
        break;
      case 'hide': hideSelected(); break;
      case 'elreset': {
        if (!selected) break;
        const path = pathOf(selected);
        if (!path) break;
        const next = JSON.parse(JSON.stringify(state));
        delete next.els[keyOf(path)];
        setState(next);
        commit();
        break;
      }
      case 'unhide': {
        const e = state.els[b.dataset.key];
        if (e) { e.hidden = false; applyStyles(); commit(); }
        break;
      }
      case 'undo': undo(); break;
      case 'reset': resetAll(); break;
      case 'bake': bake(); break;
    }
  });

  ui.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.g) {
      const k = t.dataset.g;
      state.scale[k] = +t.value / 100;
      setRange(t, +t.value);
      $(`[data-gout="${k}"]`).textContent = t.value + '%';
      schedule();
    } else if (t.dataset.es) {
      const spec = EL_SLIDERS.find(s => s[0] === t.dataset.es);
      setRange(t, +t.value);
      $(`[data-esout="${spec[0]}"]`).textContent = t.value + 'px';
      setElStyle(spec[2], t.value + 'px', true);
    } else if (t.dataset.pal) {
      const key = t.dataset.pal;
      if (t.value.toLowerCase() === key) delete state.colors[key]; else state.colors[key] = t.value.toLowerCase();
      t.parentElement.style.background = t.value;
      t.parentElement.classList.toggle('changed', !!state.colors[key]);
      schedule();
    } else if (t.dataset.ec) {
      const chip = t.parentElement;
      chip.style.background = t.value;
      chip.classList.remove('none');
      setElStyle([t.dataset.ec], t.value, true);
    }
  });

  ui.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.g || t.dataset.es || t.dataset.pal || t.dataset.ec) {
      commit();
      if (t.dataset.pal) renderPalette();
      if (t.dataset.g) renderEl();
      if (t.dataset.ec) renderEl();
    }
  });

  ui.addEventListener('dblclick', e => {
    const t = e.target;
    if (t.dataset && t.dataset.g) {
      state.scale[t.dataset.g] = 1;
      renderGlobals();
      applyStyles();
      commit();
    }
  });

  ui.addEventListener('contextmenu', e => {
    const sw = e.target.closest('.sw');
    if (!sw) return;
    e.preventDefault();
    if (!state.colors[sw.dataset.key]) return;
    delete state.colors[sw.dataset.key];
    applyStyles();
    commit();
    renderPalette();
  });

  // drag the panel by its header
  $('.hd').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const hd = e.currentTarget;
    hd.setPointerCapture(e.pointerId);
    hd.style.cursor = 'grabbing';
    const move = ev => {
      panel.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px';
      panel.style.right = 'auto';
    };
    const up = () => {
      hd.style.cursor = '';
      hd.removeEventListener('pointermove', move);
      hd.removeEventListener('pointerup', up);
    };
    hd.addEventListener('pointermove', move);
    hd.addEventListener('pointerup', up);
  });

  // ───────────────────────── bake ─────────────────────────

  // Drop the element together with the indentation in front of it, so no blank line is left behind.
  function removeClean(el) {
    const prev = el.previousSibling, next = el.nextSibling;
    if (prev && prev.nodeType === 3 && !prev.data.trim() && (!next || (next.nodeType === 3 && /^\s/.test(next.data)))) prev.remove();
    el.remove();
  }

  const openTag = el => el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);

  // Splice the new <head>/<body> contents into the raw file so everything outside them
  // (doctype, comments, formatting around the tags) stays byte-for-byte the same.
  function serialize(doc) {
    const full = () => {
      const doctype = (rawHTML.match(/^\s*(<!doctype[^>]*>)/i) || [])[1];
      return (doctype ? doctype + '\n' : '') + doc.documentElement.outerHTML + '\n';
    };
    const lower = rawHTML.toLowerCase();
    const hOpen = /<head(\s[^>]*)?>/i.exec(rawHTML);
    const bOpen = /<body(\s[^>]*)?>/i.exec(rawHTML);
    const hClose = lower.indexOf('</head');
    const bClose = lower.lastIndexOf('</body');
    if (!hOpen || !bOpen || hClose < 0 || bClose < 0) return full();
    const hs = hOpen.index + hOpen[0].length;
    const bs = bOpen.index + bOpen[0].length;
    if (!(hs <= hClose && hClose < bOpen.index && bs <= bClose)) return full();
    if (openTag(doc.documentElement) !== openTag(srcDoc.documentElement) || openTag(doc.head) !== openTag(srcDoc.head)) return full();
    const bodyTag = openTag(doc.body) === openTag(srcDoc.body) ? bOpen[0] : openTag(doc.body);
    const fit = (fresh, old) => fresh.replace(/\s*$/, old.match(/\s*$/)[0]);
    return rawHTML.slice(0, hs) + fit(doc.head.innerHTML, rawHTML.slice(hs, hClose)) +
      rawHTML.slice(hClose, bOpen.index) + bodyTag + fit(doc.body.innerHTML, rawHTML.slice(bs, bClose)) +
      rawHTML.slice(bClose);
  }

  async function bake() {
    if (editing) finishEdit(true);
    commit();
    if (saved === BLANK) { toast('Нет изменений для сохранения'); return; }
    const btn = $('[data-act="bake"]');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    try {
      const fresh = await (await fetch(rawURL(pagePath), { cache: 'no-store' })).text();
      if (fresh !== rawHTML) {
        throw new Error('файл изменился на диске после открытия страницы. Обновите страницу (правки не потеряются) и сохраните снова.');
      }
      const doc = new DOMParser().parseFromString(rawHTML, 'text/html');
      const docStyles = doc.querySelectorAll('style');
      for (const s of srcStyles) docStyles[s.index].textContent = rewriteCSS(s.orig);

      const entries = Object.values(state.els);
      let missing = 0;
      entries.filter(e => e.html != null)
        .sort((a, b) => a.sel.path.length - b.sel.path.length)
        .forEach(e => { const el = resolve(doc, e.sel); if (el) el.innerHTML = e.html; else missing++; });

      doc.querySelectorAll('[style]').forEach(el => el.setAttribute('style', rewriteCSS(el.getAttribute('style'), true)));

      const targets = entries.map(e => [e, resolve(doc, e.sel)]);
      for (const [e, el] of targets) {
        if (!el) { if (e.html == null) missing++; continue; }
        if (Object.keys(e.style).length) el.setAttribute('style', setDecls(el.getAttribute('style') || '', e.style));
      }
      for (const [e, el] of targets) if (el && e.hidden) removeClean(el);

      const files = [{ path: pagePath, content: serialize(doc) }];
      for (const l of linked) {
        const t = rewriteCSS(l.orig);
        if (t !== l.orig) files.push({ path: l.path, content: t });
      }

      const res = await fetch('/__tweak/bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tweak': '1' },
        body: JSON.stringify({ files }),
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || 'сервер отказал');
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      ready = false;
      toast('Сохранено: ' + out.files.join(', ') +
        (missing ? ` · не удалось перенести правок: ${missing}` : '') +
        ` · копия: ${out.backup}`, 5000);
      setTimeout(() => location.reload(), missing ? 3500 : 1400);
    } catch (err) {
      toast('Не сохранено: ' + err.message, 7000);
      btn.disabled = false;
      btn.textContent = 'Сохранить в файл';
    }
  }

  // ───────────────────────── init ─────────────────────────

  function collectPalette() {
    const found = new Map();
    const visit = (prop, val) => {
      val.replace(COLOR, tok => {
        if (tok[0] === 'u' || tok[0] === 'U') return tok;
        const c = parseColor(tok);
        if (c) {
          let f = found.get(c.key);
          if (!f) found.set(c.key, f = { key: c.key, n: 0, name: '' });
          f.n++;
          if (!f.name && prop.startsWith('--')) f.name = prop;
        }
        return tok;
      });
      return val;
    };
    srcStyles.forEach(s => walkCSS(s.orig, false, visit));
    linked.forEach(l => walkCSS(l.orig, false, visit));
    styleOrig.forEach(o => { if (o) walkCSS(o, true, visit); });
    return [...found.values()].sort((a, b) => b.n - a.n).slice(0, 24);
  }

  async function init() {
    document.documentElement.appendChild(host);
    renderAll();
    try {
      const res = await fetch(rawURL(pagePath), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      rawHTML = await res.text();
    } catch (err) {
      toast('Tweaks: откройте страницу через tweak_server.py — без него сохранять некуда', 10000);
      $('[data-act="bake"]').disabled = true;
      return;
    }
    srcDoc = new DOMParser().parseFromString(rawHTML, 'text/html');

    // <style> blocks from the file (skip ones injected by scripts, e.g. Tailwind CDN)
    const live = [...document.querySelectorAll('style')];
    let from = 0;
    srcDoc.querySelectorAll('style').forEach((s, index) => {
      const k = live.findIndex((l, i) => i >= from && l.textContent === s.textContent);
      if (k >= 0) { srcStyles.push({ el: live[k], orig: s.textContent, index }); from = k + 1; }
    });

    // local <link rel=stylesheet>
    const liveLinks = [...document.querySelectorAll('link[rel~="stylesheet" i][href]')];
    for (const l of srcDoc.querySelectorAll('link[rel~="stylesheet" i][href]')) {
      const url = new URL(l.getAttribute('href'), document.baseURI);
      if (url.origin !== location.origin) continue;
      const liveLink = liveLinks.find(x => x.href === url.href);
      if (!liveLink) continue;
      const path = decodeURIComponent(url.pathname);
      try {
        const r = await fetch(rawURL(path), { cache: 'no-store' });
        if (!r.ok) continue;
        const style = document.createElement('style');
        style.dataset.tweakFor = path;
        linked.push({ link: liveLink, media: liveLink.getAttribute('media'), url: url.href, path, orig: await r.text(), style });
      } catch (e) { /* skip */ }
    }

    captureStyleAttrs();
    palette = collectPalette();

    let restored = false;
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && s.scale && s.colors && s.els) {
        state = Object.assign(blank(), s);
        syncText(blank(), state);
        saved = JSON.stringify(state);
        restored = saved !== BLANK;
      }
    } catch (e) { /* no saved state */ }

    applyStyles();
    renderAll();
    ready = true;
    if (restored) toast('Восстановлены несохранённые правки · «Сбросить всё», чтобы начать заново', 4500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
