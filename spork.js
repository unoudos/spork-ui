/* Spork Core - Micro-runtime v3 */

const __state = {};
let   __rowState = {};
const __fnCache = new Map();

// ── API interna ───────────────────────────────────────────────────────────────

function __set(key, val) {
  __state[key] = val;
  __fnCache.clear();  // invalidar cache al cambiar claves
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
  try { return __compile(expr)(__state, ...Object.values(__state)); }
  catch(e) { return null; }
}

function __evalRow(expr) {
  try {
    var fn = __compile(expr, '__rowState');
    return fn(__state, __rowState, ...Object.values(__state));
  } catch(e) { return null; }
}

// ── API pública: state() ──────────────────────────────────────────────────────
//
// Uso:
//   const app = state({ contador: 0, nombre: "mundo" })
//   app.contador++          → DOM se actualiza solo
//   app.nombre = "Spork"   → DOM se actualiza solo
//   console.log(app.contador) → lectura directa
//
// También acepta múltiples objetos:
//   const ui   = state({ visible: true })
//   const data = state({ items: [] })

function state(initial) {
  // Registrar todas las claves en __state
  Object.keys(initial).forEach(function(k) {
    __state[k] = initial[k];
  });
  __fnCache.clear();

  // Devolver un Proxy que intercepta escrituras → __set
  return new Proxy(initial, {
    get: function(_, key) {
      return __state[key];
    },
    set: function(_, key, val) {
      __set(key, val);
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
      __set(el.dataset.sporkBind, el.type === 'checkbox' ? el.checked : el.value);
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
  __renderForBlocks();
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
    if (__state[_key] == null) continue;
    if (_el.type === 'checkbox') { _el.checked = !!__state[_key]; }
    else if (String(_el.value) !== String(__state[_key])) { _el.value = __state[_key]; }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  __initIndex();
  __render();
});
