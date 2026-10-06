/* Spork Core v3.2 - reactive micro-runtime by @uno_u_dos
 *
 * Directives:
 *   data-spork-text="expr"          → textContent reactivo
 *   data-spork-html="expr"          → innerHTML reactivo (asegúrate de sanitizar)
 *   data-spork-if="expr"            → muestra/oculta el elemento
 *   data-spork-style="{ prop: expr}"→ estilos inline reactivos
 *   data-spork-class='{"cls":expr}' → clases condicionales
 *   data-spork-attrs='{"attr":expr}' → atributos condicionales
 *   data-spork-bind="key"           → two-way binding (input/select/checkbox)
 *   data-spork-on="click:expr"      → eventos genéricos (cualquier nombre de evento)
 *   data-spork-ref="name"           → expone el elemento en state.$refs.name
 *   data-spork-for-src="expr"       → lista reactiva (necesita <template data-spork-for-template="id">)
 *   data-spork-for-var="varName"    → nombre de la variable de iteración (default: "item")
 *   data-spork-for-key="expr"       → expresión de clave para reconciliación DOM (recomendado)
 *
 * CSP: este runtime usa new Function() → requiere 'unsafe-eval' en script-src.
 */
(function (global) {
  "use strict";

  var stateStore = global.__state || {};
  var rowState = {};
  var cache = new Map();
  var watchers = new Map();
  var index = { text: [], html: [], if_: [], style: [], attrs: [], class_: [], bind: [], for_: [], refs: [] };
  var renderQueued = false;
  var batchDepth = 0;
  var dirty = false;
  var debug = !!global.SPORK_DEBUG;
  var delegationSetUp = false;
  var destroyCallbacks = [];

  /* ── Utilidades internas ─────────────────────────────────────────────── */

  function getState() { return global.__state || stateStore; }

  function warn(error, expression) {
    if (debug && global.console) console.warn("[Spork]", expression, error);
  }

  function compile(expression, extra, row, stmt) {
    var state = getState();
    var names = Object.keys(state);
    /* FIX: incluir nombres de variables de fila en la clave y args para que "item.name" funcione */
    var rowNames = row ? Object.keys(rowState) : [];
    var key = (row ? "row|" + rowNames.join(",") + "|" : "") + (stmt ? "S|" : "") + (extra || "") + "|" + names.join(",") + "|" + expression;
    if (cache.has(key)) return cache.get(key);
    var args = "__state," + (row ? "__rowState," + rowNames.join(",") + "," : "") + (extra ? extra + "," : "") + names.join(",");
    var fn;
    /* with(__state): permite asignaciones (contador++, a=1) que escriben en el estado real */
    var body = stmt ? "with(__state){" + expression + "}" : "with(__state){return (" + expression + ");}";
    try { fn = new Function(args, body); }
    catch (error) { warn(error, expression); fn = function () { return null; }; }
    cache.set(key, fn);
    return fn;
  }

  function evaluate(expression, extraValues, row, stmt) {
    var state = getState();
    var names = Object.keys(state);
    var values = names.map(function (key) { return state[key]; });
    /* FIX: pasar valores de fila como argumentos nombrados para que las expresiones de plantilla funcionen */
    var rowNames = row ? Object.keys(rowState) : [];
    var rowValues = row ? rowNames.map(function (k) { return rowState[k]; }) : [];
    try {
      return compile(expression, extraValues ? Object.keys(extraValues).join(",") : "", row, stmt)(
        state,
        ...(row ? [rowState, ...rowValues] : []),
        ...(extraValues ? Object.keys(extraValues).map(function (key) { return extraValues[key]; }) : []),
        ...values
      );
    } catch (error) { warn(error, expression); return null; }
  }

  /* Mapas { clave: expr } para class/attrs. Acepta JSON ('{"a":"expr"}') o literal JS ('{"a": expr}') */
  function resolveMap(src, row) {
    try {
      var m = JSON.parse(src), out = {};
      Object.keys(m).forEach(function (k) { out[k] = typeof m[k] === "string" ? evaluate(m[k], null, row) : m[k]; });
      return out;
    } catch (_) {
      var v = evaluate("(" + src + ")", null, row);
      return v && typeof v === "object" ? v : {};
    }
  }

  /* Ejecuta fn con el contexto de fila (variable de iteración) del nodo dado */
  function withRow(node, fn) {
    var rowEl = node && node.closest ? node.closest("[data-spork-row-managed]") : null;
    if (!rowEl || !rowEl.__sporkRow) return fn(false);
    var prev = rowState; rowState = rowEl.__sporkRow;
    try { return fn(true); } finally { rowState = prev; }
  }

  /* ── Estado ──────────────────────────────────────────────────────────── */

  function set(key, value) {
    var state = getState();
    var previous = state[key];
    if (Object.is(previous, value)) return value;
    /* FIX: solo limpiar caché si la clave es nueva (cambia la firma de argumentos compilados) */
    var isNew = !(key in state);
    state[key] = value;
    dirty = true;
    if (isNew) cache.clear();
    var list = watchers.get(key) || [];
    list.slice().forEach(function (fn) { fn(value, previous); });
    requestRender();
    return value;
  }

  function requestRender() {
    if (batchDepth) { renderQueued = true; return; }
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(function () { renderQueued = false; if (dirty) { dirty = false; render(); } });
  }

  /* ── Control de formularios ──────────────────────────────────────────── */

  function controlValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "radio") return el.checked ? el.value : undefined;
    if (el.multiple) return Array.from(el.selectedOptions).map(function (o) { return o.value; });
    if (el.type === "number" || el.type === "range") return el.value === "" ? null : Number(el.value);
    return el.value;
  }

  /* ── Event delegation (captura elementos dinámicos también) ──────────── */

  function setupDelegation() {
    if (delegationSetUp) return;
    delegationSetUp = true;

    /* FIX: data-spork-bind via delegación → funciona con elementos añadidos dinámicamente */
    function onInput(e) {
      var el = e.target.closest("[data-spork-bind]");
      if (!el) return;
      var value = controlValue(el);
      if (value === undefined) return;
      var key = el.dataset.sporkBind;
      if (el.closest("[data-spork-row-managed]")) {
        /* bind dentro de una fila: asigna sobre el elemento de la fila (task.completed = valor) */
        withRow(el, function (isRow) { evaluate(key + " = __v", { __v: value }, isRow, true); });
        dirty = true; requestRender();
      } else set(key, value);
    }
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    destroyCallbacks.push(function () {
      document.removeEventListener("input", onInput);
      document.removeEventListener("change", onInput);
    });

    /* FIX: data-spork-on="eventName:expr" — eventos genéricos via delegación */
    var boundEvents = new Set();
    function ensureEvent(eventName) {
      if (boundEvents.has(eventName)) return;
      boundEvents.add(eventName);
      var handler = function (e) {
        /* Busca el elemento más cercano que tenga data-spork-on con este evento */
        var el = e.target;
        while (el && el !== document) {
          var spec = el.dataset.sporkOn;
          if (spec) {
            spec.split(";").forEach(function (pair) {
              var idx = pair.indexOf(":");
              if (idx === -1) return;
              var evName = pair.slice(0, idx).trim();
              var expr   = pair.slice(idx + 1).trim();
              if (evName === eventName) withRow(el, function (isRow) { evaluate(expr, { "$event": e, "$element": el }, isRow, true); });
            });
          }
          /* Compatibilidad con el atributo singular data-spork-on-click original */
          if (eventName === "click" && el.dataset.sporkOnClick) {
            withRow(el, function (isRow) { evaluate(el.dataset.sporkOnClick, { "$event": e, "$element": el }, isRow, true); });
          }
          el = el.parentElement;
        }
      };
      document.addEventListener(eventName, handler);
      destroyCallbacks.push(function () { document.removeEventListener(eventName, handler); });
    }

    /* Registra los eventos presentes en el DOM inicial */
    function indexEvents() {
      document.querySelectorAll("[data-spork-on]").forEach(function (el) {
        (el.dataset.sporkOn || "").split(";").forEach(function (pair) {
          var evName = pair.split(":")[0].trim();
          if (evName) ensureEvent(evName);
        });
      });
      /* Siempre registrar click para data-spork-on-click (retrocompatibilidad) */
      if (document.querySelector("[data-spork-on-click]")) ensureEvent("click");
    }

    indexEvents();
    /* Re-indexar tras renders de listas */
    destroyCallbacks._indexEvents = indexEvents;
  }

  /* ── Construcción de índice ──────────────────────────────────────────── */

  function buildIndex() {
    index = { text: [], html: [], if_: [], style: [], attrs: [], class_: [], bind: [], for_: [], refs: [] };

    document.querySelectorAll("[data-spork-text]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.text.push([el, el.dataset.sporkText]);
    });
    /* FIX: nuevo directivo data-spork-html */
    document.querySelectorAll("[data-spork-html]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.html.push([el, el.dataset.sporkHtml]);
    });
    document.querySelectorAll("[data-spork-if]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.if_.push([el, el.dataset.sporkIf]);
    });
    document.querySelectorAll("[data-spork-style]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.style.push([el, el.dataset.sporkStyle]);
    });
    document.querySelectorAll("[data-spork-attrs]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.attrs.push([el, el.dataset.sporkAttrs]);
    });
    document.querySelectorAll("[data-spork-class]").forEach(function (el) {
      if (!el.closest("[data-spork-row-managed]")) index.class_.push([el, el.dataset.sporkClass]);
    });
    document.querySelectorAll("[data-spork-for-src]").forEach(function (el) {
      index.for_.push([el, el.id]);
    });
    /* FIX: data-spork-ref → expone elementos en state.$refs */
    var refs = {};
    document.querySelectorAll("[data-spork-ref]").forEach(function (el) {
      refs[el.dataset.sporkRef] = el;
      index.refs.push([el, el.dataset.sporkRef]);
    });
    getState().$refs = refs;

    setupDelegation();
    /* Re-detectar posibles nuevos eventos tras rebuild */
    if (destroyCallbacks._indexEvents) destroyCallbacks._indexEvents();
  }

  /* ── Renderizado de filas (data-spork-for) ───────────────────────────── */

  function applyRow(root) {
    root.querySelectorAll("[data-spork-text]").forEach(function (el) {
      var value = evaluate(el.dataset.sporkText, null, true);
      el.textContent = value == null ? "" : String(value);
    });
    /* data-spork-html en filas */
    root.querySelectorAll("[data-spork-html]").forEach(function (el) {
      var value = evaluate(el.dataset.sporkHtml, null, true);
      el.innerHTML = value == null ? "" : String(value);
    });
    root.querySelectorAll("[data-spork-if]").forEach(function (el) {
      el.style.display = evaluate(el.dataset.sporkIf, null, true) ? "" : "none";
    });
    root.querySelectorAll("[data-spork-class]").forEach(function (el) {
      var map = resolveMap(el.dataset.sporkClass, true);
      Object.keys(map).forEach(function (cls) { el.classList.toggle(cls, !!map[cls]); });
    });
    root.querySelectorAll("[data-spork-attrs]").forEach(function (el) {
      var map = resolveMap(el.dataset.sporkAttrs, true);
      Object.keys(map).forEach(function (attr) {
        var v = map[attr];
        if (v == null || v === false) el.removeAttribute(attr); else el.setAttribute(attr, v === true ? "" : String(v));
      });
    });
    root.querySelectorAll("[data-spork-style]").forEach(function (el) {
      var o = evaluate("(" + el.dataset.sporkStyle + ")", null, true);
      if (o && typeof o === "object") Object.keys(o).forEach(function (k) { el.style[k] = o[k] == null ? "" : String(o[k]); });
    });
    /* bind en filas: sincroniza estado -> control (la escritura va por delegación) */
    root.querySelectorAll("[data-spork-bind]").forEach(function (el) {
      var v = evaluate(el.dataset.sporkBind, null, true);
      if (v == null) return;
      if (el.type === "checkbox") el.checked = !!v;
      else if (String(el.value) !== String(v)) el.value = v;
    });
  }

  function renderLists() {
    index.for_.forEach(function (entry) {
      var container = entry[0];
      var id = entry[1];
      var template = document.querySelector('template[data-spork-for-template="' + id + '"]');
      if (!template) return;

      var values = evaluate(container.dataset.sporkForSrc);
      if (!Array.isArray(values)) values = [];
      var variable = container.dataset.sporkForVar || "item";
      var keyExpr  = container.dataset.sporkForKey;   /* FIX: soporte para claves */

      if (keyExpr) {
        /* ── Reconciliación con clave: reutiliza nodos existentes ── */
        var existingByKey = new Map();
        Array.from(container.children).forEach(function (child) {
          var k = child.dataset.sporkKey;
          if (k != null) existingByKey.set(k, child);
        });

        var fragment = document.createDocumentFragment();
        values.forEach(function (item) {
          var previous = rowState;
          rowState = {};
          rowState[variable] = item;
          var key = String(evaluate(keyExpr, null, true));
          rowState = previous;

          var node = existingByKey.get(key);
          if (node) {
            /* Reutilizar y actualizar el nodo existente */
            existingByKey.delete(key);
            rowState = {};
            rowState[variable] = item;
            node.__sporkRow = rowState;
            applyRow(node);
            rowState = previous;
            fragment.appendChild(node);
          } else {
            /* Crear nodo nuevo */
            var clone = template.content.cloneNode(true);
            rowState = {};
            rowState[variable] = item;
            Array.from(clone.children).forEach(function (child) {
              child.dataset.sporkRowManaged = "";
              child.dataset.sporkKey = key;
              child.__sporkRow = rowState;
              applyRow(child);
              fragment.appendChild(child);
            });
            rowState = previous;
          }
        });

        /* Eliminar nodos que ya no están en el array */
        existingByKey.forEach(function (node) { node.remove(); });
        container.appendChild(fragment);

      } else {
        /* ── Sin clave: comportamiento original ── */
        var fragment = document.createDocumentFragment();
        values.forEach(function (item) {
          var clone = template.content.cloneNode(true);
          var previous = rowState;
          rowState = {};
          rowState[variable] = item;
          Array.from(clone.children).forEach(function (child) {
            child.dataset.sporkRowManaged = "";
            child.__sporkRow = rowState;
            applyRow(child);
            fragment.appendChild(child);
          });
          rowState = previous;
        });
        container.replaceChildren(fragment);
      }
    });
  }

  /* ── Render principal ────────────────────────────────────────────────── */

  function render() {
    /* FIX: try/catch global para que un error no congele el runtime */
    try {
      renderLists();
      index.text.forEach(function (entry) {
        var value = evaluate(entry[1]);
        entry[0].textContent = value == null ? "" : String(value);
      });
      /* FIX: data-spork-html */
      index.html.forEach(function (entry) {
        var value = evaluate(entry[1]);
        entry[0].innerHTML = value == null ? "" : String(value);
      });
      index.if_.forEach(function (entry) {
        entry[0].style.display = evaluate(entry[1]) ? "" : "none";
      });
      index.style.forEach(function (entry) {
        var object = evaluate("(" + entry[1] + ")");
        if (object && typeof object === "object") {
          Object.keys(object).forEach(function (key) {
            entry[0].style[key] = object[key] == null ? "" : String(object[key]);
          });
        }
      });
      index.attrs.forEach(function (entry) {
        var map = resolveMap(entry[1], false);
        Object.keys(map).forEach(function (attr) {
          var value = map[attr];
          if (value == null || value === false) entry[0].removeAttribute(attr);
          else entry[0].setAttribute(attr, value === true ? "" : String(value));
        });
      });
      index.class_.forEach(function (entry) {
        var map = resolveMap(entry[1], false);
        Object.keys(map).forEach(function (cls) { entry[0].classList.toggle(cls, !!map[cls]); });
      });
      /* Sincronizar inputs con estado */
      document.querySelectorAll("[data-spork-bind]").forEach(function (el) {
        if (el.closest("[data-spork-row-managed]")) return;
        var value = getState()[el.dataset.sporkBind];
        if (value == null) return;
        if (el.type === "checkbox") { el.checked = !!value; }
        else if (el.multiple && Array.isArray(value)) {
          Array.from(el.options).forEach(function (o) { o.selected = value.includes(o.value); });
        } else if (String(el.value) !== String(value)) { el.value = value; }
      });
    } catch (error) {
      if (debug && global.console) console.error("[Spork] Error en render:", error);
    }
  }

  /* ── API pública ─────────────────────────────────────────────────────── */

  function batch(fn) {
    batchDepth++;
    try { fn(); }
    finally { batchDepth--; if (!batchDepth && renderQueued) requestRender(); }
  }

  function watch(key, fn) {
    var list = watchers.get(key) || [];
    list.push(fn);
    watchers.set(key, list);
    return function () {
      var current = watchers.get(key) || [];
      watchers.set(key, current.filter(function (item) { return item !== fn; }));
    };
  }

  function init(values) {
    Object.keys(values || {}).forEach(function (key) { getState()[key] = values[key]; });
    cache.clear();
    dirty = true;
    requestRender();
  }

  function state(initial) {
    init(initial);
    return new Proxy(initial || {}, {
      get: function (_, key) { return getState()[key]; },
      set: function (_, key, value) { set(key, value); return true; }
    });
  }

  /* FIX: destroy() — elimina todos los listeners y limpia el estado */
  function destroy() {
    destroyCallbacks.forEach(function (fn) { if (typeof fn === "function") fn(); });
    destroyCallbacks.length = 0;
    delegationSetUp = false;
    cache.clear();
    watchers.clear();
    index = { text: [], html: [], if_: [], style: [], attrs: [], class_: [], bind: [], for_: [], refs: [] };
    dirty = false;
    renderQueued = false;
  }

  global.Spork = {
    set:       set,
    init:      init,
    state:     state,
    batch:     batch,
    watch:     watch,
    destroy:   destroy,
    rebuild:   function () { buildIndex(); render(); },  /* útil tras mutaciones dinámicas del DOM */
    _eval:     evaluate,
    configure: function (options) { debug = !!(options && options.debug); }
  };

  /* Atajos globales — permiten usar state(), batch(), watch() sin prefijo Spork. */
  global.state = state;
  global.batch = batch;
  global.watch = watch;

  global.addEventListener("DOMContentLoaded", function () {
    if (global.__state) stateStore = global.__state;
    buildIndex();
    render();
  });

})(window);