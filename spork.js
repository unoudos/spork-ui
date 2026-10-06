/* Spork Core v4.0 - reactive micro-runtime by @uno_u_dos
 *
 * Directives:
 *   data-spork-text="expr"           → textContent reactivo
 *   data-spork-html="expr"           → innerHTML reactivo (se sanea por defecto, ver Spork.configure)
 *   data-spork-if="expr"             → muestra/oculta el elemento
 *   data-spork-style="{ prop: expr}" → estilos inline reactivos
 *   data-spork-class='{"cls":expr}'  → clases condicionales (JSON o literal JS)
 *   data-spork-attrs='{"attr":expr}' → atributos condicionales (JSON o literal JS)
 *   data-spork-bind="key"            → two-way binding (input/select/checkbox), admite rutas: "form.name"
 *   data-spork-on="click:expr"       → eventos (cualquier evento DOM); separa varios con ";"
 *   data-spork-ref="name"            → expone el elemento en state.$refs.name
 *   data-spork-for-src="expr"        → lista reactiva (necesita <template data-spork-for-template="id">)
 *   data-spork-for-var="varName"     → variable de iteración (por defecto "item")
 *   data-spork-for-key="expr"        → clave para reconciliar el DOM (recomendado)
 *
 * v4.0
 *   · SIN eval / new Function: las expresiones las ejecuta un intérprete propio → funciona con una CSP
 *     estricta (script-src 'self') y NO necesita 'unsafe-eval'.
 *   · Dependencias por binding: al cambiar una clave solo se reevalúan los bindings que la leen.
 *   · data-spork-html se sanea por defecto (scripts, on*, javascript:).
 *   · Las expresiones son código del DESARROLLADOR: nunca metas texto de usuarios dentro de atributos data-spork-*.
 *     Están bloqueados: constructor, __proto__, prototype, eval, Function.
 */
(function (global) {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════
   *  1. INTÉRPRETE DE EXPRESIONES (tokenizer → parser → evaluador)
   * ══════════════════════════════════════════════════════════════════════ */

  var PUNCT = ["**=", "===", "!==", "...", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??",
    "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "**", "+", "-", "*", "/", "%", "<", ">", "=", "!", "?", ":",
    ".", ",", ";", "(", ")", "[", "]", "{", "}"];
  var ASSIGN_OPS = { "=": 1, "+=": 1, "-=": 1, "*=": 1, "/=": 1, "%=": 1, "**=": 1, "&&=": 1, "||=": 1, "??=": 1 };
  var BIN_PREC = { "??": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "===": 4, "!==": 4,
    "<": 5, ">": 5, "<=": 5, ">=": 5, "in": 5, "instanceof": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7, "**": 8 };
  var BLOCKED = { "constructor": 1, "__proto__": 1, "prototype": 1, "eval": 1, "Function": 1,
    "__defineGetter__": 1, "__defineSetter__": 1, "__lookupGetter__": 1, "__lookupSetter__": 1 };
  var MUTATORS = { push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1, add: 1, delete: 1, set: 1, clear: 1, assign: 1 };
  var NUM_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
  var ID_RE = /^[A-Za-z_$À-￿][\w$À-￿]*/;

  function SyntaxErr(msg, src) { var e = new Error("Spork: " + msg + " en «" + src + "»"); e.sporkSyntax = true; return e; }

  function tokenize(src) {
    var toks = [], i = 0, n = src.length, m;
    while (i < n) {
      var c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "'" || c === '"') {
        var q = c, s = ""; i++;
        while (i < n && src[i] !== q) {
          if (src[i] === "\\") {
            i++; var e = src[i];
            s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "u" ? (function () { var h = src.substr(i + 1, 4); i += 4; return String.fromCharCode(parseInt(h, 16)); })() : e;
          } else s += src[i];
          i++;
        }
        if (i >= n) throw SyntaxErr("cadena sin cerrar", src);
        i++; toks.push({ t: "str", v: s }); continue;
      }
      if (c === "`") {
        var parts = [], cur = ""; i++;
        while (i < n && src[i] !== "`") {
          if (src[i] === "\\") { i++; cur += src[i] === "n" ? "\n" : src[i]; i++; continue; }
          if (src[i] === "$" && src[i + 1] === "{") {
            var depth = 1, j = i + 2;
            while (j < n && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
            parts.push(cur); parts.push(src.slice(i + 2, j - 1)); cur = ""; i = j; continue;
          }
          cur += src[i++];
        }
        if (i >= n) throw SyntaxErr("plantilla sin cerrar", src);
        i++; parts.push(cur); toks.push({ t: "tpl", v: parts }); continue;
      }
      if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
        m = NUM_RE.exec(src.slice(i));
        toks.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
      }
      m = ID_RE.exec(src.slice(i));
      if (m) { toks.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
      var hit = null;
      for (var k = 0; k < PUNCT.length; k++) {
        if (src.substr(i, PUNCT[k].length) === PUNCT[k]) { hit = PUNCT[k]; break; }
      }
      if (!hit) throw SyntaxErr("carácter inesperado «" + c + "»", src);
      if (hit === "?." && src[i + 2] >= "0" && src[i + 2] <= "9") hit = "?";   /* a?.5:1 */
      toks.push({ t: "p", v: hit }); i += hit.length;
    }
    toks.push({ t: "eof" });
    return toks;
  }

  function Parser(src) { this.src = src; this.toks = tokenize(src); this.i = 0; }
  var P = Parser.prototype;
  P.peek = function (o) { return this.toks[Math.min(this.i + (o || 0), this.toks.length - 1)]; };
  P.next = function () { return this.toks[this.i++]; };
  P.isP = function (v, o) { var t = this.peek(o); return t.t === "p" && t.v === v; };
  P.isId = function (v) { var t = this.peek(); return t.t === "id" && t.v === v; };
  P.eatP = function (v) { if (this.isP(v)) { this.i++; return true; } return false; };
  P.expectP = function (v) { if (!this.eatP(v)) throw SyntaxErr("se esperaba «" + v + "»", this.src); };
  P.expectEOF = function () { if (this.peek().t !== "eof") throw SyntaxErr("token inesperado", this.src); };

  P.parseStatements = function (endP) {
    var body = [];
    while (this.peek().t !== "eof" && !(endP && this.isP(endP))) {
      if (this.eatP(";")) continue;
      body.push(this.parseStatement());
      this.eatP(";");
    }
    return { type: "Seq", body: body };
  };
  P.parseStatement = function () {
    if (this.isId("if")) {
      this.next(); this.expectP("(");
      var test = this.parseExpression(); this.expectP(")");
      var cons = this.parseStatement(), alt = null;
      if (this.isP(";") && this.peek(1).t === "id" && this.peek(1).v === "else") this.next();
      if (this.isId("else")) { this.next(); alt = this.parseStatement(); }
      return { type: "If", test: test, cons: cons, alt: alt };
    }
    if (this.isP("{")) { this.next(); var b = this.parseStatements("}"); this.expectP("}"); return b; }
    if (this.isId("return")) {
      this.next();
      var arg = (this.isP(";") || this.isP("}") || this.peek().t === "eof") ? null : this.parseExpression();
      return { type: "Return", arg: arg };
    }
    return this.parseExpression();
  };

  P.parseExpression = function () { return this.parseAssignment(); };

  P.isArrowParen = function () {
    var depth = 0, j = this.i;
    for (; j < this.toks.length; j++) {
      var t = this.toks[j];
      if (t.t === "p" && t.v === "(") depth++;
      else if (t.t === "p" && t.v === ")") { depth--; if (!depth) break; }
      else if (t.t === "eof") return false;
    }
    var nx = this.toks[j + 1];
    return !!nx && nx.t === "p" && nx.v === "=>";
  };
  P.parseArrowBody = function (params) {
    this.expectP("=>");
    if (this.isP("{")) { this.next(); var b = this.parseStatements("}"); this.expectP("}"); return { type: "Arrow", params: params, body: b, block: true }; }
    return { type: "Arrow", params: params, body: this.parseAssignment(), block: false };
  };
  P.parseAssignment = function () {
    var t = this.peek();
    if (t.t === "id" && this.isP("=>", 1) && !BIN_PREC[t.v]) { this.next(); return this.parseArrowBody([t.v]); }
    if (t.t === "p" && t.v === "(" && this.isArrowParen()) {
      this.next(); var params = [];
      while (!this.isP(")")) { var id = this.next(); if (id.t !== "id") throw SyntaxErr("parámetro inválido", this.src); params.push(id.v); if (!this.eatP(",")) break; }
      this.expectP(")");
      return this.parseArrowBody(params);
    }
    var left = this.parseTernary();
    var op = this.peek();
    if (op.t === "p" && ASSIGN_OPS[op.v]) {
      if (left.type !== "Ident" && left.type !== "Member") throw SyntaxErr("asignación inválida", this.src);
      this.next();
      return { type: "Assign", op: op.v, target: left, value: this.parseAssignment() };
    }
    return left;
  };
  P.parseTernary = function () {
    var test = this.parseBinary(1);
    if (this.eatP("?")) {
      var a = this.parseAssignment(); this.expectP(":");
      var b = this.parseAssignment();
      return { type: "Cond", test: test, a: a, b: b };
    }
    return test;
  };
  P.parseBinary = function (minPrec) {
    var left = this.parseUnary();
    for (;;) {
      var t = this.peek(), op = (t.t === "p" || (t.t === "id" && (t.v === "in" || t.v === "instanceof"))) ? t.v : null;
      var prec = op && BIN_PREC[op];
      if (!prec || prec < minPrec) break;
      this.next();
      var right = this.parseBinary(op === "**" ? prec : prec + 1);
      left = (op === "&&" || op === "||" || op === "??") ? { type: "Logical", op: op, l: left, r: right } : { type: "Binary", op: op, l: left, r: right };
    }
    return left;
  };
  P.parseUnary = function () {
    var t = this.peek();
    if (t.t === "p" && (t.v === "!" || t.v === "-" || t.v === "+")) { this.next(); return { type: "Unary", op: t.v, arg: this.parseUnary() }; }
    if (t.t === "id" && (t.v === "typeof" || t.v === "void")) { this.next(); return { type: "Unary", op: t.v, arg: this.parseUnary() }; }
    if (t.t === "p" && (t.v === "++" || t.v === "--")) {
      this.next(); var a = this.parseUnary();
      if (a.type !== "Ident" && a.type !== "Member") throw SyntaxErr("operando inválido", this.src);
      return { type: "Update", op: t.v, prefix: true, target: a };
    }
    var e = this.parseCallMember();
    var nx = this.peek();
    if (nx.t === "p" && (nx.v === "++" || nx.v === "--") && (e.type === "Ident" || e.type === "Member")) {
      this.next(); return { type: "Update", op: nx.v, prefix: false, target: e };
    }
    return e;
  };
  P.parseArgs = function () {
    var args = [];
    this.expectP("(");
    while (!this.isP(")")) {
      if (this.eatP("...")) args.push({ type: "Spread", arg: this.parseAssignment() });
      else args.push(this.parseAssignment());
      if (!this.eatP(",")) break;
    }
    this.expectP(")");
    return args;
  };
  P.parseCallMember = function () {
    var e = this.parsePrimary(), optional = false;
    for (;;) {
      if (this.eatP(".")) {
        var id = this.next(); if (id.t !== "id") throw SyntaxErr("propiedad inválida", this.src);
        e = { type: "Member", obj: e, prop: { type: "Lit", v: id.v }, opt: false };
      } else if (this.eatP("?.")) {
        optional = true;
        if (this.isP("(")) e = { type: "Call", callee: e, args: this.parseArgs(), opt: true };
        else if (this.eatP("[")) { var pr = this.parseExpression(); this.expectP("]"); e = { type: "Member", obj: e, prop: pr, opt: true }; }
        else { var id2 = this.next(); if (id2.t !== "id") throw SyntaxErr("propiedad inválida", this.src); e = { type: "Member", obj: e, prop: { type: "Lit", v: id2.v }, opt: true }; }
      } else if (this.eatP("[")) {
        var pe = this.parseExpression(); this.expectP("]");
        e = { type: "Member", obj: e, prop: pe, opt: false };
      } else if (this.isP("(")) {
        e = { type: "Call", callee: e, args: this.parseArgs(), opt: false };
      } else break;
    }
    return optional ? { type: "Chain", expr: e } : e;
  };
  P.parsePrimary = function () {
    var t = this.next();
    if (t.t === "num" || t.t === "str") return { type: "Lit", v: t.v };
    if (t.t === "tpl") {
      var parts = t.v.map(function (p, idx) { return idx % 2 ? parseExpr(p) : { type: "Lit", v: p }; });
      return { type: "Tpl", parts: parts };
    }
    if (t.t === "id") {
      if (t.v === "true") return { type: "Lit", v: true };
      if (t.v === "false") return { type: "Lit", v: false };
      if (t.v === "null") return { type: "Lit", v: null };
      if (t.v === "undefined") return { type: "Lit", v: undefined };
      return { type: "Ident", name: t.v };
    }
    if (t.t === "p") {
      if (t.v === "(") { var e = this.parseExpression(); this.expectP(")"); return e; }
      if (t.v === "[") {
        var els = [];
        while (!this.isP("]")) {
          if (this.eatP("...")) els.push({ type: "Spread", arg: this.parseAssignment() });
          else els.push(this.parseAssignment());
          if (!this.eatP(",")) break;
        }
        this.expectP("]");
        return { type: "Arr", els: els };
      }
      if (t.v === "{") {
        var props = [];
        while (!this.isP("}")) {
          if (this.eatP("...")) { props.push({ spread: this.parseAssignment() }); }
          else {
            var kt = this.next(), key, computed = null;
            if (kt.t === "id" || kt.t === "str" || kt.t === "num") key = String(kt.v);
            else if (kt.t === "p" && kt.v === "[") { computed = this.parseExpression(); this.expectP("]"); }
            else throw SyntaxErr("clave de objeto inválida", this.src);
            if (this.eatP(":")) props.push({ key: key, computed: computed, value: this.parseAssignment() });
            else if (kt.t === "id") props.push({ key: key, value: { type: "Ident", name: key } });
            else throw SyntaxErr("se esperaba «:»", this.src);
          }
          if (!this.eatP(",")) break;
        }
        this.expectP("}");
        return { type: "Obj", props: props };
      }
    }
    throw SyntaxErr("token inesperado", this.src);
  };

  var parseCache = new Map();
  function parseExpr(src) {
    var p = new Parser(src), n = p.parseExpression(); p.expectEOF(); return n;
  }
  function parse(src, stmt) {
    var key = (stmt ? "S:" : "E:") + src, hit = parseCache.get(key);
    if (hit) { if (hit.err) throw hit.err; return hit.ast; }
    try {
      var p = new Parser(src), ast;
      if (stmt) { ast = p.parseStatements(); p.expectEOF(); }
      else { ast = p.parseExpression(); p.expectEOF(); }
      parseCache.set(key, { ast: ast }); return ast;
    } catch (err) { parseCache.set(key, { err: err }); throw err; }
  }

  /* ── Evaluador ─────────────────────────────────────────────────────── */

  var SC = {};                               /* señal de cortocircuito de ?. */
  function Ret(v) { this.v = v; }            /* señal de return */
  var tracker = null;                        /* Set donde se anotan las claves de estado leídas */
  var mutated = false;                       /* hubo asignación a miembros o llamadas (mutación in situ) */

  function guardKey(k) {
    if (typeof k === "string" && BLOCKED[k]) throw new Error("Spork: acceso bloqueado a «" + k + "»");
    return k;
  }

  /* Proxy "de lectura": anota las claves leídas (dependencias) y enruta escrituras por set() */
  var proxyCache = new WeakMap();
  function trackingState() {
    var raw = getState(), p = proxyCache.get(raw);
    if (!p) {
      p = new Proxy(raw, {
        get: function (t, k, r) { if (tracker && typeof k === "string") tracker.add(k); return Reflect.get(t, k, r); },
        set: function (t, k, v) { set(k, v); return true; }
      });
      proxyCache.set(raw, p);
    }
    return p;
  }

  function resolve(name, ctx) {
    if (BLOCKED[name]) throw new Error("Spork: acceso bloqueado a «" + name + "»");
    for (var i = 0; i < ctx.frames.length; i++) if (name in ctx.frames[i]) return { v: ctx.frames[i][name], th: undefined };
    if (ctx.extras && name in ctx.extras) return { v: ctx.extras[name], th: undefined };
    if (ctx.row && name in ctx.row) return { v: ctx.row[name], th: undefined };
    if (name in getState()) { var sp = trackingState(); return { v: sp[name], th: sp }; }
    if (name in global) return { v: global[name], th: undefined };
    return { v: undefined, th: undefined, missing: true };
  }

  function assignIdent(name, value, ctx) {
    guardKey(name);
    for (var i = 0; i < ctx.frames.length; i++) if (name in ctx.frames[i]) { ctx.frames[i][name] = value; return; }
    if (ctx.row && name in ctx.row) { ctx.row[name] = value; mutated = true; return; }
    if (name in getState() || !(name in global)) { set(name, value); return; }
    global[name] = value;
  }

  function applyOp(op, a, b) {
    switch (op) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b;
      case "%": return a % b; case "**": return Math.pow(a, b);
      case "==": return a == b; case "!=": return a != b; case "===": return a === b; case "!==": return a !== b; // eslint-disable-line eqeqeq
      case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
      case "in": return a in b; case "instanceof": return a instanceof b;
    }
    throw new Error("Spork: operador «" + op + "» no soportado");
  }

  function ev(n, ctx) {
    switch (n.type) {
      case "Lit": return n.v;
      case "Ident": return resolve(n.name, ctx).v;
      case "Tpl": return n.parts.map(function (p) { return p.type === "Lit" ? p.v : String(ev(p, ctx)); }).join("");
      case "Arr": {
        var out = [];
        n.els.forEach(function (e) { if (e.type === "Spread") out.push.apply(out, Array.from(ev(e.arg, ctx))); else out.push(ev(e, ctx)); });
        return out;
      }
      case "Obj": {
        var o = {};
        n.props.forEach(function (p) {
          if (p.spread) { Object.assign(o, ev(p.spread, ctx)); return; }
          var k = p.computed ? guardKey(String(ev(p.computed, ctx))) : guardKey(p.key);
          o[k] = ev(p.value, ctx);
        });
        return o;
      }
      case "Seq": { var last; for (var i = 0; i < n.body.length; i++) last = ev(n.body[i], ctx); return last; }
      case "If": return ev(n.test, ctx) ? ev(n.cons, ctx) : (n.alt ? ev(n.alt, ctx) : undefined);
      case "Return": throw new Ret(n.arg ? ev(n.arg, ctx) : undefined);
      case "Cond": return ev(n.test, ctx) ? ev(n.a, ctx) : ev(n.b, ctx);
      case "Logical": {
        var l = ev(n.l, ctx);
        if (n.op === "&&") return l ? ev(n.r, ctx) : l;
        if (n.op === "||") return l ? l : ev(n.r, ctx);
        return l != null ? l : ev(n.r, ctx);
      }
      case "Binary": return applyOp(n.op, ev(n.l, ctx), ev(n.r, ctx));
      case "Unary": {
        if (n.op === "typeof" && n.arg.type === "Ident") { var r0 = resolve(n.arg.name, ctx); return r0.missing ? "undefined" : typeof r0.v; }
        var a = ev(n.arg, ctx);
        switch (n.op) { case "!": return !a; case "-": return -a; case "+": return +a; case "typeof": return typeof a; case "void": return undefined; }
        break;
      }
      case "Chain": try { return ev(n.expr, ctx); } catch (e) { if (e === SC) return undefined; throw e; }
      case "Member": {
        var obj = ev(n.obj, ctx);
        if (obj == null) { if (n.opt) throw SC; throw new TypeError("Spork: no se puede leer una propiedad de " + obj); }
        return obj[guardKey(ev(n.prop, ctx))];
      }
      case "Call": {
        var fn, th, mname;
        if (n.callee.type === "Member") {
          th = ev(n.callee.obj, ctx);
          if (th == null) { if (n.callee.opt) throw SC; throw new TypeError("Spork: no se puede llamar sobre " + th); }
          mname = guardKey(ev(n.callee.prop, ctx));
          fn = th[mname];
        } else if (n.callee.type === "Ident") {
          var rs = resolve(n.callee.name, ctx); fn = rs.v; th = rs.th;
        } else fn = ev(n.callee, ctx);
        if (fn == null && n.opt) throw SC;
        if (typeof fn !== "function") throw new TypeError("Spork: «" + (n.callee.name || "expresión") + "» no es una función");
        var args = [];
        n.args.forEach(function (x) { if (x.type === "Spread") args.push.apply(args, Array.from(ev(x.arg, ctx))); else args.push(ev(x, ctx)); });
        if (mname && MUTATORS[mname]) mutated = true;       /* push/splice/sort/add... mutan datos in situ */
        return fn.apply(th, args);
      }
      case "Arrow": {
        return function () {
          var frame = {}, args = arguments;
          n.params.forEach(function (p, idx) { frame[p] = args[idx]; });
          var c = { frames: [frame].concat(ctx.frames), extras: ctx.extras, row: ctx.row };
          if (!n.block) return ev(n.body, c);
          try { ev(n.body, c); } catch (e) { if (e instanceof Ret) return e.v; throw e; }
          return undefined;
        };
      }
      case "Assign": {
        var val;
        if (n.op === "=") val = ev(n.value, ctx);
        else {
          var cur = ev(n.target, ctx), bop = n.op.slice(0, -1);
          if (bop === "&&") { if (!cur) return cur; val = ev(n.value, ctx); }
          else if (bop === "||") { if (cur) return cur; val = ev(n.value, ctx); }
          else if (bop === "??") { if (cur != null) return cur; val = ev(n.value, ctx); }
          else val = applyOp(bop, cur, ev(n.value, ctx));
        }
        return store(n.target, val, ctx);
      }
      case "Update": {
        var old = Number(ev(n.target, ctx)), nv = n.op === "++" ? old + 1 : old - 1;
        store(n.target, nv, ctx);
        return n.prefix ? nv : old;
      }
      case "Spread": throw new Error("Spork: spread no permitido aquí");
    }
    throw new Error("Spork: nodo «" + n.type + "» no soportado");
  }

  function store(target, value, ctx) {
    if (target.type === "Ident") { assignIdent(target.name, value, ctx); return value; }
    var obj = ev(target.obj, ctx);
    if (obj == null) throw new TypeError("Spork: no se puede asignar sobre " + obj);
    var k = guardKey(ev(target.prop, ctx));
    if (obj === trackingState()) set(k, value);
    else { obj[k] = value; mutated = true; }
    return value;
  }

  /* API de evaluación: o = { extras, row, stmt } */
  function evaluate(src, o) {
    o = o || {};
    var ctx = { frames: [], extras: o.extras || null, row: o.row || null };
    mutated = false;
    try { return ev(parse(src, !!o.stmt), ctx); }
    catch (err) {
      if (err instanceof Ret) return err.v;
      warn(err, src); return undefined;
    } finally {
      if (o.stmt) { if (mutated) dirtyAll = true; requestRender(); }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  2. ESTADO Y RENDER CON DEPENDENCIAS
   * ══════════════════════════════════════════════════════════════════════ */

  var stateStore = global.__state || {};
  var watchers = new Map();
  var index = emptyIndex();
  var dirtyKeys = new Set();
  var dirtyAll = false;
  var renderQueued = false;
  var batchDepth = 0;
  var pendingRender = false;
  var debug = !!global.SPORK_DEBUG;
  var sanitizeOpt = true;                    /* true | false | function(html) → html */
  var delegationSetUp = false;
  var destroyCallbacks = [];
  var stats = { evals: 0, renders: 0 };

  function emptyIndex() { return { text: [], html: [], if_: [], style: [], attrs: [], class_: [], bind: [], for_: [], refs: [] }; }
  function getState() { return global.__state || stateStore; }
  function warn(error, expression) { if (debug && global.console) console.warn("[Spork]", expression, error); }

  function set(key, value) {
    var state = getState(), previous = state[key];
    if (Object.is(previous, value)) return value;
    state[key] = value;
    dirtyKeys.add(key);
    var list = watchers.get(key) || [];
    list.slice().forEach(function (fn) { fn(value, previous); });
    requestRender();
    return value;
  }

  function requestRender() {
    if (batchDepth) { pendingRender = true; return; }
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(function () { renderQueued = false; render(); });
  }

  /* ── Sanitizado de HTML (data-spork-html) ────────────────────────────── */

  function sanitize(html) {
    if (sanitizeOpt === false) return html;
    if (typeof sanitizeOpt === "function") return sanitizeOpt(html);
    var tpl = document.createElement("template");
    tpl.innerHTML = html;                                 /* template es inerte: no ejecuta nada */
    tpl.content.querySelectorAll("script,iframe,object,embed,link,meta,base,style,form").forEach(function (el) { el.remove(); });
    tpl.content.querySelectorAll("*").forEach(function (el) {
      Array.from(el.attributes).forEach(function (a) {
        var name = a.name.toLowerCase(), val = a.value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
        if (name.indexOf("on") === 0 || name === "srcdoc" ||
            ((name === "href" || name === "src" || name === "xlink:href" || name === "action" || name === "formaction") &&
             (val.indexOf("javascript:") === 0 || val.indexOf("data:text/html") === 0 || val.indexOf("vbscript:") === 0))) {
          el.removeAttribute(a.name);
        }
      });
    });
    return tpl.innerHTML;
  }

  /* ── Control de formularios ──────────────────────────────────────────── */

  function controlValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "radio") return el.checked ? el.value : undefined;
    if (el.multiple) return Array.from(el.selectedOptions).map(function (o) { return o.value; });
    if (el.type === "number" || el.type === "range") return el.value === "" ? null : Number(el.value);
    return el.value;
  }
  function writeControl(el, value) {
    if (value == null) return;
    if (el.type === "checkbox") el.checked = !!value;
    else if (el.type === "radio") el.checked = String(el.value) === String(value);
    else if (el.multiple && Array.isArray(value)) Array.from(el.options).forEach(function (o) { o.selected = value.includes(o.value); });
    else if (String(el.value) !== String(value)) el.value = value;
  }

  /* ── Contexto de fila (data-spork-for) ───────────────────────────────── */

  function rowOf(node) {
    var rowEl = node && node.closest ? node.closest("[data-spork-row-managed]") : null;
    return rowEl && rowEl.__sporkRow ? rowEl.__sporkRow : null;
  }

  /* Mapas { clave: expr } para class/attrs: acepta JSON ('{"a":"expr"}') o literal JS ('{"a": expr}') */
  function resolveMap(src, row) {
    try {
      var m = JSON.parse(src), out = {};
      Object.keys(m).forEach(function (k) { out[k] = typeof m[k] === "string" ? evaluate(m[k], { row: row }) : m[k]; });
      return out;
    } catch (_) {
      var v = evaluate("(" + src + ")", { row: row });
      return v && typeof v === "object" ? v : {};
    }
  }

  /* ── Event delegation ────────────────────────────────────────────────── */

  function setupDelegation() {
    if (delegationSetUp) return;
    delegationSetUp = true;

    function onInput(e) {
      var el = e.target.closest ? e.target.closest("[data-spork-bind]") : null;
      if (!el) return;
      var value = controlValue(el);
      if (value === undefined) return;
      evaluate(el.dataset.sporkBind + " = __v", { extras: { __v: value }, row: rowOf(el), stmt: true });
    }
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    destroyCallbacks.push(function () {
      document.removeEventListener("input", onInput);
      document.removeEventListener("change", onInput);
    });

    var boundEvents = new Set();
    function ensureEvent(eventName) {
      if (boundEvents.has(eventName)) return;
      boundEvents.add(eventName);
      var handler = function (e) {
        var el = e.target;
        while (el && el !== document) {
          if (el.dataset) {
            var spec = el.dataset.sporkOn;
            if (spec) {
              spec.split(";").forEach(function (pair) {
                var idx = pair.indexOf(":");
                if (idx === -1) return;
                if (pair.slice(0, idx).trim() === eventName) {
                  evaluate(pair.slice(idx + 1).trim(), { extras: { "$event": e, "$element": el }, row: rowOf(el), stmt: true });
                }
              });
            }
            if (eventName === "click" && el.dataset.sporkOnClick) {
              evaluate(el.dataset.sporkOnClick, { extras: { "$event": e, "$element": el }, row: rowOf(el), stmt: true });
            }
          }
          el = el.parentElement;
        }
      };
      document.addEventListener(eventName, handler);
      destroyCallbacks.push(function () { document.removeEventListener(eventName, handler); });
    }

    /* Registra eventos del DOM y de las plantillas <template> (cuyo contenido es inerte) */
    function scan(root) {
      root.querySelectorAll("[data-spork-on]").forEach(function (el) {
        (el.dataset.sporkOn || "").split(";").forEach(function (pair) {
          var name = pair.split(":")[0].trim();
          if (name && pair.indexOf(":") !== -1) ensureEvent(name);
        });
      });
      if (root.querySelector("[data-spork-on-click]")) ensureEvent("click");
    }
    function indexEvents() {
      scan(document);
      document.querySelectorAll("template").forEach(function (t) { scan(t.content); });
    }
    indexEvents();
    destroyCallbacks._indexEvents = indexEvents;
  }

  /* ── Construcción del índice ─────────────────────────────────────────── */

  function entry(el, expr) { return { el: el, expr: expr, deps: null }; }
  function outsideRows(el) { return !el.closest("[data-spork-row-managed]"); }

  function buildIndex() {
    index = emptyIndex();
    function collect(sel, bucket, attr) {
      document.querySelectorAll(sel).forEach(function (el) { if (outsideRows(el)) index[bucket].push(entry(el, el.getAttribute(attr))); });
    }
    collect("[data-spork-text]", "text", "data-spork-text");
    collect("[data-spork-html]", "html", "data-spork-html");
    collect("[data-spork-if]", "if_", "data-spork-if");
    collect("[data-spork-style]", "style", "data-spork-style");
    collect("[data-spork-attrs]", "attrs", "data-spork-attrs");
    collect("[data-spork-class]", "class_", "data-spork-class");
    collect("[data-spork-bind]", "bind", "data-spork-bind");
    document.querySelectorAll("[data-spork-for-src]").forEach(function (el) { index.for_.push({ el: el, id: el.id, deps: null }); });
    var refs = {};
    document.querySelectorAll("[data-spork-ref]").forEach(function (el) { refs[el.dataset.sporkRef] = el; index.refs.push([el, el.dataset.sporkRef]); });
    getState().$refs = refs;
    setupDelegation();
    if (destroyCallbacks._indexEvents) destroyCallbacks._indexEvents();
  }

  /* ── Aplicadores (compartidos entre raíz y filas) ────────────────────── */

  function applyText(el, expr, row) { var v = evaluate(expr, { row: row }); el.textContent = v == null ? "" : String(v); }
  function applyHtml(el, expr, row) { var v = evaluate(expr, { row: row }); el.innerHTML = v == null ? "" : sanitize(String(v)); }
  function applyIf(el, expr, row) { el.style.display = evaluate(expr, { row: row }) ? "" : "none"; }
  function applyStyle(el, expr, row) {
    var o = evaluate("(" + expr + ")", { row: row });
    if (o && typeof o === "object") Object.keys(o).forEach(function (k) { el.style[k] = o[k] == null ? "" : String(o[k]); });
  }
  function applyAttrs(el, expr, row) {
    var map = resolveMap(expr, row);
    Object.keys(map).forEach(function (a) {
      var v = map[a];
      if (v == null || v === false) el.removeAttribute(a); else el.setAttribute(a, v === true ? "" : String(v));
    });
  }
  function applyClass(el, expr, row) {
    var map = resolveMap(expr, row);
    Object.keys(map).forEach(function (c) { el.classList.toggle(c, !!map[c]); });
  }
  function applyBind(el, expr, row) {
    var v = evaluate(expr, { row: row });
    writeControl(el, v);
  }

  var APPLIERS = [
    ["text", "data-spork-text", applyText], ["html", "data-spork-html", applyHtml], ["if_", "data-spork-if", applyIf],
    ["style", "data-spork-style", applyStyle], ["attrs", "data-spork-attrs", applyAttrs],
    ["class_", "data-spork-class", applyClass], ["bind", "data-spork-bind", applyBind]
  ];

  function allIn(root, sel) {
    var list = Array.from(root.querySelectorAll(sel));
    if (root.matches && root.matches(sel)) list.unshift(root);
    return list;
  }
  function applyRow(root, row) {
    APPLIERS.forEach(function (a) {
      allIn(root, "[" + a[1] + "]").forEach(function (el) { stats.evals++; a[2](el, el.getAttribute(a[1]), row); });
    });
  }

  /* ── Listas ──────────────────────────────────────────────────────────── */

  function renderList(entryObj) {
    var container = entryObj.el, template = document.querySelector('template[data-spork-for-template="' + entryObj.id + '"]');
    if (!template) return;
    var values = evaluate(container.dataset.sporkForSrc);
    if (!Array.isArray(values)) values = [];
    var variable = container.dataset.sporkForVar || "item", keyExpr = container.dataset.sporkForKey;
    var fragment = document.createDocumentFragment();

    function rowFor(item) { var r = {}; r[variable] = item; return r; }

    if (keyExpr) {
      var existing = new Map();
      Array.from(container.children).forEach(function (child) { if (child.dataset.sporkKey != null) existing.set(child.dataset.sporkKey, child); });
      values.forEach(function (item) {
        var row = rowFor(item), key = String(evaluate(keyExpr, { row: row })), node = existing.get(key);
        if (node) {
          existing.delete(key); node.__sporkRow = row; applyRow(node, row); fragment.appendChild(node);
        } else {
          Array.from(template.content.cloneNode(true).children).forEach(function (child) {
            child.dataset.sporkRowManaged = ""; child.dataset.sporkKey = key; child.__sporkRow = row;
            applyRow(child, row); fragment.appendChild(child);
          });
        }
      });
      existing.forEach(function (node) { node.remove(); });
      container.appendChild(fragment);
    } else {
      values.forEach(function (item) {
        var row = rowFor(item);
        Array.from(template.content.cloneNode(true).children).forEach(function (child) {
          child.dataset.sporkRowManaged = ""; child.__sporkRow = row;
          applyRow(child, row); fragment.appendChild(child);
        });
      });
      container.replaceChildren(fragment);
    }
  }

  /* ── Render principal (solo bindings afectados) ──────────────────────── */

  function track(e, fn) {
    var prev = tracker, deps = new Set();
    tracker = deps;
    try { fn(); } finally { tracker = prev; }
    e.deps = deps;
    stats.evals++;
  }
  function affected(e, keys, all) {
    if (all || !e.deps) return true;
    for (var k of keys) if (e.deps.has(k)) return true;
    return false;
  }

  function render() {
    pendingRender = false;
    var keys = dirtyKeys, all = dirtyAll;
    dirtyKeys = new Set(); dirtyAll = false;
    if (!keys.size && !all) return;
    stats.renders++;
    try {
      index.for_.forEach(function (e) {
        if (affected(e, keys, all)) {
          track(e, function () { renderList(e); });
          if (destroyCallbacks._indexEvents) destroyCallbacks._indexEvents();
        }
      });
      APPLIERS.forEach(function (a) {
        index[a[0]].forEach(function (e) {
          if (affected(e, keys, all)) track(e, function () { a[2](e.el, e.expr, null); });
        });
      });
    } catch (error) {
      if (debug && global.console) console.error("[Spork] Error en render:", error);
    }
  }

  /* ── API pública ─────────────────────────────────────────────────────── */

  function batch(fn) {
    batchDepth++;
    try { fn(); }
    finally { batchDepth--; if (!batchDepth && pendingRender) requestRender(); }
  }

  function watch(key, fn) {
    var list = watchers.get(key) || [];
    list.push(fn); watchers.set(key, list);
    return function () { watchers.set(key, (watchers.get(key) || []).filter(function (f) { return f !== fn; })); };
  }

  function init(values) {
    Object.keys(values || {}).forEach(function (key) { getState()[key] = values[key]; dirtyKeys.add(key); });
    requestRender();
  }

  function state(initial) {
    init(initial);
    return new Proxy(initial || {}, {
      get: function (_, key) { return getState()[key]; },
      set: function (_, key, value) { set(key, value); return true; }
    });
  }

  function refresh() { dirtyAll = true; requestRender(); }
  function touch(key) { dirtyKeys.add(key); requestRender(); }

  function destroy() {
    destroyCallbacks.forEach(function (fn) { if (typeof fn === "function") fn(); });
    destroyCallbacks.length = 0;
    delegationSetUp = false;
    watchers.clear();
    index = emptyIndex();
    dirtyKeys = new Set(); dirtyAll = false; renderQueued = false; pendingRender = false;
  }

  global.Spork = {
    version:   "4.0",
    set:       set,
    init:      init,
    state:     state,
    batch:     batch,
    watch:     watch,
    touch:     touch,          /* marca una clave como cambiada (tras mutar un objeto/array in situ) */
    refresh:   refresh,        /* reevalúa todos los bindings */
    destroy:   destroy,
    rebuild:   function () { buildIndex(); dirtyAll = true; render(); },
    _eval:     function (src, o) { return evaluate(src, o); },
    _stats:    stats,
    configure: function (options) {
      options = options || {};
      if ("debug" in options) debug = !!options.debug;
      if ("sanitize" in options) sanitizeOpt = options.sanitize;
    }
  };

  /* Atajos globales — permiten usar state(), batch(), watch() sin prefijo Spork. */
  global.state = state;
  global.batch = batch;
  global.watch = watch;

  global.addEventListener("DOMContentLoaded", function () {
    if (global.__state) stateStore = global.__state;
    buildIndex();
    dirtyAll = true;
    render();
  });

})(window);