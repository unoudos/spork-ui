/* Spork Core - Micro-runtime v2.1 */
(function(window) {
    const __state = {};
    let __rowState = {};

    function __set(key, val) {
        __state[key] = val;
        if (document.readyState === 'loading') { return; }
        __render();
    }

    function __eval(expr) {
        try {
            return (new Function(
                '__state,' + Object.keys(__state).join(','),
                'try{ return (' + expr + ') }catch(e){ return null }'
            ))(__state, ...Object.values(__state));
        } catch(e) { return null; }
    }

    function __evalRow(expr) {
        try {
            return (new Function(
                '__state,__rowState,' + Object.keys(__state).join(','),
                'try{ return (' + expr + ') }catch(e){ return null }'
            ))(__state, __rowState, ...Object.values(__state));
        } catch(e) { return null; }
    }

    function __applyRowBindings(root) {
        root.querySelectorAll('[data-spork-text]').forEach(function(el) {
            var v = __evalRow(el.dataset.sporkText);
            el.textContent = v == null ? '' : String(v);
        });
        root.querySelectorAll('[data-spork-if]').forEach(function(el) {
            el.style.display = __evalRow(el.dataset.sporkIf) ? '' : 'none';
        });
        root.querySelectorAll('[data-spork-attrs]').forEach(function(el) {
            var map = null;
            try { map = JSON.parse(el.dataset.sporkAttrs); } catch(e) {}
            if (!map) return;
            Object.keys(map).forEach(function(attr) {
                var v = __evalRow(map[attr]);
                if (v == null) el.removeAttribute(attr);
                else el.setAttribute(attr, String(v));
            });
        });
        root.querySelectorAll('[data-spork-style]').forEach(function(el) {
            var obj = __evalRow('(' + el.dataset.sporkStyle + ')');
            if (obj && typeof obj === 'object') {
                Object.keys(obj).forEach(function(k) {
                    var kebab = k.replace(/([A-Z])/g, '-$1').toLowerCase();
                    el.style[kebab] = obj[k] == null ? '' : String(obj[k]);
                });
            }
        });
        if (root.matches) {
            if (root.matches('[data-spork-text]')) {
                var vr = __evalRow(root.dataset.sporkText);
                root.textContent = vr == null ? '' : String(vr);
            }
            if (root.matches('[data-spork-if]')) {
                root.style.display = __evalRow(root.dataset.sporkIf) ? '' : 'none';
            }
        }
    }

    function __renderForBlocks() {
        document.querySelectorAll('[data-spork-for-src]').forEach(function(container) {
            var forId = container.id;
            var tmpl = document.querySelector('template[data-spork-for-template="' + forId + '"]');
            if (!tmpl) { return; }
            var arr = __eval(container.dataset.sporkForSrc);
            if (!Array.isArray(arr)) arr = [];
            container.innerHTML = '';
            var frag = document.createDocumentFragment();
            var rowVar = container.dataset.sporkForVar || 'item';
            arr.forEach(function(item) {
                var clone = tmpl.content.cloneNode(true);
                var prevRowState = __rowState;
                __rowState = {};
                __rowState[rowVar] = item;
                Array.from(clone.children).forEach(function(child) {
                    child.setAttribute('data-spork-row-managed', '');
                    frag.appendChild(child);
                    __applyRowBindings(child);
                });
                __rowState = prevRowState;
            });
            container.appendChild(frag);
        });
    }

    function __render() {
        __renderForBlocks();
        document.querySelectorAll('[data-spork-text]').forEach(function(el) {
            if (el.closest('[data-spork-row-managed]')) return;
            var v = __eval(el.dataset.sporkText);
            el.textContent = v == null ? '' : String(v);
        });
        document.querySelectorAll('[data-spork-if]').forEach(function(el) {
            if (el.closest('[data-spork-row-managed]')) return;
            el.style.display = __eval(el.dataset.sporkIf) ? '' : 'none';
        });
        document.querySelectorAll('[data-spork-bind]').forEach(function(el) {
            var key = el.dataset.sporkBind;
            if (__state[key] == null) return;
            if (el.type === 'checkbox') { el.checked = !!__state[key]; }
            else if (String(el.value) !== String(__state[key])) el.value = __state[key];
        });
        document.querySelectorAll('[data-spork-style]').forEach(function(el) {
            if (el.closest('[data-spork-row-managed]')) return;
            var obj = __eval('(' + el.dataset.sporkStyle + ')');
            if (obj && typeof obj === 'object') {
                Object.keys(obj).forEach(function(k) {
                    var kebab = k.replace(/([A-Z])/g, '-$1').toLowerCase();
                    el.style[kebab] = obj[k] == null ? '' : String(obj[k]);
                });
            }
        });
        document.querySelectorAll('[data-spork-attrs]').forEach(function(el) {
            if (el.closest('[data-spork-row-managed]')) return;
            var map = null;
            try { map = JSON.parse(el.dataset.sporkAttrs); } catch(e) {}
            if (!map) return;
            Object.keys(map).forEach(function(attr) {
                var v = __eval(map[attr]);
                if (v == null) el.removeAttribute(attr);
                else el.setAttribute(attr, String(v));
            });
        });
    }

    function init(initialState = {}) {
        Object.assign(__state, initialState);
        document.addEventListener('DOMContentLoaded', function() {
            document.querySelectorAll('[data-spork-bind]').forEach(function(el) {
                var key = el.dataset.sporkBind;
                el.addEventListener('input', function() {
                    __set(key, el.type === 'checkbox' ? el.checked
                               : (el.type === 'number' || el.type === 'range') ? Number(el.value)
                               : el.value);
                });
                el.addEventListener('change', function() {
                    if (el.tagName === 'SELECT') __set(key, el.value);
                });
                if (__state[key] != null) {
                    if (el.type === 'checkbox') el.checked = !!__state[key];
                    else el.value = __state[key];
                }
            });
            __render();
        });
    }

    window.Spork = {
        set: __set,
        init: init,
        state: __state,
        render: __render
    };
})(window);