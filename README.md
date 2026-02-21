# pasador-soga

Conjunto de userscripts para optimizar la operación del sistema de videovigilancia **VSaaS** (Video Surveillance as a Service) en entornos de seguridad municipal. Desarrollados para agilizar tareas repetitivas de monitoreo de alertas, navegación de cámaras y geolocalización en ArcGIS.

> **Autor:** Leonardo Navarro ([@hypr-lupo](https://github.com/hypr-lupo))  
> **Licencia:** MIT  
> **Plataforma:** Tampermonkey (Chrome / Edge / Firefox)

---

## Scripts disponibles

### PASADOR — Navegación y Geolocalización

Script principal que integra navegación rápida de alertas con búsqueda automática de ubicación de cámaras en ArcGIS.

- **W** — Abre la imagen de la alerta seleccionada
- **A / D** — Navega entre imágenes de la alerta (anterior / siguiente)
- **Ctrl+Q** — Busca la cámara en ArcGIS y abre el mapa centrado en su ubicación
- **Clipboard automático** — Copia el código de cámara al portapapeles al seleccionar una alerta
- **Título de pestaña** — Muestra el destacamento y código de cámara activo en la pestaña del navegador


### Mascara — Asistente de Procedimientos 

Apartado que recopila la última hora de procedimientos del Sistema de Seguridad Municipal.

- Funcionalidades de fijado, ignorado y contador de procedimientos pendientes y cerrados de la última hora
- Colorizacion de procedimientos en función de la tipificación del procedimiento
- Botón de localización rápida para ArcGIS y Google Maps  

---

## Requisitos

- Navegador **Google Chrome** o **Microsoft Edge** (versión reciente)
- Extensión **[Tampermonkey](https://www.tampermonkey.net/)** instalada
- Acceso autenticado a **VSaaS** (suite.vsaas.ai)
- Acceso autenticado a **ArcGIS** de la organización (solo para funcionalidad Ctrl+Q)

---

## Instalación

### Paso 1 — Instalar Tampermonkey

1. Abrir la [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
2. Instalar la extensión **Tampermonkey** y verificar que está [instalado](chrome://extensions)
3. Click derecho en el ícono de la extensión, seleccionar **"Administrar extensión"** y verificar que **"Permitir secuencias de comandos del usuario"** esté habilitado

### Paso 2 — Instalar los scripts

Hacer click en el enlace correspondiente. Tampermonkey detectará automáticamente que es un userscript y mostrará un diálogo de instalación.

| Script       | Instalación |
|--------------|------------|
| **PASADOR**  | [Instalar PASADOR](https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/VSaaS-PasadorArcGIS.user.js) |
| **MÁSCARA**  | [Instalar MÁSCARA](https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/Sistema-Mascara.user.js) |


### Paso 3 — Verificar

1. Recargar las páginas del VSaaS y del Sistema de Gestión
2. Escoger el destacamento y seleccionar una alerta
3. Verificar que el título de la pestaña muestre el destacamento y código
4. Presionar **W** → debe abrir la imagen
5. Con **A** y **D** cambian las imágenes en el modo Carrusel
6. Presionar **Ctrl+Q** → debe abrir ArcGIS con la ubicación de la cámara

Ante cualquier eventualidad actualizar la página con F5.

---

## Referencia rápida de teclas

```
╔══════════════════════════════════════════════════════╗
║                 VSaaS - PASADOR                      ║
╠══════════════════════════════════════════════════════╣
║  W         Abrir imagen de la alerta                 ║
║  A         Imagen anterior                           ║
║  D         Imagen siguiente                          ║
║  Ctrl+Q    Buscar cámara en ArcGIS                   ║
╚══════════════════════════════════════════════════════╝
```

> **Nota:** Las teclas solo funcionan cuando no hay un campo de texto enfocado. Si una tecla no responde, haz click en un área vacía de la página primero.

---

## Solución de problemas

**Las teclas W/A/D no responden después de cambiar un estado**  
El foco puede quedar atrapado en el selector de estados. Haz click en cualquier área vacía de la página para liberar el foco.

**Ctrl+Q no abre ArcGIS**  
Verificar que la sesión de ArcGIS esté activa en el navegador. El script requiere autenticación previa en el portal de ArcGIS.

**El título de la pestaña no se actualiza**  
El observador se activa al cambiar de alerta. Seleccionar una alerta diferente para verificar.

**La ubicación por Google Maps no es correcta**
Se realiza la búsqueda tal cual como se realizaría normalmente, esto es un problema del Maps no del Script.

**Tampermonkey no detecta actualizaciones**  
Ir a Tampermonkey → Dashboard → seleccionar el script → pestaña Configuración → verificar que "Verificar actualizaciones" esté habilitado.  

---

## Actualizaciones

Los scripts se actualizan automáticamente a través de Tampermonkey. Cuando se publique una nueva versión en este repositorio, Tampermonkey la descargará en segundo plano (verificación diaria por defecto).

Para forzar una actualización manual: Tampermonkey → Utilidades → Verificar actualizaciones.

---
## Notas legales

El uso de este script queda a discreción y autonomía del funcionario. Asi mismo es una herramienta de productividad personal desarrollada de forma independiente. No modifica, altera ni compromete los sistemas VSaaS ni ArcGIS; únicamente automatiza interacciones de interfaz de usuario que el operador realizaría manualmente.

El uso de estos scripts requiere credenciales válidas de acceso a los sistemas correspondientes. Los scripts no almacenan, transmiten ni exponen credenciales ni datos sensibles.

---

## Licencia

Copyright (c) 2026-2027 Leonardo Navarro

Distribuido bajo licencia MIT. Ver [LICENSE](LICENSE) para más detalles.
