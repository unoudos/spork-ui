/* Spork Core - Micro-runtime v3 */

// __state puede ser el Proxy del emitter (ya definido en el HTML antes de este script)
// o el objeto interno si se usa spork.js standalone
var __stateInternal = (typeof window.__state !== 'undefined' && window.__state) ? window.__state : {};
var __state = __stateInternal;
let   __rowState = {};
const __fnCache = new Map();

// ── API interna ───────────────────────────────────────────────────────────────

function __set(key, val) {
  // Si el emitter ya definió window.__set, usarlo (tiene el Proxy + Spork.set)
  // Este __set solo se usa si spork.js corre standalone sin emitter
  if (window.__set && window.__set !== __set) { window.__set(key, val); return; }
  __state[key] = val;
  __fnCache.clear();
  if (document.readyState === 'loading') return;
  __render();
}

function __compile(expr, extra) {
  var k = (extra||'') + '|' + expr;
  if (__fnCache.has(k)) return __fnCache.get(k);
  var keys = '__state,' + (extra ? extra + ',' : '') + Object.keys(__state).join(',');
  var fn;
  try { fn = new Function(keys, 'try{return(' + expr + ')}catch(e){return null}'); }
  catch(e) { fn = function(){ return null; }; }
  __fnCache.set(k, fn);
  return fn;
}

function __eval(expr) {
  // Usar el __state del emitter si existe (es el Proxy con todos los valores actuales)
  var _s = (window.__state) ? window.__state : __state;
  try {
    var keys = '__state,' + Object.keys(_s).join(',');
    var fn = __fnCache.get('|' + expr);
    if (!fn) {
      try { fn = new Function('__state,' + Object.keys(_s).join(','), 'try{return(' + expr + ')}catch(e){return null}'); }
      catch(e) { fn = function(){ return null; }; }
      __fnCache.set('|' + expr, fn);
    }
    return fn(_s, ...Object.values(_s));
  } catch(e) { return null; }
}

function __evalRow(expr) {
  var _s = (window.__state) ? window.__state : __state;
  try {
    var fn = new Function('__state,__rowState,' + Object.keys(_s).join(','), 'try{return(' + expr + ')}catch(e){return null}');
    return fn(_s, __rowState, ...Object.values(_s));
  } catch(e) { return null; }
}

// ── API pública: state() ──────────────────────────────────────────────────────

function state(initial) {
  var _s = (window.__state) ? window.__state : __state;
  Object.keys(initial).forEach(function(k) { _s[k] = initial[k]; });
  __fnCache.clear();
  return new Proxy(initial, {
    get: function(_, key) { return _s[key]; },
    set: function(_, key, val) {
      if (window.__set) window.__set(key, val);
      else { _s[key] = val; __fnCache.clear(); __render(); }
      return true;
    }
  });
}

// ── Índice de elementos reactivos ─────────────────────────────────────────────

var __idx = { text:[], if_:[], style:[], attrs:[], class_:[], bind:[], for_:[] };

function __initIndex() {
  __idx = { text:[], if_:[], style:[], attrs:[], class_:[], bind:[], for_:[] };
  document.querySelectorAll('[data-spork-text]').forEach(function(el) {
    if (!el.closest('[data-spork-row-managed]')) __idx.text.push([el, el.dataset.sporkText]);
  });
  document.querySelectorAll('[data-spork-if]').forEach(function(el) {
    if (!el.closest('[data-spork-row-managed]')) __idx.if_.push([el, el.dataset.sporkIf]);
  });
  document.querySelectorAll('[data-spork-style]').forEach(function(el) {
    if (!el.closest('[data-spork-row-managed]')) __idx.style.push([el, el.dataset.sporkStyle]);
  });
  document.querySelectorAll('[data-spork-attrs]').forEach(function(el) {
    if (!el.closest('[data-spork-row-managed]')) __idx.attrs.push([el, el.dataset.sporkAttrs]);
  });
  document.querySelectorAll('[data-spork-class]').forEach(function(el) {
    if (!el.closest('[data-spork-row-managed]')) __idx.class_.push([el, el.dataset.sporkClass]);
  });
  document.querySelectorAll('[data-spork-bind]').forEach(function(el) {
    __idx.bind.push([el, el.dataset.sporkBind]);
    el.addEventListener('input', function() {
      var val = el.type === 'checkbox' ? el.checked : el.value;
      if (window.__set) window.__set(el.dataset.sporkBind, val);
      else __set(el.dataset.sporkBind, val);
    });
  });
  document.querySelectorAll('[data-spork-for-src]').forEach(function(el) {
    __idx.for_.push([el, el.id]);
  });
}

// ── Render de listas ──────────────────────────────────────────────────────────

function __applyRowBindings(root) {
  root.querySelectorAll('[data-spork-text]').forEach(function(el) {
    var v = __evalRow(el.dataset.sporkText);
    el.textContent = v == null ? '' : String(v);
  });
  root.querySelectorAll('[data-spork-if]').forEach(function(el) {
    el.style.display = __evalRow(el.dataset.sporkIf) ? '' : 'none';
  });
  root.querySelectorAll('[data-spork-class]').forEach(function(el) {
    var map = null;
    try { map = JSON.parse(el.dataset.sporkClass); } catch(e) {}
    if (!map) return;
    Object.keys(map).forEach(function(cls) { el.classList.toggle(cls, !!__evalRow(map[cls])); });
  });
}

function __renderForBlocks() {
  for (var _fi = 0; _fi < __idx.for_.length; _fi++) {
    var _fc  = __idx.for_[_fi][0];
    var _fid = __idx.for_[_fi][1];
    var _tmpl = document.querySelector('template[data-spork-for-template="' + _fid + '"]');
    if (!_tmpl) continue;
    var _arr = __eval(_fc.dataset.sporkForSrc);
    if (!Array.isArray(_arr)) _arr = [];
    _fc.innerHTML = '';
    var _frag = document.createDocumentFragment();
    var _rowVar = _fc.dataset.sporkForVar || 'item';
    _arr.forEach(function(item) {
      var _clone = _tmpl.content.cloneNode(true);
      var _prev = __rowState;
      __rowState = {};
      __rowState[_rowVar] = item;
      Array.from(_clone.children).forEach(function(child) {
        child.setAttribute('data-spork-row-managed', '');
        _frag.appendChild(child);
        __applyRowBindings(child);
      });
      __rowState = _prev;
    });
    _fc.appendChild(_frag);
  }
}

// ── Render principal ──────────────────────────────────────────────────────────

function __render() {
  // Invalidar cache al renderizar (el __state puede haber cambiado sus keys)
  __fnCache.clear();
  __renderForBlocks();
  var _s = (window.__state) ? window.__state : __state;
  for (var _i = 0; _i < __idx.text.length; _i++) {
    var _v = __eval(__idx.text[_i][1]);
    __idx.text[_i][0].textContent = _v == null ? '' : String(_v);
  }
  for (var _i = 0; _i < __idx.if_.length; _i++) {
    __idx.if_[_i][0].style.display = __eval(__idx.if_[_i][1]) ? '' : 'none';
  }
  for (var _i = 0; _i < __idx.style.length; _i++) {
    var _obj = __eval('(' + __idx.style[_i][1] + ')');
    if (_obj && typeof _obj === 'object') {
      var _el = __idx.style[_i][0];
      Object.keys(_obj).forEach(function(k) {
        _el.style[k.replace(/([A-Z])/g, '-$1').toLowerCase()] = _obj[k] == null ? '' : String(_obj[k]);
      });
    }
  }
  for (var _i = 0; _i < __idx.attrs.length; _i++) {
    var _map = null; try { _map = JSON.parse(__idx.attrs[_i][1]); } catch(e) {}
    if (!_map) continue;
    var _el = __idx.attrs[_i][0];
    Object.keys(_map).forEach(function(attr) {
      var _v = __eval(_map[attr]);
      if (_v == null) _el.removeAttribute(attr); else _el.setAttribute(attr, String(_v));
    });
  }
  for (var _i = 0; _i < __idx.class_.length; _i++) {
    var _map = null; try { _map = JSON.parse(__idx.class_[_i][1]); } catch(e) {}
    if (!_map) continue;
    var _el = __idx.class_[_i][0];
    Object.keys(_map).forEach(function(cls) { _el.classList.toggle(cls, !!__eval(_map[cls])); });
  }
  for (var _i = 0; _i < __idx.bind.length; _i++) {
    var _key = __idx.bind[_i][1], _el = __idx.bind[_i][0];
    if (_s[_key] == null) continue;
    if (_el.type === 'checkbox') { _el.checked = !!_s[_key]; }
    else if (String(_el.value) !== String(_s[_key])) { _el.value = _s[_key]; }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  // Sincronizar con el __state del emitter si ya existe
  if (window.__state) {
    __state = window.__state;
  }
  __initIndex();
  __render();
});

// ── Objeto Spork — API que espera el emitter generado ─────────────────────────
//
// El HTML generado hace: if(window.Spork) Spork.set(k,v)
//                        if(window.Spork) Spork.init(obj)
//                        window.Spork ? Spork._eval(expr) : null

window.Spork = {
  set: function(key, val) {
    // Escribir en el __state del emitter (Proxy) y re-renderizar
    var _s = window.__state;
    if (_s) { _s[key] = val; }
    else { __state[key] = val; }
    __fnCache.clear();
    if (document.readyState !== 'loading') __render();
  },
  init: function(obj) {
    var _s = window.__state;
    Object.keys(obj).forEach(function(k) {
      if (_s) _s[k] = obj[k]; else __state[k] = obj[k];
    });
    __fnCache.clear();
    if (document.readyState !== 'loading') __render();
  },
  _eval: function(expr) {
    return __eval(expr);
  },
};
