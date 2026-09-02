# Spork UI 🚀

Un microframework reactivo, ultraligero y moderno para el desarrollo de interfaces web minimalistas y aplicaciones de escritorio embebidas. Diseñado sin dependencias pesadas, combinando un motor de reactividad en JavaScript vainilla con un sistema CSS moderno y fluido (*mobile-first*).

## Características

* **Cero dependencias:** Sin Virtual DOM ni librerías de terceros externas.
* **Estética moderna:** Basado en superficies limpias, variables dinámicas y compatibilidad nativa con Modo Oscuro (`.sz-dark`).
* **Bindings directos:** Sincronización bidireccional de datos (`data-spork-bind`), renderizado de textos (`data-spork-text`) y bucles dinámicos (`data-spork-for-src`).
* **Ultraligero:** Ideal para herramientas locales, paneles de control rápidos y runtimes embebidos.

## Uso rápido

Incluye los archivos en tu documento HTML:

```html
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Spork App</title>
    <link rel="stylesheet" href="spork.css">
</head>
<body>
    <div id="app" class="sz-page">
        <div class="sz-card sz-center">
            <h1 class="sz-h1" data-spork-text="saludo"></h1>
            <input class="sz-input sz-mt-2" type="text" data-spork-bind="saludo">
        </div>
    </div>

    <script src="spork.js"></script>
    <script>
        Spork.init({
            saludo: "¡Hola desde Spork UI!"
        });
    </script>
</body>
</html>