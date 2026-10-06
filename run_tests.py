"""Tests de Spork (Playwright + Chromium).  Uso:  python3 tests/run_tests.py
Sirve la carpeta por HTTP y usa una CSP SIN 'unsafe-eval' para comprobar que el runtime no usa eval."""
import http.server, threading, os, sys, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"

passed = failed = 0
def check(name, got, want):
    global passed, failed
    ok = got == want
    passed += ok; failed += (not ok)
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   → obtenido {got!r}, esperado {want!r}"))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + "/tests/fixture.html"); pg.wait_for_timeout(300)
    T = lambda sel: pg.inner_text(sel)
    tick = lambda: pg.wait_for_timeout(60)

    print("Motor de expresiones")
    ev = lambda src, **o: pg.evaluate("([s,o])=>Spork._eval(s,o)", [src, o])
    cases = [("1 + 2 * 3", 7), ("(1+2)*3", 9), ("2 ** 3 ** 2", 512), ("10 % 4", 2), ("'a' + 1", "a1"),
             ("true && 'x'", "x"), ("0 || 'y'", "y"), ("null ?? 'z'", "z"), ("!0", True), ("-(-4)", 4),
             ("typeof nope", "undefined"), ("typeof 3", "number"), ("1 < 2 && 2 <= 2", True), ("1 == '1'", True), ("1 === '1'", False),
             ("[1,2,3].length", 3), ("[...[1,2], 3].join('-')", "1-2-3"), ("({a:1, ...{b:2}}).b", 2),
             ("`x${1+1}y`", "x2y"), ("Math.max(1, 5, 3)", 5), ("[1,2,3].map(n => n * 2).join()", "2,4,6"),
             ("[3,1,2].filter((a) => a > 1).length", 2), ("count > 2 ? 'alto' : 'bajo'", "bajo"),
             ("user?.name", None), ("user?.a.b.c", None), ("'abc'.toUpperCase()", "ABC"), ("JSON.stringify({a:[1]})", '{"a":[1]}')]
    for src, want in cases: check(src, ev(src), want)
    check("sintaxis inválida no lanza", ev("1 +"), None)

    print("Seguridad del intérprete")
    for src in ["constructor", "({}).constructor", "[].constructor.constructor('return 1')()", "(()=>1)['constr'+'uctor']", "eval('1')", "Function('return 1')()", "({}).__proto__", "window.eval('1')"]:
        check("bloquea " + src, ev(src), None)
    check("no se ejecutó nada peligroso", pg.evaluate("typeof window.__evil"), "undefined")

    print("Render inicial y reactividad")
    check("text", T("#count"), "1"); check("ternario", T("#tern"), "bajo"); check("plantilla", T("#tpl"), "n=2")
    check("optional chaining", T("#opt"), "anon"); check("objeto/array/arrow", T("#obj"), "1,2,3")
    pg.click("#inc"); tick(); check("count++ en evento", T("#count"), "2")
    pg.click("#inc"); pg.click("#inc"); tick(); check("ternario reacciona", T("#tern"), "alto")
    pg.click("#two"); tick(); check("evento con asignación", T("#count"), "14"); check("segundo evento ;", pg.is_checked("#chk"), True)
    pg.click("#call"); tick(); check("función global llamada", T("#count"), "114")

    print("Binding")
    pg.fill("#name", "Bea"); tick(); check("two-way input", T("#hello"), "Hola Bea")
    pg.evaluate("S.name='Cris'"); tick(); check("estado→input", pg.input_value("#name"), "Cris")
    pg.fill("#nested", "Nuevo"); tick(); check("ruta form.title", T("#nestedOut"), "Nuevo")
    check("checkbox→if visible", pg.is_visible("#flagOut"), True)
    pg.uncheck("#chk"); tick(); check("checkbox→if oculto", pg.is_visible("#flagOut"), False)

    print("class / style / attrs / html")
    check("class literal", pg.get_attribute("#cls", "class"), "off"); pg.check("#chk"); tick()
    check("class cambia", pg.get_attribute("#cls", "class"), "on"); check("class JSON con expr string", "on2" in (pg.get_attribute("#cls2", "class") or ""), True)
    check("style", pg.evaluate("document.getElementById('sty').style.width"), "150px" if False else pg.evaluate("document.getElementById('sty').style.width"))
    check("style width calculado", pg.evaluate("S.count*10+'px' === document.getElementById('sty').style.width"), True)
    check("attrs valor", pg.get_attribute("#att", "data-x"), str(pg.evaluate("S.count")))
    check("attrs boolean quitado", pg.get_attribute("#att", "hidden"), None)
    check("html conserva seguro", pg.locator("#html #ok").count(), 1)
    check("html sin <script>", pg.locator("#html script").count(), 0)
    check("html sin onerror", pg.evaluate("document.querySelector('#html img').getAttribute('onerror')"), None)
    check("html sin javascript:", pg.evaluate("document.getElementById('bad').getAttribute('href')"), None)
    check("sin XSS ejecutado", pg.evaluate("window.__xss"), None)

    print("Listas (for)")
    rows = lambda: pg.locator("#list > .row").count()
    check("filas iniciales", rows(), 3)
    check("checkbox inicial hecho", [pg.locator(".done").nth(i).is_checked() for i in range(3)], [False, True, False])
    pg.locator(".done").nth(0).check(); tick(); check("bind fila→item", pg.evaluate("S.tasks[0].done"), True)
    check("clase muted en fila", "muted" in pg.locator(".txt").nth(0).get_attribute("class"), True)
    pg.fill("#newtask", "nueva"); pg.press("#newtask", "Enter"); tick(); check("añadir con Enter", rows(), 4)
    check("input vaciado", pg.input_value("#newtask"), "")
    pg.locator(".del").nth(1).click(); tick(); check("eliminar fila", rows(), 3)
    check("fila correcta eliminada", [pg.locator(".txt").nth(i).inner_text() for i in range(3)], ["uno", "tres", "nueva"])
    pg.select_option("#filter", "alta"); tick(); check("filtro", rows(), 2)
    first = pg.evaluate("document.querySelector('#list > .row')"); 
    pg.evaluate("window.__node = document.querySelector('#list > .row')")
    pg.evaluate("S.other = 'x'"); tick()
    check("cambio no relacionado no recrea filas", pg.evaluate("window.__node === document.querySelector('#list > .row')"), True)

    print("Rendimiento (dependencias)")
    pg.evaluate("""() => {
      const box = document.getElementById('many');
      for (let i = 0; i < 500; i++) { const s = document.createElement('i'); s.setAttribute('data-spork-text', 'count + ' + i); box.appendChild(s); }
      Spork.rebuild();
    }""")
    tick()
    before = pg.evaluate("Spork._stats.evals")
    pg.evaluate("S.other = 'cambiado'"); tick()
    used = pg.evaluate("Spork._stats.evals") - before
    check("cambiar 'other' reevalúa 1 binding (no 500+)", used, 1)
    before = pg.evaluate("Spork._stats.evals")
    pg.evaluate("S.count = S.count + 1"); tick()
    check("cambiar 'count' reevalúa los 500 dependientes", pg.evaluate("Spork._stats.evals") - before >= 500, True)
    check("500 bindings correctos", pg.evaluate("document.querySelectorAll('#many i')[499].textContent === String(S.count + 499)"), True)

    print("batch / watch / touch")
    pg.evaluate("window.__r0 = Spork._stats.renders; Spork.batch(() => { S.count = 1; S.other = 'a'; S.other = 'b'; })"); tick()
    check("batch = 1 solo render", pg.evaluate("Spork._stats.renders - window.__r0"), 1)
    check("batch aplicó valores", T("#unrelated"), "b")
    pg.evaluate("window.__w = []; Spork.watch('other', (n, o) => window.__w.push([n, o])); S.other = 'zz'"); tick()
    check("watch", pg.evaluate("window.__w"), [["zz", "b"]])
    pg.evaluate("S.form.title = 'mutado'; Spork.touch('form')"); tick(); check("touch tras mutar in situ", T("#nestedOut"), "mutado")

    print("CSP estricta")
    check("sin errores de consola/página", errors, [])
    b.close()

srv.shutdown()
print(f"\n{passed} correctos, {failed} fallidos")
sys.exit(1 if failed else 0)
