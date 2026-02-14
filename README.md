Conjunto de userscripts para optimizar la operación del sistema de videovigilancia VSaaS (Video Surveillance as a Service) en entornos de seguridad municipal. Desarrollados para agilizar tareas repetitivas de monitoreo de alertas, navegación de cámaras y geolocalización en ArcGIS.

Autor: Leonardo Navarro (@hypr-lupo)
Licencia: MIT
Plataforma: Tampermonkey (Chrome / Edge / Firefox)


Scripts disponibles
PASADOR — Navegación y Geolocalización (uso diario)
Script principal que integra navegación rápida de alertas con búsqueda automática de ubicación de cámaras en ArcGIS.
Funcionalidades:

W — Abre la imagen de la alerta seleccionada
A / D — Navega entre imágenes de la alerta (anterior / siguiente)
Ctrl+Q — Busca la cámara en ArcGIS y abre el mapa centrado en su ubicación
Clipboard automático — Copia el código de cámara al portapapeles al cambiar de alerta
Título de pestaña — Muestra el destacamento y código de cámara activo en la pestaña del navegador

SOGA — Gestión de Estados (circunstancias especiales)
Script complementario para el cambio rápido de estados de alertas. Activar solo cuando se requiera gestión de estados por teclado.
Funcionalidades:

S — Cambia el estado a SIN NOVEDAD
F — Cambia el estado a F.POSITIVO con comentario FALSOPOS
Q — Ciclo inteligente: cualquier estado → HIKCENTRAL → CERRADO, con comentarios automáticos según el flujo


Requisitos

Navegador Google Chrome o Microsoft Edge (versión reciente)
Extensión Tampermonkey instalada
Acceso autenticado a VSaaS (suite.vsaas.ai)
Acceso autenticado a ArcGIS de la organización (solo para funcionalidad Ctrl+Q)


Instalación
Paso 1 — Instalar Tampermonkey

Abrir la Chrome Web Store (o la tienda de extensiones de tu navegador)
Instalar la extensión Tampermonkey
En la configuración de la extensión, verificar que "Permitir acceso a las URL de los archivos" esté habilitado

Paso 2 — Instalar los scripts
Hacer click en el enlace correspondiente. Tampermonkey detectará automáticamente que es un userscript y mostrará un diálogo de instalación.
ScriptInstalaciónUsoPASADORInstalar PASADORSiempre activoSOGAInstalar SOGAActivar según necesidad
Paso 3 — Verificar

Abrir VSaaS y seleccionar una alerta
Presionar W → debe abrir la imagen
Presionar Ctrl+Q → debe abrir ArcGIS con la ubicación de la cámara
Verificar que el título de la pestaña muestre el destacamento y código


Actualizaciones
Los scripts se actualizan automáticamente a través de Tampermonkey. Cuando se publique una nueva versión en este repositorio, Tampermonkey la descargará en segundo plano (verificación diaria por defecto).
Para forzar una actualización manual: Tampermonkey → Utilidades → Verificar actualizaciones.

Referencia rápida de teclas
╔══════════════════════════════════════════════════════╗
║                 VSaaS - PASADOR                      ║
╠══════════════════════════════════════════════════════╣
║  W         Abrir imagen de la alerta                 ║
║  A         Imagen anterior                           ║
║  D         Imagen siguiente                          ║
║  Ctrl+Q    Buscar cámara en ArcGIS                   ║
╠══════════════════════════════════════════════════════╣
║                 VSaaS - SOGA                         ║
╠══════════════════════════════════════════════════════╣
║  S         Estado → SIN NOVEDAD                      ║
║  F         Estado → F.POSITIVO + FALSOPOS            ║
║  Q         Estado → HIKCENTRAL ↔ CERRADO             ║
╚══════════════════════════════════════════════════════╝

Nota: Las teclas solo funcionan cuando no hay un campo de texto enfocado. Si una tecla no responde, haz click en un área vacía de la página primero.


Estructura del repositorio
vsaas-tools/
├── PASADOR_VSaaS_ArcGIS.user.js   ← Script principal
├── SOGA_VSaaS.user.js             ← Script complementario
├── README.md                       ← Este archivo
└── LICENSE                         ← Licencia MIT

Solución de problemas
Las teclas W/A/D no responden después de cambiar un estado
El foco puede quedar atrapado en el selector de estados. Haz click en cualquier área vacía de la página para liberar el foco.
Ctrl+Q no abre ArcGIS
Verificar que la sesión de ArcGIS esté activa en el navegador. El script requiere autenticación previa en el portal de ArcGIS.
El título de la pestaña no se actualiza
El observador se activa al cambiar de alerta. Seleccionar una alerta diferente para verificar.
Tampermonkey no detecta actualizaciones
Ir a Tampermonkey → Dashboard → seleccionar el script → pestaña Configuración → verificar que "Verificar actualizaciones" esté habilitado.

Notas legales
Este software es una herramienta de productividad personal desarrollada de forma independiente. No modifica, altera ni compromete los sistemas VSaaS ni ArcGIS; únicamente automatiza interacciones de interfaz de usuario que el operador realizaría manualmente.
El uso de estos scripts requiere credenciales válidas de acceso a los sistemas correspondientes. Los scripts no almacenan, transmiten ni exponen credenciales ni datos sensibles.

Licencia
Copyright (c) 2026-2027 Leonardo Navarro
