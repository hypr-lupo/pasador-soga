// ==UserScript==
// @name         Sistema Mapa Integrado
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  Mapa Leaflet integrado con procedimientos en vivo y panel Última Hora. Accesible via #mapa-integrado
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2025-2026 Leonardo Navarro
// @license      MIT
// @match        https://seguridad.lascondes.cl/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @resource     LEAFLET_CSS https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css
// @require      https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js
// @run-at       document-idle
// @updateURL    https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/SistemaMapaIntegrado.user.js
// @downloadURL  https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/SistemaMapaIntegrado.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  1. CONFIGURACIÓN                                             ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const CONFIG = {
        HASH: '#mapa-integrado',
        CENTER: [-33.4000, -70.5500],
        ZOOM: 13,
        PROC_URL: '/incidents',
        ARCGIS_VISOR_URL: 'https://arcgismlc.lascondes.cl/portal/apps/webappviewer/index.html?id=118513d990134fcbb9196ac7884cfb8c',
        CAMARAS_FEATURESERVER: null,
        // Refresh adaptativo (segundos) por cantidad de pendientes
        REFRESH: { 0: 20, 3: 12, 10: 7, max: 5 },
        CRITICAS: ['homicidio', 'robo_hurto', 'incendio_gas', 'violencia'],
        REFRESH_CRITICO: 5,
        VENTANA_MIN: 60,
        // Paginación de scraping
        MAX_PAGINAS: 15,
        DELAY_ENTRE_PAGINAS: 400,
        // URL del mapa de incidentes (fuente de coordenadas)
        INCIDENT_MAP_URL: '/incident_maps',
        // Leaflet CDN (fallback si @require/@resource fallan)
        LEAFLET_CSS: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
        LEAFLET_JS: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
        // Mapa
        PAN_PX: 150,
        PAN_INTERVAL: 120,
        NEARBY_RADIUS: 250,
        // Bounds de Las Condes
        BOUNDS: { latMin: -33.50, latMax: -33.34, lonMin: -70.65, lonMax: -70.47 },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  2. ESTADO CENTRALIZADO                                       ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const S = {
        // Mapa y capas
        map: null,
        layers: { proc: null, cam: null, nearby: null, draw: null },
        // Procedimientos
        procs: { all: [], markers: new Map(), ignored: new Set(), pinned: new Set(), pinnedData: new Map(), manualCoords: new Map(), serverCoords: new Map() },
        // Cámaras
        cameras: { data: [], loaded: false },
        // Refresh
        refresh: { timer: null, countdown: 0 },
        // Navegación WASD
        wasd: { keys: new Set(), interval: null },
        // Dibujo
        draw: {
            mode: null,       // null | 1 | 2 | 3
            isDrawing: false,  // Pencil: mouse held
            isDragging: false, // Arrow: mouse held
            dragStart: null,
            pencilPoints: [],
            radiusCenter: null,
            radiusCenterMarker: null,
            distLabel: null,
            temp: null,        // Layer temporal de preview
            history: [],       // Stack para undo
        },
        // Ventanas externas
        windows: { arcgis: null, gmaps: null },
        // Ubicación manual
        placement: { active: false, procId: null },
        // UI
        ui: { container: null, clockTimer: null },
        // Filtro
        activeFilter: 'all',
        // Lifecycle
        abortController: null,
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  3. UTILIDADES                                                ║
    // ╚═══════════════════════════════════════════════════════════════╝

    /** Sanitiza texto para inserción segura en HTML */
    function esc(text) {
        if (!text) return '';
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    /** Formatea distancia en metros o km */
    function fmtDist(m) {
        return m > 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm';
    }

    /** Distancia Haversine entre dos puntos [lat,lon] en metros */
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Verifica si coordenadas caen dentro de Las Condes */
    function dentroDeLC(lat, lon) {
        const b = CONFIG.BOUNDS;
        return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
    }

    /** Sleep helper para retry/throttle */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /**
     * Dirección para ArcGIS: limpia ruido, normaliza separadores.
     */
    function prepararDireccion(dir) {
        return dir
            .replace(/LPR\s*\d+\s*/gi, '')
            .replace(/\(\s*([^)]+?)\s*\)/g, '$1')
            .replace(/,\s*(\d+)\s*$/, ' $1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Dirección para Google Maps: preserva máximo detalle,
     * Google es muy bueno parseando formatos variados.
     */
    function dirParaGMaps(dir) {
        return dir
            .replace(/LPR\s*\d+\s*/gi, '')
            .replace(/\(\s*([^)]+?)\s*\)/g, 'y $1')
            .replace(/\.\s+/g, ' y ')
            .replace(/,\s*(\d+)\s*$/, ' $1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  4. CATEGORÍAS                                                ║
    // ╚═══════════════════════════════════════════════════════════════╝

    // Categorías sincronizadas con Sistema Máscara v3.2.
    // color = fondo rgba para UI, border = acento sólido para bordes/marcadores
    // Orden importa: primera coincidencia gana.
    const CATEGORIAS = [
        { id: 'homicidio', nombre: '☠️ Homicidio', color: 'rgba(153,27,27,.25)', border: '#991b1b',
          keywords: ['homicidio'] },
        { id: 'incendio_gas', nombre: '🔥 Incendio / Gas / Explosivos', color: 'rgba(220,38,38,.2)', border: '#dc2626',
          keywords: ['incendio con lesionados','incendio sin lesionados','incendio forestal','quema de pastizales','amago de incendio','humo visible','humos visibles','artefacto explosivo','escape de gas','emergencias de gas','derrame de liquidos','elementos tóxicos'] },
        { id: 'robo_hurto', nombre: '💰 Robos / Hurtos / Estafas', color: 'rgba(234,88,12,.2)', border: '#ea580c',
          keywords: ['hurtos','estafa','defraudaciones','microtráfico','llamada telefónica tipo estafa','robo a transeúnte'] },
        { id: 'violencia', nombre: '👊 Violencia / Agresión', color: 'rgba(249,115,22,.2)', border: '#f97316',
          keywords: ['agresión','acoso','actos deshonestos','disparos','riña','violencia intrafamiliar','desorden, huelga','huelga y/o manifestación','desorden','desalojo'] },
        { id: 'detenidos', nombre: '🚔 Detenidos', color: 'rgba(217,119,6,.18)', border: '#d97706',
          keywords: ['detenidos por carabineros','detenidos por civiles','detenidos por funcionarios municipales','detenidos por funcionarios policiales','detenidos por pdi'] },
        { id: 'accidente', nombre: '🚗 Accidentes de Tránsito', color: 'rgba(234,179,8,.2)', border: '#eab308',
          keywords: ['accidentes de tránsito','colisión','choque con lesionados','choque sin lesionados','atropello','caida en vehículo','vehículo en panne','solicitud de grúa'] },
        { id: 'salud', nombre: '🏥 Salud / Lesionados', color: 'rgba(20,184,166,.18)', border: '#14b8a6',
          keywords: ['enfermo en interior','enfermo en vía','enfermos','lesionado en interior','lesionado en vía','lesionados','muerte natural','parturienta','oxígeno dependiente','ebrio en via'] },
        { id: 'alarmas', nombre: '🚨 Alarmas / Pánico', color: 'rgba(219,39,119,.15)', border: '#db2777',
          keywords: ['alarma activada','alarma domicilio casa protegida','alarma pat','alarma domicilio fono vacaciones','alarmas domiciliarias','botón sos','botón de pánico'] },
        { id: 'ruidos', nombre: '🔊 Ruidos Molestos', color: 'rgba(8,145,178,.18)', border: '#0891b2',
          keywords: ['ruidos molestos'] },
        { id: 'novedades', nombre: '📋 Novedades / Reportes', color: 'rgba(107,114,128,.15)', border: '#6b7280',
          keywords: ['novedades central','novedades climáticas','novedades cámaras','novedades domicilio casa protegida','novedades domicilio fono vacaciones','novedades globos','novedades instalaciones','novedades permisos','novedades propaganda','novedades servicio carabineros','mal tiempo novedades','reporte destacamentos','reporte servicio especial','reporte servicio patrulleros'] },
        { id: 'administrativo', nombre: '📝 Administrativo / Consultas', color: 'rgba(148,163,184,.12)', border: '#94a3b8',
          keywords: ['inscripcion o consulta casa protegida','agradecimientos','felicitaciones','ayuda al vecino','consulta interna','consultas en general','contigencia fv','corte de llamada','en creación','encuestas','internos','llamada falsa','otros no clasificados','otros','aseo en espacio público','repetición de servicio','transferencia de llamada','solicitud de entrevista','reclamo de vecino en contra del servicio o funcionarios','supervisión a funcionario en terreno'] },
        { id: 'preventivo', nombre: '🔍 Seguridad Preventiva', color: 'rgba(139,92,246,.18)', border: '#8b5cf6',
          keywords: ['alerta analítica','alerta de aforo','alerta de merodeo','auto protegido','casa protegida ingresa','casa protegida','fono vacaciones ingresa','fono vacaciones','domicilio con puertas abiertas','domicilio marcado','marcas sospechosas','detección de vehículo con sistema lector','hallazgo de vehículo con encargo','encargo de vehículo','especies abandonadas','vigilancia especial','sospechoso en vía pública','vehículo abandonado','reporte brigada de halcones','vehículo abierto o con indicios de robo','reporte brigada de vigilancia aero-municipal'] },
        { id: 'infraestructura', nombre: '🏗️ Infraestructura / Daños', color: 'rgba(161,98,7,.18)', border: '#a16207',
          keywords: ['cables cortados','baja altura','desnivel en acera','desnivel en calzada','hoyo o hundimiento','luminaria en mal estado','desganche','árbol derribado','graffiti','daños a mobiliario público','daños a móviles municipales','daños a vehículo o propiedad','escombros en espacio','matriz rota','pabellón patrio','semáforo en mal estado','semaforo en mal estado'] },
        { id: 'servicios_basicos', nombre: '💧 Servicios Básicos / Agua', color: 'rgba(59,130,246,.18)', border: '#3b82f6',
          keywords: ['corte de agua','corte de energía','cañeria rota','ausencia de medidor','calles anegadas','domicilio anegado','paso nivel anegado','canales de agua','grifo abierto','escurrimiento de aguas servidas','material de arrastre','entrega manga plástica'] },
        { id: 'orden_publico', nombre: '⚖️ Orden Público', color: 'rgba(99,102,241,.18)', border: '#6366f1',
          keywords: ['comercio ambulante','consumo de cannabis','alcohol en vía pública','infracción por ordenanza','fiscalización estacionadores','limpia vidrios','mendicidad','indigente','fumar en parques','no usar mascarilla','vehículos mal estacionados','trabajos u ocupación vía pública'] },
        { id: 'animales', nombre: '🐾 Animales', color: 'rgba(16,185,129,.18)', border: '#10b981',
          keywords: ['animales sueltos','encargo de mascota','perro suelto','plagas'] },
        { id: 'patrullaje', nombre: '🚶 Patrullaje / Turnos', color: 'rgba(229,231,235,.35)', border: '#d1d5db',
          keywords: ['patrullaje preventivo','inicio y/0 termino de turno','carga de combustible','constancia de servicio'] },
    ];

    const CAT_OTRO = { id: 'otro', nombre: 'Otro', color: 'rgba(107,114,128,.12)', border: '#6b7280' };

    // Lookup rápido: keyword → categoría (O(1))
    const _kwMap = new Map();
    for (const cat of CATEGORIAS) {
        for (const kw of cat.keywords) _kwMap.set(kw.toLowerCase(), cat);
    }

    function clasificar(tipo) {
        if (!tipo) return CAT_OTRO;
        const lower = tipo.toLowerCase().trim();
        // Intento exacto primero (O(1))
        const exact = _kwMap.get(lower);
        if (exact) return exact;
        // Fallback: substring match
        for (const [kw, cat] of _kwMap) {
            if (lower.includes(kw)) return cat;
        }
        return CAT_OTRO;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  5. COORDENADAS DESDE MAPA DE INCIDENTES (servidor)          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    /** Verifica que lat/lng estén dentro de los límites de Las Condes */
    function inBounds(lat, lng) {
        const b = CONFIG.BOUNDS;
        return lat >= b.latMin && lat <= b.latMax && lng >= b.lonMin && lng <= b.lonMax;
    }

    /**
     * Obtiene coordenadas reales desde /incident_maps.
     * La página embebe un JSON en `new ModelMap('[...]')` con {id, lat, lng} por procedimiento.
     * El `id` es el ID interno de Rails que coincide con los hrefs en /incidents.
     * Retorna Map<internalId(string), [lat, lng]>
     */
    async function fetchIncidentMapCoords() {
        try {
            const resp = await fetch(CONFIG.INCIDENT_MAP_URL, {
                credentials: 'same-origin',
                headers: { 'Accept': 'text/html' },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();

            // Extraer JSON del constructor: new ModelMap('[{\"id\":...}]')
            // El JSON viene con comillas escapadas (\") dentro del string literal JS
            const match = html.match(/new\s+ModelMap\s*\(\s*'(\[[\s\S]*?\])'\s*\)/);
            if (!match) {
                console.warn('[MapaIntegrado] No se encontró ModelMap en /incident_maps');
                return new Map();
            }

            const raw = match[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
            const items = JSON.parse(raw);
            const coords = new Map();
            for (const item of items) {
                const lat = parseFloat(item.lat);
                const lng = parseFloat(item.lng);
                if (!isNaN(lat) && !isNaN(lng) && inBounds(lat, lng)) {
                    coords.set(String(item.id), [lat, lng]);
                }
            }
            console.log(`[MapaIntegrado] Coords servidor: ${coords.size}/${items.length} en bounds`);
            return coords;
        } catch (e) {
            console.error('[MapaIntegrado] Error obteniendo coords de incident_maps:', e);
            return new Map();
        }
    }

    /**
     * Resuelve coordenadas para un procedimiento.
     * Prioridad: 1) manualCoords (operador), 2) serverCoords (incident_maps)
     */
    function resolveCoords(procId, internalId) {
        return S.procs.manualCoords.get(procId)
            || (internalId && S.procs.serverCoords.get(internalId))
            || null;
    }


    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  6. SCRAPER DE PROCEDIMIENTOS (con retry)                     ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function parseProcedimientosHTML(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const filas = doc.querySelectorAll('table.table tbody tr');
        const resultados = [];
        const ahora = Date.now();
        const limite = ahora - CONFIG.VENTANA_MIN * 60000;
        let hayRecientes = false;

        filas.forEach(fila => {
            const celdas = fila.querySelectorAll('td');
            if (celdas.length < 7) return;

            const fechaTexto = celdas[1]?.textContent?.trim();
            if (!fechaTexto) return;

            const m = fechaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
            if (!m) return;
            const fecha = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);

            if (fecha.getTime() < limite) return;
            hayRecientes = true;

            const areaHTML = celdas[0]?.innerHTML || '';
            const estado = areaHTML.includes('badge-danger') ? 'PENDIENTE' : 'CERRADO';
            const tipo = celdas[2]?.textContent?.trim() || '';
            const id = celdas[3]?.textContent?.trim() || '';
            const operador = celdas[4]?.textContent?.trim() || '';
            const descRaw = celdas[5]?.textContent?.trim() || '';
            const desc = descRaw.split('\n')[0]?.substring(0, 120) || '';
            const dir = celdas[6]?.textContent?.trim() || '';

            // Extraer ID interno de Rails desde links: /incidents/1846600
            const internalLink = fila.querySelector('a[href*="/incidents/"]');
            const iidMatch = internalLink?.href?.match(/\/incidents\/(\d+)/);
            const internalId = iidMatch ? iidMatch[1] : null;

            resultados.push({
                fecha: fechaTexto, fechaObj: fecha,
                tipo, id, operador, desc, dir,
                estado, cat: clasificar(tipo),
                internalId,
            });
        });

        resultados.sort((a, b) => b.fechaObj - a.fechaObj);
        return { resultados, seguirBuscando: hayRecientes && filas.length > 0 };
    }

    async function fetchProcedimientos() {
        const todos = new Map(); // id → proc (dedup por ID público)

        for (let pag = 1; pag <= CONFIG.MAX_PAGINAS; pag++) {
            try {
                if (pag > 1) await sleep(CONFIG.DELAY_ENTRE_PAGINAS);
                const url = `${CONFIG.PROC_URL}?_=${Date.now()}&page=${pag}`;
                const resp = await fetch(url, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'text/html' },
                });
                if (!resp.ok) {
                    console.warn(`[MapaIntegrado] Pág ${pag} HTTP ${resp.status}`);
                    break;
                }
                const html = await resp.text();
                const { resultados, seguirBuscando } = parseProcedimientosHTML(html);

                for (const proc of resultados) {
                    if (!todos.has(proc.id)) todos.set(proc.id, proc);
                }

                if (!seguirBuscando) break;
            } catch (e) {
                console.warn(`[MapaIntegrado] Pág ${pag} error:`, e.message);
                break;
            }
        }

        const procs = [...todos.values()].sort((a, b) => b.fechaObj - a.fechaObj);
        console.log(`[MapaIntegrado] ${procs.length} procedimientos en ventana de ${CONFIG.VENTANA_MIN}min`);
        return { procs, live: procs.length > 0 || todos.size === 0 };
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  7. DATOS DE CÁMARAS                                          ║
    // ╚═══════════════════════════════════════════════════════════════╝
    // 3.832 cámaras (dedup) – MAESTRO.kml. Formato compacto: [lat, lng, codigo, dir, dest_idx, tipo_idx, prog_idx]
    // dest_idx → DEST_LOOKUP, tipo_idx → TIPO_LOOKUP, prog_idx → PROG_LOOKUP
    const DEST_LOOKUP = ["CS1 Quinchamalí", "CS2 Errázuriz", "CS3 San Carlos", "CS4 Fleming", "CS5 Apoquindo", "CS6 El Golf", "Red Municipal", "Refugios Inteligentes", "Postes Inteligentes"];
    const TIPO_LOOKUP = ["", "PTZ", "LPR", "FIJA", "FISHEYE", "SOS", "PARLANTE"];
    const PROG_LOOKUP = ["B", "R", "P", "F"];

    const CAMARAS_RAW = [
[-33.38943,-70.53189,'LG1-01 - C 490','CAMPANARIO 499',0,0,0],
[-33.38943,-70.53189,'LG2-06 - LG 9861','CAMPANARIO 499',0,0,0],
[-33.38971,-70.53234,'LG1-02 - C 490','LOS GLADIOLOS 9930',0,0,0],
[-33.38971,-70.53234,'LG1-03 - LG 9930','LOS GLADIOLOS 9930',0,0,0],
[-33.38976,-70.53241,'LG1-04 - LG 9930','LOS GLADIOLOS 9885',0,0,0],
[-33.39028,-70.53288,'LG1-05 - LG 9885','LOS GLADIOLOS 9805',0,0,0],
[-33.38978,-70.53363,'LG1-07 - LG 9805','QUEPE 410',0,0,0],
[-33.38978,-70.53363,'LG1-08 - Q 433','QUEPE 410',0,0,0],
[-33.3905,-70.53311,'LG1-09 - Q 433','LOS GLADIOLOS 9763',0,0,0],
[-33.39078,-70.53343,'LG1-11 - LG 9763','LOS GLADIOLOS 9716',0,0,0],
[-33.39078,-70.53343,'LG1-12 - LG 9595','LOS GLADIOLOS 9716',0,0,0],
[-33.39076,-70.53349,'LG1-17 - H 386','LOS GLADIOLOS 9716',0,0,0],
[-33.39128,-70.53393,'LG1-18 - LG 9619','LOS GLADIOLOS 9619',0,0,0],
[-33.38997,-70.53262,'LG2-10 - Q 394','LOS GLADIOLOS 9861',0,0,0],
[-33.39015,-70.53435,'LG2-14 - LG 9716','HUENTELAUQUEN 410',0,0,0],
[-33.39015,-70.53435,'LG2-15 - H 421','HUENTELAUQUEN 410',0,0,0],
[-33.38967,-70.53502,'LG2-16 - H 421','PAUL HARRIS HUENTELAUQUEN',0,0,0],
[-33.39132,-70.53396,'LG2-19 - M 511','MARBERIA 511',0,0,0],
[-33.39132,-70.53396,'LG2-20 - M 511','MARBERIA 511',0,0,0],
[-33.39079,-70.5347,'LG2-21 - M 433','MARBERIA 433',0,0,0],
[-33.39079,-70.5347,'LG2-22 - M 433','MARBERIA 433',0,0,0],
[-33.39012,-70.53562,'LG2-23 - M 361','PAUL HARRIS MARBERIA',0,0,0],
[-33.39023,-70.52977,'LC-01 - LC 10123','LOS CARPINTEROS 10123',0,0,0],
[-33.38979,-70.53029,'LC-02 - LC 10176','LOS CARPINTEROS 10176',0,0,0],
[-33.38976,-70.53032,'LC-03 - LC 10176','LOS CARPINTEROS 10176',0,0,0],
[-33.38972,-70.5304,'LC-04-PTZ - LC 10132','LOS CARPINTEROS 10132',0,1,0],
[-33.39192,-70.53075,'FC-01 - CH 9633','CHARLES HAMILTON 9633',0,0,0],
[-33.39233,-70.53185,'FC-02 - CH 9351','CHARLES HAMILTON 9351',0,0,0],
[-33.39254,-70.53257,'FC-03-PTZ - CH 9307','CHARLES HAMILTON 9307',0,1,0],
[-33.39269,-70.53241,'FC-04 - FPS 925','FRAY PEDRO SUBERCASEUX 925',0,0,0],
[-33.39411,-70.53108,'FC-05 - RLF 1205','ROTONDA LAS FLORES 1205',0,0,0],
[-33.40469,-70.54041,'CI-01 - I 9154','ISLANDIA 9154',0,0,0],
[-33.40495,-70.54169,'CI-02 - I 9116','ISLANDIA 9116',0,0,0],
[-33.40485,-70.54108,'CI-03-PTZ - I 9127','ISLANDIA 9127',0,1,0],
[-33.40434,-70.5413,'CI-04 - C 1360','CANTERBURY 1360',0,0,0],
[-33.40425,-70.54133,'CI-05 - C 1360','CANTERBURY 1360',0,0,0],
[-33.40398,-70.54141,'CI-06 - C 1343','CARTERBURY 1343',0,0,0],
[-33.40387,-70.54144,'CI-07 - C 1343','CARTERBURY 1343',0,0,0],
[-33.40345,-70.54159,'CI-08 - C 1221','CANTERBURY 1221',0,0,0],
[-33.40335,-70.5416,'CI-09 - C 1221','CANTERBURY 1221',0,0,0],
[-33.38161,-70.51782,'BEN-01-PTZ - CLV 11933','CAMINO LA VIÑA 11802',0,1,0],
[-33.38171,-70.51774,'BEN-02 - CFJ 765','CAMINO FRAY JORGE 765',0,0,0],
[-33.38178,-70.51768,'BEN-03 - CFJ 765','CAMINO FRAY JORGE 765',0,0,0],
[-33.38227,-70.51729,'BEN-04-PTZ - CFJ 777','CAMINO FRAY JORGE 777',0,1,0],
[-33.38238,-70.5172,'BEN-05 - CFJ 798','CAMINO FRAY JORGE 798',0,0,0],
[-33.38245,-70.51715,'BEN-06 - CFJ 798','CAMINO FRAY JORGE 798',0,0,0],
[-33.38265,-70.51699,'BEN-07 - CFJ 807','CAMINO FRAY JORGE 807',0,0,0],
[-33.37716,-70.51646,'FBA-01 - FB 12236','FRAY BERNARDO 12236',0,0,0],
[-33.37716,-70.51646,'FBA-02 - FB 12236','FRAY BERNARDO 12236',0,0,0],
[-33.37754,-70.51713,'FBA-03 - FB 12195','FRAY BERNARDO 12195',0,0,0],
[-33.37754,-70.51713,'FBA-04 - FB 12200','FRAY BERNARDO 12200',0,0,0],
[-33.37746,-70.51702,'FBA-05 - FB 12120','FRAY BERNARDO 12120',0,0,0],
[-33.37746,-70.51702,'FBA-06 - FB 12120','FRAY BERNARDO 12120',0,0,0],
[-33.37761,-70.51735,'FBA-07-PTZ - FB 12109','FRAY BERNARDO 12109',0,1,0],
[-33.37733,-70.51681,'FBB-01 - FB 11958','FRAY BERBARDO 11958',0,0,0],
[-33.37733,-70.51681,'FBB-02 - FB 11958','FRAY BERBARDO 11958',0,0,0],
[-33.3783,-70.51888,'FBB-03 - FB 11854','FRAY BERBARDO 11854',0,0,0],
[-33.3783,-70.51888,'FBB-04 - FB 11854','FRAY BERBARDO 11854',0,0,0],
[-33.3782,-70.50715,'CSA-01 - CSA 1026','CAMINO SAN ANTONIO 1026',0,0,0],
[-33.37805,-70.50723,'CSA-02 - CSA 1026','CAMINO SAN ANTONIO 1026',0,0,0],
[-33.37724,-70.50772,'CSA-03-PTZ - CSA 910','CAMINO SAN ANTONIO 910',0,1,0],
[-33.37709,-70.50776,'CSA-04 - CSA 910','CAMINO SAN ANTONIO 910',0,0,0],
[-33.37644,-70.50814,'CSA-05 - CSA 821','CAMINO SAN ANTONIO 821',0,0,0],
[-33.37615,-70.50848,'CSA-06 - CSA 782','CAMINO SAN ANTONIO 782',0,0,0],
[-33.376,-70.50865,'CSA-07 - CSA 782','CAMINO SAN ANTONIO 782',0,0,0],
[-33.39574,-70.54104,'CNN-01 - CN 470','CARDENAL NEWMAN 470',0,0,0],
[-33.39562,-70.54117,'CNN-02 - CN 470','CARDENAL NEWMAN 470',0,0,0],
[-33.39427,-70.54075,'CNN-03 - CN 394','CARDENAL NEWMAN 394',0,0,0],
[-33.39409,-70.54173,'CNN-04 - D 9136','DUNKERQUE 9136',0,0,0],
[-33.39671,-70.54106,'CNS-01 - CN 507','CARDENAL NEWMAN 507',0,0,0],
[-33.3968,-70.54106,'CNS-02 - CN 507','CARDENAL NEWMAN 507',0,0,0],
[-33.39754,-70.54108,'CNS-03-PTZ - CN 536','CARDENAL NEWMAN 536',0,1,0],
[-33.39859,-70.54113,'CNS-04 - CN 576','CARDENAL NEWMAN 576',0,0,0],
[-33.39865,-70.54113,'CNS-05 - CN 576','CARDENAL NEWMAN 576',0,0,0],
[-33.38029,-70.52482,'VF-01 - FL 11335','FRAY LEON 11335',0,0,0],
[-33.38098,-70.52625,'VF-02 - FL 11200','FRAY LEON 11200',0,0,0],
[-33.38096,-70.52622,'VF-05 - FL 11200','FRAY LEON 11200',0,0,0],
[-33.38147,-70.52756,'VF-03 - FL 11140','FRAY LEON 11140',0,0,0],
[-33.38104,-70.52756,'VF-04 - FL 11180','FRAY LEON 11180',0,0,0],
[-33.38175,-70.52579,'VF-06 - VA 430','VALLE ALEGRE 430',0,0,0],
[-33.38172,-70.52581,'VF-07 - VA 430','VALLE ALEGRE 430',0,0,0],
[-33.3822,-70.5266,'VF-08 - VA 505','VALLE ALEGRE 505',0,0,0],
[-33.38212,-70.52646,'VF-09 - VA 505','VALLE ALEGRE 505',0,0,0],
[-33.38226,-70.52547,'VF-10 - VA 445','VALLE ALEGRE 445',0,0,0],
[-33.37605,-70.51559,'LCS-09 - CSFDA 387','CAMINO SAN FRANCISCO DE ASIS 387',0,0,0],
[-33.37385,-70.51135,'LCN-02-PTZ - LC 316','LA CABAÑA 316',0,1,0],
[-33.37289,-70.51188,'LCN-03 - LC 270','LA CABAÑA 270',0,0,0],
[-33.37289,-70.51188,'LCN-04 - LC 270','LA CABAÑA 270',0,0,0],
[-33.37615,-70.51053,'LCS-01 - CLP 12866','CAMINO LA POSADA 12866',0,0,0],
[-33.37601,-70.51016,'LCS-02 - CLP 12889','CAMINO LA POSADA 12889',0,0,0],
[-33.37553,-70.51032,'LCS-03 - LC 606','LA CABAÑA 606',0,0,0],
[-33.3752,-70.51052,'LCS-04 - LC 606','LA CABAÑA 606',0,0,0],
[-33.37519,-70.51061,'LCS-05 - LC 606','LA CABAÑA 606',0,0,0],
[-33.37586,-70.51224,'LCS-06 - FB 12702','FRAY BERNARDO 12702',0,0,0],
[-33.37594,-70.51228,'LCS-07 - FB 12702','FRAY BERNARDO 12702',0,0,0],
[-33.37578,-70.51238,'LCS-08 - FG 483','FRAY GABRIEL 483',0,0,0],
[-33.37514,-70.50175,'SJS-01 - SJDLS 780','SAN JOSE DE LA SIERRA 780',0,0,0],
[-33.37558,-70.50154,'SJS-02 - SJDLS 710','SAN JOSE DE LA SIERRA 710',0,0,0],
[-33.37558,-70.50154,'SJS-03 - SJDLS 720','SAN JOSE DE LA SIERRA 720',0,0,0],
[-33.37598,-70.50134,'SJS-04-PTZ - SJDLS 845','SAN JOSE DE LA SIERRA 845',0,1,0],
[-33.37671,-70.501,'SJS-05 - SJDLS 890','SAN JOSE DE LA SIERRA 890',0,0,0],
[-33.37671,-70.501,'SJS-06 - SJDLS 890','SAN JOSE DE LA SIERRA 890',0,0,0],
[-33.38855,-70.5387,'DLCM-01 - PAPC 60','PASAJE ARTURO PEREZ CANTO 97',0,0,0],
[-33.38852,-70.53878,'DLCM-02 - PAPC 60','PASAJE ARTURO PEREZ CANTO 97',0,0,0],
[-33.3886,-70.53737,'DLCM-03-PTZ - L 9669','LUXEMBURGO 9669',0,1,0],
[-33.38854,-70.5372,'DLCM-04 - L 9711','LUXEMBURGO 9711',0,0,0],
[-33.38852,-70.53716,'DLCM-05 - L 9711','LUXEMBURGO 9711',0,0,0],
[-33.38784,-70.5364,'DLCM-06 - L 9875','LUXEMBURGO 9875',0,0,0],
[-33.3878,-70.53637,'DLCM-07 - L 9875','LUXEMBURGO 9875',0,0,0],
[-33.38726,-70.53576,'DLCM-08 - L 9910','LUXEMBURGO 9910',0,0,0],
[-33.38717,-70.5357,'DLCM-09 - L 9910','LUXEMBURGO 9910',0,0,0],
[-33.38735,-70.53702,'DLCM-10 - DLCM 9854','DOCTOR LUIS CALVO MACKENNA 9854',0,0,0],
[-33.38783,-70.53744,'DLCM-11 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759',0,0,0],
[-33.38791,-70.53751,'DLCM-12 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759',0,0,0],
[-33.38811,-70.53832,'DLCM-13 - CAMM 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',0,0,0],
[-33.38807,-70.5384,'DLCM-14 - CAMM 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',0,0,0],
[-33.39859,-70.54536,'E-01 - ME 553','MARÍA ESTUARDO 553',0,0,0],
[-33.39914,-70.54535,'E-02 - E 572','ESCOCIA 572',0,0,0],
[-33.39948,-70.54535,'E-03 - E 598','ESCOCIA 598',0,0,0],
[-33.39948,-70.54535,'E-04 - E 598','ESCOCIA 598',0,0,0],
[-33.39988,-70.54534,'E-05 - E 614','ESCOCIA 614',0,0,0],
[-33.39988,-70.54534,'E-06-PTZ - E 614','ESCOCIA 614',0,1,0],
[-33.40035,-70.54533,'E-07 - E 635','ESCOCIA 635',0,0,0],
[-33.40035,-70.54533,'E-08 - E 635','ESCOCIA 635',0,0,0],
[-33.40102,-70.54532,'E-09 - E 659','ESCOCIA 659',0,0,0],
[-33.36781,-70.49872,'AMF-01 - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272',0,0,0],
[-33.36784,-70.49867,'AMF-02 - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272',0,0,0],
[-33.36765,-70.49796,'AMF-03-PTZ - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377',0,1,0],
[-33.36762,-70.4979,'AMF-04 - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377',0,0,0],
[-33.367,-70.49744,'AMF-05 - CAF 14420','CAMINO A FARELLONES 14320',0,0,0],
[-33.37923,-70.50768,'FM-01-PTZ - CH 12920','CHARLES HAMILTON 12920',0,1,0],
[-33.37904,-70.50785,'FM-02 - FM 1088','FERNANDEZ MIRA 1088',0,0,0],
[-33.37886,-70.50793,'FM-03 - FM 1061','FERNANDEZ MIRA 1061',0,0,0],
[-33.37852,-70.50817,'FM-04 - FM 1005','FERNANDEZ MIRA 1005',0,0,0],
[-33.37838,-70.50825,'FM-05 - FM 1005','FERNANDEZ MIRA 1005',0,0,0],
[-33.37801,-70.50851,'FM-06 - FM 958','FERNANDEZ MIRA 958',0,0,0],
[-33.37785,-70.5086,'FM-07 - FM 958','FERNANDEZ MIRA 958',0,0,0],
[-33.37727,-70.5089,'FM-08 - FM 865','FERNANDEZ MIRA 865',0,0,0],
[-33.37712,-70.50894,'FM-09 - FM 865','FERNANDEZ MIRA 865',0,0,0],
[-33.39073,-70.53091,'LCS2-01 - C 700','CAMPANARIO 700',0,0,0],
[-33.39089,-70.53052,'LCS2-02 - LC 10020','LOS CARPINTEROS 10020',0,0,0],
[-33.39089,-70.53052,'LCS2-03 - LC 10020','LOS CARPINTEROS 10020',0,0,0],
[-33.39044,-70.52997,'LCS2-04 - LC 10096','LOS CARPINTEROS 10096',0,0,0],
[-33.39044,-70.52997,'LCS2-05 - LC 10096','LOS CARPINTEROS 10096',0,0,0],
[-33.39001,-70.52945,'LCS2-06 - LC 10184','LOS CARPINTEROS 10184',0,0,0],
[-33.38987,-70.52928,'LCS2-07 - LC 10195','LOS CARPINTEROS 10195',0,0,0],
[-33.38967,-70.52904,'LCS2-08 - LC 10231','LOS CARPINTEROS 10231',0,0,0],
[-33.38895,-70.52816,'LCS2-09 - LC 10277','LOS CARPINTEROS 10277',0,0,0],
[-33.37188,-70.50334,'STA-01 - SJDLS 201','SAN JOSE DE LA SIERRA 201',0,0,0],
[-33.37188,-70.50334,'STA-02 - SJDLS 201','SAN JOSE DE LA SIERRA 201',0,0,0],
[-33.37189,-70.50342,'STA-03 - STDA 13685','SANTA TERESA DE AVILA 13685',0,0,0],
[-33.37212,-70.50421,'STA-04 - STDA 13610','SANTA TERESA DE AVILA 13610',0,0,0],
[-33.37212,-70.50421,'STA-05 - STDA 13610','SANTA TERESA DE AVILA 13610',0,0,0],
[-33.3723,-70.50491,'STA-06 - STDA 13516','SANTA TERESA DE AVILA 13516',0,0,0],
[-33.3723,-70.50491,'STA-07 - STDA 13516','SANTA TERESA DE AVILA 13516',0,0,0],
[-33.3723,-70.50491,'STA-08 - STDA 13516','SANTA TERESA DE AVILA 13516',0,0,0],
[-33.37227,-70.50471,'STA-09 - STDA 13575','SANTA TERESA DE AVILA 13575',0,0,0],
[-33.37227,-70.50471,'STA-10-PTZ - STDA 13575','SANTA TERESA DE AVILA 13575',0,1,0],
[-33.37991,-70.51292,'CLV1-01 - CV 12314','CAMINO LA VIÑA 12314',0,0,0],
[-33.3799,-70.51289,'CLV1-02 - CV 12314','CAMINO LA VIÑA 12314',0,0,0],
[-33.37971,-70.51243,'CLV1-03 - CV 12368','CAMINO LA VIÑA 12368',0,0,0],
[-33.37953,-70.51202,'CLV1-04 - CV 12439','CAMINO LA VIÑA 12368',0,0,0],
[-33.37948,-70.51174,'CLV1-05 - CV 12442','CAMINO LA VIÑA 12391',0,0,0],
[-33.37911,-70.511,'CLV1-06 - CV 12479','CAMINO LA VIÑA 12496',0,0,0],
[-33.37913,-70.51099,'CLV1-07 - CV 12479','CAMINO LA VIÑA 12496',0,0,0],
[-33.37909,-70.51101,'CLV1-08 - CV 12479','CAMINO LA VIÑA 12496',0,0,0],
[-33.37834,-70.51143,'CLV2-01 - CV 12486','CAMINO LA VIÑA 12486',0,0,0],
[-33.3783,-70.51146,'CLV2-02 - CV-12486','CAMINO LA VIÑA 12486',0,0,0],
[-33.37823,-70.51168,'CLV2-04 - CV 12478','CAMINO LA VIÑA 12478',0,0,0],
[-33.37825,-70.51174,'CLV2-05 - CV 12478','CAMINO LA VIÑA 12472',0,0,0],
[-33.37841,-70.51208,'CLV2-06 - CV 12444','CAMINO LA VIÑA 12444',0,0,0],
[-33.37877,-70.51292,'CLV2-07 - CV 12354','CAMINO LA VIÑA 12354',0,0,0],
[-33.3788,-70.51299,'CLV2-08 - CV 12354','CAMINO LA VIÑA 12354',0,0,0],
[-33.37931,-70.51344,'CLV2-09 - CV 12313','CAMINO LA VIÑA 12313',0,0,0],
[-33.37823,-70.51149,'CLV2-03-PTZ - CV 12482','CAMINO LA VIÑA 12482',0,1,0],
[-33.39262,-70.49331,'SFDA-01 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,0,0],
[-33.39268,-70.49388,'SFDA-02 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,0,0],
[-33.39268,-70.49388,'SFDA-03 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,0,0],
[-33.38597,-70.53291,'RC-01 - RM 335','RIO MAULE 335',0,0,0],
[-33.3862,-70.53318,'RC-02 - RC 10146','RIO CLARO 10146',0,0,0],
[-33.38636,-70.53332,'RC-03 - RC 10132','RIO CLARO 10132',0,0,0],
[-33.38641,-70.53336,'RC-04 - RC 10129','RIO CLARO 10129',0,0,0],
[-33.3865,-70.53344,'RC-05 - RC 10117','RIO CLARO 10117',0,0,0],
[-33.38664,-70.53357,'RC-06 - RC 10103','RIO CLARO 10103',0,0,0],
[-33.38704,-70.53408,'RC-07 - RC 10045','RIO CLARO 10045',0,0,0],
[-33.38704,-70.53408,'RC-08 - RC 10045','RIO CLARO 10045',0,0,0],
[-33.38731,-70.53441,'RC-09 - C 299','CAMPANARIO 299',0,0,0],
[-33.38731,-70.53441,'RC-10 - C 299','CAMPANARIO 299',0,0,0],
[-33.38713,-70.51886,'LL-01 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,0,0],
[-33.38754,-70.51915,'LL-02 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,0,0],
[-33.38754,-70.51915,'LL-03 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,0,0],
[-33.38779,-70.51914,'LL-04 - CF 1011','FRENTE A CAMINO LA FUENTE N°1011',0,0,0],
[-33.38779,-70.51989,'LL-05 - CF 1005','FRENTE A CAMINO LA FUENTE N°1005',0,0,0],
[-33.38831,-70.51939,'LL-06 - CF 1017','FRENTE A CAMINO LA FUENTE N°1017',0,0,0],
[-33.38763,-70.51956,'LL-07 - LL 11300','FRENTE A LAS LAVANDULAS N°11300',0,0,0],
[-33.38753,-70.51954,'LL-08 - LL 11300','FRENTE A LAS LAVANDULAS N°11300',0,0,0],
[-33.38789,-70.51833,'LL-09 - CO 1025','FRENTE A CAMINO OTOÑAL N°1025',0,0,0],
[-33.39914,-70.54648,'I-01 - I 607','IRLANDA 607',0,0,0],
[-33.39905,-70.54644,'I-02 - I 610','IRLANDA 610',0,0,0],
[-33.3995,-70.54611,'I-03 - I 580','IRLANDA 580',0,0,0],
[-33.39936,-70.54617,'I-04 - I 580','IRLANDA 580',0,0,0],
[-33.39992,-70.54617,'I-05 - I 654','IRLANDA 654',0,0,0],
[-33.40048,-70.54618,'I-06 - I 676','IRLANDA 676',0,0,0],
[-33.40048,-70.54618,'I-07 - I 676','IRLANDA 676',0,0,0],
[-33.40096,-70.54618,'I-08 - I 729','IRLANDA 729',0,0,0],
[-33.40156,-70.54618,'I-09 - I 735','IRLANDA 735',0,0,0],
[-33.40156,-70.54618,'I-10 - I 735','IRLANDA 735',0,0,0],
[-33.40209,-70.54618,'I-11 - I 986','IRLANDA 986',0,0,0],
[-33.40209,-70.54618,'I-12 - I 986','IRLANDA 986',0,0,0],
[-33.38914,-70.5347,'PT-01 - P 365','PETEN 365',0,0,0],
[-33.38914,-70.5347,'PT-02 - P 365','PETEN 365',0,0,0],
[-33.38888,-70.53503,'PT-03 - P 348','PETEN 348',0,0,0],
[-33.38858,-70.53545,'PT-04 - P 330','PETEN 330',0,0,0],
[-33.38858,-70.53545,'PT-05 - P 330','PETEN 330',0,0,0],
[-33.38848,-70.53628,'PT-06 - P 256','PETEN 256',0,0,0],
[-33.38848,-70.53628,'PT-07 - P 265','PETEN 256',0,0,0],
[-33.38814,-70.53595,'PT-08 - P 290','PETEN 290',0,0,0],
[-33.38867,-70.53653,'PT-09 - P 217','PETEN 217',0,0,0],
[-33.38867,-70.53653,'PT-10 - P 217','PETEN 217',0,0,0],
[-33.38906,-70.53747,'PT-11 - T 161','TIKAL 161',0,0,0],
[-33.38906,-70.53747,'PT-12 - T 161','TIKAL 161',0,0,0],
[-33.38929,-70.53643,'PT-13 - T 213','TIKAL 213',0,0,0],
[-33.38929,-70.53643,'PT-14 - T 213','TIKAL 213',0,0,0],
[-33.38878,-70.53601,'PT-15 - T 256','TIKAL 256',0,0,0],
[-33.38878,-70.53601,'PT-16 - T 256','TIKAL 256',0,0,0],
[-33.38623,-70.51688,'MC-01 - M 940','MONTECASSINO 940',0,0,0],
[-33.38597,-70.51762,'MC-02 - M 934','MONTECASSINO 934',0,0,0],
[-33.38597,-70.51762,'MC-03 - M 934','MONTECASSINO 934',0,0,0],
[-33.386,-70.51776,'MC-04 - M 930','MONTECASSINO 930',0,0,0],
[-33.386,-70.51776,'MC-05 - M 930','MONTECASSINO 930',0,0,0],
[-33.38621,-70.51886,'MC-06 - M 912','MONTECASSINO 912',0,0,0],
[-33.38621,-70.51886,'MC-07 - M 912','MONTECASSINO 912',0,0,0],
[-33.3846,-70.51783,'MC-08 - CH 11655','CHARLES HAMILTON 11655',0,0,0],
[-33.38561,-70.51954,'MC-09 - CH 11509','CHARLES HAMILTON 11509',0,0,0],
[-33.38561,-70.51954,'MC-10 - CH 11509','CHARLES HAMILTON 11509',0,0,0],
[-33.37541,-70.50912,'CSAN1-01 - CSA 672','CAMINO SAN ANTONIO 672',0,0,0],
[-33.37514,-70.50927,'CSAN1-02 - CSA 602','CAMINO SAN ANTONIO 602',0,0,0],
[-33.37514,-70.50927,'CSAN1-03 - CSA 602','CAMINO SAN ANTONIO 602',0,0,0],
[-33.37451,-70.50965,'CSAN1-04 - CSA 525','CAMINO SAN ANTONIO 525',0,0,0],
[-33.37459,-70.50955,'CSAN1-05 - CSA 480','CAMINO SAN ANTONIO 480',0,0,0],
[-33.37406,-70.50988,'CSAN1-06 - CSA 405','CAMINO SAN ANTONIO 405',0,0,0],
[-33.37406,-70.50988,'CSAN1-07 - CSA 404','CAMINO SAN ANTONIO 404',0,0,0],
[-33.37406,-70.50988,'CSAN1-08 - CSA 404','CAMINO SAN ANTONIO 404',0,0,0],
[-33.37319,-70.51038,'CSAN1-09 - CSA 391','CAMINO SAN ANTONIO 391',0,0,0],
[-33.37289,-70.51046,'CSAN1-10 - CSA 294','CAMINO SAN ANTONIO 294',0,0,0],
[-33.37245,-70.51079,'CSAN1-11 - CSA 255','CAMINO SAN ANTONIO 255',0,0,0],
[-33.37245,-70.51079,'CSAN1-12 - CSA 255','CAMINO SAN ANTONIO 255',0,0,0],
[-33.37204,-70.51094,'CSAN1-13 - CSA 110','CAMINO SAN ANTONIO 110',0,0,0],
[-33.37204,-70.51094,'CSAN1-14 - CSA 110','CAMINO SAN ANTONIO 110',0,0,0],
[-33.37184,-70.5111,'CSAN1-15 - CSA 99','CAMINO SAN ANTONIO 99',0,0,0],
[-33.37171,-70.51118,'CSAN1-16-PTZ - CSA 89','CAMINO SAN ANTONIO 89',0,1,0],
[-33.37408,-70.50981,'CSAN2-01 - CSA 410','CAMINO SAN ANTONIO 410',0,0,0],
[-33.37288,-70.51048,'CSAN2-02 - CSA 294','CAMINO SAN ANTONIO 294',0,0,0],
[-33.37184,-70.5111,'CSAN2-03 - CSA 89','CAMINO SAN ANTONIO 99',0,0,0],
[-33.37171,-70.51118,'CSAN2-04 - CSA 89','CAMINO SAN ANTONIO 89',0,0,0],
[-33.37138,-70.51136,'CSAN2-05 - CSA 73','CAMINO SAN ANTONIO 73',0,0,0],
[-33.37094,-70.51157,'CSAN2-06 - CSA 29','CAMINO SAN ANTONIO 29',0,0,0],
[-33.37094,-70.51157,'CSAN2-07 - CSA 29','CAMINO SAN ANTONIO 29',0,0,0],
[-33.39332,-70.52192,'VLF-01 - CLF 1236','Camino La Fuente 1236',0,0,0],
[-33.39332,-70.52192,'VLF-02 - CLF 1236','Camino La Fuente 1236',0,0,0],
[-33.39314,-70.52186,'VLF-03 - CLF 1222','Camino La Fuente 1222',0,0,0],
[-33.39314,-70.52186,'VLF-04 - CLF 1222','Camino La Fuente 1222',0,0,0],
[-33.39314,-70.52186,'VLF-05 - PTZ - CLF 1222','Camino La Fuente 1222',0,1,0],
[-33.38906,-70.52763,'E820-01 - E 820','Estoril 855',0,0,0],
[-33.38872,-70.52804,'E820-02 - E 820','Estoril 785',0,0,0],
[-33.38885,-70.52787,'E820-03-PTZ - E 820','Estoril 820',0,1,0],
[-33.40064,-70.54705,'BO-01 - BO 532','Bocaccio 532',0,0,0],
[-33.40073,-70.54682,'BO-02 - BO 560','Bocaccio 560',0,0,0],
[-33.40073,-70.54682,'BO-03-PTZ - BO 560','Bocaccio 560',0,1,0],
[-33.40088,-70.54639,'BO-04 - BO 588','Bocaccio 588',0,0,0],
[-33.40088,-70.54639,'BO-05 - BO 588','Bocaccio 588',0,0,0],
[-33.40098,-70.54617,'BO-06 - BO I','Bocaccio & Irlanda',0,0,0],
[-33.4009,-70.54561,'BO-07 - BO 648','Bocaccio 648',0,0,0],
[-33.40088,-70.54529,'BO-08 - BO 654','Bocaccio 654',0,0,0],
[-33.40087,-70.54516,'BO-09 - BO 675','Bocaccio 675',0,0,0],
[-33.40086,-70.54479,'BO-10 - BO 709','Bocaccio 709',0,0,0],
[-33.39236,-70.54784,'ER-08-PTZ - T 264','Trinidad 264',0,1,0],
[-33.39316,-70.54651,'ER-01 - PHN 182','Padre Hurtado Norte 182',0,0,0],
[-33.3924,-70.54708,'ER-06 - PHN 276','Padre Hurtado Norte 276',0,0,0],
[-33.39316,-70.54651,'ER-02 - PHN 182','Padre Hurtado Norte 182',0,0,0],
[-33.39296,-70.54748,'ER-11 - T 250','Trinidad 250',0,0,0],
[-33.3924,-70.54708,'ER-05 - PHN 276','Padre Hurtado Norte 276',0,0,0],
[-33.39282,-70.54681,'ER-04 - PHN 228','Padre Hurtado Norte 228',0,0,0],
[-33.39282,-70.54681,'ER-03 - PHN 228','Padre Hurtado Norte 228',0,0,0],
[-33.3926,-70.54767,'ER-10 - T 269','Trinidad 269',0,0,0],
[-33.39264,-70.54771,'ER-09 - T 269','Trinidad 269',0,0,0],
[-33.39219,-70.54783,'ER-07 - M 8828','Mardoñal 8828',0,0,0],
[-33.39313,-70.54737,'ER-12 - T 230','Trinidad 230',0,0,0],
[-33.40715,-70.54649,'P-01 - P L','Parana & Lareda Oriente',0,0,0],
[-33.40681,-70.54643,'P-02 - P 8375','Parana 8375',0,0,0],
[-33.4067,-70.54643,'P-03 - P 8378','Parana 8378',0,0,0],
[-33.40649,-70.54638,'P-04 - P 8394','Parana 8394',0,0,0],
[-33.40595,-70.54606,'P-05 - P 8431','Parana 8431',0,0,0],
[-33.40595,-70.54606,'P-06 - P 8430','Parana 8430',0,0,0],
[-33.40582,-70.54601,'P-07 - P 8455','Parana 8455',0,0,0],
[-33.40569,-70.54594,'P-08 - P 8460','Parana 8460',0,0,0],
[-33.40543,-70.54564,'P-09 - P 8479','Parana 8479',0,0,0],
[-33.40522,-70.5455,'P-10 - P 8580','Parana 8580',0,0,0],
[-33.40522,-70.5455,'P-11-PTZ - P 8580','Parana 8580',0,1,0],
[-33.40524,-70.54543,'P-12 - P L','Parana & Laredo Norte',0,0,0],
[-33.40489,-70.54491,'P-13 - P 8730','Parana 8730',0,0,0],
[-33.40485,-70.54479,'P-14 - P 8760','Parana 8760',0,0,0],
[-33.40482,-70.54472,'P-15 - P AG','Parana & Augusta Gerona',0,0,0],
[-33.38054,-70.52111,'FJ1-01 - PH 11649','Paul Harris 11649',0,0,0],
[-33.3801,-70.52043,'FJ1-02 - PH 11675','Paul Harris 11675',0,0,0],
[-33.38033,-70.52002,'FJ1-03 - PH 11729','Paul Harris 11729',0,0,0],
[-33.38057,-70.51983,'FJ1-04 - PH 11711','Paul Harris 11711',0,0,0],
[-33.38001,-70.52025,'FJ1-05 - PH 11710','Paul Harris 11710',0,0,0],
[-33.37969,-70.5198,'FJ1-06 - PH 11758','Paul Harris 11758',0,0,0],
[-33.37969,-70.5198,'FJ1-07 - PH 11758','Paul Harris 11758',0,0,0],
[-33.37954,-70.51955,'FJ1-08 - PH 11765','Paul Harris 11765',0,0,0],
[-33.37954,-70.51955,'FJ1-09 - PH 11758','Paul Harris 11778',0,0,0],
[-33.37951,-70.51932,'FJ1-10 - FJ 508','Fray Jorge 508',0,0,0],
[-33.37951,-70.51932,'FJ1-11-PTZ - FJ 508','Fray Jorge 508',0,1,0],
[-33.37972,-70.51916,'FJ1-12 - FJ 585','Fray Jorge 585',0,0,0],
[-33.37933,-70.51945,'FJ1-13 - FJ 502','Fray Jorge 502',0,0,0],
[-33.37933,-70.51945,'FJ1-14 - FJ 502','Fray Jorge 502',0,0,0],
[-33.37909,-70.51963,'FJ1-16 - FJ 467','Fray Jorge 467',0,0,0],
[-33.37909,-70.51963,'FJ1-15 - FJ 462','Fray Jorge 462',0,0,0],
[-33.37886,-70.51978,'FJ2-01 - FJ 476','Fray Jorge 476',0,0,0],
[-33.37886,-70.51978,'FJ2-02-PTZ - FJ 476','Fray Jorge 476',0,1,0],
[-33.3788,-70.51986,'FJ2-03 - FJ 423','Fray Jorge 423',0,0,0],
[-33.37863,-70.51998,'FJ2-04 - FJ 417','Fray Jorge 417',0,0,0],
[-33.37865,-70.51942,'FJ2-05 - FB 11835','Fray Bernardo 11835',0,0,0],
[-33.37985,-70.52005,'FJ2-06 - PH 11756','Paul Harris 11756',0,0,0],
[-33.37683,-70.51583,'FJ2-07 - FB 585','Fray Bernardo 585',0,0,0],
[-33.37212,-70.50926,'FMU-01 - FM 204','Fray Montalva 204',0,0,0],
[-33.37187,-70.5094,'FMU-02 - FM 150','Fray Montalva 150',0,0,0],
[-33.37187,-70.5094,'FMU-03 - FM 150','Fray Montalva 150',0,0,0],
[-33.37162,-70.50955,'FMU-04 - FM 111','Fray Montalva 111',0,0,0],
[-33.37145,-70.50964,'FMU-05 - FM 102','FRAY MONTALVA 102',0,0,0],
[-33.37145,-70.50964,'FMU-06-PTZ - FM 102','FRAY MONTALVA 102',0,1,0],
[-33.37136,-70.50969,'FMU-07 - FM 102','FRAY MONTALVA 102',0,0,0],
[-33.37112,-70.50982,'FMU-08 - FM 102','FRAY MONTALVA 102',0,0,0],
[-33.38696,-70.5301,'LGE-01 - E 660','ESTORIL 660',0,0,0],
[-33.38724,-70.52974,'LGE-02 - E 680','ESTORIL 680',0,0,0],
[-33.38724,-70.52974,'LGE-03 - E 680','ESTORIL 680',0,0,0],
[-33.38797,-70.52922,'LGE-04 - E 707','ESTORIL 707',0,0,0],
[-33.38734,-70.52993,'LGE-05 - LG 10298','LOS GLADIOLOS 10298',0,0,0],
[-33.38764,-70.5302,'LGE-06 - LG 10292','LOS GLADIOLOS 10292',0,0,0],
[-33.38764,-70.5302,'LGE-07-PTZ','LOS GLADIOLOS 10292',0,1,0],
[-33.38789,-70.53042,'LGE-08 - LG 10262','LOS GLADIOLOS 10262',0,0,0],
[-33.38789,-70.53042,'LGE-09 - LG 10262','LOS GLADIOLOS 10262',0,0,0],
[-33.38804,-70.53054,'LGE-10 - LG 10254','LOS GLADIOLOS 10254',0,0,0],
[-33.38817,-70.53067,'LGE-11 - LG 10210','LOS GLADIOLOS 10210',0,0,0],
[-33.3886,-70.53104,'LGE-12 - LG 10116','LOS GLADIOLOS 10116',0,0,0],
[-33.3886,-70.53104,'LGE-13 - LG 10116','LOS GLADIOLOS 10116',0,0,0],
[-33.3886,-70.53104,'LGE-14 - LG 10116','LOS GLADIOLOS 10116',0,0,0],
[-33.3886,-70.53104,'LGE-15 - LG 10116','LOS GLADIOLOS 10116',0,0,0],
[-33.38911,-70.53049,'LGE-16 - LG 10109','LOS GLADIOLOS 10109',0,0,0],
[-33.39838,-70.52885,'CM-01 - CM 1471','CAMINO MIRASOL 1471',0,0,0],
[-33.39796,-70.5288,'CM-02 - CM 1459','CAMINO MIRASOL 1459',0,0,0],
[-33.39796,-70.5288,'CM-03 - CM 1459','CAMINO MIRASOL 1459',0,0,0],
[-33.3973,-70.52873,'CM-04 - CM 1433','CAMINO MIRASOL 1433',0,0,0],
[-33.39718,-70.52871,'CM-05-PTZ - CM 1431','CAMINO MIRASOL 1431',0,1,0],
[-33.3876,-70.53252,'CFB-01 – PH 10105','PAUL HARRIS 10105',0,0,0],
[-33.3876,-70.53252,'CFB-02 – PH 10105','PAUL HARRIS 10105',0,0,0],
[-33.38755,-70.53248,'CFB-03-PTZ – PH 10109','PAUL HARRIS 10109',0,1,0],
[-33.40315,-70.54323,'COE-01 - O E','OXFORD & EDIMBURGO',0,0,0],
[-33.40274,-70.54329,'COE-02 - O 1060','OXFORD 1060',0,0,0],
[-33.40255,-70.5433,'COE-03 - O 1020','OXFORD 1020',0,0,0],
[-33.40215,-70.5433,'COE-04 - O 940','OXFORD 940',0,0,0],
[-33.40215,-70.5433,'COE-05 - O 940','OXFORD 940',0,0,0],
[-33.40196,-70.5433,'COE-06 - O 913','OXFORD 913',0,0,0],
[-33.40196,-70.5433,'COE-07 - O 913','OXFORD 913',0,0,0],
[-33.40176,-70.5433,'COE-08-PTZ - O 890','OXFORD 890',0,1,0],
[-33.40138,-70.54331,'COE-09 - O 769','OXFORD 769',0,0,0],
[-33.40138,-70.54331,'COE-10 - O 768','OXFORD 768',0,0,0],
[-33.40138,-70.54331,'COE-11 - O 768','OXFORD 768',0,0,0],
[-33.4012,-70.54331,'COE-12 - O 754','OXFORD 754',0,0,0],
[-33.40084,-70.5433,'COE-13 - O B','OXFORD & BOCACCIO',0,0,0],
[-33.4031,-70.54421,'CE-01 - E PHC','EDIMBURGO & PADRE HURTADO CENTRAL',0,0,0],
[-33.40301,-70.54371,'CE-02 - E 8958','EDIMBURGO 8958',0,0,0],
[-33.40301,-70.54371,'CE-03 - E 8958','EDIMBURGO 8958',0,0,0],
[-33.40299,-70.54357,'CE-04 - E 8972','EDIMBURGO 8972',0,0,0],
[-33.40297,-70.54293,'CE-05 - E 9010','EDIMBURGO 9010',0,0,0],
[-33.40299,-70.54327,'CE-06-PTZ - E O','EDIMBURGO & OXFORD',0,1,0],
[-33.40532,-70.54181,'CW1-01 - CW 1571','WATERLOO 1571',0,0,0],
[-33.40491,-70.54194,'CW1-02 - CW I','WATERLOO & ISLANDIA',0,0,0],
[-33.40496,-70.54193,'CW1-03-PTZ - CW I','WATERLOO & ISLANDIA',0,1,0],
[-33.40462,-70.54202,'CW1-04 - CW 1450','WATERLOO 1450',0,0,0],
[-33.40462,-70.54197,'CW1-05 - CW 1449','WATERLOO 1449',0,0,0],
[-33.40439,-70.54204,'CW1-06 - CW 1404','WATERLOO 1404',0,0,0],
[-33.40432,-70.54213,'CW1-07 - CW 1409','WATERLOO 1409',0,0,0],
[-33.40407,-70.5422,'CW1-08 - CW 1347','WATERLOO 1347',0,0,0],
[-33.404,-70.54215,'CW1-09 - CW 1340','WATERLOO 1340',0,0,0],
[-33.40381,-70.54227,'CW1-10 - CW 1309','WATERLOO 1309',0,0,0],
[-33.40366,-70.54231,'CW1-11 - CW 1237','WATERLOO 1237',0,0,0],
[-33.40358,-70.54228,'CW1-12 - CW 1212','WATERLOO 1212',0,0,0],
[-33.40358,-70.54228,'CW1-13 - CW 1212','WATERLOO 1212',0,0,0],
[-33.40327,-70.54242,'CW1-14 - CW 1149','WATERLOO 1149',0,0,0],
[-33.40316,-70.54241,'CW1-15 - CW 1120','WATERLOO 1120',0,0,0],
[-33.40293,-70.54252,'CW1-16 - CW E','WATERLOO & EDIMBURGO',0,0,0],
[-33.40293,-70.54252,'CW2-01-PTZ - CW E','WATERLOO & EDIMBURGO',0,1,0],
[-33.40264,-70.54252,'CW2-02 - CW 1066','WATERLOO 1066',0,0,0],
[-33.40269,-70.54256,'CW2-03 - CW 1065','WATERLOO 1065',0,0,0],
[-33.40237,-70.54253,'CW2-04 - CW 1010','WATERLOO 1010',0,0,0],
[-33.40204,-70.54257,'CW2-05 - CW 931','WATERLOO 931',0,0,0],
[-33.4019,-70.5426,'CW2-06 - CW 913','WATERLOO 913',0,0,0],
[-33.40155,-70.54259,'CW2-07 - CW 836','WATERLOO 836',0,0,0],
[-33.40163,-70.54257,'CW2-08 - CW 848','WATERLOO 848',0,0,0],
[-33.40135,-70.54264,'CW2-09 - CW 789','WATERLOO 789',0,0,0],
[-33.40132,-70.54258,'CW2-10 - CW 788','WATERLOO 788',0,0,0],
[-33.40132,-70.54258,'CW2-11 - CW 788','WATERLOO 788',0,0,0],
[-33.4012,-70.54266,'CW2-12 - CW 765','WATERLOO 765',0,0,0],
[-33.40083,-70.54266,'CW2-13 - CW B','WATERLOO & BOCACCIO',0,0,0],
[-33.40083,-70.54266,'CW2-14 - CW B','WATERLOO & BOCACCIO',0,0,0],
[-33.40083,-70.54266,'CW2-15 - CW B','WATERLOO & BOCACCIO',0,0,0],
[-33.40511,-70.54275,'COX-01 - I 9003','Islandia 9003',0,0,0],
[-33.40505,-70.54275,'COX-02 - I O','Islandia & Oxford',0,0,0],
[-33.40466,-70.54284,'COX-03 - O 1422','Oxford 1422',0,0,0],
[-33.40438,-70.54291,'COX-04 - O 1391','Oxford 1391',0,0,0],
[-33.40402,-70.543,'COX-05 - O 1291','Oxford 1291',0,0,0],
[-33.40402,-70.543,'COX-06 - O 1291','Oxford 1291',0,0,0],
[-33.40402,-70.543,'COX-07 - O 1291','Oxford 1291',0,0,0],
[-33.40365,-70.54309,'COX-08 - O 1205','Oxford 1205',0,0,0],
[-33.40315,-70.54323,'COX-09 - O 1119','Oxford 1119',0,0,0],
[-33.4029,-70.54325,'COX-10-PTZ - O E','Oxford & Edimburgo',0,1,0],
[-33.37442,-70.51114,'LCN-01 - FM 12853','FRAY MARTIN 12853',0,0,0],
[-33.39097,-70.52079,'CLFLF-02 - CLF 1159','CAMINO LA FUENTE 1159',6,0,0],
[-33.39105,-70.52093,'CLFLF-01 - CLF 1158','CAMINO LA FUENTE 1158',6,0,0],
[-33.42173,-70.59483,'MU-01 - U 547','Unamuno 547',1,0,0],
[-33.42181,-70.59473,'MU-02 - U 550','Unamuno 550',1,0,0],
[-33.42194,-70.59456,'MU-03 - U 560','Unamuno 560',1,0,0],
[-33.42221,-70.59421,'MU-04 - U 607','Unamuno 607',1,0,0],
[-33.42221,-70.59421,'MU-05 - U 607','Unamuno 607',1,0,0],
[-33.42264,-70.59364,'MU-06 - U 691','Unamuno 691',1,0,0],
[-33.42299,-70.59316,'MU-07 - U 779','Unamuno 779',1,0,0],
[-33.42299,-70.59316,'MU-08 - U 779','Unamuno 779',1,0,0],
[-33.42275,-70.59414,'MU-09 - M 2956','Marne 2956',1,0,0],
[-33.42275,-70.59414,'MU-10 - M 2956','Marne 2956',1,0,0],
[-33.42239,-70.59373,'MU-11 - M 3031','Marne 3031',1,0,0],
[-33.42214,-70.59346,'MU-12 - M 3172','Marne 3172',1,0,0],
[-33.42214,-70.59346,'MU-13 - M 3172','Marne 3172',1,0,0],
[-33.42184,-70.5932,'MU-14 - SC 585','San Crescente 585',1,0,0],
[-33.42348,-70.59256,'MU-15 - U 853','Unamuno 853',1,0,0],
[-33.42348,-70.59256,'MU-16 - U 853','Unamuno 853',1,0,0],
[-33.41074,-70.5987,'CSL-01 - LP 2991','LAS PENAS 2991',1,0,0],
[-33.41105,-70.59737,'CSL-02 - LP 3114','LAS PENAS 3114 C',1,0,0],
[-33.41105,-70.59737,'CSL-03 - LP 3114','LAS PENAS 3114 C',1,0,0],
[-33.41145,-70.59629,'CSL-04 - LP 3297','LAS PEÑAS 3297',1,0,0],
[-33.41145,-70.59629,'CSL-05 - LP 3297','LAS PEÑAS 3297',1,0,0],
[-33.41144,-70.5984,'CSL-06 - CDA 3051','CRISTAL DE ABELLI 3051',1,0,0],
[-33.41144,-70.5984,'CSL-07 - CDA 3051','CRISTAL DE ABELLI 3051',1,0,0],
[-33.42248,-70.58405,'M-01 - M 897','MALAGA 897',1,0,0],
[-33.42226,-70.58406,'M-02 - M 888','MALAGA 888',1,0,0],
[-33.42215,-70.58418,'M-03 - M 859','MALAGA 859',1,0,0],
[-33.42209,-70.5842,'M-04 - M 859','MALAGA 859',1,0,0],
[-33.42138,-70.58442,'M-05 - M 808','MALAGA 808',1,0,0],
[-33.42135,-70.5845,'M-06 - M 782','MALAGA 808',1,0,0],
[-33.42108,-70.58461,'M-07 - M 701','MALAGA 701',1,0,0],
[-33.42103,-70.58463,'M-08 - M 701','MALAGA 701',1,0,0],
[-33.42101,-70.58468,'M-09 - M 701','MALAGA 701',1,0,0],
[-33.42115,-70.58449,'M-10 - M 782','MALAGA 782',1,0,0],
[-33.42067,-70.58479,'M-11-PTZ - M 670','MALAGA 670',1,1,0],
[-33.42058,-70.58488,'M-12 - M 661','MALAGA 661',1,0,0],
[-33.42055,-70.58472,'M-13 - M R','MALAGA & RAPALLO',1,0,0],
[-33.42021,-70.58501,'M-14 - M 557','MALAGA 557',1,0,0],
[-33.42012,-70.58505,'M-15 - M 557','MALAGA 557',1,0,0],
[-33.41987,-70.58518,'M-16 - M 529','MALAGA 529',1,0,0],
[-33.42148,-70.59238,'G-01 - G 547','GALICIA 547',1,0,0],
[-33.42158,-70.59234,'G-02 - G 547','GALICIA 547',1,0,0],
[-33.42197,-70.59173,'G-03 - G 628','GALICIA 628',1,0,0],
[-33.42209,-70.59168,'G-04 - G 662','GALICIA 662',1,0,0],
[-33.42239,-70.59131,'G-05 - G 727','GALICIA 727',1,0,0],
[-33.42245,-70.59125,'G-06 - G 727','GALICIA 727',1,0,0],
[-33.42266,-70.59095,'G-07 - G 788','GALICIA 788',1,0,0],
[-33.42252,-70.59219,'G-08 - B 3326','BAZTAN 3326',1,0,0],
[-33.42246,-70.59232,'G-09 - SC 644','SAN CRESCENTE 644',1,0,0],
[-33.42351,-70.57304,'JDM-01 - JDM 4894','José de Moraleda 4894',1,0,0],
[-33.42351,-70.57304,'JDM-02 - JDM 4894','José de Moraleda 4894',1,0,0],
[-33.41122,-70.59918,'EQ1-01 - CDA 2998','CRISTAL DE ABELI 2998',1,0,0],
[-33.41124,-70.59944,'EQ1-02 - CDA 2988','CRISTAL DE ABELI 2988',1,0,0],
[-33.41159,-70.5993,'EQ1-03 - EQ 3001','EL QUISCO 3001',1,0,0],
[-33.41159,-70.5993,'EQ1-04 - EQ 3001','EL QUISCO 3001',1,0,0],
[-33.41193,-70.59873,'EQ1-05 - EQ 3046','EL QUISCO 3046',1,0,0],
[-33.41204,-70.59855,'EQ1-06 - EQ 3052','EL QUISCO 3052',1,0,0],
[-33.41204,-70.59849,'EQ1-07 - EQ 3152','EL QUISCO 3152',1,0,0],
[-33.41215,-70.59781,'EQ1-08 - EQ 3140','EL QUISCO 3140',1,0,0],
[-33.41218,-70.59762,'EQ1-09 - EQ 3140','EL QUISCO 3140',1,0,0],
[-33.41156,-70.59576,'EQ2-01 - EQ 3311','EL QUISCO 3311',1,0,0],
[-33.41175,-70.59521,'EQ2-02 - EQ 3397','EL QUISCO 3397',1,0,0],
[-33.41201,-70.5949,'EQ2-03 - EQ 3438','EL QUISCO 3438',1,0,0],
[-33.41207,-70.59559,'EQ2-04 - EQ 3408','EL QUISCO 3408',1,0,0],
[-33.41207,-70.59559,'EQ2-05 - EQ 3408','EL QUISCO 3408',1,0,0],
[-33.41205,-70.59619,'EQ2-06 - EQ 3298','EL QUISCO 3298',1,0,0],
[-33.41214,-70.597,'EQ2-07 - EQ 3180','EL QUISCO 3180',1,0,0],
[-33.41214,-70.597,'EQ2-08 - EQ 3180','EL QUISCO 3180',1,0,0],
[-33.41214,-70.597,'EQ2-09 - EQ 3180','EL QUISCO 3180',1,0,0],
[-33.42885,-70.57476,'MBP-01-PTZ - MB AVS','MANUEL BARRIOS & AMERICO VESPUCIO SUR',1,1,0],
[-33.42885,-70.57476,'MBP-02 - MB AVS','MANUEL BARRIOS & AMERICO VESPUCIO SUR',1,0,0],
[-33.42879,-70.57384,'MBP-03 - MB 4539','MANUEL BARRIOS 4593',1,0,0],
[-33.42879,-70.57384,'MBP-04 - MB 4593','MANUEL BARRIOS 4593',1,0,0],
[-33.42878,-70.57365,'MBP-05 - MB 4551','MANUEL BARRIOS 4551',1,0,0],
[-33.42874,-70.57324,'MBP-06 - MB 4627','MANUEL BARRIOS 4627',1,0,0],
[-33.42873,-70.57298,'MBP-07 - MB 4695','MANUEL BARRIOS 4695',1,0,0],
[-33.42872,-70.57283,'MBP-08 - MB 4701','MANUEL BARRIOS 4701',1,0,0],
[-33.42872,-70.57283,'MBP-09 - MB 4701','MANUEL BARRIOS 4701',1,0,0],
[-33.42864,-70.57188,'MBP-10 - MB 4841','MANUEL BARRIOS 4841',1,0,0],
[-33.42864,-70.57188,'MBP-11 - MB 4841','MANUEL BARRIOS 4841',1,0,0],
[-33.42859,-70.57107,'MBP-12 - MB 4993','MANUEL BARRIOS 4993',1,0,0],
[-33.42859,-70.57107,'MBP-13 - MB 4993','MANUEL BARRIOS 4993',1,0,0],
[-33.42844,-70.57066,'MBP-14 - SE 1783','MANUEL BARRIOS 4980',1,0,0],
[-33.42861,-70.5715,'MBP-15 - MB 4915','MANUEL BARRIOS 4915',1,0,0],
[-33.42861,-70.57173,'MBP-16 - MB 4884','MANUEL BARRIOS 4884',1,0,0],
[-33.4189,-70.59205,'H-01 - RS 3570','Renato Sanchez 3570',1,0,0],
[-33.41942,-70.59189,'H-02 - H 367','Hendaya 367',1,0,0],
[-33.41941,-70.59189,'H-03 - H 380','Hendaya 380',1,0,0],
[-33.41961,-70.59182,'H-04 - H 392','Hendaya 392',1,0,0],
[-33.41969,-70.5918,'H-05-PTZ - 395','Hendaya 395',1,1,0],
[-33.41977,-70.59178,'H-06 - H 402','Hendaya 402',1,0,0],
[-33.41984,-70.59175,'H-07 - H 413','Hendaya 413',1,0,0],
[-33.42014,-70.59166,'H-08 - H 438','Hendaya 438',1,0,0],
[-33.42047,-70.59155,'H-09 - H 488','Hendaya 488',1,0,0],
[-33.41984,-70.59175,'H-10 - H PH','Hendaya 413',1,0,0],
[-33.42961,-70.57443,'CAP-01-PTZ - CA 4475','Carlos Alvarado 4475',1,1,0],
[-33.42958,-70.57375,'CAP-02 - CA 4536','Carlos Alvarado 4536',1,0,0],
[-33.42958,-70.57375,'CAP-03 - CA 4536','Carlos Alvarado 4536',1,0,0],
[-33.42955,-70.5735,'CAP-04 - CA 4576','Carlos Alvarado 4576',1,0,0],
[-33.42948,-70.5726,'CAP-05 - CA 4740','Carlos Alvarado 4740',1,0,0],
[-33.42948,-70.5726,'CAP-06 - CA 4740','Carlos Alvarado 4740',1,0,0],
[-33.42944,-70.57164,'CAP-07 - CA 4888','Carlos Alvarado 4888',1,0,0],
[-33.42948,-70.57177,'CAP-08 - CA 4888','Carlos Alvarado 4888',1,0,0],
[-33.42941,-70.57123,'CAP-09 - CA 4944','Carlos Alvarado 4944',1,0,0],
[-33.42941,-70.57123,'CAP-10 - CA 4944','Carlos Alvarado 4944',1,0,0],
[-33.42938,-70.57071,'CAP-11 - CA 5024','Carlos Alvarado 5024',1,0,0],
[-33.42938,-70.57071,'CAP-12 - CA 5024','Carlos Alvarado 5024',1,0,0],
[-33.42937,-70.57044,'CAP-13 - CA 5080','Carlos Alvarado 5080',1,0,0],
[-33.4294,-70.57018,'CAP-14-PTZ - CA SE','Carlos Alvarado esquina Sebastian Elcano',1,1,0],
[-33.42023,-70.56511,'CMU-01 - AVI 6012','Alberto Vial Infate 6000',1,0,0],
[-33.42023,-70.56511,'CMU-02 - AVI 6012','Alberto Vial Infate 6000',1,0,0],
[-33.42022,-70.56592,'CMU-03 - AVI 5922','Alberto Vial Infate 5922',1,0,0],
[-33.42081,-70.56507,'CMU-05 - ADC 6079','Alonso de Camargo 6079',1,0,0],
[-33.42079,-70.5655,'CMU-06 - ADC 6020','Alonso de Camargo 6020',1,0,0],
[-33.42079,-70.5655,'CMU-07 - ADC 6020','Alonso de Camargo 6020',1,0,0],
[-33.42055,-70.56597,'CMU-04 - AVI 5880','Alberto Vial Infate 5880',1,0,0],
[-33.42079,-70.56619,'CMU-08 - ADC 5845','Alonso de Camargo 5845',1,0,0],
[-33.42079,-70.56619,'CMU-09 - ADC 5845','Alonso de Camargo 5845',1,0,0],
[-33.42078,-70.56683,'CMU-10 - ADC M','Alonso de Camargo 5776',1,0,0],
[-33.42078,-70.56683,'CMU-11-PTZ - ADC M','Alonso de Camargo 5776',1,1,0],
[-33.42009,-70.56664,'CMU-12 - M 1231','Medinacelli 1231',1,0,0],
[-33.42009,-70.56664,'MI-01 - M 1231','Medinacelli 1231',1,0,0],
[-33.42037,-70.56673,'MI-02 - M 1237','Medinacelli 1237',1,0,0],
[-33.42077,-70.56679,'MI-03 - ADC M','Medinacelli Esquina Alonso de Camargo',1,0,0],
[-33.42075,-70.5664,'MI-04 - ADC 5870','Alonso de Camargo 5870',1,0,0],
[-33.42101,-70.56679,'MI-05 - M 1260','Medinacelli 1260',1,0,0],
[-33.42133,-70.56699,'MI-06 - M 1283','Medinacelli 1283',1,0,0],
[-33.42133,-70.56699,'MI-07 - M 1283','Medinacelli 1283',1,0,0],
[-33.4219,-70.56724,'MI-08 - DED 5455','Dra. Eloisa Díaz 5455',1,0,0],
[-33.42197,-70.56743,'MI-09 - M 1327','Medinacelli 1327',1,0,0],
[-33.42213,-70.56749,'MI-10-PTZ - M 1330','Medinacelli 1330',1,1,0],
[-33.42252,-70.56779,'MI-11 - M 1358','Medinacelli 1358',1,0,0],
[-33.42153,-70.56807,'MI-12 - DB 1311','Domingo Bondi 1311',1,0,0],
[-33.39919,-70.57345,'CCYK1-01-PTZ - PK 5853','PDTE. KENNEDY 5853',1,1,0],
[-33.39919,-70.57345,'CCYK1-02 - PK 5853','PDTE. KENNEDY 5853',1,0,0],
[-33.399,-70.57308,'CCYK1-03 - PK 5933','PDTE. KENNEDY 5933',1,0,0],
[-33.399,-70.57308,'CCYK1-04 - PK 5933','PDTE. KENNEDY 5933',1,0,0],
[-33.3989,-70.57283,'CCYK1-05 - PK 5947','PDTE. KENNEDY 5947',1,0,0],
[-33.3989,-70.57283,'CCYK1-06 - PK 5947','PDTE. KENNEDY 5947',1,0,0],
[-33.39878,-70.57216,'CCYK1-07 - MN 952','MANQUEHUE NORTE 952',1,0,0],
[-33.39878,-70.57216,'CCYK1-08 - MN 952','MANQUEHUE NORTE 952',1,0,0],
[-33.39914,-70.57106,'CCYK1-09 - MN 952','MANQUEHUE NORTE 952',1,0,0],
[-33.39914,-70.57106,'CCYK1-10 - MN 952','MANQUEHUE NORTE 952',1,0,0],
[-33.40066,-70.57029,'CCYK2-01-PTZ - MN CC','MANQUEHUE NORTE & CERRO COLORADO',1,1,0],
[-33.40072,-70.57127,'CCYK2-02 - CC 6036','CERRO COLORADO 6036',1,0,0],
[-33.40072,-70.57127,'CCYK2-03 - CC 6036','CERRO COLORADO 6036',1,0,0],
[-33.40085,-70.57192,'CCYK2-04 - CC 6028','CERRO COLORADO 6028',1,0,0],
[-33.40085,-70.57192,'CCYK2-05 - CC 6028','CERRO COLORADO 6028',1,0,0],
[-33.40093,-70.57224,'CCYK2-06 - CC 6010','CERRO COLORADO 6010',1,0,0],
[-33.42621,-70.57452,'CR-01 - IC 4580','Isabel la Catolica 4580',1,0,0],
[-33.42595,-70.57495,'CR-02 - IC JM','Isabel la Catolica & Jose de Moraleda',1,0,0],
[-33.426,-70.57538,'CR-03 - IC 4472','Isabel la Catolica 4472',1,0,0],
[-33.42589,-70.57608,'CR-04 - IC 4460','Isabel la Catolica 4460',1,0,0],
[-33.42589,-70.57608,'CR-05-PTZ - IC 4460','Isabel la Catolica 4460',1,1,0],
[-33.42658,-70.5759,'CR-06 - AVS 1520','Americo Vespucio Sur 1520',1,0,0],
[-33.42682,-70.57567,'CR-07 - AVS 1622','Americo Vespucio Sur 1622',1,0,0],
[-33.42726,-70.57494,'CR-08 - JEM 4456','Juan Esteban Montero 4456',1,0,0],
[-33.42721,-70.57435,'CR-09 - JEM 4560','Juan Esteban Montero 4560',1,0,0],
[-33.42403,-70.57557,'FR1-01-PTZ - FR 1206','Fitz Roy 1206',1,1,0],
[-33.42403,-70.57557,'FR1-02 - FR 1206','Fitz Roy 1206',1,0,0],
[-33.42429,-70.57513,'FR1-03 - FR 1231','Fitz Roy 1231',1,0,0],
[-33.42435,-70.57504,'FR1-04 - FR 1240','Fitz Roy 1240',1,0,0],
[-33.42446,-70.57484,'FR1-05 - FR 1259','Fitz Roy 1259',1,0,0],
[-33.42446,-70.57484,'FR1-06 - FR 1260','Fitz Roy 1260',1,0,0],
[-33.42453,-70.57473,'FR1-07 - FR 1266','Fitz Roy 1266',1,0,0],
[-33.42465,-70.57451,'FR1-08 - FR 1272','Fitz Roy 1272',1,0,0],
[-33.42465,-70.57451,'FR1-09 - FR 1272','Fitz Roy 1272',1,0,0],
[-33.42472,-70.5744,'FR1-10 - FR 1280','Fitz Roy 1280',1,0,0],
[-33.42468,-70.57394,'FR1-11 - JDM 4751','Jose de Moraleda 4751',1,0,0],
[-33.42511,-70.57425,'FR1-12 - JDM 4725','Jose de Moraleda 4725',1,0,0],
[-33.42511,-70.57425,'FR1-13 - JDM 4716','Jose de Moraleda 4716',1,0,0],
[-33.42493,-70.57411,'FR1-14 - FR JDM','Fitz Roy & Jose de Moraleda',1,0,0],
[-33.42505,-70.57385,'FR1-15 - FR 1413','Fitz Roy 1413',1,0,0],
[-33.42511,-70.57375,'FR1-16 - FR 1418','Fitz Roy 1418',1,0,0],
[-33.42511,-70.57375,'FR2-01 - FR 1418','Fitz Roy 1418',1,0,0],
[-33.42528,-70.57345,'FR2-02 - FR 1424','Fitz Roy 1424',1,0,0],
[-33.42545,-70.57316,'FR2-03 - FR 1432','Fitz Roy 1432',1,0,0],
[-33.42515,-70.57514,'FR2-04 - FR 1436','Fitz Roy 1436',1,0,0],
[-33.42515,-70.57514,'FR2-05 - FR 1436','Fitz Roy 1436',1,0,0],
[-33.42545,-70.57316,'FR2-06 - FR 1440','Fitz Roy 1440',1,0,0],
[-33.42498,-70.57259,'FR2-07 - FR 1440','Fitz Roy 1440',1,0,0],
[-33.42557,-70.57297,'FR2-08 - FR 1455','Fitz Roy 1445',1,0,0],
[-33.42557,-70.57297,'FR2-09 - FR 1452','Fitz Roy 1452',1,0,0],
[-33.42574,-70.57266,'FR2-10 - FR PDP','Fitz Roy & Puerto de Palos',1,0,0],
[-33.4258,-70.57258,'FR2-11-PTZ - FR PDP','Fitz Roy & Puerto de Palos',1,1,0],
[-33.42564,-70.57228,'FR2-12 - PDP 4916','Puerto de Palos 4916',1,0,0],
[-33.42481,-70.56846,'RP-01 - PDP 5362','PUERTO DE PALOS 5362',1,0,0],
[-33.42482,-70.5685,'RP-02 - PDP 5349','PUERTO DE PALOS 5349',1,0,0],
[-33.42487,-70.56908,'RP-03 - PDP 5325','PUERTO DE PALOS 5325',1,0,0],
[-33.42455,-70.56838,'RP-04 - RP 5373','ROBERTO PERAGALLO 5373',1,0,0],
[-33.42455,-70.56838,'RP-05 - RP 5373','ROBERTO PERAGALLO 5373',1,0,0],
[-33.42435,-70.56829,'RP-06 - RP 5390','ROBERTO PERAGALLO 5390',1,0,0],
[-33.42415,-70.56816,'RP-07 - RP 5477','ROBERTO PERAGALLO 5477',1,0,0],
[-33.42415,-70.56816,'RP-08-PTZ','ROBERTO PERAGALLO 5477',1,1,0],
[-33.42415,-70.56816,'RP-09 - RP 5477','ROBERTO PERAGALLO 5477',1,0,0],
[-33.42376,-70.56795,'RP-10 - RP 5483','ROBERTO PERAGALLO 5483',1,0,0],
[-33.42356,-70.56788,'RP-11 - RP 5482','ROBERTO PERAGALLO 5482',1,0,0],
[-33.42016,-70.58943,'P-01 – P PE','POLONIA & PRESIDENTE ERRAZURIZ',1,0,0],
[-33.41954,-70.58965,'P-02 – P 433','POLONIA 433',1,0,0],
[-33.41954,-70.58965,'P-03 – P 433','POLONIA 433',1,0,0],
[-33.41921,-70.58974,'P-04 – P 395','POLONIA 395',1,0,0],
[-33.41921,-70.58974,'P-05 – P 395','POLONIA 395',1,0,0],
[-33.41921,-70.58974,'P-06-PTZ – P 395','POLONIA 395',1,1,0],
[-33.41885,-70.58985,'P-07 – P 357','POLONIA 357',1,0,0],
[-33.41883,-70.58981,'P-08 – P 326','POLONIA 326',1,0,0],
[-33.42993,-70.5776,'CVL-01 - L 4196','LATADIA 4196',1,0,0],
[-33.43018,-70.57718,'CVL-02 - L 4233','LATADIA 4233',1,0,0],
[-33.43018,-70.57718,'CVL-03 - L 4227','LATADIA 4233',1,0,0],
[-33.4304,-70.57677,'CVL-04 - L 4223','LATADIA INTERIOR 4223',1,0,0],
[-33.43057,-70.57707,'CVL-05 - L 4211','LATADIA INTERIOR 4211',1,0,0],
[-33.43057,-70.57707,'CVL-06 - L 4211','LATADIA INTERIOR 4211',1,0,0],
[-33.43054,-70.57737,'CVL-07 - L 4203','LATADIA INTERIOR 4203',1,0,0],
[-33.43042,-70.578,'CVL-08 - L 4209','LATADIA INTERIOR',1,0,0],
[-33.43036,-70.57795,'CVL-09 - L 4243','LATADIA 4243',1,0,0],
[-33.43004,-70.57772,'CVL-10-PTZ - L 4251','LATADIA 4251',1,1,0],
[-33.41318,-70.58753,'CETG-01 – G 4233','LA GIOCONDA 4233',1,0,0],
[-33.41318,-70.58753,'CETG-02 – G 4233','LA GIOCONDA 4233',1,0,0],
[-33.41323,-70.58766,'CETG-03-PTZ – GM G','LA GIOCONDA & GOLDA MEIR',1,1,0],
[-33.41364,-70.58749,'CETG-04 – GM 122','GOLDA MEIR 122',1,0,0],
[-33.41369,-70.58719,'CETG-05 – T 4222','EL TROVADOR 4222',1,0,0],
[-33.41369,-70.58719,'CETG-06 – T 4222','EL TROVADOR 4222',1,0,0],
[-33.41367,-70.58703,'CETG-07 – T 4253','EL TROVADOR 4253',1,0,0],
[-33.42882,-70.58729,'TA-01 - MSF T','MARIANO SANCHEZ FONTECILLA & TARRAGONA​',1,0,0],
[-33.42877,-70.58699,'TA-02 - T 3622','TARRAGONA​ 3622​',1,0,0],
[-33.42869,-70.58663,'TA-03 - T 3646','TARRAGONA​ 3646​',1,0,0],
[-33.42864,-70.58641,'TA-04 -T 3656','TARRAGONA​ 3656',1,0,0],
[-33.42864,-70.58641,'TA-05 - T 3656','TARRAGONA​ 3656',1,0,0],
[-33.42858,-70.58618,'TA-06 - PTZ - T 3682','TARRAGONA​ 3682​',1,1,0],
[-33.42849,-70.58584,'TA-07 - T 3703','TARRAGONA​ 3703​',1,0,0],
[-33.42849,-70.58584,'TA-08 - T 3703','TARRAGONA​ 3703​',1,0,0],
[-33.42837,-70.58547,'TA-09 - T 3741','TARRAGONA​ 3741',1,0,0],
[-33.42814,-70.58523,'TA-10 - T CD','TARRAGONA &​ CANCILLER DOLLFUSS​',1,0,0],
[-33.4279,-70.5849,'TA-11 - T A','TARRAGONA & ALCANTARA​',1,0,0],
[-33.4279,-70.5849,'TA-12 - T A','TARRAGONA & ALCANTARA​',1,0,0],
[-33.42794,-70.58548,'TA-13 - CD 1351','CANCILLER DOLLFUSS​ 1351',1,0,0],
[-33.42789,-70.58539,'TA-14 - T 3850','TARRAGONA 3850',1,0,0],
[-33.42359,-70.58836,'CMZ-01 - MZ 3768','MARTIN DE ZAMORA 3768',1,0,0],
[-33.42359,-70.58836,'CMZ-02 - MZ 3768','MARTIN DE ZAMORA 3768',1,0,0],
[-33.42362,-70.58857,'CMZ-03-PTZ - MZ 3752','MARTIN DE ZAMORA 3752',1,1,0],
[-33.41531,-70.60226,'CEBRO-01 - E 2799','EBRO 2799',1,0,0],
[-33.41531,-70.60226,'CEBRO-02 - E 2799','EBRO 2799',1,0,0],
[-33.41531,-70.60226,'CEBRO-03-PTZ - E 2799','EBRO 2799',1,1,0],
[-33.42225,-70.57291,'CMO-01 - MO 1267','MARIA OLIVARES 1267',1,0,0],
[-33.42225,-70.57291,'CMO-02-PTZ - MO 1267','MARIA OLIVARES 1267',1,1,0],
[-33.42234,-70.57308,'CMO-03 - MO 1256','MARIA OLIVARES 1256',1,0,0],
[-33.42192,-70.57244,'CMO-04 - VNB 1286','VASCO NUÑEZ DE BALBOA 1286',1,0,0],
[-33.41391,-70.58993,'CPLA-01 - A 99','ALSACIA 99',1,0,0],
[-33.41436,-70.59011,'CPLA-02 - A 100','ALSACIA 100',1,0,0],
[-33.41448,-70.5901,'CPLA-03 - A 57','ALSACIA 57',1,0,0],
[-33.41468,-70.59022,'CPLA-04 - A B','ALSACIA & BERNARDITA',1,0,0],
[-33.41443,-70.59092,'CPLA-05 - NSDLA B','NUESTRA SRA DE LOS ANGELES & BERNARDITA',1,0,0],
[-33.41443,-70.59092,'CPLA-06-PTZ - NSDLA B','NUESTRA SRA DE LOS ANGELES & BERNARDITA',1,1,0],
[-33.41395,-70.59076,'CPLA-07 - NSDLA 133','NUSTRA SRA DE LOS ANGELES 133',1,0,0],
[-33.41395,-70.59076,'CPLA-08 - NSDLA 133','NUSTRA SRA DE LOS ANGELES 133',1,0,0],
[-33.42072,-70.59027,'CSG-01 - PE GE','PADRE ERRAZURIZ & GERTRUDIZ ECHEÑIQUE',1,0,0],
[-33.42124,-70.59026,'CSG-02 - GE 685','GERTRUDIZ ECHEÑIQUE 685',1,0,0],
[-33.42115,-70.59023,'CSG-03 - GE 564','GERTRUDIZ ECHEÑIQUE 564',1,0,0],
[-33.42151,-70.59019,'CSG-04 - GE 609','GERTRUDIZ ECHEÑIQUE 609',1,0,0],
[-33.42152,-70.59011,'CSG-05 - GE 598','GERTRUDIZ ECHEÑIQUE 598',1,0,0],
[-33.42171,-70.59008,'CSG-06-PTZ - GE 640','GERTRUDIZ ECHEÑIQUE 640',1,1,0],
[-33.42181,-70.59016,'CSG-07 - GE N','GERTRUDIZ ECHEÑIQUE & NAVARRA',1,0,0],
[-33.42193,-70.5902,'CSG-08 - SG 3693','SAN GABRIEL 3693',1,0,0],
[-33.42211,-70.59034,'CSG-09 - SG H','SAN GABRIEL & HENDAYA',1,0,0],
[-33.4222,-70.59043,'CSG-10 - SG 3534','SAN GABRIEL 3534',1,0,0],
[-33.4222,-70.59043,'CSG-11 - SG 3534','SAN GABRIEL 3534',1,0,0],
[-33.42205,-70.59043,'CSG-12 - H 663','HENDAYA 663',1,0,0],
[-33.42197,-70.59054,'CSG-13 - H 672','HENDAYA 672',1,0,0],
[-33.4216,-70.59093,'CSG-14 - H 624','HENDAYA 624',1,0,0],
[-33.42115,-70.59142,'CSG-15 - H 535','HENDAYA 535',1,0,0],
[-33.42091,-70.59133,'CSG-16 - PE 3575','PADRE ERRAZURIZ & HENDAYA',1,0,0],
[-33.42073,-70.58258,'AE-01 - P A','PORTOFINO & ALICANTE',1,0,0],
[-33.42124,-70.58229,'AE-02 - A 836','ALICANTE 836',1,0,0],
[-33.42136,-70.58234,'AE-03 - A 839','ALICANTE 839',1,0,0],
[-33.42153,-70.58227,'AE-04 - A 861','ALICANTE 861',1,0,0],
[-33.42157,-70.58216,'AE-05 - A 858','ALICANTE 858',1,0,0],
[-33.42184,-70.58205,'AE-06 - A 894','ALICANTE 894',1,0,0],
[-33.42207,-70.58205,'AE-07-PTZ - A 894','ALICANTE 894',1,1,0],
[-33.4181,-70.59865,'CV90-01 - V 90','VECINAL 90',1,0,0],
[-33.4181,-70.59865,'CV90-02 - V 90','VECINAL 90',1,0,0],
[-33.41839,-70.59854,'CV90-03 - V 90','VECINAL 90',1,0,0],
[-33.41832,-70.59825,'CV90-04 - N 2985','NAPOLEON 2985',1,0,0],
[-33.41852,-70.59861,'CV90-05-PTZ - V N','NAPOLEON & VECINAL',1,1,0],
[-33.42442,-70.59284,'CSGP-01 - MSF SG','MARIANO SANCHEZ FONTECILLA & SAN GABRIEL',1,0,0],
[-33.42418,-70.59252,'CSGP-02 - SG 2922','SAN GABRIEL 2922',1,0,0],
[-33.42385,-70.5923,'CSGP-03 - SG 3011','SAN GABRIEL 3011',1,0,0],
[-33.42386,-70.59219,'CSGP-04 - SG 3087','SAN GABRIEL 3087',1,0,0],
[-33.42376,-70.59207,'CSGP-05 - SG 3011','SAN GABRIEL 3011',1,0,0],
[-33.4237,-70.59215,'CSGP-06 - U SG','UNAMUNO & SAN GABRIEL',1,0,0],
[-33.42359,-70.592,'CSGP-07 - SG 3135','SAN GABRIEL 3135',1,0,0],
[-33.42358,-70.59186,'CSGP-08 - SG 3177','SAN GABRIEL 3177',1,0,0],
[-33.4235,-70.59191,'CSGP-09-PTZ - SG 3094','SAN GABRIEL 3094',1,1,0],
[-33.42324,-70.5916,'CSGP-10 - SG 3225','SAN GABRIEL 3225',1,0,0],
[-33.42319,-70.59143,'CSGP-11 - SG L','SAN GABRIEL & LEON',1,0,0],
[-33.42319,-70.59143,'CSGP-12 - SG L','SAN GABRIEL & LEON',1,0,0],
[-33.42309,-70.59146,'CSGP-13 - SC 800','SAN CRESCENTE 800',1,0,0],
[-33.42309,-70.59146,'CSGP-14 - SC 800','SAN CRESCENTE 800',1,0,0],
[-33.42272,-70.59102,'CSGP-15 - SG 3427','SAN GABRIEL 3427',1,0,0],
[-33.42271,-70.5909,'CSGP-16 - SG 3364','SAN GABRIEL 3364',1,0,0],
[-33.42902,-70.58176,'DLV-01 - DLV 1754A','Daniel de la Vega 1754 A',1,0,0],
[-33.42885,-70.58194,'DLV-02 - DLV 1754C','Daniel de la Vega 1726',1,0,0],
[-33.42878,-70.58203,'DLV-03 - DLV 1726','Daniel de la Vega 1754 C',1,0,0],
[-33.42848,-70.58239,'DLV-04 - DLV 1698','Daniel de la Vega 1798',1,0,0],
[-33.42852,-70.5825,'DLV-05 - DLV MRC','Mariscal Ramon Castilla & Daniel de la Vega',1,0,0],
[-33.42852,-70.5825,'DLV-06-PTZ - DLV MRC','Mariscal Ramon Castilla & Daniel de la Vega',1,1,0],
[-33.42829,-70.5826,'DLV-07 - DLV 1688','Daniel de la Vega 1688',1,0,0],
[-33.42686,-70.58057,'FDAN-01 - FDA F (P)','Fernando De Aragon 4190',1,0,0],
[-33.42691,-70.58112,'FDAN-02 - FDA 4190 (O)','Fernando De Aragon 4181',1,0,0],
[-33.42705,-70.58138,'FDAN-03 - FDA 4181 (O)','Fernando De Aragon 4181',1,0,0],
[-33.42705,-70.58138,'FDAN-04 - FDA 4181 (P)','Fernando De Aragon 4172',1,0,0],
[-33.42706,-70.58171,'FDAN-05 - FDA 4172 (O)','Fernando De Aragon 4160',1,0,0],
[-33.42712,-70.58203,'FDAN-06 - FDA 4160 (P)','Fernando De Aragon 4160',1,0,0],
[-33.42721,-70.58209,'FDAN-07 - FDA 4160 (O)','Fernando De Aragon 4163',1,0,0],
[-33.42721,-70.58209,'FDAN-08 - FDA 4163 (P)','Fernando De Aragon 4163',1,0,0],
[-33.42744,-70.5825,'FDAN-09-PTZ - FDA 4163','Fernando De Aragon 4146',1,1,0],
[-33.4272,-70.58245,'FDAN-10 - FDA 4146 (O)','Fernando De Aragon 4145',1,0,0],
[-33.42745,-70.58237,'FDAN-11 - FDA 4145 (N)','Fernando De Aragon 4145',1,0,0],
[-33.42745,-70.58237,'FDAN-12 - FDA 4145 (P)','Fernando De Aragon 4145',1,0,0],
[-33.42745,-70.58237,'FDAN-13 - FDA 4155 (O)','Juan De Austria 1539',1,0,0],
[-33.42789,-70.582,'FDAN-14 - JDA 1539 (N)','General Blanche 9792',1,0,0],
[-33.42821,-70.58529,'TA-15 - CD 1445 (S)','CANCILLER DOLLFUSS 1445',1,0,0],
[-33.42848,-70.58498,'TA-16 - CD 1457 (S)','CANCILLER DOLLFUSS 1457',1,0,0],
[-33.39315,-70.50708,'CSJ-01-PTZ - CSJ 12350','CUMBRE SAN JUAN 12350',2,1,0],
[-33.39312,-70.50723,'CSJ-02 - CSJ 12350','CUMBRE SAN JUAN 12350',2,0,0],
[-33.39318,-70.50709,'CSJ-03 - CSJ 12350','CUMBRE SAN JUAN 12350',2,0,0],
[-33.3933,-70.5069,'CSJ-04 - CSJ 12415','CUMBRE SAN JUAN 12415',2,0,0],
[-33.3936,-70.5071,'CSJ-05 - CSJ 12408','CUMBRE SAN JUAN 12408',2,0,0],
[-33.39364,-70.5071,'CSJ-06 - CSJ 12408 (Oriente)','CUMBRE SAN JUAN 12408',2,0,0],
[-33.394,-70.50628,'CSJ-07 - CSJ 12485 (Poniente)','CUMBRE SAN JUAN 12485',2,0,0],
[-33.39366,-70.50599,'CSJ-08 - CSJ 12490 (Sur)','CUMBRE SAN JUAN 12490',2,0,0],
[-33.39363,-70.50592,'CSJ-09 - CSJ 12490 (Oriente)','CUMBRE SAN JUAN 12490',2,0,0],
[-33.3936,-70.50597,'CSJ-10 - CSJ 12490','CUMBRE SAN JUAN 12490',2,0,0],
[-33.39322,-70.50688,'CSJ-11 - CSJ 12415 (Oriente)','CUMBRE SAN JUAN 12415',2,0,0],
[-33.39317,-70.50685,'CSJ-12 - CSJ 12415 (Poniente)','CUMBRE SAN JUAN 12415',2,0,0],
[-33.39935,-70.51019,'CLH-01 - SCDA 12212 (Poniente)','SAN CARLOS DE APOQUINDO 12212',2,0,0],
[-33.39931,-70.51016,'CLH-02 - SCDA 12212 (Sur)','SAN CARLOS DE APOQUINDO 12212',2,0,0],
[-33.3991,-70.51048,'CLH-03 - CDLH 12298 (Oriente)','CAMINO DE LAS HOJAS 12298',2,0,0],
[-33.39908,-70.51055,'CLH-04 - CDLH 12298 (Poniente)','CAMINO DE LAS HOJAS 12298',2,0,0],
[-33.39907,-70.511,'CLH-05 - CDLH 12233 (Oriente)','CAMINO DE LAS HOJAS 12233',2,0,0],
[-33.39906,-70.51102,'CLH-06 - CDLH 12233 (Norte)','CAMINO DE LAS HOJAS 12233',2,0,0],
[-33.39909,-70.51101,'CLH-07 - CDLH 12233 (Oriente)','CAMINO DE LAS HOJAS 12233',2,0,0],
[-33.39928,-70.5114,'CLH-08 - CDLH 12151 (Sur)','CAMINO DE LAS HOJAS 12151',2,0,0],
[-33.39926,-70.51142,'CLH-09 - CDLH 12151','CAMINO DE LAS HOJAS 12151',2,0,0],
[-33.39933,-70.5115,'CLH-10 - CDLH 12151 (NorPoniente)','CAMINO DE LAS HOJAS 12151',2,0,0],
[-33.39941,-70.51174,'CLH-11 - CDLH 12145 (Norte)','CAMINO DE LAS HOJAS 12145',2,0,0],
[-33.39945,-70.51204,'CLH-12 - CP 1490 (Norte)','CERRO PINTOR 1490',2,0,0],
[-33.39947,-70.51204,'CLH-13 - CP 1490 (Sur)','CERRO PINTOR 1490',2,0,0],
[-33.40725,-70.5356,'LEGB-01 - GB 9395 (Oriente)','GENERAL BLANCHE 9395',2,0,0],
[-33.40773,-70.53541,'LEGB-02 - LE 379 (Sur)','LA ESCUELA 379',2,0,0],
[-33.40766,-70.53522,'LEGB-03 - LE 374 (Norte)','LA ESCUELA 374',2,0,0],
[-33.40773,-70.53519,'LEGB-04 - LE 374 (Sur)','LA ESCUELA 374',2,0,0],
[-33.40837,-70.53491,'LEGB-05 - LE 442 (Norte)','LA ESCUELA 442',2,0,0],
[-33.40844,-70.53489,'LEGB-06 - LE 442 (Sur)','LA ESCUELA 442',2,0,0],
[-33.40895,-70.5349,'LEGB-07 - LE 475 (Norte)','LA ESCUELA 475',2,0,0],
[-33.38873,-70.50381,'SB-01 - SB 12295 (NorPoniente)','SAN BENITO 12295',2,0,0],
[-33.38804,-70.50435,'SB-02 - SB 12238 (Sur Oriente)','SAN BENITO 12238',2,0,0],
[-33.38811,-70.50458,'SB-03 - SB 12196 (Nor Oriente)','SAN BENITO 12196',2,0,0],
[-33.38774,-70.50494,'SB-04 - SB 12154 (Sur Oriente)','SAN BENITO 12154',2,0,0],
[-33.38772,-70.50496,'SB-05 - SB 12154 (Nor Poniente)','SAN BENITO 12154',2,0,0],
[-33.38743,-70.50528,'SB-06 - SB 12150 (Sur Oriente)','San Benito 12150',2,0,0],
[-33.38759,-70.50565,'SB-07 - EC 803 (Sur Poniente)','EL CONVENTO 803',2,0,0],
[-33.38803,-70.50519,'SB-08-PTZ - EO 12161','EL OBISPO 12161',2,1,0],
[-33.38829,-70.50476,'SB-09 - EO - 12195 (Poniente)','EL OBISPO 12195',2,0,0],
[-33.38844,-70.50483,'SB-10 - EM 821 (Poniente)','EL MONASTERIO 821',2,0,0],
[-33.3889,-70.50542,'SB-11 - EM 838 (Nor Oriente)','EL MONASTERIO 838',2,0,0],
[-33.38853,-70.50472,'SB-12 - EM 826 (Oriente)','EL MONASTERIO 826',2,0,0],
[-33.38836,-70.50441,'SB-13 - EM 814 (Oriente)','EL MONASTERIO 814',2,0,0],
[-33.41382,-70.53139,'CLV-01-PTZ - LV 934','LOMA VERDE 934',2,1,0],
[-33.4138,-70.53139,'CLV-02 - LV 934 (Norte)','LOMA VERDE 934',2,0,0],
[-33.41332,-70.53143,'CLV-03 - LV 929 (Sur)','LOMA VERDE 929',2,0,0],
[-33.41304,-70.53149,'CLV-04 - LV 926 (Sur)','LOMA VERDE 926',2,0,0],
[-33.41299,-70.53152,'CLV-05 - LV 926 (Norte)','LOMA VERDE 926',2,0,0],
[-33.41233,-70.53207,'CLV-06 - LV 912 (Sur Oriente)','LOMA VERDE 912',2,0,0],
[-33.41232,-70.53209,'CLV-07 - LV 912 (Nor Poniente)','LOMA VERDE 912',2,0,0],
[-33.41238,-70.5325,'CLV-08-PTZ - LE 906','LA ESCUELA 906',2,1,0],
[-33.41236,-70.5325,'CLV-09 - LE 906 (Sur Oriente)','LA ESCUELA 906',2,0,0],
[-33.38905,-70.5111,'B-01-PTZ - LM 970','LOS MAITENES 970',2,1,0],
[-33.38894,-70.51109,'B-02 - LM 937 (Sur)','LOS MAITENES 937',2,0,0],
[-33.38844,-70.51182,'B-03 - B 11882 (Oriente)','BEURON 11882',2,0,0],
[-33.38841,-70.51188,'B-04 - B 11882 (Nor Oriente)','BEURON 11882',2,0,0],
[-33.38791,-70.51298,'B-05 - B 11821 (Oriente)','BEURON 11821',2,0,0],
[-33.38789,-70.51302,'B-06 - B 11821 (Nor Poniente)','BEURON 11821',2,0,0],
[-33.38782,-70.51324,'B-07-PTZ - FBC 912','FRANCISCO BULNES CORREA 912',2,1,0],
[-33.39022,-70.50936,'EC-01 - EC 994 (Norte)','EL CAMPANIL 994',2,0,0],
[-33.3898,-70.50905,'EC-02 - EC 980 (Sur)','EL CAMPANIL 980',2,0,0],
[-33.38977,-70.50902,'EC-03 - EC 980 (Norte)','EL CAMPANIL 980',2,0,0],
[-33.3895,-70.50884,'EC-04 - EC 950 (Sur)','EL CAMPANIL 950',2,0,0],
[-33.38947,-70.50883,'EC-05 - EC 950 (Norte)','EL CAMPANIL 950',2,0,0],
[-33.38917,-70.50863,'EC-06 - EC 926 (Sur)','EL CAMPANIL 926',2,0,0],
[-33.38914,-70.5086,'EC-07 - EC 926 (Norte)','EL CAMPANIL 926',2,0,0],
[-33.38879,-70.50835,'EC-08 - LM 12060 (Sur)','LOS MONJES 12060',2,0,0],
[-33.38865,-70.50869,'EC-09 - LM 12042 (Oriente)','LOS MONJES 12042',2,0,0],
[-33.41073,-70.53305,'LML3-01 - LML 732 (Norte)','LUIS MATTE LARRAIN 764',2,0,0],
[-33.41018,-70.53336,'LML3-02 - LML 680 (Sur)','LUIS MATTE LARRAIN 680',2,0,0],
[-33.4102,-70.5334,'LML3-03-PTZ - LML 680','LUIS MATTE LARRAIN 680',2,1,0],
[-33.4098,-70.53348,'LML3-04 - LML 657 (Sur)','LUIS MATTE LARRAIN 657',2,0,0],
[-33.40973,-70.53352,'LML3-05 - LML 657 (Norte)','LUIS MATTE LARRAIN 657',2,0,0],
[-33.4094,-70.53363,'LML3-06 - LML 621 (Norte)','LUIS MATTE LARRAIN 621',2,0,0],
[-33.40869,-70.53396,'LML3-07 - LML 496 (Sur)','LUIS MATTE LARRAIN 9880',2,0,0],
[-33.40308,-70.50994,'SA-01 - SA 2266','SANTOS APOSTOLES 2266',2,0,0],
[-33.40496,-70.50929,'SA-02 - SA 2416','SANTOS APOSTOLES 2416',2,0,0],
[-33.40496,-70.50929,'SA-03 - SA 2416','SANTOS APOSTOLES 2416',2,0,0],
[-33.40631,-70.5088,'SA-04 - SA 2542','SANTOS APOSTOLES 2542',2,0,0],
[-33.40341,-70.51933,'O-01 - GB 1598','GENERAL BLANCHE 11613',2,0,0],
[-33.4066,-70.51795,'O-02 - CO 1801','CAMINO OTOÑAL 2245',2,0,0],
[-33.40432,-70.51913,'O-03 - CO 1902','CAMINO OTOÑAL 1902',2,0,0],
[-33.40447,-70.51909,'O-04 - CO 1902','CAMINO OTOÑAL 1902',2,0,0],
[-33.40503,-70.51886,'O-05-PTZ - CO 1958','CAMINO OTOÑAL 1958',2,1,0],
[-33.40559,-70.51862,'O-06 - CO 2046','CAMINO OTOÑAL 2046',2,0,0],
[-33.40567,-70.51858,'O-07 - CO 2046','CAMINO OTOÑAL 2046',2,0,0],
[-33.40613,-70.51828,'O-08 - CO 2595','CAMINO OTOÑAL 2595',2,0,0],
[-33.41175,-70.51388,'O-09 - CO 2881','CAMINO OTOÑAL 2881',2,0,0],
[-33.41354,-70.52878,'CP-01 - CPO 9702','Carlos Peña Otagui 9702',2,0,0],
[-33.4137,-70.52882,'CP-02 - CP 921','Colina del Peumo 921',2,0,0],
[-33.41407,-70.52876,'CP-03 - CP 927','Colina del Peumo 927',2,0,0],
[-33.41442,-70.52865,'CP-04-PTZ - CP 935','Colina del Peumo 935',2,1,0],
[-33.4144,-70.52865,'CP-05 - CP 935','Colina del Peumo 935',2,0,0],
[-33.41455,-70.52863,'CP-06 - CP 937','Colina del Peumo 937',2,0,0],
[-33.41458,-70.52863,'CP-07 - CP 937','Colina del Peumo 937',2,0,0],
[-33.41441,-70.5284,'CP-08 - CP 951','Colina del Peumo 951',2,0,0],
[-33.41436,-70.528,'CP-09-PTZ - CP 956','Colina del Peumo 956',2,1,0],
[-33.41436,-70.52797,'CP-10 - CP 956','Colina del Peumo 956',2,0,0],
[-33.41439,-70.5277,'CP-11 - CP 968','Colina del Peumo 968',2,0,0],
[-33.4144,-70.52765,'CP-12 - CP 968','Colina del Peumo 968',2,0,0],
[-33.41447,-70.52733,'CP-13 - CP 974','Colina del Peumo 974',2,0,0],
[-33.41449,-70.52728,'CP-14 - CP 974','Colina del Peumo 974',2,0,0],
[-33.41449,-70.52699,'CP-15 - CP 978','Colina del Peumo 978',2,0,0],
[-33.41454,-70.52694,'CP-16 - CP 981','Colina del Peumo 981',2,0,0],
[-33.41261,-70.52799,'CMIR-01-PTZ - CM 9721','COLINA MIRAVALLE 9721',2,1,0],
[-33.41269,-70.52649,'CMIR-02 - CM 9783','COLINA MIRAVALLE 9783',2,0,0],
[-33.41269,-70.52649,'CMIR-03 - CM 9783','COLINA MIRAVALLE 9783',2,0,0],
[-33.41129,-70.52566,'CMIR-04 - CM 9881','COLINA MIRAVALLE 9881',2,0,0],
[-33.41269,-70.52651,'CMIR-05 - CM 9783','COLINA MIRAVALLE 9783',2,0,0],
[-33.40851,-70.51669,'ECV-01 - CO 2490','CAMINO OTOÑAL 2490',2,0,0],
[-33.40841,-70.51675,'ECV-05 - CO 2490','CAMINO OTOÑAL 2490',2,0,0],
[-33.40867,-70.5166,'ECV-02-PTZ - CO 2491','CAMINO OTOÑAL 2491',2,1,0],
[-33.40788,-70.51709,'ECV-03 - CO 2396','CAMINO OTOÑAL 2396',2,0,0],
[-33.4078,-70.51714,'ECV-06 - CO 2396','CAMINO OTOÑAL 2396',2,0,0],
[-33.40881,-70.51653,'ECV-04 - CO 2510','CAMINO OTOÑAL 2510',2,0,0],
[-33.40849,-70.51596,'ECV-07 - EC 11695','EL CORRALERO 11695',2,0,0],
[-33.40822,-70.5153,'ECV-09 - EC 11695','EL CORRALERO 11797',2,0,0],
[-33.40851,-70.516,'ECV-08 - EC 11797','EL CORRALERO 11695',2,0,0],
[-33.40795,-70.51519,'ECV-10 - FBC 2483','FRANCISCO BULNES CORREA 2511',2,0,0],
[-33.40823,-70.51496,'ECV-11-PTZ - FBC 2541','FRANCISCO BULNES CORREA 2541',2,1,0],
[-33.39697,-70.51936,'CEO-01 - CO 1382','CAMINO OTOÑAL 1382',2,0,0],
[-33.39683,-70.5194,'CEO-02 - CO 1390','CAMINO OTOÑAL 1390',2,0,0],
[-33.39697,-70.51941,'CEO-03-PTZ - CO 1382','CAMINO OTOÑAL 1382',2,1,0],
[-33.39653,-70.51931,'CEO-04 - CO 1368','CAMINO OTOÑAL 1368',2,0,0],
[-33.39616,-70.51927,'CEO-05 - CO 1326','CAMINO OTOÑAL 1326',2,0,0],
[-33.40438,-70.52552,'CMQH-01 - CM 2099','CAMINO MIRASOL 2099',2,0,0],
[-33.40453,-70.52545,'CMQH-02 - CM 2099','CAMINO MIRASOL 2099',2,0,0],
[-33.4058,-70.52446,'CMQH-03 - CM 2315','CAMINO MIRASOL 2315',2,0,0],
[-33.4058,-70.52446,'CMQH-04 - CM 2315','CAMINO MIRASOL 2315',2,0,0],
[-33.40836,-70.52269,'CMQH-05 - QH 9990','QUEBRADA HONDA 9990',2,0,0],
[-33.40836,-70.52269,'CMQH-06 - QH 9990','QUEBRADA HONDA 9990',2,0,0],
[-33.40751,-70.52328,'CMQH-07 - CM 2511','CAMINO MIRASOL 2511',2,0,0],
[-33.40751,-70.52328,'CMQH-08 - CM 2511','CAMINO MIRASOL 2511',2,0,0],
[-33.40336,-70.52276,'CLFQH-01-PTZ - GB CLF','GENERAL BLANCHE - CAMINO LA FUENTE',2,1,0],
[-33.40418,-70.52267,'CLFQH-02 - CLF 1917','CAMINO LA FUENTE 1917',2,0,0],
[-33.40429,-70.52264,'CLFQH-03 - CLF 1917','CAMINO LA FUENTE 1917',2,0,0],
[-33.40567,-70.52171,'CLFQH-04 - CLF 2041','CAMINO LA FUENTE 2041',2,0,0],
[-33.40578,-70.52165,'CLFQH-05 - CLF 2041','CAMINO LA FUENTE 2041',2,0,0],
[-33.40615,-70.52141,'CLFQH-06-PTZ - CLF 2117','CAMINO LA FUENTE 2117',2,1,0],
[-33.40695,-70.52087,'CLFQH-07 - CLF 2237','CAMINO LA FUENTE 2237',2,0,0],
[-33.40711,-70.52078,'CLFQH-08 - CLF 2237','CAMINO LA FUENTE 2237',2,0,0],
[-33.40739,-70.52058,'CLFQH-09-PTZ - CLF 2259','CAMINO LA FUENTE 2259',2,1,0],
[-33.38556,-70.5034,'ECM-01 - EC 629','EL CONVENTO 629',2,0,0],
[-33.38556,-70.5034,'ECM-02 - EC 629','EL CONVENTO 629',2,0,0],
[-33.3853,-70.50369,'ECM-03 - EC 619','EL CONVENTO 619',2,0,0],
[-33.38649,-70.50491,'ECM-04 - EC 619','EL CONVENTO 619',2,0,0],
[-33.38641,-70.50434,'ECM-05 - EC 715','EL CONVENTO 715',2,0,0],
[-33.38641,-70.50434,'ECM-06 - EC 715','EL CONVENTO 715',2,0,0],
[-33.38685,-70.50481,'ECM-07 - EC 759','EL CONVENTO 759',2,0,0],
[-33.38571,-70.50345,'ECM-08 - AQ 1603','AGUA QUIETA 1603',2,0,0],
[-33.39129,-70.51334,'LF-01 - LF CLS (Sur)','LOS FALDEOS & CERRO CATEDRAL SUR',2,0,0],
[-33.39168,-70.51358,'LF-02 - LF 1149 (Norte)','LOS FALDEOS 1149',2,0,0],
[-33.39174,-70.51362,'LF-03 - LF 1149 (Sur)','LOS FALDEOS 1149',2,0,0],
[-33.3921,-70.51379,'LF-04 - LF 1169 (Sur)','LOS FALDEOS 1169',2,0,0],
[-33.3929,-70.5141,'LF-05 - LF 1215 (Sur)','LOS FALDEOS 1215',2,0,0],
[-33.39296,-70.51413,'LF-06 - LF 1227 (Oriente)','LOS FALDEOS 1227',2,0,0],
[-33.39302,-70.51415,'LF-07 - LF 1227 (Sur)','LOS FALDEOS 1227',2,0,0],
[-33.39299,-70.51414,'LF-08-PTZ - LF 1227','LOS FALDEOS 1227',2,1,0],
[-33.39338,-70.51431,'LF-09 - LF 1241 (Norte)','LOS FALDEOS 1241',2,0,0],
[-33.39367,-70.51444,'LF-10 - LF 1253 (Norte)','LOS FALDEOS 1253',2,0,0],
[-33.39375,-70.51448,'LF-11 - LF 1262 (Sur)','LOS FALDEOS 1262',2,0,0],
[-33.39412,-70.51461,'LF-12 - LF 1277 (Norte)','LOS FALDEOS 1277',2,0,0],
[-33.39421,-70.51466,'LF-13 - LF 1277 (Sur)','LOS FALDEOS 1277',2,0,0],
[-33.39444,-70.51471,'LF-14 - LF 1286 (Norte)','LOS FALDEOS 1286',2,0,0],
[-33.40227,-70.52799,'LMM-01 - CM 1744','CAMINO MIRASOL 1744',2,0,0],
[-33.40205,-70.52843,'LMM-02 - CM 1701','CAMINO MIRASOL 1701',2,0,0],
[-33.40236,-70.52859,'LMM-03 - LML 10185','LUIS MATTE LARRAIN 10185',2,0,0],
[-33.4025,-70.5291,'LMM-04 - LML 10162','LUIS MATTE LARRAIN 10162',2,0,0],
[-33.40251,-70.52914,'LMM-05 - LML 10135','LUIS MATTE LARRAIN 10135',2,0,0],
[-33.40264,-70.5297,'LMM-06-PTZ - LML 10091','LUIS MATTE LARRAIN 10091',2,1,0],
[-33.40276,-70.53016,'LMM-07 - LML 10066','LUIS MATTE LARRAIN 10066',2,0,0],
[-33.40283,-70.53052,'LMM-08 - LML 10011','LUIS MATTE LARRAIN 10011',2,0,0],
[-33.40276,-70.53084,'LMM-09 - LML 9972','LUIS MATTE LARRAIN 9972',2,0,0],
[-33.40278,-70.53093,'LMM-10 - LML 9996','LUIS MATTE LARRAIN 9966',2,0,0],
[-33.40309,-70.53159,'LMM-11 - LML 9924','Luis Matte Larrain 9924',2,0,0],
[-33.40296,-70.5316,'LMM-12 - LML 9924','Luis Matte Larrain 9923',2,0,0],
[-33.40304,-70.53173,'LMM-13 - LML 9923','Luis Matte Larraín 9898',2,0,0],
[-33.3938,-70.51122,'AC-01 - CF 1211 (Norte)','CERRO FRANCISCANO 1211',2,0,0],
[-33.39362,-70.51112,'AC-02 - CF 1171 (Sur)','CERRO FRANCISCANO 1171',2,0,0],
[-33.39386,-70.51069,'AC-03-PTZ - ALC 12098','ANILLO LA CUMBRE 12098',2,1,0],
[-33.39387,-70.51071,'AC-04 - ALC 12098 (Poniente)','ANILLO LA CUMBRE 12098',2,0,0],
[-33.3946,-70.51081,'AC-05 - ALC 1259 (Norte)','ANILLO LA CUMBRE 1259',2,0,0],
[-33.3947,-70.51017,'AC-06 - ALC 1241 (Norte)','ANILLO LA CUMBRE 1241',2,0,0],
[-33.3941,-70.50993,'AC-07 - ALC 1211 (Poniente)','ANILLO LA CUMBRE 1211',2,0,0],
[-33.39342,-70.50969,'AC-08 - ALC 1187 (Surponiente)','ANILLO LA CUMBRE 1187',2,0,0],
[-33.39318,-70.5102,'AC-09 - ALC 1153 (Sur)','ANILLO LA CUMBRE 1153',2,0,0],
[-33.38682,-70.50381,'PSC-01 - PSC 741 (Sur Poniente)','PASAJE SANTA CLARA 741',2,0,0],
[-33.38671,-70.50352,'PSC-02 - PSC 711 (Sur Poniente)','PASAJE SANTA CLARA 711',2,0,0],
[-33.38669,-70.50349,'PSC-03 - PSC 667 (Oriente)','PASAJE SANTA CLARA 667',2,0,0],
[-33.38651,-70.5035,'PSC-04 - PSC 686 (Nor Oriente)','PASAJE SANTA CLARA 686',2,0,0],
[-33.38654,-70.50353,'PSC-05 - PSC 711 (Sur Poniente)','PASAJE SANTA CLARA 711',2,0,0],
[-33.41203,-70.51734,'LT2-01-PTZ - LT CPO','LAS TORTOLAS / CARLOS PEÑA OTAEGUI',2,1,0],
[-33.41165,-70.51716,'LT2-02 - LT 2958','LAS TORTOLAS 2958',2,0,0],
[-33.41161,-70.5173,'LT2-03 - LT 2929','LAS TORTOLAS 2929',2,0,0],
[-33.41087,-70.51696,'LT2-04 - LT 2796','LAS TORTOLAS 2796',2,0,0],
[-33.41067,-70.51694,'LT2-05 - LT 2778','LAS TORTOLAS 2778',2,0,0],
[-33.40983,-70.51727,'LT2-06 - LT 2712','LAS TORTOLAS 2692',2,0,0],
[-33.40929,-70.5176,'LT2-07 - LT 2658','LAS TORTOLAS 2658',2,0,0],
[-33.40853,-70.51809,'LT2-08 - LT 2550','LAS TORTOLAS 2550',2,0,0],
[-33.40745,-70.51877,'LT2-09 - LT 2358','LAS TORTOLAS 2358',2,0,0],
[-33.40733,-70.51886,'LT2-10 - LT 2358','LAS TORTOLAS 2358',2,0,0],
[-33.40712,-70.51914,'LT2-11-PTZ - LT QH','LAS TORTOLAS / QUEBRADA HONDA',2,1,0],
[-33.40351,-70.52094,'LT-01 - LT 1807','LAS TORTOLAS 1807',2,0,0],
[-33.40437,-70.52092,'LT-02 - LT 1901','LAS TORTOLAS 1901',2,0,0],
[-33.40437,-70.52092,'LT-03 - LT 1901','LAS TORTOLAS 1901',2,0,0],
[-33.40499,-70.52054,'LT-04 - LT 2008','LAS TORTOLAS 2008',2,0,0],
[-33.40499,-70.52054,'LT-05 - LT 2008','LAS TORTOLAS 2008',2,0,0],
[-33.40573,-70.52003,'LT-06 - LT 2084','LAS TORTOLAS 2084',2,0,0],
[-33.40573,-70.52003,'LT-07 - LT 2084','LAS TORTOLAS 2084',2,0,0],
[-33.40712,-70.51905,'LT-08 - LT 2346','LAS TORTOLAS 2346',2,0,0],
[-33.40335,-70.5242,'LC1-01 - LC 1950','LAS CONDESAS 1950',2,0,0],
[-33.40382,-70.52431,'LC1-02 - LC 2032','LAS CONDESAS 2032',2,0,0],
[-33.40504,-70.52356,'LC1-03 - LC 2248','LAS CONDESAS 2248',2,0,0],
[-33.40504,-70.52356,'LC1-04 - LC 2248','LAS CONDESAS 2248',2,0,0],
[-33.40504,-70.52356,'LC1-05-PTZ - LC 2248','LAS CONDESAS 2248',2,1,0],
[-33.40781,-70.52164,'LC2-01 - LC 2334','LAS CONDESAS 2334',2,0,0],
[-33.40781,-70.52164,'LC2-02 - LC 2422','LAS CONDESAS 2422',2,0,0],
[-33.40601,-70.52288,'LC2-03 - LC 2536','LAS CONDESAS 2536',2,0,0],
[-33.40601,-70.52288,'LC2-04 - LC 2598','LAS CONDESAS 2398',2,0,0],
[-33.38798,-70.50605,'PLM-01 - EC 824','EL CONVENTO 824',2,0,0],
[-33.38841,-70.50658,'PLM-02 - EC 863','EL CONVENTO 863',2,0,0],
[-33.38878,-70.50697,'PLM-03 - EC 955','EL CONVENTO 955',2,0,0],
[-33.38953,-70.50714,'PLM-04 - LM 12124','LOS MONJES 12124',2,0,0],
[-33.38979,-70.50723,'PLM-05 - LM 12144','LOS MONJES 12144',2,0,0],
[-33.39022,-70.50745,'PLM-06 - LM 12124','LOS MONJES 12124',2,0,0],
[-33.39026,-70.50743,'PLM-07 - LM 12171','LOS MONJES 12171',2,0,0],
[-33.39065,-70.50702,'PLM-08 - EM 973','EL MONASTERIO 973',2,0,0],
[-33.39006,-70.50848,'PLM-09 - EC 969','EL CONVENTO 969',2,0,0],
[-33.38997,-70.50824,'PLM-10 - LM 12109','LOS MONJES 12109',2,0,0],
[-33.39041,-70.50689,'PLM-11 - EM 948','EL MONASTERIO 948',2,0,0],
[-33.38916,-70.50782,'PLM-12 - EC 901','EL CONVENTO 901',2,0,0],
[-33.38918,-70.5077,'PLM-13 - LM 12092','LOS MONJES 12092',2,0,0],
[-33.39237,-70.50615,'SV-01 - SV 1018 (Sur)','SANTA VERONICA 1018',2,0,0],
[-33.39236,-70.50631,'SV-02 - SV 1018 (Norte)','SANTA VERONICA 1018',2,0,0],
[-33.39252,-70.50591,'SV-03 - SV 1044 (Poniente)','SANTA VERONICA 1044',2,0,0],
[-33.41372,-70.53071,'VLML-01 - LML 917 (Sur)','LUIS MATTE LARRAIN 917',2,0,0],
[-33.41367,-70.53072,'VLML-02 - LML 917 (Norte)','LUIS MATTE LARRAIN 917',2,0,0],
[-33.41297,-70.53093,'VLML-04 - LML 907 (Sur)','LUIS MATTE LARRAIN 907',2,0,0],
[-33.41291,-70.53094,'VLML-05 - LML 907 (Norte)','LUIS MATTE LARRAIN 907',2,0,0],
[-33.41241,-70.53121,'VLML-06 - LML 899 (Sur)','LUIS MATTE LARRAIN 899',2,0,0],
[-33.41238,-70.53122,'VLML-07 - LML 899 (Norte)','LUIS MATTE LARRAIN 899',2,0,0],
[-33.41183,-70.53167,'VLML-09 - LML 885 (Sur)','LUIS MATTE LARRAIN 885',2,0,0],
[-33.41181,-70.5317,'VLML-10 - LML 885 (Norte)','LUIS MATTE LARRAIN 885',2,0,0],
[-33.41331,-70.53081,'VLML-03-PTZ - LML 913','LUIS MATTE LARRAIN 913',2,1,0],
[-33.41215,-70.53141,'VLML-08-PTZ - LML 893','LUIS MATTE LARRAIN 893',2,1,0],
[-33.39382,-70.50752,'SCLF-01 - CCS 12317 (Sur Poniente)','CERRO CATEDRAL SUR 12317',2,0,0],
[-33.3938,-70.50752,'SCLF-02 - CCS 12317 (Norte)','CERRO CATEDRAL SUR 12317',2,0,0],
[-33.3935,-70.50802,'SCLF-03 - SCDA 1126 (Oriente)','SAN CARLOS DE APOQUINDO 1126',2,0,0],
[-33.39382,-70.50824,'SCLF-04 - SCDA 1128 (Oriente)','SAN CARLOS DE APOQUINDO 1128',2,0,0],
[-33.39422,-70.50849,'SCLF-05 - SCDA 1154 (Oriente)','SAN CARLOS DE APOQUINDO 1154',2,0,0],
[-33.39432,-70.50858,'SCLF-06 - SCDA 1218 (Oriente)','SAN CARLOS DE APOQUINDO 1218',2,0,0],
[-33.39442,-70.50865,'SCLF-07 - SCDA 1218 (Oriente)','SAN CARLOS DE APOQUINDO 1218',2,0,0],
[-33.39477,-70.50887,'SCLF-08 - SCDA 1248 (Oriente)','SAN CARLOS DE APOQUINDO 1248',2,0,0],
[-33.39479,-70.50889,'SCLF-09 - SCDA 1248 (Oriente)','SAN CARLOS DE APOQUINDO 1248',2,0,0],
[-33.3949,-70.50899,'SCLF-10 - SCDA 1290 (Oriente)','SAN CARLSO DE APOQUINDO 1290',2,0,0],
[-33.39551,-70.50914,'SCLF-11 - CLF 12300 (Norte)','CAMINO LAS FLORES 12300',2,0,0],
[-33.39561,-70.50856,'SCLF-12 - CLF 12368 (Norte)','CAMINO LAS FLORES 12368',2,0,0],
[-33.3957,-70.50807,'SCLF-13 - CLF 12414 (Norte)','CAMINO LAS FLORES 12414',2,0,0],
[-33.39582,-70.50742,'SCLF-14 - CLF 12488 (Norte)','CAMINO LAS FLORES 12488',2,0,0],
[-33.39569,-70.50714,'SCLF-15 - STJDI 1094 (Norte)','SANTA TERESA JORNET DE IBARS 1094',2,0,0],
[-33.40357,-70.51224,'AFSR-01 - LO 12179 (Nor Poniente)','LOS OLIVOS 12179',2,0,0],
[-33.40359,-70.51227,'AFSR-02 - LO 12179 (Oriente)','LOS OLIVOS 12179',2,0,0],
[-33.40359,-70.51222,'AFSR-03 - LO 12179 (Sur)','LOS OLIVOS 12179',2,0,0],
[-33.40283,-70.51094,'AFSA-01 - LO 12289 (Oriente)','LOS OLIVOS 12289',2,0,0],
[-33.4028,-70.51088,'AFSA-02 - LO 12289 (Poniente)','LOS OLIVOS 12289',2,0,0],
[-33.40283,-70.51087,'AFSA-03 - LO 12289 (Sur)','LOS OLIVOS 12289',2,0,0],
[-33.4049,-70.52514,'CMGB-01 - CM 2148 (Norte)','CAMINO MIRASOL 2148',2,0,0],
[-33.40464,-70.52533,'CMGB-02 - CM 2099 (Oriente)','CAMINO MIRASOL 2099',2,0,0],
[-33.40413,-70.52568,'CMGB-03 - CM 2080 (Oriente)','CAMINO MIRASOL 2080',2,0,0],
[-33.40359,-70.52612,'CMGB-04 - CM 1982 (Oriente)','CAMINO MIRASOL 1982',2,0,0],
[-33.40343,-70.52615,'CMGB-05 - CM 1943 (Sur Oriente)','CAMINO MIRASOL 1943',2,0,0],
[-33.40336,-70.52619,'CMGB-06 - CM 1943 (Oriente)','CAMINO MIRASOL 1943',2,0,0],
[-33.40304,-70.52659,'CMGB-07 - CM 1888 (Oriente)','CAMINO MIRASOL 1888',2,0,0],
[-33.40289,-70.52593,'CMGB-09 - GB 10364 (Poniente)','GENERAL BLANCHE 10364',2,0,0],
[-33.4029,-70.52579,'CMGB-10 - GB 10364 (Oriente)','GENERAL BLANCHE 10364',2,0,0],
[-33.40296,-70.52586,'CMGB-11 - GB 10364 (Sur)','GENERAL BLANCHE 10364',2,0,0],
[-33.40301,-70.525,'CMGB-12 - GB 10472 (Sur Oriente)','GENERAL BLANCHE 10472',2,0,0],
[-33.40284,-70.52707,'CMGB-08-PTZ - GB 10260','GENERAL BLANCHE 10260',2,1,0],
[-33.40072,-70.5137,'LBEA-01 - CEA 12048 (Oriente)','CAMINO EL ALBA 12048',2,0,0],
[-33.40042,-70.51275,'LBEA-02 - CEA 12061','CAMINO EL ALBA 12061',2,0,0],
[-33.40031,-70.51246,'LBEA-03 - CEA 12069 (Sur)','CAMINO EL ALBA 12069',2,0,0],
[-33.40033,-70.51244,'LBEA-04 - CEA 12069 (Sur)','CAMINO EL ALBA 12069',2,0,0],
[-33.40075,-70.51219,'LBEA-05 - CEA 12079 (Norte)','CAMINO EL ALBA 12079',2,0,0],
[-33.40045,-70.51155,'LBEA-06 - CEA 12141 (Poniente)','CAMINO EL ALBA 12141',2,0,0],
[-33.40065,-70.51154,'LBEA-07 - CEA 12133 (Norte)','CAMINO EL ALBA 12133',2,0,0],
[-33.40011,-70.51159,'LBEA-08 - CEA 12145 (Sur)','CAMINO EL ALBA 12145',2,0,0],
[-33.39994,-70.51101,'LBEA-09 - CEA 12163 (Poniente)','CAMINO EL ALBA 12163',2,0,0],
[-33.40037,-70.51094,'LBEA-10 - CEA 12169 (Sur)','CAMINO EL ALBA 12169',2,0,0],
[-33.3998,-70.51047,'LBEA-11 - CEA 12295 (Poniente)','CAMINO EL ALBA 12295',2,0,0],
[-33.39984,-70.51023,'LBEA-12 - SCDA 1625 (Sur)','SAN CARLOS DE APOQUINDO 1625',2,0,0],
[-33.40038,-70.51022,'LBEA-13 - SCDA 1643 (Sur Poniente)','SAN CARLOS DE APOQUINDO 1643',2,0,0],
[-33.40086,-70.51029,'LBEA-14 - SCDA 1653 (Norte)','SAN CARLOS DE APOQUINDO 1653',2,0,0],
[-33.39702,-70.50978,'LPS-01 - LP 12276 (Oriente)','LOS PUMAS 12276',2,0,0],
[-33.39701,-70.50982,'LPS-02 - LP 12276 (Poniente)','LOS PUMAS 12276',2,0,0],
[-33.39686,-70.51073,'LPS-03 - LP 12194 (Oriente)','LOS PUMAS 12194',2,0,0],
[-33.39685,-70.51078,'LPS-04 - LP 12194 (Poniente)','LOS PUMAS 12194',2,0,0],
[-33.39672,-70.51155,'LPS-05 - LP 12140 (Oriente)','LOS PUMAS 12140',2,0,0],
[-33.39671,-70.51162,'LPS-06 - LP 12140 (Poniente)','LOS PUMAS 12140',2,0,0],
[-33.41166,-70.51492,'LV-01 - CO 2837','CAMINO OTOÑAL 2859',2,0,0],
[-33.41137,-70.51568,'LV-02 - CO 2785','CAMINO OTOÑAL 2785',2,0,0],
[-33.4107,-70.51567,'LV-03 - CO 2708','CAMINO OTOÑAL 2708',2,0,0],
[-33.41021,-70.51576,'LV-04-PTZ - CO 2678','CAMINO OTOÑAL 2678',2,1,0],
[-33.40986,-70.51471,'LV-05 - LV 11717','LA VIGUELA 11717',2,0,0],
[-33.40984,-70.5146,'LV-06 - LV 11717','LA VIGUELA 11717',2,0,0],
[-33.40905,-70.51519,'LV-07 - LR 11771','LA RAMADA 11771',2,0,0],
[-33.40908,-70.51528,'LV-08 - LR 11771','LA RAMADA 11771',2,0,0],
[-33.40917,-70.51628,'LV-09 - CO 2536','CAMINO OTOÑAL 2536',2,0,0],
[-33.40318,-70.53186,'LML2-01 - LML 9880 (Norte)','LUIS MATTE LARRAIN 9880',2,0,0],
[-33.40321,-70.53192,'LML2-02 - LML 9880 (Poniente)','LUIS MATTE LARRAIN 9880',2,0,0],
[-33.40336,-70.53215,'LML2-03 - LML 9862 (Sur)','LUIS MATTE LARRAIN 9862',2,0,0],
[-33.40362,-70.53265,'LML2-04 - LML 9818 (Oriente)','LUIS MATTE LARRAIN 9818',2,0,0],
[-33.40367,-70.53268,'LML2-05 - LML 9818 (Poniente)','LUIS MATTE LARRAIN 9818',2,0,0],
[-33.40395,-70.53322,'LML2-06 - LML 9744 (Nor oriente)','LUIS MATTE LARRAIN 9774',2,0,0],
[-33.40406,-70.53334,'LML2-08 - LML 9744 (Sur)','LUIS MATTE LARRAIN 9744',2,0,0],
[-33.40424,-70.533,'LML2-09 - LML 9743 (Oriente)','LUIS MATTE LARRAIN 9743',2,0,0],
[-33.40444,-70.53368,'LML2-10 - LML 9705 (Oriente)','LUIS MATTE LARRAIN 9705',2,0,0],
[-33.40448,-70.53372,'LML2-11 - LML 9705 (Poniente)','LUIS MATTE LARRAIN 9705',2,0,0],
[-33.4045,-70.53368,'LML2-12 - LML 9699 (Norte)','LUIS MATTE LARRAIN 9699',2,0,0],
[-33.40475,-70.53396,'LML2-13 - LML 9647 (Norte)','LUIS MATTE LARRAIN 9647',2,0,0],
[-33.40505,-70.53438,'LML2-14 - LML 9600 (Oriente)','LUIS MATTE LARRAIN 9600',2,0,0],
[-33.40401,-70.53328,'LML2-07-PTZ - LML 9744','LUIS MATTE LARRAIN 9744',2,1,0],
[-33.41557,-70.53046,'LML5-01 - LML 940 (Norte)','Luis Matte Larraín 940',2,0,0],
[-33.41525,-70.53042,'LML5-02 - LML 936 (Sur)','Luis Matte Larraín 936',2,0,0],
[-33.4152,-70.53042,'LML5-03 - LML 936 (Norte)','Luis Matte Larraín 936',2,0,0],
[-33.41471,-70.53038,'LML5-04 - LML 930 (Poniente)','Luis Matte Larraín 930',2,0,0],
[-33.41452,-70.53046,'LML5-05 - LML 927 (Sur)','Luis Matte Larraín 927',2,0,0],
[-33.4145,-70.53047,'LML5-06 - LML 927 (Norte)','Luis Matte Larraín 927',2,0,0],
[-33.4142,-70.53057,'LML5-07 - LML 924 (Sur)','Luis Matte Larraín 924',2,0,0],
[-33.41416,-70.53058,'LML5-08 - LML 924 (Norte)','Luis Matte Larraín 924',2,0,0],
[-33.41373,-70.53058,'LML5-09 - CPO 9574 (Sur)','Carlos Peña Otaegui 9574',2,0,0],
[-33.39239,-70.51812,'CO-01 - CO 1189 (Oriente)','Camino Otoñal 1189',2,0,0],
[-33.39237,-70.51817,'CO-02 - CO 1189 (Oriente)','Camino Otoñal 1189',2,0,0],
[-33.39293,-70.51613,'CO-03 - CO 1189','Camino Otoñal 1189',2,0,0],
[-33.393,-70.51599,'CO-04 - CO 1189','Camino Otoñal 1189',2,0,0],
[-33.41883,-70.52014,'AER-01 - ER 9417 (Norte)','El Remanso 9417',2,0,0],
[-33.41938,-70.52028,'AER-02 - ER 11828 (Norte)','El Remanso 11828',2,0,0],
[-33.41942,-70.5203,'AER-03 - ER 11828 (Sur)','El Remanso 11828',2,0,0],
[-33.41972,-70.52052,'AER-04 - ER 11832 (Norte)','Caseta Norte',2,0,0],
[-33.41979,-70.52056,'AER-05 - ER 11832 (Sur)','Caseta Sur',2,0,0],
[-33.42012,-70.52071,'AER-06 - ER 11842 (Nor Poniente)','El Remanso 11842',2,0,0],
[-33.42019,-70.52072,'AER-07 - ER 11842 (Sur)','El Remanso 11842',2,0,0],
[-33.42075,-70.52064,'AER-08 - ER 11851 (Nor Poniente)','El Remanso 11851',2,0,0],
[-33.42082,-70.52066,'AER-09 - ER 11851 (Sur)','El Remanso 11851',2,0,0],
[-33.38849,-70.50321,'SC2-01 - SC 12276 (Sur)','Sta Clara 12276',2,0,0],
[-33.38844,-70.50323,'SC2-02 - SC 12276 (Nor Poniente)','Sta Clara 12276',2,0,0],
[-33.388,-70.50357,'SC2-03 - SC 12238 (Sur Oriente)','Sta Clara 12238',2,0,0],
[-33.38796,-70.50359,'SC2-04 - SC 12238 (Nor Poniente)','Sta Clara 12238',2,0,0],
[-33.38756,-70.50382,'SC2-05 - SC 12161 (Sur Oriente)','Sta Clara 12161',2,0,0],
[-33.38754,-70.50383,'SC2-06 - SC 12161 (Nor Poniente)','Sta Clara 12161',2,0,0],
[-33.38724,-70.50418,'SC2-07 - SC 12161 (Nor Poniente)','Sta Clara 12161',2,0,0],
[-33.38713,-70.50431,'SC2-08 - SC 12135 (Sur Oriente)','Sta Clara 12135',2,0,0],
[-33.38705,-70.50441,'SC2-09 - SC 12135 (Nor Poniente)','Sta Clara 12135',2,0,0],
[-33.38683,-70.50469,'SC2-10 - SC 12150 (Sur Oriente)','Sta Clara 12150',2,0,0],
[-33.4119,-70.53548,'RG-01 - RG PH (Oriente)','RIO GUADIANA & PAUL HARRIS',2,0,0],
[-33.41214,-70.53476,'RG-02 - RG 9242 (Norte)','RIO GUADIANA 9242',2,0,0],
[-33.41223,-70.53458,'RG-03 - RG 9260 (Oriente)','RIO GUADIANA 9260',2,0,0],
[-33.41208,-70.53366,'RG-04 - LL 878 (Sur)','LAS LOMAS 878',2,0,0],
[-33.4122,-70.53402,'RG-05-PTZ - RG 9284','RIO GUADIANA 9284',2,1,0],
[-33.41249,-70.53402,'RG-06 - RG 9309 (Poniente)','RIO GUADIANA 9309',2,0,0],
[-33.41254,-70.53393,'RG-07 - RG 9309 (Oriente)','RIO GUADIANA 9309',2,0,0],
[-33.4128,-70.53366,'RG-08 - RG 9326 (Poniente)','RIO GUADIANA 9326',2,0,0],
[-33.41306,-70.53345,'RG-09 - RG 9387 (Nor Poniente)','RIO GUADIANA 9387',2,0,0],
[-33.41344,-70.53308,'RG-10 - RG 9433 (Oriente)','RIO GUADIANA 9433',2,0,0],
[-33.4134,-70.53301,'RG-11-PTZ - RG 9434','RIO GUADIANA 9434',2,1,0],
[-33.41359,-70.53276,'RG-12 - RG 9461 (Sur Poniente)','RIO GUADIANA 9461',2,0,0],
[-33.41257,-70.51857,'A1-01 - A 11217 (Norponiente)','ATALAYA 11217',2,0,0],
[-33.41256,-70.51872,'A1-02 - A 11217 (Oriente)','ATALAYA 11217',2,0,0],
[-33.41236,-70.52002,'A1-03 - A 11136 (Poniente)','ATALAYA 11136',2,0,0],
[-33.41233,-70.52017,'A1-04 - A 11136 (Oriente)','ATALAYA 11136',2,0,0],
[-33.41215,-70.52123,'A1-05 - A 10948 (Poniente)','Frente a Atalaya 10948',2,0,0],
[-33.41214,-70.52142,'A1-06 - A 10948 (Oriente)','Frente a Atalaya 10948',2,0,0],
[-33.41224,-70.52224,'A2-01 - A 10866 (Oriente)','ATALAYA 10866',2,0,0],
[-33.41227,-70.52231,'A2-02 - A 10866 (Poniente)','ATALAYA 10866',2,0,0],
[-33.41264,-70.52299,'A2-03 - A 10766 (Oriente)','ATALAYA 10911',2,0,0],
[-33.41269,-70.52307,'A2-04 - A 10766 (Poniente)','ATALAYA 10911',2,0,0],
[-33.41284,-70.52391,'A2-05 - A 10893 (Sur)','ATALAYA 10893',2,0,0],
[-33.41263,-70.52394,'A2-06 - A 10847 (Sur)','ATALAYA 10847',2,0,0],
[-33.41256,-70.52393,'A2-07 - A 10847 (Nororiente)','ATALAYA 10847',2,0,0],
[-33.41177,-70.52291,'A3-01 - A 10731 (Norte)','ATALAYA 10731',2,0,0],
[-33.41183,-70.52299,'A3-02 - A 10731 (Surponiente)','ATALAYA 10731',2,0,0],
[-33.41151,-70.52295,'A3-03 - A 10731 (Oriente)','CARLOS PEÑA OTAEGUI 10880',2,0,0],
[-33.41145,-70.52197,'A3-04 - CP WS (Oriente)','CARLOS PEÑA WENLOCK SCHOOL',2,0,0],
[-33.41148,-70.52168,'A3-05 - CP WS (Poniente)','CARLOS PEÑA WENLOCK SCHOOL',2,0,0],
[-33.41149,-70.52158,'A3-06 - CP WS (Oriente)','CARLOS PEÑA EXTERIOR WENLOCK SCHOOL',2,0,0],
[-33.41173,-70.52031,'A3-07 - CPO 11052 (Poniente)','CARLOS PEÑA OTAEGUI 11052',2,0,0],
[-33.41175,-70.52021,'A3-08 - CPO 11052 (Oriente)','CARLOS PEÑA OTAEGUI 11052',2,0,0],
[-33.4118,-70.51902,'A3-09 - CPO 11264 (Poniente)','CARLOS PEÑA OTAEGUI 11170',2,0,0],
[-33.41181,-70.5189,'A3-10 - CPO 11170 (Oriente)','CARLOS PEÑA OTAEGUI 11170',2,0,0],
[-33.41186,-70.51849,'A3-11 - CPO 11052 (Poniente)','CARLOS PEÑA OTAEGUI 11266',2,0,0],
[-33.41187,-70.5184,'A3-12 - CPO 11052 (Oriente)','CARLOS PEÑA OTAEGUI 11266',2,0,0],
[-33.40349,-70.52964,'CMR1-01 - CVH 1874 (Poniente)','COLINA VISTA HERMOSA 1874',2,0,0],
[-33.40347,-70.52954,'CMR1-02 - CVH 1874 (Oriente)','COLINA VISTA HERMOSA 1874',2,0,0],
[-33.40345,-70.52906,'CMR1-03 - CVH 1874 (Sur)','COLINA VISTA HERMOSA 1874',2,0,0],
[-33.40349,-70.52849,'CMR1-04 - CVH 1897 (Poniente)','COLINA VISTA HERMOSA 1897',2,0,0],
[-33.40353,-70.52826,'CMR1-05 - CVH 1897 (Oriente)','COLINA VISTA HERMOSA 1897',2,0,0],
[-33.40371,-70.52767,'CMR1-06 - CVH 1920 (Oriente)','COLINA VISTA HERMOSA 1920',2,0,0],
[-33.40426,-70.52675,'CMR1-07 - CVH 2008 (Nor Poniente)','COLINA VISTA HERMOSA 2008',2,0,0],
[-33.40433,-70.52667,'CMR1-08 - CVH 2008 (Sur Oriente)','COLINA VISTA HERMOSA 2008',2,0,0],
[-33.40515,-70.52604,'CMR1-09 - CVH 2156 (Norte)','COLINA VISTA HERMOSA 2156',2,0,0],
[-33.40522,-70.52599,'CMR1-10 - CVH 2156 (Sur)','COLINA VISTA HERMOSA 2156',2,0,0],
[-33.40566,-70.526,'CMR1-11 - AML 10188 (Poniente)','ARTURO MATTE LARRAIN 10188',2,0,0],
[-33.40561,-70.52593,'CMR1-12 - AML 10188 (Oriente)','ARTURO MATTE LARRAIN 10188',2,0,0],
[-33.40575,-70.52562,'CMR1-13 - CVH 2244 (Norte)','COLINA VISTA HERMOSA 2244',2,0,0],
[-33.40582,-70.52557,'CMR1-14 - CVH 2244 (Sur)','COLINA VISTA HERMOSA 2244',2,0,0],
[-33.40639,-70.52517,'CMR1-15 - CVH 2356 (Norte)','COLINA VISTA HERMOSA 2356',2,0,0],
[-33.40645,-70.52513,'CMR1-16 - CVH 2356 (Sur)','COLINA VISTA HERMOSA 2356',2,0,0],
[-33.40608,-70.52658,'CMR2-01 - AML 10101 (Oriente)','ARTURO MATTE LARRAIN 10101',2,0,0],
[-33.4061,-70.52664,'CMR2-02 - AML 10101 (Poniente)','ARTURO MATTE LARRAIN 10101',2,0,0],
[-33.40628,-70.52652,'CMR2-03 - CG 2257 (Norte)','COLINA LA GLORIA 2257',2,0,0],
[-33.40633,-70.52647,'CMR2-04 - CG 2257 (Sur)','COLINA LA GLORIA 2257',2,0,0],
[-33.40691,-70.52604,'CMR2-05 - CG 2296 (Norte)','COLINA LA GLORIA 2296',2,0,0],
[-33.40699,-70.52599,'CMR2-06 - CG 2296 (Sur)','COLINA LA GLORIA 2296',2,0,0],
[-33.40773,-70.52574,'CMR2-07 - CG 2386 (Norte)','COLINA LA GLORIA 2386',2,0,0],
[-33.40781,-70.52575,'CMR2-08 - CG 2386 (Sur)','COLINA LA GLORIA 2386',2,0,0],
[-33.40864,-70.52614,'CMR2-09 - CG 2460 (Norte)','COLINA LA GLORIA 2460',2,0,0],
[-33.40872,-70.52617,'CMR2-10 - CG 2460 (Sur)','COLINA LA GLORIA 2460',2,0,0],
[-33.40942,-70.52663,'CMR2-11 - CG 2573 (Nor Oriente)','COLINA LA GLORIA 2573',2,0,0],
[-33.40946,-70.5267,'CMR2-12 - CG 2573 (Poniente)','COLINA LA GLORIA 2573',2,0,0],
[-33.40815,-70.52699,'CMR2-13 - CM 2426 (Sur)','COLINA DEL MIRADOR 2426',2,0,0],
[-33.40803,-70.52695,'CMR2-14 - CM 2426 (Norte)','COLINA DEL MIRADOR 2426',2,0,0],
[-33.40673,-70.52741,'CMR2-15 - CM 2242 (Sur)','COLINA DEL MIRADOR 2242',2,0,0],
[-33.40663,-70.52748,'CMR2-16 - CM 2242 (Norte)','COLINA DEL MIRADOR 2242',2,0,0],
[-33.40507,-70.52907,'CMR3-01 - CM 1854 (Sur)','COLINA DEL MIRADOR 1854',2,0,0],
[-33.40496,-70.52911,'CMR3-02 - CM 1854 (Norte)','COLINA EL MIRADOR 1854',2,0,0],
[-33.40444,-70.52894,'CMR3-03 - CG 1860 (Norte)','COLINA LA GLORIA 1860',2,0,0],
[-33.40472,-70.52771,'CMR3-04 - CG 1990 (Poniente)','COLINA LA GLORIA 1990',2,0,0],
[-33.4048,-70.5276,'CMR3-05 - CG 1990 (Sur Oriente)','COLINA LA GLORIA 1990',2,0,0],
[-33.40525,-70.52719,'CMR3-06 - CG 2098 (Nor Poniente)','COLINA LA GLORIA 2098',2,0,0],
[-33.40536,-70.52712,'CMR3-07 - CG 2098 (Sur)','COLINA LA GLORIA 2098',2,0,0],
[-33.4063,-70.52771,'CMR3-08 - AML 10020 (Poniente)','ARTURO MATTE LARRAIN 10020',2,0,0],
[-33.40708,-70.5282,'CMR3-09 - AML 2246 (Norte)','ARTURO MATTE LARRAIN 2246',2,0,0],
[-33.40724,-70.52821,'CMR3-10 - AML 2246 (Sur)','ARTURO MATTE LARRAIN 2246',2,0,0],
[-33.40774,-70.52832,'CMR3-11 - LC 1888 (Poniente)','LA CUMBRE 1888',2,0,0],
[-33.40841,-70.52842,'CMR3-12 - AML 2468 (Norte)','ARTURO MATTE LARRAIN 2468',2,0,0],
[-33.40857,-70.52843,'CMR3-13 - AML 2468 (Sur)','ARTURO MATTE LARRAIN 2468',2,0,0],
[-33.40916,-70.52748,'CMR3-14 - CM 2580 (Sur)','COLINA DEL MIRADOR 2580',2,0,0],
[-33.40905,-70.52743,'CMR3-15 - CM 2580 (Norte)','COLINA EL MIRADOR 2580',2,0,0],
[-33.40789,-70.52595,'CMR3-16 - CG 2393 (Poniente)','COLINA LA GLORIA 2393',2,0,0],
[-33.4083,-70.52383,'CMR4-01 - CVH 2552 (Sur)','COLINA VISTA HERMOSA 2552',2,0,0],
[-33.40823,-70.52389,'CMR4-02 - CVH 2552 (Norte)','COLINA VISTA HERMOSA 2552',2,0,0],
[-33.40729,-70.52452,'CMR4-03 - CVH 2450 (Sur)','COLINA VISTA HERMOSA 2450',2,0,0],
[-33.40723,-70.52458,'CMR4-04 - CVH 2450 (Poniente)','COLINA VISTA HERMOSA 2450',2,0,0],
[-33.40715,-70.52463,'CMR4-05 - CVH 2450 (Norte)','COLINA VISTA HERMOSA 2450',2,0,0],
[-33.40799,-70.52485,'CMR4-06 - SVF 2465 (Norte)','SAN VICENTE FERRER 2465',2,0,0],
[-33.40808,-70.52487,'CMR4-07 - SVF 2465 (Sur)','SAN VICENTE FERRER 2465',2,0,0],
[-33.40938,-70.5252,'CMR4-08 - SVF 2520 (Norte)','SAN VICENTE FERRER 2520',2,0,0],
[-33.40952,-70.52527,'CMR4-09 - SVF 2520 (Sur)','SAN VICENTE FERRER 2520',2,0,0],
[-33.41022,-70.526,'CMR4-10 - SVF 2580 (Norte)','SAN VICENTE FERRER 2580',2,0,0],
[-33.4103,-70.52613,'CMR4-11 - SVF 2580 (Sur)','SAN VICENTE FERRER 2580',2,0,0],
[-33.41041,-70.52644,'CMR4-12 - SVF 2599 (Norte)','SAN VICENTE FERRER 2599',2,0,0],
[-33.41044,-70.5264,'CMR4-13 - SVF 2599 (Sur)','SAN VICENTE FERRER 2599',2,0,0],
[-33.41061,-70.52711,'CMR4-14 - SVF 2569 (Oriente)','SAN VICENTE FERRER 2569',2,0,0],
[-33.40964,-70.52783,'CMR4-15 - AML 2559 (Oriente)','ARTURO MATTE LARRAIN 2559',2,0,0],
[-33.40954,-70.52803,'CMR4-16 - AML 2559 (Nor Poniente)','ARTURO MATTE LARRAIN 2559',2,0,0],
[-33.41064,-70.52724,'CMR5-01 - SVF 2569 (Poniente)','SAN VICENTE FERRER 2569',2,0,0],
[-33.41061,-70.528,'CMR5-02 - SVF 2537 (Oriente)','SAN VICENTE FERRER 2537',2,0,0],
[-33.4106,-70.5281,'CMR5-03 - SVF 2537 (Poniente)','SAN VICENTE FERRER 2537',2,0,0],
[-33.41015,-70.5289,'CMR5-04 - SVF 2494 (Oriente)','SAN VICENTE FERRER 2494',2,0,0],
[-33.4101,-70.52895,'CMR5-05 - SVF 2494 (Norte)','SAN VICENTE FERRER 2494',2,0,0],
[-33.40924,-70.52953,'CMR5-06 - SVF 2408 (Sur)','SAN VICENTE FERRER 2408',2,0,0],
[-33.4091,-70.52959,'CMR5-07 - SVF 2408 (Norte)','SAN VICENTE FERRER 2408',2,0,0],
[-33.40812,-70.52977,'CMR5-08 - SVF 2338 (Sur)','SAN VICENTE FERRER 2338',2,0,0],
[-33.40797,-70.52977,'CMR5-09 - SVF 2338 (Norte)','SAN VICENTE FERRER 2338',2,0,0],
[-33.40723,-70.52959,'CMR5-10 - SVF 2326 (Sur)','SAN VICENTE FERRER 2350',2,0,0],
[-33.4072,-70.52957,'CMR5-11 - SVF 2326 (Oriente)','SAN VICENTE FERRER 2350',2,0,0],
[-33.40716,-70.52955,'CMR5-12 - SVF 2326 (Norte)','SAN VICENTE FERRER 2350',2,0,0],
[-33.40664,-70.52936,'CMR5-13 - SVF 2270 (Norte)','SAN VICENTE FERRER 2270',2,0,0],
[-33.40547,-70.52886,'CMR5-14 - CM 1891 (Oriente)','COLINA DEL MIRADOR 1891',2,0,0],
[-33.40547,-70.52891,'CMR5-15 - CM 1891 (Surponiente)','COLINA DEL MIRADOR 1891',2,0,0],
[-33.40578,-70.5281,'CMR5-16 - CM 2080 (Sur)','COLINA DEL MIRADOR 2080',2,0,0],
[-33.40322,-70.51849,'LH-01 - GB 11724 (Sur)','GENERAL BLANCHE 11724',2,0,0],
[-33.40392,-70.5182,'LH-02 - LH 1850 (Norte)','LOS HUASOS 1850',2,0,0],
[-33.4041,-70.51814,'LH-03 - LH 1850 (Sur)','LOS HUASOS 1850',2,0,0],
[-33.4048,-70.51796,'LH-04 - LH 1948 (Norte)','LOS HUASOS 1948',2,0,0],
[-33.40494,-70.51791,'LH-05 - LH 1948 (Sur)','LOS HUASOS 1948',2,0,0],
[-33.40535,-70.51773,'LH-06 - LH 2044 (Norte)','LOS HUASOS 2044',2,0,0],
[-33.40541,-70.51771,'LH-07 - LH 2044 (Sur)','LOS HUASOS 2044',2,0,0],
[-33.4058,-70.51751,'LH-08 - LH 2090 (Norte)','LOS HUASOS 2090',2,0,0],
[-33.40589,-70.51746,'LH-09 - LH 2090 (Sur)','LOS HUASOS 2090',2,0,0],
[-33.4062,-70.51725,'LH-10 - QH 11725 (Norte)','QUEBRADA HONDA 11725',2,0,0],
[-33.39473,-70.52528,'PR1-01 - CPR 1322 (Poniente)','CAMINO PIEDRA ROJA 1322',2,0,0],
[-33.39485,-70.52539,'PR1-02 - CPR 1320 (Sur)','CAMINO PIEDRA ROJA 1320',2,0,0],
[-33.3953,-70.52534,'PR1-03 - CPR 1323 (Norte)','CAMINO PIEDRA ROJA 1323',2,0,0],
[-33.39536,-70.52535,'PR1-04 - CPR 1323 (Sur)','CAMINO PIEDRA ROJA 1323',2,0,0],
[-33.39565,-70.52538,'PR1-05 - CPR 1335 (Norte)','CAMINO PIEDRA ROJA 1335',2,0,0],
[-33.39571,-70.52538,'PR1-06 - CPR 1335 (Sur)','CAMINO PIEDRA ROJA 1335',2,0,0],
[-33.39614,-70.52543,'PR1-07 - CPR 1357 (Norte)','CAMINO PIEDRA ROJA 1351',2,0,0],
[-33.39622,-70.52543,'PR1-08 - CPR 1357 (Sur)','CAMINO PIEDRA ROJA 1351',2,0,0],
[-33.39627,-70.52557,'PR1-09 - CPR 1357 (Oriente)','CAMINO PIEDRA ROJA 1357',2,0,0],
[-33.39659,-70.52547,'PR1-10 - CPR 1391 (Norte)','CAMINO PIEDRA ROJA 1391',2,0,0],
[-33.39668,-70.52549,'PR1-11 - CPR 1391 (Sur)','CAMINO PIEDRA ROJA 1391',2,0,0],
[-33.39721,-70.52553,'PR1-12 - CPR 1411 (Norte)','CAMINO PIEDRA ROJA 1411',2,0,0],
[-33.39731,-70.52554,'PR1-13 - CPR 1411 (Sur)','CAMINO PIEDRA ROJA 1411',2,0,0],
[-33.39752,-70.52557,'PR1-14 - CPR 1426 (Norte)','CAMINO PIEDRA ROJA 1426',2,0,0],
[-33.39761,-70.52558,'PR1-15 - CPR 1426 (Sur)','CAMINO PIEDRA ROJA 1426',2,0,0],
[-33.3976,-70.52612,'PR1-16 - CPR 1429 (Poniente)','CAMINO PIEDRA ROJA 1429',2,0,0],
[-33.39796,-70.52576,'PR2-01 - CPR 1434 (Oriente)','CAMINO PIEDRA ROJA 1434',2,0,0],
[-33.39803,-70.52535,'PR2-02 - CPR 1439 (Oriente)','CAMINO PIEDRA ROJA 1439',2,0,0],
[-33.39804,-70.52565,'PR2-03 - CPR 1439 (Poniente)','CAMINO PIEDRA ROJA 1439',2,0,0],
[-33.39814,-70.52565,'PR2-04 - CPR 1442','CAMINO PIEDRA ROJA 1442',2,0,0],
[-33.39906,-70.52577,'PR2-05 - CPR 1452','CAMINO PIEDRA ROJA 1452',2,0,0],
[-33.39837,-70.5257,'PR2-06 - CPR 1442','CAMINO PIEDRA ROJA 1442',2,0,0],
[-33.39869,-70.52572,'PR2-07 - CPR 1464','CAMINO PIEDRA ROJA 1464',2,0,0],
[-33.39868,-70.52582,'PR2-08 - CPR 1464','CAMINO PIEDRA ROJA 1464',2,0,0],
[-33.39935,-70.52579,'PR2-09 - CPR 1468','CAMINO PIEDRA ROJA 1468',2,0,0],
[-33.39939,-70.52591,'PR2-10 - CPR 1468','CAMINO PIEDRA ROJA 1468',2,0,0],
[-33.39975,-70.52583,'PR2-11 - CPR 1534','CAMINO PIEDRA ROJA 1515',2,0,0],
[-33.39983,-70.52584,'PR2-12 - CPR 1534','CAMINO PIEDRA ROJA 1534',2,0,0],
[-33.40029,-70.52587,'PR2-13 - CPR 1561','CAMINO PIEDRA ROJA 1561',2,0,0],
[-33.40062,-70.52587,'PR2-14 - CPR 1569','CAMINO PIEDRA ROJA 1569',2,0,0],
[-33.40071,-70.52589,'PR2-15 - CPR 1569','CAMINO PIEDRA ROJA 1569',2,0,0],
[-33.40121,-70.52604,'PR2-16 - CEA 10439','CAMINO EL ALBA 10439',2,0,0],
[-33.41875,-70.52011,'GV-01 - ER 11111','EL REMANSO 11111',2,0,0],
[-33.41873,-70.5201,'GV-02 - ER 11111','EL REMANSO 11111',2,0,0],
[-33.41838,-70.5197,'GV-03 - ER N 77','EL REMANSO NORTE 77',2,0,0],
[-33.4181,-70.51934,'GV-04 - ER N 73','EL REMANSO NORTE 73',2,0,0],
[-33.41763,-70.51891,'GV-05 - ER N 65','EL REMANSO NORTE 65',2,0,0],
[-33.41738,-70.51859,'GV-06 - ER N 61','EL REMANSO NORTE 61',2,0,0],
[-33.41731,-70.5185,'GV-07 - ER N 57','EL REMANSO NORTE 57',2,0,0],
[-33.41723,-70.5184,'GV-08 - ER N 57','EL REMANSO NORTE 57',2,0,0],
[-33.41715,-70.51802,'GV-09 - ER N 53','EL REMANSO NORTE 53',2,0,0],
[-33.41715,-70.51795,'GV-10 - ER N 53','EL REMANSO NORTE 53',2,0,0],
[-33.41718,-70.51768,'GV-11 - ER N 49','EL REMANSO NORTE 49',2,0,0],
[-33.41718,-70.51762,'GV-12 - ER N 49','EL REMANSO NORTE 49',2,0,0],
[-33.417,-70.51715,'GV-13 - ER GV','EL REMANSO GRAN VISTA',2,0,0],
[-33.41703,-70.51711,'GV-14-PTZ - ER GV','EL REMANSO GRAN VISTA',2,1,0],
[-33.41559,-70.51766,'GV-15-PTZ - CGV1','CAMINO GRAN VISTA 1',2,1,0],
[-33.41555,-70.51864,'GV-16-PTZ - CGV2','CAMINO GRAN VISTA 2',2,1,0],
[-33.41644,-70.51993,'GV-17-PTZ - CGV3','CAMINO GRAN VISTA 3',2,1,0],
[-33.4161,-70.52123,'GV-18-PTZ - CGV4','CAMINO GRAN VISTA 4',2,1,0],
[-33.40684,-70.51101,'LB-01 - LB 2440','LOS BELLOTOS 2440',2,0,0],
[-33.40684,-70.51101,'LB-02-PTZ - LB 2440','LOS BELLOTOS 2440',2,1,0],
[-33.40586,-70.50898,'LB-03 - SA 2470','SANTOS APOSTOLES 2470',2,0,0],
[-33.38735,-70.51287,'LHS-01 - LH FBC','F. Bulnes Correa Esquina Los Hermanos',2,0,0],
[-33.38731,-70.51285,'LHS-02 - LH FBC','F. Bulnes Correa Esquina Los Hermanos',2,0,0],
[-33.38731,-70.51291,'LHS-03-PTZ - LH FBC','F. Bulnes Correa Esquina Los Hermanos',2,1,0],
[-33.38758,-70.51234,'LHS-04 - LH 11844','Los Hermanos 11844',2,0,0],
[-33.3876,-70.51229,'LHS-05 - LH 11844','Los Hermanos 11844',2,0,0],
[-33.38779,-70.51202,'LHS-06 - LH SIS','Sta. Inez Sur Esquina Los Hermanos',2,0,0],
[-33.38775,-70.51197,'LHS-07 - LH 11868','Los Hermanos 11868',2,0,0],
[-33.38793,-70.51156,'LHS-08 - LH 11880','Los Hermanos 11880',2,0,0],
[-33.38795,-70.51151,'LHS-09 - LH 11880','Los Hermanos 11880',2,0,0],
[-33.38775,-70.51138,'LHS-10 - SIN 903','Sta. Inez Norte 903',2,0,0],
[-33.38826,-70.51079,'LHS-11 - LH 11946','Los Hermanos Esquina Los Maitenes',2,0,0],
[-33.38825,-70.51065,'LHS-12 - LM 942','Los Maitenes 938',2,0,0],
[-33.38838,-70.51064,'LHS-13 - LM 938','Los Maitenes 938',2,0,0],
[-33.38838,-70.51075,'LHS-14 - LM 938','Los Maitenes 942',2,0,0],
[-33.41378,-70.5297,'VACP-01 - VA CP','Vital Apoquindo esquina Carlos Peña Otaegui',2,0,0],
[-33.4138,-70.52966,'VACP-02-PTZ - VA CP','Vital Apoquindo esquina Carlos Peña Otaegui',2,1,0],
[-33.41405,-70.52962,'VACP-03 - VA 926','Vital Apoquindo 926',2,0,0],
[-33.4145,-70.5297,'VACP-04 - VA 929','Vital Apoquindo 929',2,0,0],
[-33.41463,-70.52951,'VACP-05 - VA 938','Vital Apoquindo 938',2,0,0],
[-33.41486,-70.52967,'VACP-06 - VA 933','Vital Apoquindo 933',2,0,0],
[-33.41517,-70.52951,'VACP-07 - VA 946','Vital Apoquindo 946',2,0,0],
[-33.41529,-70.52968,'VACP-08 - VA 937','Vital Apoquindo 937',2,0,0],
[-33.41539,-70.52968,'VACP-09 - VA 937','Vital Apoquindo 937',2,0,0],
[-33.39759,-70.52263,'LFM-02-PTZ - CLF 1406','Camino La Fuente 1406',2,1,0],
[-33.39749,-70.52255,'LFM-01 - CLF 1406','Camino La Fuente 1406',2,0,0],
[-33.39715,-70.52249,'LFM-03 - CLF 1398','Camino La Fuente 1392',2,0,0],
[-33.41449,-70.53249,'ME-01-PTZ - PLA LDC','Loma del Canelo Esquina La Escuela',2,1,0],
[-33.41459,-70.53215,'ME-02 - LDC 9503','Loma del Canelo 9503',2,0,0],
[-33.41454,-70.53207,'ME-03 - LDC 9504','Loma del Canelo 9504',2,0,0],
[-33.41466,-70.53183,'ME-04 - LDC 9510','Loma del Canelo 9510',2,0,0],
[-33.41504,-70.53149,'ME-05 - LDC 9514','Loma del Canelo 9514',2,0,0],
[-33.41509,-70.53144,'ME-06 - LDC 9514','Loma del Canelo 9514',2,0,0],
[-33.41511,-70.53132,'ME-07 - LDC 9517','Loma del Canelo 9517',2,0,0],
[-33.41558,-70.53077,'ME-08 - LDC 9524','Loma del Canelo 9524',2,0,0],
[-33.41487,-70.53122,'ME-09 - LV 952','Loma Verde 952',2,0,0],
[-33.41469,-70.53115,'ME-10 - LV 948','Loma Verde 948',2,0,0],
[-33.41396,-70.5314,'ME-11 - LV 933','Loma Verde 933',2,0,0],
[-33.40915,-70.53556,'LLS-01 - LL AS','Las Lomas & Almirante Soublette',2,0,0],
[-33.40947,-70.53553,'LLS-02 - LL 547','Las Lomas 547',2,0,0],
[-33.40996,-70.53535,'LLS-03 - LL 585','Las Lomas 585',2,0,0],
[-33.41034,-70.53512,'LLS-04 - LL 628','Las Lomas 628',2,0,0],
[-33.41038,-70.5351,'LLS-05 - LL 628','Las Lomas 628',2,0,0],
[-33.4108,-70.53492,'LLS-06 - LL 684','Las Lomas 684',2,0,0],
[-33.41087,-70.53489,'LLS-07 - LL 684','Las Lomas 684',2,0,0],
[-33.41105,-70.5348,'LLS-08-PTZ - LL 701','Las Lomas 701',2,1,0],
[-33.41138,-70.53473,'LLS-09 - LL 739','Las Lomas 739',2,0,0],
[-33.41146,-70.53467,'LLS-10 - LL 739','Las Lomas 739',2,0,0],
[-33.41172,-70.53423,'LLS-11 - LL 824','Las Lomas 824',2,0,0],
[-33.41178,-70.53414,'LLS-12 - LL 824','Las Lomas 824',2,0,0],
[-33.41202,-70.53376,'LLS-13 - LL 892','Las Lomas 892',2,0,0],
[-33.41272,-70.51538,'AT2-01 - A 11431','Atalaya 11531',2,0,0],
[-33.41323,-70.51535,'AT2-02 - A 11521','Atalaya 11521',2,0,0],
[-33.41317,-70.51533,'AT2-03-PTZ - A 11521','Atalaya 11521',2,1,0],
[-33.41332,-70.51545,'AT2-04 - A 11515','Atalaya 11515',2,0,0],
[-33.41303,-70.51632,'AT2-05 - A 11457','Atalaya 11457',2,0,0],
[-33.41298,-70.5163,'AT2-06 - A 11460','Atalaya 11460',2,0,0],
[-33.41301,-70.51636,'AT2-07 - A 11427','Atalaya 11427',2,0,0],
[-33.41291,-70.51686,'AT2-08 - A 11337','Atalaya 11373',2,0,0],
[-33.41254,-70.51744,'AT2-09 - A 11328','Atalaya 11351',2,0,0],
[-33.40059,-70.51354,'SRO1-01-PTZ - SR 1555','Cerro San Ramon 1555',2,1,0],
[-33.40054,-70.51353,'SRO1-02 - SR 1555','Cerro San Ramon 1555',2,0,0],
[-33.40018,-70.5136,'SRO1-03 - CLH 12049','Camino de las hojas 12049',2,0,0],
[-33.40018,-70.51365,'SRO1-04 - CLH 12049','Camino de las hojas 12049',2,0,0],
[-33.40015,-70.51358,'SRO1-05 - SR CLH','Cerro San Ramon & Camino de las hojas',2,0,0],
[-33.39955,-70.51351,'SRO1-07 - SR 1483','Cerro San Ramon 1483',2,0,0],
[-33.39948,-70.5135,'SRO1-06 - SR 1483','Cerro San Ramon 1483',2,0,0],
[-33.39941,-70.51349,'SRO1-08 - SR 1483','Cerro San Ramon 1483',2,0,0],
[-33.399,-70.51345,'SRO1-10 - SR 1475','Cerro San Ramon 1475',2,0,0],
[-33.39901,-70.51336,'SRO1-09 - SR 1476','Cerro San Ramon 1476',2,0,0],
[-33.39871,-70.51341,'SRO1-11 - SR 1469','Cerro San Ramon 1469',2,0,0],
[-33.39867,-70.5134,'SRO1-12 - SR 1469','Cerro San Ramon 1469',2,0,0],
[-33.3982,-70.51333,'SRO1-13 - SR 1465','Cerro San Ramon 1465',2,0,0],
[-33.39816,-70.51332,'SRO1-14 - SR 1465','Cerro San Ramon 1465',2,0,0],
[-33.39809,-70.51333,'SRO1-15 - SR 1461','Cerro San Ramon 1461',2,0,0],
[-33.39809,-70.5131,'SRO1-16 - CA 12052','Camino del alba 12052',2,0,0],
[-33.39763,-70.51329,'SRO2-01 - SR 1457','Cerro San Ramon 1457',2,0,0],
[-33.39758,-70.51328,'SRO2-02 - SR 1457','Cerro San Ramon 1457',2,0,0],
[-33.39812,-70.51279,'SRO2-03 - CA 12074','Cerro Abanico 12074',2,0,0],
[-33.39823,-70.51268,'SRO2-04 - CA 12073','Cerro Abanico 12073',2,0,0],
[-33.39832,-70.51211,'SRO2-05 - CP 1463','Cerro Pintor 1463',2,0,0],
[-33.39827,-70.51192,'SRO2-06 - CA 12121','Cerro Abanico 12121',2,0,0],
[-33.3975,-70.51326,'SRO2-07 - SR 1449','Cerro San Ramon 1449',2,0,0],
[-33.39746,-70.51313,'SRO2-08 - SR 1449','Cerro San Ramon 1449',2,0,0],
[-33.3969,-70.51309,'SRO2-09 - SR 1429','Cerro San Ramon 1429',2,0,0],
[-33.39654,-70.51326,'SRO2-10 - CLP 12018','Cerro los pumas 12018',2,0,0],
[-33.39636,-70.51312,'SRO2-11 - SR 1357','Cerro San Ramon 1357',2,0,0],
[-33.39608,-70.51308,'SRO2-12 - SR 1345','Cerro San Ramon 1345',2,0,0],
[-33.39616,-70.5131,'SRO2-13 - SR 1345','Cerro San Ramon 1345',2,0,0],
[-33.3959,-70.51301,'SRO2-14 - SR 1335','Cerro San Ramon 1335',2,0,0],
[-33.39579,-70.51299,'SRO2-15 - SR 1335','Cerro San Ramon 1335',2,0,0],
[-33.39584,-70.51305,'SRO2-16-PTZ - SR 1335','Cerro San Ramon 1335',2,1,0],
[-33.4088,-70.53339,'VS-01 - AS 9581','Almirante Soublette 9581',2,0,0],
[-33.40901,-70.53301,'VS-02 - VA 579','Vital Apoquindo 579',2,0,0],
[-33.40933,-70.53274,'VS-03 - VA 587','Vital Apoquindo 587',2,0,0],
[-33.40933,-70.53274,'VS-04 - VA 587','Vital Apoquindo 587',2,0,0],
[-33.40953,-70.53265,'VS-05 - VA 613','Vital Apoquindo 613',2,0,0],
[-33.40961,-70.53261,'VS-06 - VA 621','Vital Apoquindo 621',2,0,0],
[-33.4099,-70.53248,'VS-07 - VA 667','Vital Apoquindo 667',2,0,0],
[-33.41009,-70.53238,'VS-08 - VA 695','Vital Apoquindo 695',2,0,0],
[-33.41018,-70.53233,'VS-09-PTZ - VA 749','Vital Apoquindo 749',2,1,0],
[-33.41042,-70.53215,'VS-10 - VA 831','Vital Apoquindo 831',2,0,0],
[-33.41042,-70.53215,'VS-11 - VA 831','Vital Apoquindo 831',2,0,0],
[-33.41049,-70.53208,'VS-12 - VA 855','Vital Apoquindo 855',2,0,0],
[-33.41057,-70.532,'VS-13 - VA 867','Vital Apoquindo 867',2,0,0],
[-33.41064,-70.53192,'VS-14 - VA 881','Vital Apoquindo 881',2,0,0],
[-33.41093,-70.53155,'VS-15 - VA 883','Vital Apoquindo 883',2,0,0],
[-33.41107,-70.53136,'VS-16 - VA 887','Vital Apoquindo 887',2,0,0],
[-33.40776,-70.53737,'VE-01 - GB 9185','GENERAL BLANCHE 9185',2,0,0],
[-33.40785,-70.53773,'VE-02 - GB 9175','GENERAL BLANCHE 9175',2,0,0],
[-33.40807,-70.53778,'VE-03 - VE 344','VIEJOS ESTANDARTES 344',2,0,0],
[-33.40846,-70.53763,'VE-04 - VE 366','VIEJOS ESTANDARTES 366',2,0,0],
[-33.40846,-70.53763,'VE-05 - VE 366','VIEJOS ESTANDARTES 366',2,0,0],
[-33.40874,-70.5375,'VE-06 - VE 394','VIEJOS ESTANDARTES 394',2,0,0],
[-33.40874,-70.5375,'VE-07-PTZ - VE 394','VIEJOS ESTANDARTES 394',2,1,0],
[-33.40874,-70.5375,'VE-08 - VE 394','VIEJOS ESTANDARTES 394',2,0,0],
[-33.40893,-70.53804,'VE-09 - PA 391','PUERTO ARTURO 391',2,0,0],
[-33.4089,-70.53779,'VE-10 - AF PA','PASAJE AGUSTIN FONTAINE & VIEJOS ESTANDARTES',2,0,0],
[-33.40875,-70.53725,'VE-11 - AF PA','PASAJE AGUSTIN FONTAINE & VIEJOS ESTANDARTES',2,0,0],
[-33.40864,-70.53686,'VE-12 - AF PH','AGUSTIN FONTAINE & PAUL HARRIS',2,0,0],
[-33.4079,-70.53714,'VE-13 - PH 343','PAUL HARRIS 343',2,0,0],
[-33.40969,-70.53707,'VE-14 - AS 9153','ALMIRANTE SOUBLETTE 9153',2,0,0],
[-33.4107,-70.51496,'ADR1-01 - LQ 11680','LA QUINCHA 11680',2,0,0],
[-33.41073,-70.51495,'ADR1-02 - LQ 11720','LA QUINCHA 11720',2,0,0],
[-33.41073,-70.51495,'ADR1-03 - LQ 11720','LA QUINCHA 11720',2,0,0],
[-33.41073,-70.51461,'ADR1-04 - LQ 11761','LA QUINCHA 11761',2,0,0],
[-33.41071,-70.51461,'ADR1-05 - LQ 11754','LA QUINCHA 11754',2,0,0],
[-33.40948,-70.51419,'ADR1-06 - FBC 2699','FRANCISCO BULNES CORREA 2699',2,0,0],
[-33.41011,-70.51409,'ADR1-07 - FBC 2739','FRANCISCO BULNES CORREA 2739',2,0,0],
[-33.41081,-70.51403,'ADR1-08 - FBC 2803','FRANCISCO BULNES CORREA 2803',2,0,0],
[-33.41158,-70.51387,'ADR1-09-PTZ - FBC CO','FRANCISCO BULNES CORREA & CAMINO OTOÑAL',2,1,0],
[-33.41158,-70.51387,'ADR1-10 - FBC CO','FRANCISCO BULNES CORREA & CAMINO OTOÑAL',2,0,0],
[-33.41218,-70.51348,'ADR2-01 - FBC 2931','FRANCISCO BULNES CORREA 2931',2,0,0],
[-33.41168,-70.51382,'ADR2-02 - CO FBC','CAMINO OTOÑAL & FRANCISCO BULNES CORREA',2,0,0],
[-33.41169,-70.51402,'ADR2-03 - CO 2897','CAMINO OTOÑAL 2897',2,0,0],
[-33.41167,-70.51457,'ADR2-04 - CO 2878','CAMINO OTOÑAL 2878',2,0,0],
[-33.41169,-70.5151,'ADR2-05 - CO 2837','CAMINO OTOÑAL 2837',2,0,0],
[-33.41164,-70.51536,'ADR2-06 - CO 2812','CAMINO OTOÑAL 2812',2,0,0],
[-33.41164,-70.51536,'ADR2-07 - CO 2812','CAMINO OTOÑAL 2812',2,0,0],
[-33.41148,-70.51568,'ADR2-08 - CO 2793','CAMINO OTOÑAL 2793',2,0,0],
[-33.41132,-70.51572,'ADR2-09 - CO 2785','CAMINO OTOÑAL 2785',2,0,0],
[-33.41167,-70.51503,'ADR2-10 - CO 2799','CAMINO OTOÑAL 2799',2,0,0],
[-33.4109,-70.51567,'ADR2-11-PTZ - CO 2756','CAMINO OTOÑAL 2756',2,1,0],
[-33.41819,-70.52997,'AA1-01 - VA 1285','VITAL APOQUINDO INTERIOR 1285',2,0,0],
[-33.41819,-70.52997,'AA1-02 - VA 1285','VITAL APOQUINDO INTERIOR 1285',2,0,0],
[-33.41754,-70.52984,'AA1-03 - Y VA','YOLANDA & VITAL APOQUINDO INTERIOR',2,0,0],
[-33.41754,-70.52983,'AA1-04-PTZ - Y VA','YOLANDA & VITAL APOQUINDO INTERIOR',2,1,0],
[-33.41757,-70.53015,'AA1-05 - Y 9645','YOLANDA 9645',2,0,0],
[-33.39789,-70.51075,'CECCP-01 - CEP 12221','CERRO EL CEPO 12221',2,0,0],
[-33.39782,-70.51129,'CECCP-02 - CEP 12169','CERRO EL CEPO 12169',2,0,0],
[-33.39772,-70.51172,'CECCP-03 - CEP 12106','CERRO EL CEPO 12106',2,0,0],
[-33.39771,-70.5119,'CECCP-04 - CEP CP','CERRO EL CEPO & CERRO PINTOR',2,0,0],
[-33.39811,-70.51198,'CECCP-05 - CP 1460','CERRO PINTOR 1460',2,0,0],
[-33.39811,-70.51198,'CECCP-06 - CP 1460','CERRO PINTOR 1460',2,0,0],
[-33.39782,-70.51195,'CECCP-07-PTZ - CP 1451','CERRO PINTOR 1451',2,1,0],
[-33.39771,-70.5119,'CECCP-08 - CEC 12082','CERRO PINTOR & CERRO EL CEPO',2,0,0],
[-33.39762,-70.51236,'CECCP-09 - CEC 12076','CERRO EL CEPO 12076',2,0,0],
[-33.39734,-70.51185,'CECCP-10 - CP 1441','CERRO PINTOR 1441',2,0,0],
[-33.39734,-70.51185,'CECCP-11 - CP 1441','CERRO PINTOR 1441',2,0,0],
[-33.39704,-70.51177,'CECCP-12 - CP 1419','CERRO PINTOR 1419',2,0,0],
[-33.39704,-70.51177,'CECCP-13 - CP 1419','CERRO PINTOR 1419',2,0,0],
[-33.39655,-70.51162,'CECCP-14 - CP 1370','CERRO PINTOR 1370',2,0,0],
[-33.39632,-70.51157,'CECCP-15 - CP 1344','CERRO PINTOR 1344',2,0,0],
[-33.39529,-70.51125,'CECCP-16 - CP 1312','CERRO PINTOR 1312',2,0,0],
[-33.40074,-70.52905,'CMEA-01 - PTZ - CM 1583','CAMINO MIRASOL 1583',2,1,0],
[-33.40048,-70.52901,'CMEA-02 - CM 1571','CAMINO MIRASOL 1571',2,0,0],
[-33.40048,-70.52901,'CMEA-03 - CM 1571','CAMINO MIRASOL 1571',2,0,0],
[-33.40012,-70.52898,'CMEA-04 - CM 1557','CAMINO MIRASOL 1557',2,0,0],
[-33.39994,-70.52896,'CMEA-05 - CM 1556','CAMINO MIRASOL 1556',2,0,0],
[-33.39958,-70.52892,'CMEA-06 - CM 1541','CAMINO MIRASOL 1541',2,0,0],
[-33.39939,-70.5289,'CMEA-07 - CM 1527','CAMINO MIRASOL 1527',2,0,0],
[-33.40578,-70.53326,'CGB-01 - GB VA','GENERAL BLANCHE & VITAL APOQUINDO',2,0,0],
[-33.40605,-70.53351,'CGB-02 - GB 9576','GENERAL BLANCHE 9576',2,0,0],
[-33.40638,-70.53387,'CGB-03 - GB 9538','GENERAL BLANCHE 9538',2,0,0],
[-33.40638,-70.53387,'CGB-04-PTZ - GB 9540','GENERAL BLANCHE 9540',2,1,0],
[-33.40661,-70.53422,'CGB-05 - GB 9524','GENERAL BLANCHE 9524',2,0,0],
[-33.40677,-70.53449,'CGB-06 - GB 9535','GENERAL BLANCHE 9535',2,0,0],
[-33.3912,-70.51762,'CCO-01 - CO 1130','CAMINO OTOÑAL 1130',2,0,0],
[-33.3912,-70.51762,'CCO-02-PTZ - CO 1130','CAMINO OTOÑAL 1130',2,1,0],
[-33.3912,-70.51762,'CCO-03 - CO 1130','CAMINO OTOÑAL 1130',2,0,0],
[-33.3912,-70.51762,'CCO-04 - CO 1130','CAMINO OTOÑAL 1130',2,0,0],
[-33.39601,-70.50731,'STJ-01 - STJDI 1303','Santa Teresa Jornet de Ibars 1303',2,0,0],
[-33.39684,-70.50754,'STJ-02-PTZ - STJDI 1357','Santa Teresa Jornet de Ibars 1357',2,1,0],
[-33.3969,-70.50755,'STJ-03 - STJDI 1357','Santa Teresa Jornet de Ibars 1357',2,0,0],
[-33.39763,-70.5076,'STJ-04 - STJDI 1410','Santa Teresa Jornet de Ibars 1410',2,0,0],
[-33.39763,-70.5076,'STJ-05 - STJDI 1410','Santa Teresa Jornet de Ibars 1410',2,0,0],
[-33.39857,-70.50792,'STJ-06 - STJDI 1451','Santa Teresa Jornet de Ibars 1451',2,0,0],
[-33.39897,-70.508,'STJ-07 - STJDI 1478','Santa Teresa Jornet de Ibars 1478',2,0,0],
[-33.4075,-70.53633,'CL-01 - LL GB','LAS LOMAS & GENERAL BLANCHE',2,0,0],
[-33.40764,-70.53616,'CL-02 - LL 353','LAS LOMAS 353',2,0,0],
[-33.40807,-70.53609,'CL-03 - LL 389','LAS LOMAS 389',2,0,0],
[-33.40805,-70.53599,'CL-04 - LL 390','LAS LOMAS 390',2,0,0],
[-33.4082,-70.53602,'CL-05-PTZ - LL 409','LAS LOMAS 409',2,1,0],
[-33.40841,-70.53585,'CL-06 - LL 436','LAS LOMAS 436',2,0,0],
[-33.40872,-70.53583,'CL-07 - LL 437','LAS LOMAS 437',2,0,0],
[-33.4088,-70.5357,'CL-08 - LL 437','LAS LOMAS 437',2,0,0],
[-33.40902,-70.53562,'CL-09 - LL 485','LAS LOMAS 485',2,0,0],
[-33.40917,-70.53564,'CL-10 - LL 485','LAS LOMAS 485',2,0,0],
[-33.40118,-70.51582,'CDLV1-01 - CEA CDLV','Las Vertientes 1585',2,0,0],
[-33.40064,-70.5158,'CDLV1-02 - CDLV 1585','Las Vertientes & Camino Las Hojas',2,0,0],
[-33.3999,-70.51574,'CDLV1-03 - CDLV CLH','Las Vertientes & Camino Las Hojas',2,0,0],
[-33.39921,-70.51569,'CDLV1-04 - CDLV CLH','Las Vertientes 1499',2,0,0],
[-33.39921,-70.51569,'CDLV1-05-PTZ - CDLV 1499','Las Vertientes 1472',2,1,0],
[-33.39902,-70.51568,'CDLV1-06 - CDLV 1472','Las Vertientes 1465',2,0,0],
[-33.39846,-70.51563,'CDLV1-07 - CDLV 1465','Las Vertientes 1449',2,0,0],
[-33.39809,-70.51561,'CDLV1-08 - CDLV 1449','Las Vertientes 1417',2,0,0],
[-33.39752,-70.51557,'CDLV1-09 - CDLV 1417','Las Vertientes 1409',2,0,0],
[-33.39752,-70.51557,'CDLV2-01 - CDLV 1409','Las Vertientes 1398',2,0,0],
[-33.39714,-70.51554,'CDLV2-02 - CDLV 1398','Las Vertientes 1349',2,0,0],
[-33.39653,-70.5154,'CDLV2-03-PTZ - CDLV 1349','Las Vertientes 1371',2,1,0],
[-33.39688,-70.51552,'CDLV2-04 - CDLV 1371','Las Vertientes & Camino El Manzanar',2,0,0],
[-33.39617,-70.51507,'CDLV2-05 - CDLV CEM','Las Vertientes & Camino El Manzanar',2,0,0],
[-33.39617,-70.51507,'CDLV2-06 - CDLV CEM','Las Vertientes 1465',2,0,0],
[-33.39564,-70.51441,'CDLV2-07 - CDLV 1465','Fernando De Aragon & Flandes',2,0,0],
[-33.40441,-70.53215,'GB-01 - GB 9792 (P)','General Blanche 9792',2,0,0],
[-33.40441,-70.53215,'GB-02 - GB 9792 (O)','General Blanche 9792',2,0,0],
[-33.40441,-70.53215,'GB-03 - GB 9792 (P)','General Blanche 9792',2,0,0],
[-33.40441,-70.53215,'GB-04 - GB 9792 (O)','General Blanche 9826',2,0,0],
[-33.4042,-70.53191,'GB-05 - GB 9826 (P)','General Blanche 9826',2,0,0],
[-33.4042,-70.53191,'GB-06 - GB 9826 (O)','General Blanche 9826',2,0,0],
[-33.4042,-70.53191,'GB-07-PTZ - GB 9826','General Blanche 9848',2,1,0],
[-33.40407,-70.53175,'GB-08 - GB 9848 (O)','General Blanche 9876',2,0,0],
[-33.4039,-70.5315,'GB-09 - GB 9876 (O)','General Blanche 9876',2,0,0],
[-33.4039,-70.5315,'GB-10 - GB 9876 (P)','General Blanche 9894',2,0,0],
[-33.4038,-70.53135,'GB-11 - GB 9894 (P)','General Blanche 9910',2,0,0],
[-33.4038,-70.53135,'GB-12 - GB 9910 (P)','General Blanche 9910',2,0,0],
[-33.4038,-70.53135,'GB-13 - GB 9910 (O)','General Blanche 9910',2,0,0],
[-33.40374,-70.53116,'GB-14 - GB 9910 (P)','General Blanche 9922',2,0,0],
[-33.40366,-70.53103,'GB-15 - GB 9922 (P)','General Blanche 9922',2,0,0],
[-33.40366,-70.53103,'GB-16 - GB 9922 (O)','Manuel Aldunate 6392',2,0,0],
[-33.3987,-70.5096,'CCA-01 - CA 12339 (O)','Cerro Abanico 12390',2,0,0],
[-33.39875,-70.50893,'CCA-02-PTZ - CA 12390','Santa Teresa De Jornet De Ibars 1478',2,1,0],
[-33.39894,-70.50791,'CCA-03 - STDJDI 1478 (P)','Camino La Fuente Esquina Pasaje La Fontana',2,0,0],
[-33.41124,-70.51864,'CLFPLF-01 - CLF PLF (N)','Entrada Pasaje La Fontana',2,0,0],
[-33.41121,-70.51853,'CLFPLF-02 - PLF CLF (O)','Pasaje La Fontana 11264',2,0,0],
[-33.41099,-70.51803,'CLFPLF-03 - PLF 11264 (P)','Camino La Fuente 2796',2,0,0],
[-33.41093,-70.51871,'CLFPLF-04 - CLF 2796 (N)','Camino La Fuente 2762',2,0,0],
[-33.41047,-70.51872,'CLFPLF-05 - CLF 2762 (NO)','Pasaje Camino La Fuente 2763',2,0,0],
[-33.41077,-70.51921,'CLFPLF-06 - PCLF 2763 (P)','Pasaje Camino La Fuente (Entrada Psje)',2,0,0],
[-33.41041,-70.51885,'CLFPLF-07 - PCLF 2763 (P)','Camino La Fuente 2724',2,0,0],
[-33.41005,-70.5188,'CLFPLF-08 - CLF 2724 (S)','Camino La Fuente 2724',2,0,0],
[-33.41005,-70.5188,'CLFPLF-09 - CLF 2724 (N)','Camino La Fuente 2654',2,0,0],
[-33.40965,-70.51896,'CLFPLF-10 - CLF 2654 (N)','Camino La Fuente 2654',2,0,0],
[-33.40965,-70.51896,'CLFPLF-11 - CLF 2654 (S)','Camino La Fuente 2630',2,0,0],
[-33.40944,-70.51913,'CLFPLF-12 - CLF 2630 (P)','Camino La Fuente 2665',2,0,0],
[-33.40972,-70.51908,'CLFPLF-13-PTZ - CLF 2665','Camino La Fuente 2434',2,1,0],
[-33.40839,-70.51967,'CLFPLF-14 - CLF 2434 (S)','Camino La Fuente 2434',2,0,0],
[-33.40839,-70.51967,'CLFPLF-15 - CLF 2434 (N)','Camino La Fuente 2434',2,0,0],
[-33.40843,-70.51977,'CLFPLF-16 - CLF 2434 (P)','Camino La Fuente 2434',2,0,0],
[-33.40843,-70.51977,'CLFPLF-17 - CLF 2434 (O)','Camino La Fuente Esquina Quebrada Honda N 2762',2,0,0],
[-33.40751,-70.52029,'CLFPLF-18 - CLF QH 2762 (N)','Camino La Fuente Esquina Quebrada Honda Frente Al Camino La Fuente N 2434',2,0,0],
[-33.40751,-70.52029,'CLFPLF-19 - CLF QH 2434 (N)','Camino La Fuente Esquina Quebrada Honda Frente Al Camino La Fuente N 2434',2,0,0],
[-33.41199,-70.53544,'Punto 787','<br>Cuadrante:',2,0,0],
[-33.40413,-70.51129,'AFSR-04 C14 (Sur Poniente)','Los Olivos Interior',2,0,0],
[-33.40411,-70.51185,'AFSR-05 - Plaza (Oriente)','Los Olivos Plaza',2,0,0],
[-33.40414,-70.51182,'AFSR-06 - Plaza (Oriente)','Los Olivos',2,0,0],
[-33.40376,-70.51077,'AFSA-04 (Oriente)','Los Olivos',2,0,0],
[-33.40352,-70.51095,'AFSA-05 (Sur)','Los Olivos',2,0,0],
[-33.40342,-70.51052,'AFSA-06 (Poniente)','Los Olivos',2,0,0],
[-33.42096,-70.54507,'CCT-01 - ADC 8607','TOCONAO 1249',3,0,0],
[-33.42099,-70.54505,'CCT-02 - ADC 8607','ALONSO DE CAMARGO 8607',3,0,0],
[-33.42107,-70.54568,'CCT-03 - ADC 8591','ALONSO DE CAMARGO 8591',3,0,0],
[-33.42105,-70.54569,'CCT-04 - ADC 8591','ALONSO DE CAMARGO 8591',3,0,0],
[-33.42055,-70.54576,'CCT-05 - CC 1229','CHIU CHIU 1229',3,0,0],
[-33.42034,-70.54575,'CCT-06 - CC 1207','CHIU CHIU 1207',3,0,0],
[-33.41999,-70.54576,'CCT-07 - CC 1179','CHIU CHIU 1179',3,0,0],
[-33.41994,-70.54576,'CCT-08 - CC 1179','CHIU CHIU 1179',3,0,0],
[-33.41957,-70.54577,'CCT-09 - CC 1164','CHIU CHIU 1164',3,0,0],
[-33.4195,-70.54575,'CCT-10 - Z 8580','ZARAGOZA 8580',3,0,0],
[-33.41951,-70.54511,'CCT-11 - T 1208','TOCONAO 1167',3,0,0],
[-33.42001,-70.54508,'CCT-12 - T 1208','TOCONAO 1208',3,0,0],
[-33.42107,-70.54565,'CCT-13 - ADC 8591','ALONSO DE CAMARGO 8591',3,0,0],
[-33.42344,-70.54073,'T-01 - T A','TOCONCE & ASCOTAN',3,0,0],
[-33.42344,-70.54073,'T-02 - T A','TOCONCE & ASCOTAN',3,0,0],
[-33.42344,-70.54073,'T-03 - T A','TOCONCE & ASCOTAN',3,0,0],
[-33.42285,-70.5408,'T-04 - T 1520','TOCONCE 1530',3,0,0],
[-33.42285,-70.5408,'T-05 - T 1520','TOCONCE 1530',3,0,0],
[-33.4224,-70.54081,'T-06 -PTZ - T 1501','TOCONCE 1481',3,1,0],
[-33.42229,-70.54076,'T-07 - T 1496','TOCONCE & ROBERTO GUZMAN',3,0,0],
[-33.42263,-70.54078,'T-08 - T RG','TOCONCE 1501',3,0,0],
[-33.42141,-70.54823,'GS-01 - G 1251','GUADARRAMA 1251',3,0,0],
[-33.4216,-70.54802,'GS-02 - G 1264','GUADARRAMA 1259',3,0,0],
[-33.42181,-70.54786,'GS-03 - G EP','GUADARRAMA & EL PASTOR',3,0,0],
[-33.4219,-70.54778,'GS-04 - G 1272','GUADARRAMA 1272',3,0,0],
[-33.42223,-70.54757,'GS-05-PTZ - G 1287','GUADARRAMA 1287',3,1,0],
[-33.42227,-70.54745,'GS-06 - G EO','GUADARRAMA & EL OVEJERO',3,0,0],
[-33.4224,-70.5473,'GS-07 - G 1295','GUADARRAMA 1295',3,0,0],
[-33.4225,-70.5473,'GS-08 - G 1299','GUADARRAMA 1299',3,0,0],
[-33.42252,-70.54718,'GS-09 - G 1304','GUADARRAMA 1304',3,0,0],
[-33.42274,-70.54697,'GS-10 - G 1315','GUADARRAMA 1315',3,0,0],
[-33.42277,-70.54694,'GS-11 - G 1316','GUADARRAMA 1316',3,0,0],
[-33.42292,-70.54657,'GS-12 - G 1324','GUADARRAMA 1324',3,0,0],
[-33.42165,-70.54633,'GS-13 - EP FO','EL PASTOR & FUENTE OVEJUNA',3,0,0],
[-33.42224,-70.54747,'GS-14 - G EO','GUADARRAMA & EL OVEJERO',3,0,0],
[-33.42211,-70.54695,'GS-15 - EO 8036','EL OVEJERO 8036',3,0,0],
[-33.42212,-70.54634,'GS-16 - EO FO','EL OVEJERO & FUENTE OVEJUNA',3,0,0],
[-33.42737,-70.54145,'ET-01 - ET 1843','EL TATIO 1843',3,0,0],
[-33.4266,-70.54156,'ET-04 - ET 1791','EL TATIO 1791',3,0,0],
[-33.42675,-70.54153,'ET-03 - ET 1818','EL TATIO 1818',3,0,0],
[-33.42611,-70.54164,'ET-07-PTZ - ET 1781','EL TATIO 1781',3,1,0],
[-33.42599,-70.54165,'ET-08 - R 8769','RUPANCO 8769',3,0,0],
[-33.42599,-70.54165,'ET-09 - R 8769','RUPANCO 8769',3,0,0],
[-33.42597,-70.54105,'ET-10 - R 8828','RUPANCO 8828',3,0,0],
[-33.42557,-70.5417,'ET-11 - ET 1735','El TATIO 1735',3,0,0],
[-33.42696,-70.54148,'ET-02 - ET 1842','El TATIO 1842',3,0,0],
[-33.42644,-70.54156,'ET-05 - ET 1786','El TATIO 1786',3,0,0],
[-33.42644,-70.54156,'ET-06 - ET 1786','El TATIO 1786',3,0,0],
[-33.41393,-70.53351,'CA-07 - CA 879','CERRO ALEGRE 879',3,0,0],
[-33.41485,-70.53334,'CA-12- CA 921','CERRO ALEGRE 944',3,0,0],
[-33.41289,-70.53433,'CA-01 - CA 825','CERRO ALEGRE 825',3,0,0],
[-33.41312,-70.53409,'CA-02 - CA 841','CERRO ALEGRE 841',3,0,0],
[-33.41333,-70.53405,'CA-03 - CA 841','CERRO ALEGRE 841',3,0,0],
[-33.4134,-70.534,'CA-04 - CA 860','CERRO ALEGRE 860',3,0,0],
[-33.41359,-70.53366,'CA-05 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.41366,-70.53359,'CA-06 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.41409,-70.53339,'CA-08 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.41427,-70.5333,'CA-09-PTZ - CA 900','CERRO ALEGRE 918',3,1,0],
[-33.41448,-70.53321,'CA-10 - CA 921','CERRO ALEGRE 921',3,0,0],
[-33.41459,-70.53322,'CA-11 - CA 921','CERRO ALEGRE 921',3,0,0],
[-33.41495,-70.53335,'CA-13 - CG 964','CERRO ALEGRE 944',3,0,0],
[-33.41208,-70.54717,'V-01 - V 480','VALDEPEÑAS 480',3,0,0],
[-33.41133,-70.54818,'V-02 - V 382','VALDEPEÑAS 382',3,0,0],
[-33.41145,-70.54808,'V-03 - V 382','VALDEPEÑAS 382',3,0,0],
[-33.41067,-70.54882,'V-04 - V 275','VALDEPEÑAS 275',3,0,0],
[-33.41962,-70.54627,'Z-01 - FO 1172','FUENTE OVEJUNA 1172',3,0,0],
[-33.41961,-70.54744,'Z-02 - Z 8018','ZARAGOZA 8018',3,0,0],
[-33.41961,-70.54744,'Z-03 - Z 8018','ZARAGOZA 8018',3,0,0],
[-33.41967,-70.54803,'Z-04 - G 1126','GUIPUZCOA 1126',3,0,0],
[-33.41976,-70.54831,'Z-06 - V 1127','VIZCAYA 1127',3,0,0],
[-33.41978,-70.54847,'Z-07 - Z 7899','ZARAGOZA 7899',3,0,0],
[-33.41976,-70.54831,'Z-08 - V 1127','VIZCAYA 1127',3,0,0],
[-33.41992,-70.54957,'Z-09 - Z 7782','ZARAGOZA 7782',3,0,0],
[-33.41992,-70.54957,'Z-10 - Z 7782','ZARAGOZA 7782',3,0,0],
[-33.42005,-70.5497,'Z-11 - G 1153','GUADARRAMA 1153',3,0,0],
[-33.41983,-70.54993,'Z-12 - G 1135','GUADARRAMA 1135',3,0,0],
[-33.41942,-70.54948,'Z-13 - L 7798','LERIDA 7798',3,0,0],
[-33.41942,-70.54948,'Z-14 - L 7798','LERIDA 7798',3,0,0],
[-33.41931,-70.54864,'Z-15 - L 7851','LERIDA 7851',3,0,0],
[-33.41922,-70.54802,'Z-16 - L 7996','LERIDA 7996',3,0,0],
[-33.41978,-70.54847,'Z-05-PTZ - Z 7899','ZARAGOZA 7899',3,1,0],
[-33.42514,-70.56104,'ELT-01 - ET 1635','EL TOQUI 1635',3,0,0],
[-33.42521,-70.56106,'ELT-02 - ET 1635','EL TOQUI 1635',3,0,0],
[-33.42576,-70.56121,'ELT-03 - ET 1663','EL TOQUI 1663',3,0,0],
[-33.42581,-70.56123,'ELT-04 - ET 1663','EL TOQUI 1663',3,0,0],
[-33.42653,-70.56139,'ELT-05 - ET 1711','EL TOQUI 1711',3,0,0],
[-33.42656,-70.56139,'ELT-06 - ET 1711','EL TOQUI 1711',3,0,0],
[-33.42704,-70.56131,'ELT-07 - ET 1677','LATADIA 6573',3,0,0],
[-33.42691,-70.56139,'ELT-08 - ET 1677','EL TOQUI 1677',3,0,0],
[-33.42754,-70.56154,'ELT-09 - ET 1770','EL TOQUI 1770',3,0,0],
[-33.42776,-70.5617,'ELT-10 - ET 1793','El Toqui 1781',3,0,0],
[-33.42785,-70.56172,'ELT-11 - ET 1793','El Toqui 1781',3,0,0],
[-33.42812,-70.5618,'ELT-12 - ET 1837','El Toqui 1809',3,0,0],
[-33.42854,-70.56187,'ELT-13 - ET 1853','EL TOQUI 1853',3,0,0],
[-33.42861,-70.56188,'ELT-14 - ET 1853','EL TOQUI 1853',3,0,0],
[-33.42402,-70.5553,'MAY-01-PTZ - ILC 7400','ISABEL LA CATOLICA 7400',3,1,0],
[-33.42359,-70.55537,'MAY-02 - M 1554','MAYECURA 1554',3,0,0],
[-33.42359,-70.55537,'MAY-03 - M 1554','MAYECURA 1554',3,0,0],
[-33.42338,-70.55545,'MAY-04 - M 1482','MAYECURA 1482',3,0,0],
[-33.42296,-70.55544,'MAY-05 - M 1400','MAYECURA 1400',3,0,0],
[-33.42296,-70.55544,'MAY-06 - M 1400','MAYECURA 1400',3,0,0],
[-33.42252,-70.55539,'MAY-07-PTZ - M 1331','MAYECURA 1331',3,1,0],
[-33.42247,-70.55535,'MAY-08 - M 1336','MAYECURA 1336',3,0,0],
[-33.42247,-70.55535,'MAY-09 - M 1336','MAYECURA 1336',3,0,0],
[-33.43077,-70.56244,'ELT2-01 - ET 2001','EL TOQUI 2001',3,0,0],
[-33.43077,-70.56244,'ELT2-02 - ET 2001','EL TOQUI 2001',3,0,0],
[-33.4305,-70.56234,'ELT2-03 - ET 1997','EL TOQUI 1977',3,0,0],
[-33.4304,-70.56231,'ELT2-04 - ET 1977','EL TOQUI 1977',3,0,0],
[-33.42999,-70.56218,'ELT2-05 - ET 1956','EL TOQUI 1956',3,0,0],
[-33.42964,-70.56213,'ELT2-06 - ET 1948','EL TOQUI 1948',3,0,0],
[-33.42919,-70.56195,'ELT2-07 - ET 1887','EL TOQUI 1887',3,0,0],
[-33.42961,-70.56266,'ELT2-08 - P 6420','PROGRESO 6420',3,0,0],
[-33.42422,-70.5565,'JP-01 - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,0,0],
[-33.42421,-70.55645,'JP-02-PTZ - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,1,0],
[-33.42421,-70.55645,'JP-03 - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,0,0],
[-33.42387,-70.55655,'JP-04 - JP 1570','JUAN PALAU 1570',3,0,0],
[-33.42387,-70.55655,'JP-05 - JP 1570','JUAN PALAU 1570',3,0,0],
[-33.42348,-70.55661,'JP-06 - JP 1512','JUAN PALAU 1512',3,0,0],
[-33.42348,-70.55661,'JP-07 - JP 1512','JUAN PALAU 1512',3,0,0],
[-33.42278,-70.5568,'JP-08 - JP 1403','JUAN PALAU 1403',3,0,0],
[-33.42278,-70.5568,'JP-09 - JP 1403','JUAN PALAU 1403',3,0,0],
[-33.42259,-70.55689,'JP-10 - JP 1366','JUAN PALAU 1366',3,0,0],
[-33.42257,-70.55683,'JP-11 - JP 1371','JUAN PALAU 1371',3,0,0],
[-33.42257,-70.55683,'JP-12 - JP 1371','JUAN PALAU 1371',3,0,0],
[-33.42217,-70.55682,'JP-13 - JP 1302','JUAN PALAU 1302',3,0,0],
[-33.42217,-70.55682,'JP-14 - JP 1302','JUAN PALAU 1302',3,0,0],
[-33.42173,-70.55668,'JP-15 - JP ADC','JUAN PALAU & ALONSO DE CAMARGO',3,0,0],
[-33.42172,-70.55678,'JP-16 - JP ADC','JUAN PALAU & ALONSO DE CAMARGO',3,0,0],
[-33.41751,-70.54272,'PC-01 - P 1031','PICA 1031',3,0,0],
[-33.41751,-70.54272,'PC-02 - P 1031','PICA 1031',3,0,0],
[-33.41758,-70.54278,'PC-03 - P 1037','PICA 1037',3,0,0],
[-33.41775,-70.54271,'PC-04 - P 1041','PICA 1041',3,0,0],
[-33.41785,-70.54271,'PC-05 - P 1051','PICA 1051',3,0,0],
[-33.41785,-70.54271,'PC-06-PTZ - P 1051','PICA 1051',3,1,0],
[-33.41812,-70.54271,'PC-07 - P 1067','PICA 1067',3,0,0],
[-33.41812,-70.54271,'PC-08 - P 1067','PICA 1067',3,0,0],
[-33.41825,-70.54268,'PC-09 - P 1078','PICA 1078',3,0,0],
[-33.41839,-70.5427,'PC-10 - P 1082','PICA 1082',3,0,0],
[-33.42176,-70.55271,'PP-01-PTZ - P 1241','Palenque 1219',3,1,0],
[-33.42176,-70.55271,'PP-02 - P 1219','Palenque 1219',3,0,0],
[-33.42185,-70.55269,'PP-03 - P 1192','Palenque 1192',3,0,0],
[-33.42088,-70.55247,'PP-04 - N 7562','Nicosia 7562',3,0,0],
[-33.4218,-70.55227,'PP-05 - P 7563','Pretoria 7563',3,0,0],
[-33.4218,-70.55227,'PP-06 - P 7563','Pretoria 7563',3,0,0],
[-33.42174,-70.55171,'PP-07 - P 7585','Pretoria 7585',3,0,0],
[-33.42169,-70.5511,'PP-08 - P H','Pretoria esquina Huampani',3,0,0],
[-33.42169,-70.5511,'PP-09 - P H','Pretoria esquina Huampani',3,0,0],
[-33.42133,-70.55244,'PP-10 - M 7563','Manitoba 7563',3,0,0],
[-33.42129,-70.55194,'PP-11 - M 7580','Manitoba 7580',3,0,0],
[-33.4215,-70.5401,'CTADC-01 - V 1381 (N)','Visviri 1371',3,0,0],
[-33.42171,-70.54055,'CTADC-02 - C 8891 (O)','Chapiquiña 8891',3,0,0],
[-33.42171,-70.54055,'CTADC-03 - C 8891 (P)','Chapiquiña 8891',3,0,0],
[-33.42174,-70.54077,'CTADC-04 - C 8875 (N)','Chapiquiña 8875',3,0,0],
[-33.4212,-70.54078,'CTADC-05 - T 1350 (N)','Toconce 1350',3,0,0],
[-33.4212,-70.54078,'CTADC-06 - T 1350 (S)','Toconce 1350',3,0,0],
[-33.42179,-70.54105,'CTADC-07 - C 8851 (O)','Chapiquiña 8851',3,0,0],
[-33.42179,-70.54105,'CTADC-08 - C 8851 (N)','Chapiquiña 8851',3,0,0],
[-33.42179,-70.54105,'CTADC-09 - C 8851 (P)','Chapiquiña 8851',3,0,0],
[-33.4217,-70.54137,'CTADC-10-PTZ - A 1391','Ayquina 1391',3,1,0],
[-33.42229,-70.54139,'CTADC-11 - A RG (N)','Ayquina & Roberto Guzman',3,0,0],
[-33.42135,-70.54137,'CTADC-12 - A 1350 (S)','Ayquina 1350',3,0,0],
[-33.42135,-70.54137,'CTADC-13- A 1350 (N)','Ayquina 1350',3,0,0],
[-33.42413,-70.54134,'AP-01 - A AF','Ayquina Esquina Alexander Fleming',3,0,0],
[-33.42441,-70.54129,'AP-02 - A 1658','Ayquina 1658',3,0,0],
[-33.42476,-70.54123,'AP-03 - LG 8809','La Guaica 8809',3,0,0],
[-33.4249,-70.54121,'AP-04 - A 1709','Ayquina 1709',3,0,0],
[-33.42497,-70.5412,'AP-05 - A 1712','Ayquina 1712',3,0,0],
[-33.42497,-70.5412,'AP-06-PTZ - A 1712','Ayquina 1712',3,1,0],
[-33.42502,-70.54131,'AP-07 - P 8790','Pachica 8790',3,0,0],
[-33.4251,-70.54189,'AP-08 - P 8763','Pachica 8763',3,0,0],
[-33.4251,-70.54189,'AP-09 - P 8763','Pachica 8763',3,0,0],
[-33.42515,-70.54236,'AP-10 - P 8732','Pachica 8732',3,0,0],
[-33.42515,-70.54236,'AP-11 - P 8732','Pachica 8732',3,0,0],
[-33.4252,-70.54287,'AP-12 - P A','Pachica Esquina Alhue',3,0,0],
[-33.42569,-70.5568,'FJPL-01 - JP 1666','Juan Palau 1643',3,0,0],
[-33.42589,-70.55683,'FJPL-02 PTZ - JP 1669','Juan Palau 1669',3,1,0],
[-33.42588,-70.55668,'FJPL-03 - JP JP','Juan Palau Int 7210',3,0,0],
[-33.42628,-70.55691,'FJPL-04 - JP 1685','Juan Palau 1685',3,0,0],
[-33.42628,-70.55691,'FJPL-05 - JP 1685','Juan Palau 1685',3,0,0],
[-33.42657,-70.55696,'FJPL-06 - JP 1696','Juan Palau 1696',3,0,0],
[-33.42677,-70.55699,'FJPL-07 - JP 1713','Juan Palau 1713',3,0,0],
[-33.42677,-70.55699,'FJPL-08 - JP 1713','Juan Palau 1713',3,0,0],
[-33.42668,-70.55678,'FJPL-09 - PJP 1718','Pje Juan Palau 1718',3,0,0],
[-33.42664,-70.55664,'FJPL-10 - PJP 1706','Pje Juan Palau 1706',3,0,0],
[-33.42664,-70.55664,'FJPL-11 - PJP 1706','Pje Juan Palau 1706',3,0,0],
[-33.42623,-70.55653,'FJPL-12 - PA 7220','Pje Albania 7220',3,0,0],
[-33.42623,-70.55653,'FJPL-13 - PA 7220','Pje Albania 7220',3,0,0],
[-33.42593,-70.55605,'FJPL-14 - PA 7253','Pje Albania 7253',3,0,0],
[-33.42593,-70.55605,'FJPL-15 - PA 7253','Pje Albania 7253',3,0,0],
[-33.42588,-70.55668,'FJPL-16 - JP JP','Juan Palau Int 7210',3,0,0],
[-33.42427,-70.5478,'PGC-01 - PJGC 8098','Pintor José Gil de Castro 8098',3,0,0],
[-33.42428,-70.54806,'PGC-02 - PJGC 8119','Pintor José Gil de Castro 8119',3,0,0],
[-33.42435,-70.54845,'PGC-03 - PJGC 8059','Pintor José Gil de Castro 8059',3,0,0],
[-33.42435,-70.54845,'PGC-04 - PJGC 8059','Pintor José Gil de Castro 8059',3,0,0],
[-33.42443,-70.54928,'PGC-05 - PJGC 7984','Pintor José Gil de Castro 7984',3,0,0],
[-33.42443,-70.54928,'PGC-06 - PSGC 7984','Pintor José Gil de Castro 7984',3,0,0],
[-33.42449,-70.54981,'PGC-07-PTZ - PJS 1337','Pintor José Gil de Castro 7911',3,1,0],
[-33.42452,-70.55005,'PGC-08 - PSGC 7899','Pintor José Gil de Castro 7899',3,0,0],
[-33.42452,-70.55005,'PGC-09 - PJGC 7899','Pintor José Gil de Castro 7899',3,0,0],
[-33.4246,-70.55067,'PGC-10 - PJGC 7838','Pintor José Gil de Castro 7838',3,0,0],
[-33.4246,-70.55067,'PGC-11 - PJGC 7838','Pintor José Gil de Castro 7838',3,0,0],
[-33.42469,-70.55153,'PGC-12 - PJGC 7760','Pintor José Gil de Castro 7760',3,0,0],
[-33.42469,-70.55153,'PGC-13 - PJGC 7759','Pintor José Gil de Castro 7759',3,0,0],
[-33.4245,-70.53947,'PLP-01 - PLP 1633','Padre Le Paige 1633',3,0,0],
[-33.4245,-70.53947,'PLP-02 - PLP 1633','Padre Le Paige 1633',3,0,0],
[-33.4245,-70.53947,'PLP-03-PTZ - PLP 1633','Padre Le Paige 1633',3,1,0],
[-33.42504,-70.53938,'PLP-04 - PLP 1683','Padre Le Paige 1683',3,0,0],
[-33.42512,-70.53928,'PLP-05 - PLP 1699','Padre Le Paige 1699',3,0,0],
[-33.4247,-70.53894,'PLP-06 - PLP 1750','Padre Le Paige 1750',3,0,0],
[-33.4247,-70.53894,'PLP-07 - PLP 1750','Padre Le Paige 1750',3,0,0],
[-33.42429,-70.53888,'PLP-08 - PLP 1776','Padre Le Paige 1776',3,0,0],
[-33.42429,-70.53888,'PLP-09 - PLP 1776','Padre Le Paige 1776',3,0,0],
[-33.42383,-70.53883,'PLP-10 - PLP F','Padre Le Paige & Alejandro Fleming',3,0,0],
[-33.42383,-70.53883,'PLP-11 - PLP F','Padre Le Paige & Alejandro Fleming',3,0,0],
[-33.42386,-70.53944,'PLP-12 - PLP F','Alejandro Fleming 8904',3,0,0],
[-33.42386,-70.53944,'PLP-13 - PLP F','Alejandro Fleming 8904',3,0,0],
[-33.41236,-70.54891,'Y-01 - Y DEP','YAGUERO & DOCTORA ERNESTINA PEREZ',3,0,0],
[-33.4124,-70.54902,'Y-02 - Y 7783','YAGUERO 7783',3,0,0],
[-33.41264,-70.54928,'Y-03 - Y 77769','YAGUERO 7769',3,0,0],
[-33.41264,-70.54928,'Y-04 - Y 7769','YAGUERO 7769',3,0,0],
[-33.41295,-70.54959,'Y-05 - Y 7750','YAGUERO 7750',3,0,0],
[-33.41295,-70.54959,'Y-06-PTZ - Y 7750','YAGUERO 7750',3,1,0],
[-33.41295,-70.54959,'Y-07 - Y 7751','YAGUERO 7751',3,0,0],
[-33.41295,-70.54959,'Y-08 - Y 7751','YAGUERO 7751',3,0,0],
[-33.41328,-70.54995,'Y-09 - Y 7735','YAGUERO 7735',3,0,0],
[-33.41346,-70.55018,'Y-10 - Y 595','YELCHO 595',3,0,0],
[-33.41345,-70.55012,'Y-11 - Y 611','YELCHO 611',3,0,0],
[-33.41345,-70.55012,'Y-12 - Y 611','YELCHO 611',3,0,0],
[-33.41328,-70.54995,'Y-13 - Y 7734','YAGUERO 7734',3,0,0],
[-33.4279,-70.54513,'LSI-01 - MCV 8471','Manuel Claro vial 8471',3,0,0],
[-33.42795,-70.54561,'LSI-02 - MCV 8443','Manuel Claro vial 8443',3,0,0],
[-33.4291,-70.54519,'LSI-08 - LS 1989','Luis Strozzi 1989',3,0,0],
[-33.42841,-70.54742,'LSI-03 - LS 1922','Luis Strozzi 1920',3,0,0],
[-33.42844,-70.54972,'LSI-04 - LS 1922','Luis Strozzi 1922',3,0,0],
[-33.42869,-70.54525,'LSI-05 - LS 1954','Luis Strozzi 1954',3,0,0],
[-33.42869,-70.54525,'LSI-07-PTZ - LS 1954','Luis Strozzi 1954',3,1,0],
[-33.42869,-70.54525,'LSI-06 - LS 1954','Luis Strozzi 1954',3,0,0],
[-33.42926,-70.54518,'LSI-09 - LS FB','Luis Strozzi & Av. Francisco Bilbao',3,0,0],
[-33.42928,-70.54523,'LSI-10 - LS FB','Luis Strozzi & Av. Francisco Bilbao',3,0,0],
[-33.42955,-70.55433,'N-01 - N TM','Ñandu & Tomas Moro',3,0,0],
[-33.42966,-70.55373,'N-02 - N 7547','Ñandu 7547',3,0,0],
[-33.42966,-70.55373,'N-03 - N 7547','Ñandu 7547',3,0,0],
[-33.42963,-70.5536,'N-04-PTZ - N 7567','Ñandu 7567',3,1,0],
[-33.42957,-70.55332,'N-06 - N 7628','Ñandu 7628',3,0,0],
[-33.4296,-70.5532,'N-05 - N 7611','Ñandu 7611',3,0,0],
[-33.4295,-70.55282,'N-07 - P 1962','Polcura 1962',3,0,0],
[-33.4295,-70.55282,'N-08 - N P','Ñandu & Polcura',3,0,0],
[-33.42544,-70.54045,'LGN-01 - LG 8867','Luisa Guzman 8867',3,0,0],
[-33.42539,-70.54056,'LGN-02 - LG 8846','Luisa Guzman 8846',3,0,0],
[-33.42542,-70.54094,'LGN-03 - LG 8832','Luisa Guzman 8832',3,0,0],
[-33.42549,-70.54103,'LGN-04 - LG 8810','Luisa Guzman 8810',3,0,0],
[-33.42549,-70.54103,'LGN-05 - LG 8810','Luisa Guzman 8810',3,0,0],
[-33.42551,-70.54117,'LGN-06 - LG A','Luisa Guzman & Ayquina',3,0,0],
[-33.42551,-70.54125,'LGN-07 - LG 8792','Luisa Guzman 8792',3,0,0],
[-33.42558,-70.54168,'LGN-08 - ET 1737','El Tatio 1737',3,0,0],
[-33.42552,-70.54174,'LGN-09-PTZ - LG 8770','Luisa Guzman 8770',3,1,0],
[-33.42552,-70.54174,'LGN-10 - LG 8770','Luisa Guzman 8770',3,0,0],
[-33.42561,-70.54212,'LGN-11 - LG 8755','Luisa Guzman 8755',3,0,0],
[-33.42557,-70.54221,'LGN-12 - LG 8742','Luisa Guzman 8742',3,0,0],
[-33.42565,-70.54235,'LGN-13 - LG 8723','Luisa Guzman 8723',3,0,0],
[-33.42565,-70.54281,'LGN-14 - LG 8710','Luisa Guzman 8710',3,0,0],
[-33.42293,-70.56082,'LBR-01 - L RP','Longopilla & Roberto peragallo',3,0,0],
[-33.4234,-70.56064,'LBR-02 - L 1491','Longopilla 1491',3,0,0],
[-33.42364,-70.56055,'LBR-03 - L 1527','Longopilla 1527',3,0,0],
[-33.42382,-70.56051,'LBR-04 - L 1550','Longopilla 1550',3,0,0],
[-33.42382,-70.56051,'LBR-05 - L 1550','Longopilla 1550',3,0,0],
[-33.42382,-70.56051,'LBR-06-PTZ - L 1550','Longopilla 1550',3,1,0],
[-33.42401,-70.56039,'LBR-07 - L 1536','Longopilla 1536',3,0,0],
[-33.42401,-70.56039,'LBR-08 - L 1536','Longopilla 1536',3,0,0],
[-33.42434,-70.56042,'LBR-09 - L 1579','Longopilla 1579',3,0,0],
[-33.4239,-70.56076,'LBR-10 - IPB 6588','Ingeniero Pedro Blanquier 6588',3,0,0],
[-33.42397,-70.56095,'LBR-11 - IPB 6565','Ingeniero Pedro Blanquier 6565',3,0,0],
[-33.42394,-70.56111,'LBR-12 - IPB 6504','Ingeniero Pedro Blanquier 6504',3,0,0],
[-33.42401,-70.56147,'LBR-13 - IPB 6437','Ingeniero Pedro Blanquier 6437',3,0,0],
[-33.42399,-70.56188,'LBR-14 - IPB 6340','Ingeniero Pedro Blanquier 6340',3,0,0],
[-33.42402,-70.56215,'LBR-15 - IPB HDM','Ingeniero Pedro Blanquier & Hernando de Magallanes',3,0,0],
[-33.42404,-70.56232,'LBR-16 - IPB 6280','Ingeniero Pedro Blanquier 6280',3,0,0],
[-33.42792,-70.54567,'CMCV-01 - MCV 8443','Manuel Claro Vial 8443',3,0,0],
[-33.4279,-70.54598,'CMCV-02 - MCV 8394','Manuel Claro Vial 8394',3,0,0],
[-33.42798,-70.54622,'CMCV-03 - MCV 8350','Manuel Claro Vial 8350',3,0,0],
[-33.42795,-70.54632,'CMCV-04-PTZ - MCV C','Manuel Claro Vial & Calatambo',3,1,0],
[-33.42802,-70.54672,'CMCV-05 - MCV 8234','Manuel Claro Vial 8234',3,0,0],
[-33.42774,-70.54643,'CMCV-06 - C 1870','Catalambo 1870',3,0,0],
[-33.42747,-70.54647,'CMCV-07 - C 1854','Catalambo 1854',3,0,0],
[-33.42709,-70.54653,'CMCV-08 - C 1814','Catalambo 1814',3,0,0],
[-33.42709,-70.54653,'CMCV-09 - C 1797','Catalambo 1797',3,0,0],
[-33.42709,-70.54653,'CMCV-10 - C 1797','Catalambo 1797',3,0,0],
[-33.42694,-70.55863,'VO-01 - L 6943','LATADIA 6943',3,0,0],
[-33.42706,-70.55799,'VO-02 - L V','LATADIA & VICHATO',3,0,0],
[-33.4269,-70.55805,'VO-03 - V L','VICHATO & LATADIA',3,0,0],
[-33.42671,-70.55803,'VO-04 - VO 1727','VICHATO 1727',3,0,0],
[-33.42623,-70.55794,'VO-05 - VO 1693','VICHATO 1693',3,0,0],
[-33.42633,-70.55796,'VO-06 - VO 1698','VICHATO 1698',3,0,0],
[-33.42603,-70.55791,'VO-07 - VO 1685','VICHATO 1685',3,0,0],
[-33.42603,-70.55791,'VO-08-PTZ - VO 1685','VICHATO 1685',3,1,0],
[-33.42603,-70.55791,'VO-09 - VO 1685','VICHATO 1685',3,0,0],
[-33.42579,-70.55786,'VO-10 - VO 1677','VICHATO 1677',3,0,0],
[-33.42556,-70.55782,'VO-11 - VO 1640','VICHATO 1640',3,0,0],
[-33.42556,-70.55782,'VO-12 - VO 1640','VICHATO 1640',3,0,0],
[-33.4253,-70.55763,'VO-13 - V AF','VICHATO & ALEJANDRO FLEMING',3,0,0],
[-33.42526,-70.55799,'VO-14 - VO 6889','ALEJANDRO FLEMING 6889',3,0,0],
[-33.42633,-70.55796,'VO-15 - VO 1700','VICHATO 1700',3,0,0],
[-33.42941,-70.54744,'D1-01 - D 1988','DUQUECO 1988',3,0,0],
[-33.42901,-70.54748,'D1-02 - D 1942','DUQUECO 1942',3,0,0],
[-33.42882,-70.54751,'D1-03 - D 1918','DUQUECO 1918',3,0,0],
[-33.4286,-70.54756,'D1-04 - D 1906','DUQUECO 1906',3,0,0],
[-33.42841,-70.54758,'D1-05 - D 1894','DUQUECO 1894',3,0,0],
[-33.42813,-70.54764,'D1-06 - D MCV','DUQUECO & MANUEL CLARO VIAL',3,0,0],
[-33.42813,-70.54764,'D1-07-PTZ - D 1875','DUQUECO 1875',3,1,0],
[-33.42813,-70.54764,'D1-08 - D 1875','DUQUECO 1875',3,0,0],
[-33.42782,-70.54777,'D1-09 - D 1869','DUQUECO 1869',3,0,0],
[-33.4275,-70.54783,'D1-10 - D 1845','DUQUECO 1845',3,0,0],
[-33.42719,-70.54787,'D1-11 - D 1813','DUQUECO 1813',3,0,0],
[-33.42719,-70.54787,'D1-12 - D 1813','DUQUECO 1813',3,0,0],
[-33.42672,-70.54794,'D1-12 - D L','DUQUECO & LAMPA',3,0,0],
[-33.42656,-70.54786,'D2-01 - D 1774','DUQUECO 1774',3,0,0],
[-33.42638,-70.54788,'D2-02 - D 1750','DUQUECO 1750',3,0,0],
[-33.42638,-70.54788,'D2-03 - D 1750','DUQUECO 1750',3,0,0],
[-33.42638,-70.54788,'D2-04-PTZ - D 1750','DUQUECO 1750',3,1,0],
[-33.4257,-70.54811,'D2-05 - D 1707','DUQUECO 1707',3,0,0],
[-33.42555,-70.54812,'D2-06 - D 1691','DUQUECO 1691',3,0,0],
[-33.42569,-70.54811,'D2-07 - D 1699','DUQUECO 1699',3,0,0],
[-33.42531,-70.54805,'D2-08 - D LG','DUQUECO & LA GUAICA',3,0,0],
[-33.42504,-70.54811,'D2-09 - D 1666','DUQUECO 1666',3,0,0],
[-33.42481,-70.54819,'D2-10 - D AF','DUQUECO & ALEJANDRO FLEMING',3,0,0],
[-33.42941,-70.54686,'CMP-01 - MP 1986','Marcela Paz 1986',3,0,0],
[-33.42896,-70.54693,'CMP-02 - MP 1948','Marcela Paz 1948',3,0,0],
[-33.42896,-70.54693,'CMP-03 - MP 1948','Marcela Paz 1948',3,0,0],
[-33.42867,-70.54698,'CMP-04 - MP 1918','Marcela Paz 1918',3,0,0],
[-33.42867,-70.54698,'CMP-05 - MP 1918','Marcela Paz 1918',3,0,0],
[-33.42824,-70.54706,'CMP-06 - MP 1880','Marcela Paz 1880',3,0,0],
[-33.42824,-70.54706,'CMP-07 - MP 1880','Marcela Paz1880',3,0,0],
[-33.42809,-70.54712,'CMP-08-PTZ - MCV MP','Manuel Claro Vial & Marcela Paz',3,1,0],
[-33.42384,-70.53659,'CVUS1-01 – LTM AF','LAS TRES MARIAS & ALEJANDRO FLEMING',3,0,0],
[-33.42396,-70.53659,'CVUS1-02-PTZ – LTM 1614','LAS TRES MARIAS 1614',3,1,0],
[-33.42443,-70.53661,'CVUS1-03 – LTM 1650','LAS TRES MARIAS 1650',3,0,0],
[-33.42444,-70.53749,'CVUS1-04 – AC 8920','ALFA CENTAURO 8920',3,0,0],
[-33.42449,-70.53593,'CVUS1-05 – AC 1679','ALFA CENTAURO 1679',3,0,0],
[-33.42462,-70.5366,'CVUS1-06 – LTM 1682','LAS TRES MARIAS 1682',3,0,0],
[-33.42491,-70.53675,'CVUS1-07 – LTM A','LAS TRES MARIAS & ARTURO',3,0,0],
[-33.4249,-70.53749,'CVUS1-08 – A 8924','ARTURO 8924',3,0,0],
[-33.42492,-70.53602,'CVUS1-09 – A 1713','ARTURO 1713',3,0,0],
[-33.42504,-70.53663,'CVUS2-01 – LTM 1734','LAS TRES MARIAS 1734',3,0,0],
[-33.42536,-70.53665,'CVUS2-02 – LTM 1758','LAS TRES MARIAS 1758',3,0,0],
[-33.42558,-70.5366,'CVUS2-03 – LTM VL','LAS TRES MARIAS & VIA LACTEA',3,0,0],
[-33.42558,-70.5366,'CVUS2-04 – LTM VL','LAS TRES MARIAS & VIA LACTEA',3,0,0],
[-33.42559,-70.53622,'CVUS2-05 – VL 8990','VIA LACTEA 8990',3,0,0],
[-33.42556,-70.53742,'CVUS2-06 – VL 8934','VIA LACTEA 8934',3,0,0],
[-33.42556,-70.53742,'CVUS2-07 – VL 8934','VIA LACTEA 8934',3,0,0],
[-33.4258,-70.53712,'CVUS2-08 – VL 8943','VIA LACTEA 8943',3,0,0],
[-33.42579,-70.53666,'CVUS2-09-PTZ – VL 8989','VIA LACTEA 8989',3,1,0],
[-33.42579,-70.53652,'CVUS2-10 – VL 8993','VIA LACTEA 8993',3,0,0],
[-33.40869,-70.54916,'CV-01 - V 85','VALDEPEÑAS 85',3,0,0],
[-33.40913,-70.54908,'CV-02 - V 116','VALDEPEÑAS 116',3,0,0],
[-33.40951,-70.54905,'CV-03 - V 176','VALDEPEÑAS 176',3,0,0],
[-33.40934,-70.54906,'CV-04 - V 150','VALDEPEÑAS 150',3,0,0],
[-33.40934,-70.54906,'CV-05 - V 150','VALDEPEÑAS 150',3,0,0],
[-33.40965,-70.54904,'CV-06 - V 192','VALDEPEÑAS 192',3,0,0],
[-33.40979,-70.54903,'CV-07 - V 214','VALDEPEÑAS 214',3,0,0],
[-33.40982,-70.54903,'CV-08 - V 220','VALDEPEÑAS 220',3,0,0],
[-33.41021,-70.54902,'CV-09 - V 259','VALDEPEÑAS 259',3,0,0],
[-33.41021,-70.54902,'CV-10 - V 259','VALDEPEÑAS 259',3,0,0],
[-33.41036,-70.549,'CV-11 - V 275','VALDEPEÑAS 275',3,0,0],
[-33.41036,-70.549,'CV-12 - V 275','VALDEPEÑAS 275',3,0,0],
[-33.41073,-70.54883,'CV-13-PTZ - V RT','VALDEPEÑAS & RIO TAJO',3,1,0],
[-33.42596,-70.54107,'AGMB-01 - A R','AYQUINA & RUPANCO',3,0,0],
[-33.42613,-70.54105,'AGMB-02 - A 1780','AYQUINA 1780',3,0,0],
[-33.42671,-70.54099,'AGMB-03 - A 1825','AYQUINA 1825',3,0,0],
[-33.42692,-70.54095,'AGMB-04 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.42692,-70.54095,'AGMB-05 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.42692,-70.54095,'AGMB-06-PTZ - A 1837','AYQUINA 1837',3,1,0],
[-33.4271,-70.54089,'AGMB-07 - A 1861','AYQUINA 1861',3,0,0],
[-33.42692,-70.54095,'AGMB-08 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.42689,-70.54028,'AGMB-09 - G 8833','GUALLATIRE 8833',3,0,0],
[-33.42689,-70.54028,'AGMB-10 - G 8833','GUALLATIRE 8833',3,0,0],
[-33.42642,-70.53974,'AGMB-11 - V G','VISVIRI & GUALLATIRE',3,0,0],
[-33.42688,-70.53963,'AGMB-12 - V 1839','VISVIRI 1839',3,0,0],
[-33.42725,-70.53973,'AGMB-13 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,0,0],
[-33.42724,-70.53961,'AGMB-14 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,0,0],
[-33.4273,-70.54015,'AGMB-15 - MCV 8844','MANUEL CLARO VIAL 8844',3,0,0],
[-33.42739,-70.5409,'AGMB-16 - MCV 8784','MANUEL CLARO VIAL 8784',3,0,0],
[-33.42602,-70.55057,'CSSCN-01 - N 7865','NAICURA 7865',3,0,0],
[-33.42601,-70.55048,'CSSCN-02 - N 7881','NAICURA 7881',3,0,0],
[-33.42597,-70.55011,'CSSCN-03 - N 7921','NAICURA 7921',3,0,0],
[-33.42596,-70.54997,'CSSCN-04 - N 7929','NAICURA 7929',3,0,0],
[-33.42547,-70.54982,'CSSCN-05 - C 1672','CECILIA 1672',3,0,0],
[-33.42547,-70.54982,'CSSCN-06 - C 1672','CECILIA 1672',3,0,0],
[-33.42592,-70.54954,'CSSCN-07 - N 7963','NAICURA 7963',3,0,0],
[-33.42588,-70.54926,'CSSCN-08 - N 7979','NAICURA 7979',3,0,0],
[-33.42497,-70.54948,'CSSCN-09 - AF 7989','ALEJANDRO FLEMING 7989',3,0,0],
[-33.42507,-70.5493,'CSSCN-10 - R 1661','RUCALHUE 1661',3,0,0],
[-33.42568,-70.54916,'CSSCN-11 – R 1690','RUCALHUE 1690',3,0,0],
[-33.42597,-70.54911,'CSSCN-12 - R 1706','RUCALHUE 1706',3,0,0],
[-33.42597,-70.54911,'CSSCN-13 - R 1706','RUCALHUE 1706',3,0,0],
[-33.4262,-70.54976,'CSSCN-14 - R 1729','RUCALHUE 1729',3,0,0],
[-33.42631,-70.54897,'CSSCN-15 - L 8020','LOLCO 8020',3,0,0],
[-33.42544,-70.54923,'CSSCN-16-PTZ - R 1679','RUCALHUE 1679',3,1,0],
[-33.41264,-70.54742,'SMS-01 - LD SMS','LOS DOMINICOS & SANTA MAGDALENA SOFIA',3,0,0],
[-33.41271,-70.54736,'SMS-02 - LD SMS','LOS DOMINICOS & SANTA MAGDALENA SOFIA',3,0,0],
[-33.41305,-70.5469,'SMS-03 - SMS 542','SANTA MAGDALENA SOFIA 542',3,0,0],
[-33.41334,-70.54651,'SMS-04 - SMS 613','SANTA MAGDALENA SOFIA 613',3,0,0],
[-33.41334,-70.54651,'SMS-05 - SMS 613','SANTA MAGDALENA SOFIA 613',3,0,0],
[-33.41334,-70.54651,'SMS-06-PTZ - SMS 613','SANTA MAGDALENA SOFIA 613',3,1,0],
[-33.41363,-70.54613,'SMS-07 - SMS 648','SANTA MAGDALENA SOFIA 648',3,0,0],
[-33.41363,-70.54613,'SMS-08 - SMS 648','SANTA MAGDALENA SOFIA 648',3,0,0],
[-33.41395,-70.5457,'SMS-09 - SMS M','SANTA MAGDALENA SOFIA & MONROE',3,0,0],
[-33.42212,-70.55028,'PM-01 - ADC PAM','ALONSO DE CAMARGO & PINTORA AURORA MIRA',3,0,0],
[-33.42236,-70.55023,'PM-02 - PAM 1241','PINTORA AURORA MIRA​ 1241​',3,0,0],
[-33.42278,-70.54981,'PM-03 - PAM 1264','PINTORA AURORA MIRA​ 1264',3,0,0],
[-33.42278,-70.54981,'PM-04 - PAM 1264','PINTORA AURORA MIRA​ 1264',3,0,0],
[-33.42299,-70.5496,'PM-05 - PAM 1276','PINTORA AURORA MIRA​ 1276​',3,0,0],
[-33.42299,-70.5496,'PM-06 - PAM 1276','PINTORA AURORA MIRA​ 1276​',3,0,0],
[-33.42299,-70.5496,'PM-07 - PAM 1276','PINTORA AURORA MIRA​ 1276​',3,0,0],
[-33.42337,-70.54917,'PM-08 - PAM PRM','PINTORA AURORA MIRA & PINTOR RAIMUNDO MONVOISIN',3,0,0],
[-33.42307,-70.55002,'PM-09 - PMM 7923','PINTORA MAGDALENA MIRA​ 7923​',3,0,0],
[-33.42307,-70.55002,'PM-10 - PMM 7923','PINTORA MAGDALENA MIRA​ 7923​',3,0,0],
[-33.42317,-70.55088,'PM-11 - PMM 7839','PINTORA MAGDALENA MIRA​ 7839',3,0,0],
[-33.42317,-70.55088,'PM-12 - PMM 7839','PINTORA MAGDALENA MIRA​ 7839',3,0,0],
[-33.42326,-70.55168,'PM-13 - PMM 7785','PINTORA MAGDALENA MIRA​ 7785',3,0,0],
[-33.42326,-70.55168,'PM-14 - PMM 7785','PINTORA MAGDALENA MIRA​ 7785',3,0,0],
[-33.42327,-70.55184,'PM-15-PTZ - PMM 7777','PINTORA MAGDALENA MIRA​ 7777',3,1,0],
[-33.42334,-70.55229,'PM-16 - C PMM','CANUMANQUI & PINTORA​ MAGDALENA MIRA',3,0,0],
[-33.42017,-70.54728,'CH-01 - S H','HUESCA & SOMORROSTRO',3,0,0],
[-33.42017,-70.54728,'CH-02 - S H','HUESCA & SOMORROSTRO',3,0,0],
[-33.42016,-70.54752,'CH-03 - H 7995','HUESCA 7995',3,0,0],
[-33.42021,-70.54785,'CH-04 - H 7946','HUESCA ​7946​',3,0,0],
[-33.42021,-70.54785,'CH-05 - H 7946','​HUESCA 7946​',3,0,0],
[-33.42025,-70.54829,'CH-06-PTZ - H 7914','​HUESCA 7914​',3,1,0],
[-33.42025,-70.54829,'CH-07 - H 7914','​HUESCA 7914​',3,0,0],
[-33.42025,-70.54829,'CH-08 - H 7914','​HUESCA 7914​',3,0,0],
[-33.42029,-70.54864,'CH-09 - H 7874','​HUESCA 7874​',3,0,0],
[-33.42029,-70.54864,'CH-10 - H 7874','​HUESCA 7874​',3,0,0],
[-33.42034,-70.54897,'CH-11 - H 7846','​HUESCA 7846​',3,0,0],
[-33.42034,-70.54897,'CH-12 - H 7846','​HUESCA 7846',3,0,0],
[-33.42041,-70.54939,'CH-13 - H G','HUESCA & GUADARRAMA',3,0,0],
[-33.41118,-70.54354,'CVA-01 - V A','VILANOVA & ANTEQUERA',3,0,0],
[-33.41132,-70.54345,'CVA-02 - V 411','VILANOVA 411',3,0,0],
[-33.41158,-70.54333,'CVA-03 - V 438','VILANOVA 438',3,0,0],
[-33.41171,-70.54323,'CVA-04 - V M','VILANOVA & MONROE',3,0,0],
[-33.41174,-70.54332,'CVA-05 - V M','VILANOVA & MONROE',3,0,0],
[-33.41176,-70.54309,'CVA-06 - M 8508','MONROE 8508',3,0,0],
[-33.41203,-70.54313,'CVA-07 - V 476','VILANOVA 476',3,0,0],
[-33.41229,-70.54303,'CVA-08 - V 510','VILANOVA 510',3,0,0],
[-33.41265,-70.54289,'CVA-09-PTZ - V 553','VILANOVA 553',3,1,0],
[-33.41265,-70.54289,'CVA-10 - V 553','VILANOVA 553',3,0,0],
[-33.41265,-70.54289,'CVA-11 - V 553','VILANOVA 553',3,0,0],
[-33.4131,-70.54272,'CVA-12 - V 665','VILANOVA 665',3,0,0],
[-33.41335,-70.54261,'CVA-13 - V 677','VILANOVA 677',3,0,0],
[-33.41364,-70.54255,'CVA-14 - V 727','VILANOVA 727',3,0,0],
[-33.41388,-70.5425,'CVA-15 - RG 8673','RIO GUADIANA 8673',3,0,0],
[-33.4138,-70.54215,'CVA-16 - RG 8693','RIO GUADIANA 8693',3,0,0],
[-33.42462,-70.54137,'CG-01 - LG A','LA GUAICA & AYQUINA',3,0,0],
[-33.42455,-70.54063,'CG-02 - LG 8864','LA GUAICA 8864',3,0,0],
[-33.42455,-70.54063,'CG-03 - LG 8864','LA GUAICA 8864',3,0,0],
[-33.42455,-70.54063,'CG-04 - LG 8864','LA GUAICA 8864',3,0,0],
[-33.42455,-70.54063,'CG-05-PTZ - LG 8864','LA GUAICA 8864',3,1,0],
[-33.42499,-70.54057,'CG-06 - T 1715','TOCONCE 1715',3,0,0],
[-33.42499,-70.54057,'CG-07 - T 1715','TOCONCE 1715',3,0,0],
[-33.42544,-70.54048,'CG-08 - LG 8869','LUISA GUZMAN 8869',3,0,0],
[-33.42546,-70.53985,'CG-09 - V 1730','VISVIRI 1730',3,0,0],
[-33.42485,-70.53995,'CG-10 - V 1711','VISVIRI 1711',3,0,0],
[-33.42448,-70.54002,'CG-11 - V LG','VISVIRI & LA GUAICA',3,0,0],
[-33.42448,-70.54002,'CG-12 - V LG','VISVIRI & LA GUAICA',3,0,0],
[-33.42381,-70.54011,'CG-13 - V AF','VISVIRI & ALEJANDRO FLEMING',3,0,0],
[-33.42448,-70.54002,'CG-14 - V LG','VISVIRI & LA GUAICA',3,0,0],
[-33.41742,-70.55196,'RL-01 - RL CH','RIO LOA & CHOAPA',3,0,0],
[-33.41742,-70.55196,'RL-02-PTZ - RL CH','RIO LOA & CHOAPA',3,1,0],
[-33.41732,-70.55175,'RL-03 - RL 7616','RIO LOA 7616',3,0,0],
[-33.41734,-70.55138,'RL-04 - RL 7635','RIO LOA 7635',3,0,0],
[-33.41728,-70.55142,'RL-05 - RL 7640','RIO LOA 7640',3,0,0],
[-33.41728,-70.55094,'RL-06 - RL M','RIO LOA & MATAQUITO',3,0,0],
[-33.41721,-70.55096,'RL-07 - RL 7655','RIO LOA 7955',3,0,0],
[-33.41719,-70.55078,'RL-08 - RL 7664','RIO LOA 7664',3,0,0],
[-33.41717,-70.55056,'RL-09 - RL 7667','RIO LOA 7667',3,0,0],
[-33.41721,-70.55037,'RL-10 - RL 7680','RIO LOA 7680',3,0,0],
[-33.41714,-70.5503,'RL-11 - RL 7695','RIO LOA 7695',3,0,0],
[-33.42478,-70.54315,'CGA-01 - A 1661','ALHUE 1661',3,0,0],
[-33.42478,-70.54315,'CGA-02 - A 1661','ALHUE 1661',3,0,0],
[-33.42471,-70.54273,'CGA-03 - G 8781','LA GUAICA 8781',3,0,0],
[-33.42471,-70.54273,'CGA-04 - G 8718','LA GUAICA 8718',3,0,0],
[-33.42469,-70.54248,'CGA-05-PTZ - G 8750','LA GUAICA 8750',3,1,0],
[-33.42464,-70.5419,'CGA-06 - G 8772','LA GUAICA 8772',3,0,0],
[-33.42464,-70.5419,'CGA-07 - G 8772','LA GUAICA 8772',3,0,0],
[-33.42458,-70.54146,'CGA-08 - G A','LA GUAICA & ALHUE',3,0,0],
[-33.41907,-70.56082,'MAP-01 - MAP 6500','MARTIN ALONSO DE PINZON 6500',3,0,0],
[-33.4195,-70.56095,'MAP-02 - MAP 6501','MARTIN ALONSO DE PINZON 6501',3,0,0],
[-33.4195,-70.56095,'MAP-03 - MAP 6501','MARTIN ALONSO DE PINZON 6501',3,0,0],
[-33.4195,-70.56095,'MAP-04 - MAP 6501','MARTIN ALONSO DE PINZON 6501',3,0,0],
[-33.41969,-70.56105,'MAP-05-PTZ - MAP 6507','MARTIN ALONSO DE PINZON 6507',3,1,0],
[-33.41984,-70.56115,'MAP-06 - MAP 6521','MARTIN ALONSO DE PINZON 6521',3,0,0],
[-33.41997,-70.56044,'MAP-07 - MAP 6573','MARTIN ALONSO DE PINZON 6573',3,0,0],
[-33.41997,-70.56044,'MAP-08 - MAP 6573','MARTIN ALONSO DE PINZON 6573',3,0,0],
[-33.41978,-70.55994,'MAP-09 - MAP 6641','MARTIN ALONSO DE PINZON 6641',3,0,0],
[-33.4197,-70.56,'MAP-10 - MAP 6641','MARTIN ALONSO DE PINZON 6641',3,0,0],
[-33.41958,-70.5607,'MAP-11 - MAP 6645','MARTIN ALONSO DE PINZON 6645',3,0,0],
[-33.41964,-70.55987,'MAP-12 - MAP 6642','MARTIN ALONSO DE PINZON 6642',3,0,0],
[-33.41923,-70.55983,'MAP-13 - MAP 6599','MARTIN ALONSO DE PINZON 6599',3,0,0],
[-33.41911,-70.56055,'MAP-14 - MAP 6569','MARTIN ALONSO DE PINZON 6569',3,0,0],
[-33.41908,-70.56068,'MAP-15 - MAP 6569','MARTIN ALONSO DE PINZON 6569',3,0,0],
[-33.42322,-70.5444,'CU1-01 - O 8638','OLLAGUE 8638',3,0,0],
[-33.42336,-70.54428,'CU1-02-PTZ - P 1541','PARINACOTA 1541',3,1,0],
[-33.42327,-70.54427,'CU1-03 - O 8650','OLALGUE 8650',3,0,0],
[-33.42317,-70.54386,'CU1-04 - O 8684','OLLAGUE 8684',3,0,0],
[-33.42317,-70.54386,'CU1-05 - O 8684','OLLAGUE 8684',3,0,0],
[-33.42307,-70.54319,'CU1-06 - O A','OLLAGUE & ALHUE',3,0,0],
[-33.42355,-70.54318,'CU1-07 - A 1560','ALHUE 1560',3,0,0],
[-33.42419,-70.54316,'CU1-08 - A AF','ALHUE & AV ALEJANDRO FLEMING',3,0,0],
[-33.42433,-70.54315,'CU1-09 - AF A','ALEJANDO FLEMING & ALHUE',3,0,0],
[-33.42433,-70.54315,'CU1-10 - AF A','ALEJANDO FLEMING & ALHUE',3,0,0],
[-33.42377,-70.54387,'CU2-01 - P 1579','PENDIENTE',3,0,0],
[-33.42377,-70.54387,'CU2-02 - P 1579','PENDIENTE',3,0,0],
[-33.42441,-70.54376,'CU2-03 - P AF','PENDIENTE',3,0,0],
[-33.42439,-70.54356,'CU2-04-PTZ - AF 8673','PENDIENTE',3,1,0],
[-33.42449,-70.54436,'CU2-05 - PA AF','PENDIENTE',3,0,0],
[-33.42433,-70.54436,'CU2-06 - PA AF','PENDIENTE',3,0,0],
[-33.42376,-70.54443,'CU2-07 - PA 1579','PENDIENTE',3,0,0],
[-33.42376,-70.54443,'CU2-08 - PA 1579','PENDIENTE',3,0,0],
[-33.4262,-70.52981,'CLP-01 - VA 1884','Vital Apoquindo 1884',3,0,0],
[-33.42619,-70.53029,'CLP-02 - LP 9439','Las Pleyades 9442',3,0,0],
[-33.42648,-70.5303,'CLP-03 - LP 9445','Las Pleyades 9445',3,0,0],
[-33.42621,-70.53062,'CLP-04 - LP 9385','Las Pleyades 9358',3,0,0],
[-33.42621,-70.53062,'CLP-05 - LP 9390','Las Pleyades 9390',3,0,0],
[-33.42621,-70.53062,'CLP-06 - LP 9390','Las Pleyades 9390',3,0,0],
[-33.42656,-70.53114,'CLP-07 - LP 9329','Las Pleyades 9329',3,0,0],
[-33.42653,-70.53149,'CLP-08 - LP 9307','Las Pleyades 9307',3,0,0],
[-33.42653,-70.53149,'CLP-09 - LP 9307','Las Pleyades 9307',3,0,0],
[-33.42624,-70.53061,'CLP-10-PTZ - LP 9390','Las Pleyades 9390',3,1,0],
[-33.42623,-70.5321,'CLP-11 - LP 9290','Las Pleyades 9290',3,0,0],
[-33.40708,-70.53461,'CLU-01 - LML 337','Luis Matte Larrain 337',3,0,0],
[-33.40799,-70.53424,'CLU-02-PTZ - LML 426','Luis Matte Larrain 426',3,1,0],
[-33.40799,-70.53424,'CLU-03 - LML 426','Luis Matte Larrain 426',3,0,0],
[-33.4087,-70.53402,'CLU-04 - LML AS','Luis Matte Larrain & Almirante Soublette',3,0,0],
[-33.42027,-70.56134,'MA-08 - MA 6392 (O)','Manuel Aldunate 6392',3,0,0],
[-33.42027,-70.56134,'MA-09 - MA 6392 (P)','Hernando De Magallanes 1227',3,0,0],
[-33.42016,-70.56198,'MA-10 - HDM 1227 (O)','Hernando De Magallanes 1238',3,0,0],
[-33.42048,-70.56206,'MA-11 - HDM 1238 (N)','Calatambo 1814',3,0,0],
[-33.42705,-70.54656,'MCV-11 - C 1814','Luis Zeggers 297',3,0,0],
[-33.41758,-70.53034,'VLE-01 - Y VA','Yolanda 9437',3,0,0],
[-33.4178,-70.53149,'VLE-02 - Y 9437','Yolanda & La Paz',3,0,0],
[-33.41762,-70.53085,'VLE-03 - Y P','Yolanda 9431',3,0,0],
[-33.41775,-70.53132,'VLE-04 - Y 9431','Yolanda 9431',3,0,0],
[-33.41769,-70.53131,'VLE-05 - Y 9432','Yolanda 9430',3,0,0],
[-33.41782,-70.53163,'VLE-06 - Y 9430','Yolanda 9424',3,0,0],
[-33.41775,-70.53159,'VLE-07 - Y 9424','Yolanda 9424',3,0,0],
[-33.41775,-70.53159,'VLE-08 - Y 9425','Yolanda 9410',3,0,0],
[-33.41778,-70.53193,'VLE-09 - Y 9410','Yolanda & La Escuela',3,0,0],
[-33.41787,-70.53253,'VLE-10-PTZ - Y E','Delia Matte 1892',3,1,0],
[-33.42815,-70.54648,'CDL-01 - DL 1892 (N)','Delia Matte 1892',3,0,0],
[-33.42815,-70.54648,'CDL-02 - DL 1892 (S)','Delia Matte 1929',3,0,0],
[-33.42858,-70.54642,'CDL-03 - DL 1929 (N)','Delia Matte 1929',3,0,0],
[-33.42858,-70.54642,'CDL-04 - DL 1929 (S)','Delia Matte 1950',3,0,0],
[-33.42896,-70.54635,'CDL-05-PTZ - DL 1950','Delia Matte 1975',3,1,0],
[-33.42917,-70.54637,'CDL-06 - DL 1975 (S)','Delia Matte 1976',3,0,0],
[-33.42922,-70.54632,'CDL-07 - DL 1976 (N)','Cerro Abanico 12339',3,0,0],
[-33.43019,-70.55755,'RVC14S-JPCA-01 - JP 1960 (NO)','Juan Palau 1952',3,0,0],
[-33.43009,-70.5575,'RVC14S-JPCA-02 - JP 1952 (S)','Juan Palau 1940',3,0,0],
[-33.42949,-70.55742,'RVC14S-JPCA-03 - JP 1940 (P)','Juan Palau & Carlos Alvarado',3,0,0],
[-33.429,-70.55742,'RVC14S-JPCA-04-PTZ - JP CA','Juan Palau 7283​',3,1,0],
[-33.42917,-70.55669,'RVC14S-JPCA-05 - CA 7283 (P)','Carlos Alvarado & Juan Palau​',3,0,0],
[-33.429,-70.55729,'RVC14S-JPCA-06 - CA JP (S)','Carlos Alvarado & Juan Palau​',3,0,0],
[-33.42898,-70.55742,'RVC14S-JPCA-07 - CA JP (SO)','Carlos Alvarado 7177​',3,0,0],
[-33.42908,-70.55745,'RVC14S-JPCA-08 - CA 7177 (N)','Carlos Alvarado 7105​',3,0,0],
[-33.42901,-70.55787,'RVC14S-JPCA-09 - CA 7105 (N)','Carlos Alvarado 7128​',3,0,0],
[-33.42892,-70.55795,'RVC14S-JPCA-10 - CA 7128 (S)','Carlos Alvarado 7080',3,0,0],
[-33.42886,-70.55827,'RVC14S-JPCA-11 - CA 7080 (SP)','Carlos Alvarado Esquina Vichato',3,0,0],
[-33.42893,-70.55844,'RVC14S-JPCA-12 - CA V (NO)','Carlos Alvarado 6963​',3,0,0],
[-33.43025,-70.55856,'RVC14S-V-01 - V 1959','Vichato 1959',3,0,0],
[-33.42952,-70.55852,'RVC14S-V-02 - V 1925','Vichato 1925',3,0,0],
[-33.42939,-70.55839,'RVC14S-V-03 - V 1890','Vichato 1890',3,0,0],
[-33.42865,-70.55977,'RVC14S-V-04-PTZ - V 1867','Vichato 1867',3,1,0],
[-33.4287,-70.55828,'RVC14S-V-05 - V 1864','Vichato 1864',3,0,0],
[-33.4287,-70.55828,'RVC14S-V-06 - V 1864','Vichato 1864',3,0,0],
[-33.428,-70.55817,'RVC14S-V-07 - V 1792','Vichato 1792',3,0,0],
[-33.42788,-70.55826,'RVC14S-V-08 - V 1795','Vichato 1795',3,0,0],
[-33.42729,-70.55802,'RVC14S-V-09 - V 1770','Vichato 1770',3,0,0],
[-33.42725,-70.55812,'RVC14S-V-10 - V 1769','Vichato 1769',3,0,0],
[-33.42896,-70.55876,'RVC14S-V-11 - CA 6963','Carlos Alvarado 6963​',3,0,0],
[-33.42887,-70.55912,'RVC14S-V-12 - CA 6884','Carlos Alvarado 6883',3,0,0],
[-33.42887,-70.55912,'RVC14S-V-13 - CA 6884','Carlos Alvarado 6883',3,0,0],
[-33.42863,-70.55964,'RVC14S-V-14 - CA 6800','Carlos Alvarado 6800',3,0,0],
[-33.42881,-70.55981,'RVC14S-V-15 - HH & CA','Huara huara & Carlos Alvarado.',3,0,0],
[-33.42863,-70.55964,'RVC14S-V-16 - CA 6800','Carlos Alvarado 6800',3,0,0],
[-33.4269,-70.55932,'RVC14S-HH-01 - HH L','HUARA HUARA​ & Latadia',3,0,0],
[-33.42737,-70.55936,'RVC14S-HH-02 - HH 1768','HUARA HUARA​ 1768​',3,0,0],
[-33.42737,-70.55936,'RVC14S-HH-03 - HH 1768','HUARA HUARA​ 1768​',3,0,0],
[-33.42773,-70.55957,'RVC14S-HH-04 - HH CA','HUARA HUARA​ 1803​',3,0,0],
[-33.4279,-70.55962,'RVC14S-HH-05 - HH 1803','HUARA HUARA​ 1821​',3,0,0],
[-33.42871,-70.55965,'RVC14S-HH-06 - HH 1821','HUARA HUARA​ CARLOS ALVARADO',3,0,0],
[-33.42908,-70.55973,'RVC14S-HH-07 - HH 1894','HUARA HUARA​ 1894​',3,0,0],
[-33.42915,-70.55974,'RVC14S-HH-08 - HH 1886','HUARA HUARA​ 1886​',3,0,0],
[-33.42927,-70.55984,'RVC14S-HH-09 - HH 1925','HUARA HUARA​ 1925​',3,0,0],
[-33.43032,-70.55992,'RVC14S-HH-10 - HH 1970','HUARA HUARA​ 1970​',3,0,0],
[-33.43053,-70.56006,'RVC14S-HH-11 - HH 1987','HUARA HUARA​ 1987​',3,0,0],
[-33.42993,-70.55987,'RVC14S-HH-12 - HH 1947','HUARA HUARA​ 1947​',3,0,0],
[-33.43057,-70.55999,'RVC14S-HH-13 - HH 1991','HUARA HUARA​ 1991​',3,0,0],
[-33.42881,-70.55983,'RVC14S-HH-14 - HH CA','HUARA HUARA​ & Carlos Alvarado',3,0,0],
[-33.42883,-70.56039,'RVC14S-HH-15 - CA 6715','CARLOS ALVARADO​ 6715​',3,0,0],
[-33.42886,-70.56083,'RVC14S-HH-16 - CA EP','CARLOS ALVARADO​ & El Pillan​',3,0,0],
[-33.41489,-70.53327,'CA-14-PTZ - CA 964','CERRO ALEGRE 921',0,1,0],
[-33.41529,-70.53331,'CA-16 - CA 964','CERRO ALEGRE 964',6,0,0],
[-33.41524,-70.53336,'CA-15 - CA 964','CERRO ALEGRE 966',6,0,0],
[-33.39972,-70.56863,'CC-01 - CC 6160','CERRO COLORADO 6160',4,0,0],
[-33.39973,-70.56865,'CC-02 - CC 6160','CERRO COLORADO 6160',4,0,0],
[-33.39997,-70.56914,'CC-03 - CC 6130','CERRO COLORADO 6130',4,0,0],
[-33.39999,-70.56918,'CC-05 - CC 6130','CERRO COLORADO 6130',4,0,0],
[-33.40001,-70.56914,'CC-04 - CC 6130','CERRO COLORADO 6130',4,0,0],
[-33.40003,-70.56917,'CC-06 - CC 6130','CERRO COLORADO 6130',4,0,0],
[-33.40044,-70.57009,'CC-07 - CC 6110','CERRO COLORADO 6110',4,0,0],
[-33.40984,-70.55795,'PIN-01 - AI 286','ARQUITECTO ICTINOS 286',4,0,0],
[-33.40965,-70.55796,'PIN-02 - AI 273','ARQUITECTO ICTINOS 273',4,0,0],
[-33.40958,-70.55793,'PIN-03 - AI 273','ARQUITECTO ICTINOS 273',4,0,0],
[-33.40938,-70.55782,'PIN-04 - AI 245','ARQUITECTO ICTINOS 245',4,0,0],
[-33.4093,-70.55779,'PIN-05 - AI 245','ARQUITECTO ICTINOS 245',4,0,0],
[-33.40895,-70.55764,'PIN-06 - AI 225','ARQUITECTO ICTINOS 225',4,0,0],
[-33.40884,-70.55753,'PIN-07-PTZ - AI 203','ARQUITECTO ICTINOS 203',4,1,0],
[-33.40884,-70.55755,'PIN-08 - AI 203','ARQUITECTO ICTINOS 203',4,0,0],
[-33.41764,-70.57962,'LS-01 - LS 511','LA SERENA 511',4,0,0],
[-33.41764,-70.57962,'LS-02 - LS 511','LA SERENA 511',4,0,0],
[-33.41843,-70.57908,'LS-03-PTZ - LS 640','LA SERENA 640',4,1,0],
[-33.41935,-70.57837,'LS-04 - LS 841','LA SERENA 841',4,0,0],
[-33.41935,-70.57837,'LS-05 - LS 841','LA SERENA 841',4,0,0],
[-33.41525,-70.58178,'FDA-01 - FDA 218 (NORTE)','FELIX DE AMESTI 218',4,0,0],
[-33.41538,-70.58162,'FDA-02 - FDA 218','FELIX DE AMESTI 218',4,0,0],
[-33.41583,-70.58135,'FDA-03 - FDA 255','FELIX DE AMESTI 255',4,0,0],
[-33.41583,-70.58135,'FDA-04 - FDA 255','FELIX DE AMESTI 255',4,0,0],
[-33.4164,-70.58104,'FDA-05-PTZ - FDA 327','FELIZ DE AMESTI 327',4,1,0],
[-33.4164,-70.58104,'FDA-06 - FDA 327','FELIX DE AMESTI 327',4,0,0],
[-33.4164,-70.58104,'FDA-07 - FDA 327','FELIX DE AMESTI 327',4,0,0],
[-33.41704,-70.58069,'FDA-08 - FDA 403','FELIX DE AMESTI 403',4,0,0],
[-33.41711,-70.58065,'FDA-09 - FDA 432','FELIX DE AMESTI 432',4,0,0],
[-33.41738,-70.5805,'FDA-10 - FDA 451','FELIX DE AMESTI 451',4,0,0],
[-33.41761,-70.58036,'FDA-11 - FDA 477','FELIX DE AMESTI 477',4,0,0],
[-33.41762,-70.58035,'FDA-12 - FDA 462','FELIX DE AMESTI 462',4,0,0],
[-33.40989,-70.56518,'LM-01 - LM 6255','LOS MILAGROS 6255',4,0,0],
[-33.41,-70.56537,'LM-02 - LM 6255','LOS MILAGROS 6255',4,0,0],
[-33.41009,-70.56578,'LM-03 - LM 6231','LOS MILAGROS 6231',4,0,0],
[-33.41011,-70.56584,'LM-04 - LM 6231','LOS MILAGROS 6231',4,0,0],
[-33.41023,-70.56635,'LM-05 - LM 6206','LOS MILAGROS 6206',4,0,0],
[-33.41692,-70.5792,'A-01 - DI 4622','DEL INCA 4622',4,0,0],
[-33.41725,-70.57904,'A-02 - A 506','ALGECIRAS 506',4,0,0],
[-33.41774,-70.57873,'A-03 - A 567','ALGECIRAS 567',4,0,0],
[-33.41774,-70.57873,'A-04 - A 567','ALGECIRAS 567',4,0,0],
[-33.41811,-70.57846,'A-05-PTZ - A 684','ALGECIRAS 684',4,1,0],
[-33.41845,-70.57824,'A-06 - A 778','ALGECIRAS 778',4,0,0],
[-33.41845,-70.57824,'A-07 - A 778','ALGECIRAS 778',4,0,0],
[-33.4188,-70.57796,'A-08 - A 829','ALGECIRAS 829',4,0,0],
[-33.4188,-70.57796,'A-09 - A 829','ALGECIRAS 829',4,0,0],
[-33.39938,-70.5643,'NSRI-01 - NSDRI 623','NUESTRA SEÑORA DEL ROSARIO INT 623',4,0,0],
[-33.39935,-70.56424,'NSRI-02-PTZ - NSDRI 567','NUESTRA SEÑORA DEL ROSARIO INT 567',4,1,0],
[-33.39903,-70.56306,'NSRI-03 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583',4,0,0],
[-33.39902,-70.56301,'NSRI-04 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583',4,0,0],
[-33.41257,-70.56335,'LA-01 - M 6541','MONROE 6541',4,0,0],
[-33.41242,-70.56395,'LA-02 - LA 561','LOS ALMENDROS 561',4,0,0],
[-33.41216,-70.56443,'LA-03 - LA 485','LOS ALMENDROS 485',4,0,0],
[-33.41204,-70.56433,'LA-04 - LA 483','LOS ALMENDROS 483',4,0,0],
[-33.41204,-70.56433,'LA-05 - LA 483','LOS ALMENDROS 483',4,0,0],
[-33.42113,-70.56038,'MA-01 - ADC 6497 (N)','ALONSO DE CAMARGO 6497',4,0,0],
[-33.42102,-70.56059,'MA-02 - ADC 6466 (S)','ALONSO DE CAMARGO 6466',4,0,0],
[-33.42056,-70.56021,'MA-03 - MA 6520 (P)','MANUEL ALDUNATE 6520',4,0,0],
[-33.42043,-70.56034,'MA-04 - MA 6486 (O)','MANUEL ALDUNATE 6486',4,0,0],
[-33.42047,-70.56044,'MA-05 - MA 6491 (P)','MANUEL ALDUNATE 6491',4,0,0],
[-33.42036,-70.56082,'MA-06 - MA 6446 (O)','MANUEL ALDUNATE 6446',4,0,0],
[-33.42036,-70.56082,'MA-07 - MA 6446 (P)','MANUEL ALDUNATE 6446',4,0,0],
[-33.41588,-70.57635,'PEV-01 - D1 4852','DEL INCA 4852',4,0,0],
[-33.41629,-70.57612,'PEV-02 - PEV 555','PABLO EL VERONES 555',4,0,0],
[-33.41666,-70.57587,'PEV-03 - PEV 647','PABLO EL VERONES 647',4,0,0],
[-33.41694,-70.57567,'PEV-04 - PEV 696','PABLO EL VERONES 696',4,0,0],
[-33.41694,-70.57567,'PEV-05 - PEV 696','PABLO EL VERONES 696',4,0,0],
[-33.41716,-70.57549,'PEV-06-PTZ - PEV 773','PABLO EL VERONES 773',4,1,0],
[-33.41716,-70.57549,'PEV-07 - PEV 773','PABLO EL VERONES 773',4,0,0],
[-33.41725,-70.57543,'PEV-08 - PEV 782','PABLO EL VERONES 782',4,0,0],
[-33.41717,-70.5755,'PEV-09 - PEV 773','Pablo El Veronés 773',4,0,0],
[-33.41735,-70.57538,'PEV-10 - PEV 782','Pablo El Veronés 782',4,0,0],
[-33.41775,-70.57513,'PEV-11 - PEV MZ','Pablo El Veronés & Martín de Zamora',4,0,0],
[-33.41671,-70.5728,'SE-01 - SE 849 (N)','849 Sebastián Elcano',4,0,0],
[-33.41629,-70.57296,'SE-02 - SE 756 (N)','756 Sebastián Elcano',4,0,0],
[-33.41629,-70.57296,'SE-03 - SE 700 (S)','700 Sebastián Elcano',4,0,0],
[-33.4158,-70.57316,'SE-04 - SE 628 (O)','628 Sebastián Elcano',4,0,0],
[-33.41571,-70.5732,'SE-05 - SE 609 (S)','609 Sebastián Elcano',4,0,0],
[-33.41551,-70.57328,'SE-06 - SE 538 (P)','538 Sebastián Elcano',4,0,0],
[-33.41533,-70.57335,'SE-07 - SE 487 (S)','487 Sebastián Elcano',4,0,0],
[-33.41533,-70.57335,'SE-08 - SE 487 (N)','487 Sebastián Elcano',4,0,0],
[-33.41515,-70.57343,'SE-09 - SE 482 (O)','482 Sebastián Elcano',4,0,0],
[-33.41411,-70.57471,'AMC-01 - AMC ROH','ANA MARIA CARRERA & ROSA OHIGGINS',4,0,0],
[-33.41396,-70.57425,'AMC-02 - AMC 5090','ANA MARIA CARRERA 5090',4,0,0],
[-33.4139,-70.57403,'AMC-03 - AMC 5140','ANA MARIA CARRERA 5140',4,0,0],
[-33.4139,-70.57403,'AMC-04-PTZ - AMC 5140','ANA MARIA CARRERA 5140',4,1,0],
[-33.4139,-70.57403,'AMC-05 - AMC 5140','ANA MARIA CARRERA 5140',4,0,0],
[-33.41382,-70.57381,'AMC-06 - AMC 5155','ANA MARIA CARRERA 5155',4,0,0],
[-33.4137,-70.57342,'AMC-07 - AMC 5226','ANA MARIA CARRERA 5226',4,0,0],
[-33.4137,-70.57342,'AMC-08 - AMC 5226','ANA MARIA CARRERA 5226',4,0,0],
[-33.41384,-70.56333,'R-01 - R 6367','Roncesvalles 6367',4,0,0],
[-33.4139,-70.56304,'R-02 - R 6391','Roncesvalles 6391',4,0,0],
[-33.4139,-70.56304,'R-03 - R 6391','Roncesvalles 6391',4,0,0],
[-33.4139,-70.56301,'R-04 - R 6415','Roncesvalles 6415',4,0,0],
[-33.41407,-70.56232,'R-05 - R 6467','Roncesvalles 6467',4,0,0],
[-33.41407,-70.56232,'R-06 - R 6467','Roncesvalles 6467',4,0,0],
[-33.4141,-70.56216,'R-07-PTZ - R 6491','Roncesvalles 6535',4,1,0],
[-33.41414,-70.56192,'R-08 - R 6529','Roncesvalles Esquina Bello Horizonte',4,0,0],
[-33.41431,-70.56154,'R-09 - R BH','Roncesvalles 6491',4,0,0],
[-33.41902,-70.58115,'AYCDS-01 - S 626','Soria 626',4,0,0],
[-33.41902,-70.58115,'AYCDS-02 - S 626','Soria 626',4,0,0],
[-33.4186,-70.58062,'AYCDS-03 - A CDS','Albacete Esquina Cruz del Sur',4,0,0],
[-33.41901,-70.58034,'AYCDS-04 - CDS 706','Cruz del Sur 706',4,0,0],
[-33.41897,-70.58037,'AYCDS-05 - CDS 706','Cruz del Sur 706',4,0,0],
[-33.41927,-70.58013,'AYCDS-06-PTZ - CDS 740','Cruz del Sur 740',4,1,0],
[-33.4195,-70.57996,'AYCDS-07 - CDS 788','Cruz del Sur 788',4,0,0],
[-33.41968,-70.57984,'AYCDS-08 - C 4515','Cuenca 4515',4,0,0],
[-33.40306,-70.56753,'VSL-01 - CP 6560','Cerro el Plomo 6560',4,0,0],
[-33.40306,-70.56753,'VSL-02 - CP 6560','Cerro el Plomo 6560',4,0,0],
[-33.4027,-70.56668,'VSL-03 - CP 6578','Cerro el Plomo 6578',4,0,0],
[-33.40304,-70.56749,'VSL-04 - CP 6596','Cerro el Plomo 6596',4,0,0],
[-33.40255,-70.56632,'VSL-05-PTZ - CP E','Cerro el Plomo Esquina Estocolmo',4,1,0],
[-33.40164,-70.56683,'VSL-06 - E 659','Estocolmo 659',4,0,0],
[-33.40168,-70.56798,'VSL-07 - PR 6583','Presidente Riesco 6583',4,0,0],
[-33.41194,-70.56367,'GDLR-01 - LA 533','LOS ALMENDROS 533',4,0,0],
[-33.41194,-70.56367,'GDLR-02-PTZ - LA 533','LOS ALMENDROS 533',4,1,0],
[-33.41189,-70.56361,'GDLR-03 - GDLR LA','GONZALO DE LOS RIOS & LOS ALMENDROS',4,0,0],
[-33.4118,-70.56355,'GDLR-04 - GDLR 5627','GONZALO DE LOS RIOS 5627',4,0,0],
[-33.41162,-70.5634,'GDLR-05 - GDLR 6524','GONZALO DE LOS RIOS 6524',4,0,0],
[-33.41154,-70.56333,'GDLR-06 - GDLR 6523','GONZALO DE LOS RIOS 6523',4,0,0],
[-33.41154,-70.56333,'GDLR-07 - GDLR 6523','GONZALO DE LOS RIOS 6523',4,0,0],
[-33.41146,-70.56327,'GDLR-08 - GDLR 6511','GONZALO DE LOS RIOS 6511',4,0,0],
[-33.41121,-70.56311,'GDLR-09 - GDLR 6515','GONZALO DE LOS RIOS 6515',4,0,0],
[-33.4109,-70.56287,'GDLR-10 - GDLR IV C','GONZALO DE LOS RIOS & IV CENTENARIO',4,0,0],
[-33.41676,-70.57877,'SP-01 - SP DI','San Pascual & Del Inca',4,0,0],
[-33.41711,-70.57845,'SP-02 - SP 540','San Pascual 540',4,0,0],
[-33.41741,-70.57824,'SP-03 - SP 601','San Pascual 601',4,0,0],
[-33.41767,-70.57806,'SP-04 - SP 648','San Pascual 660',4,0,0],
[-33.41776,-70.578,'SP-05 - SP 687','San Pascual 687',4,0,0],
[-33.41793,-70.57788,'SP-06 - SP 736','San Pascual 725',4,0,0],
[-33.41802,-70.57781,'SP-07 - SP 750','San Pascual 750',4,0,0],
[-33.41821,-70.57767,'SP-08 - SP 796','San Pascual 796',4,0,0],
[-33.41831,-70.5776,'SP-09 - SP 851','San Pascual 851',4,0,0],
[-33.41858,-70.57738,'SP-10 - SP 860','San Pascual 877',4,0,0],
[-33.41867,-70.5772,'SP-11-PTZ - SP MDZ','San Pascual & Martín de Zamora',4,1,0],
[-33.41705,-70.57852,'SP-12 - SP 541','San Pascual 540',4,0,0],
[-33.41803,-70.58016,'FDA2-01 - FDA 539','FELIX DE AMESTI 539',4,0,0],
[-33.41839,-70.57994,'FDA2-02 - FDA 594','FELIX DE AMESTI 594',4,0,0],
[-33.41835,-70.57995,'FDA2-03 - FDA 594','FELIX DE AMESTI 594',4,0,0],
[-33.41873,-70.57972,'FDA2-04 - FDA 700','FELIX DE AMESTI 700',4,0,0],
[-33.4192,-70.57938,'FDA2-05 - FDA 722','FELIX DE AMESTI 722',4,0,0],
[-33.4192,-70.57938,'FDA2-06 - FDA 722','FELIX DE AMESTI 722',4,0,0],
[-33.41933,-70.57946,'FDA2-07 - C 4542','CUENCA 4542',4,0,0],
[-33.4193,-70.57931,'FDA2-08-PTZ - FDA C','FELIX DE AMESTI & CUENCA',4,1,0],
[-33.41957,-70.5791,'FDA2-09 - FDA 776','FELIX DE AMESTI 776',4,0,0],
[-33.41957,-70.5791,'FDA2-10 - FDA 776','FELIX DE AMESTI 776',4,0,0],
[-33.4199,-70.57882,'FDA2-11 - FDA 828','FELIX DE AMESTI 828',4,0,0],
[-33.4199,-70.57882,'FDA2-12 - FDA 828','FELIX DE AMESTI 828',4,0,0],
[-33.42025,-70.57851,'FDA2-13 - FDA MDZ','FELIX DE AMESTI & MARTIN DE ZAMORA',4,0,0],
[-33.40761,-70.55751,'RDA-01 - A 6934','Apoquindo 6960',4,0,0],
[-33.40759,-70.55762,'RDA-02 - A 6934','Apoquindo 6954',4,0,0],
[-33.40757,-70.55784,'RDA-03-PTZ - A 6934','Apoquindo 6934',4,1,0],
[-33.41598,-70.55866,'DH-01 - LP 6828','Los Pozos 6828',4,0,0],
[-33.41602,-70.55839,'DH-02 - LP 6828','Los Pozos 6828',4,0,0],
[-33.41602,-70.55839,'DH-03 - LP 6828','Los Pozos 6828',4,0,0],
[-33.41615,-70.57019,'PMZR-01 - MDZ LR','Martin de Zamora & La Reconquista',4,0,0],
[-33.41651,-70.57005,'PMZR-02 - MDZ 5485','Pasaje Martin de Zamora 5485',4,0,0],
[-33.41651,-70.57005,'PMZR-03 - MDZ 5485','Pasaje Martin de Zamora 5485',4,0,0],
[-33.41658,-70.56996,'PMZR-04-PTZ - MDZ 5511','Pasaje Martin de Zamora 5511',4,1,0],
[-33.4167,-70.56992,'PMZR-05 - MDZ 5509','Pasaje Martin de Zamora 5509',4,0,0],
[-33.41689,-70.56985,'PMZR-06 - MDZ 5505','Pasaje Martin de Zamora 5505',4,0,0],
[-33.40219,-70.55252,'PE-01 - PE LDM','Padre Errazuriz & Lorenzo de Medicis',4,0,0],
[-33.40274,-70.5527,'PE-02 - PE 7583','Padre Errazuriz 7583',4,0,0],
[-33.40314,-70.55291,'PE-05 - PE 7541','Padre Errazuriz 7541',4,0,0],
[-33.403,-70.55294,'PE-04-PTZ - PE 7514','Padre Errazuriz 7514',4,1,0],
[-33.40265,-70.55276,'PE-03 - PE 7550','Padre Errazuriz 7550',4,0,0],
[-33.40318,-70.55303,'PE-06 - PE 7478','Padre Errazuriz 7478',4,0,0],
[-33.40322,-70.55295,'PE-07 - PE 7483','Padre Errazuriz 7483',4,0,0],
[-33.40342,-70.55305,'PE-08 - PE 7451','Padre Errazuriz 7451',4,0,0],
[-33.40351,-70.5531,'PE-09 - PE 7442','Padre Errazuriz 7442',4,0,0],
[-33.40358,-70.55314,'PE-10 - PE 7433','Padre Errazuriz 7433',4,0,0],
[-33.40371,-70.55323,'PE-11 - PE 7412','Padre Errazuriz 7412',4,0,0],
[-33.41411,-70.55264,'MM-01 - MM TM','MERCEDES MARÍN & TOMÁS MORO',4,0,0],
[-33.41407,-70.55258,'MM-02 - MM TM','MERCEDES MARÍN & TOMÁS MORO',4,0,0],
[-33.414,-70.55336,'MM-03 - MM 7321','MERCEDES MARÍN 7321',4,0,0],
[-33.414,-70.55336,'MM-04 - MM 7321','MERCEDES MARÍN 7321',4,0,0],
[-33.41395,-70.55366,'MM-05 - MM 7249','MERCEDES MARÍN 7249',4,0,0],
[-33.41388,-70.55388,'MM-06-PTZ - MM 7186','MERCEDES MARÍN 7186',4,1,0],
[-33.41367,-70.55423,'MM-07 - MM 7075','MERCEDES MARÍN 7075',4,0,0],
[-33.41367,-70.55423,'MM-08 - MM 7075','MERCEDES MARÍN 7075',4,0,0],
[-33.41363,-70.55454,'MM-09 - MM 7031','MERCEDES MARÍN 7031',4,0,0],
[-33.41358,-70.55483,'MM-10 - MN MM','MERCEDES MARÍN & MANUEL NOVOA',4,0,0],
[-33.41368,-70.55485,'MM-11 - MN 620','MANUEL NOVOA 620',4,0,0],
[-33.4183,-70.5767,'NB-01 - MDZ & NC','MARTIN DE ZAMORA & NIBALDO CORREA',4,0,0],
[-33.41787,-70.577,'NB-02 - NC 808','NIBALDO CORREA 808',4,0,0],
[-33.41779,-70.57708,'NC-04 - NC 763','NIBALDO CORREA 763',4,0,0],
[-33.41747,-70.57728,'NC-05 - NC 710','NIBALDO CORREA 710',4,0,0],
[-33.41747,-70.57728,'NC-06 - NC 710','NIBALDO CORREA 710',4,0,0],
[-33.41721,-70.57745,'NC-07 - NC 640','NIBALDO CORREA 640',4,0,0],
[-33.41721,-70.57745,'NC-08 - NC 640','NIBALDO CORREA 640',4,0,0],
[-33.41689,-70.5777,'NC-09 - NC 547','NIBALDO CORREA 547',4,0,0],
[-33.41689,-70.5777,'NC-10 - NC 547','NIBALDO CORREA 547',4,0,0],
[-33.41642,-70.578,'NC-11-PTZ - DI & NC','DEL INCA & NIBALDO CORREA',4,1,0],
[-33.4125,-70.55458,'VSA-01 –VS 7311','VICTOR SOTTA 7311',4,0,0],
[-33.4125,-70.55458,'VSA-02 –VS 7311','VICTOR SOTTA 7311',4,0,0],
[-33.41234,-70.55541,'VSA-03 –VS 7230','VICTOR SOTTA 7230',4,0,0],
[-33.41234,-70.55541,'VSA-04 –VS 7230','VICTOR SOTTA 7230',4,0,0],
[-33.41234,-70.55541,'VSA-05 –VS 7230','VICTOR SOTTA 7230',4,0,0],
[-33.41229,-70.5559,'VSA-06 –VS 7165','VICTOR SOTTA 7165',4,0,0],
[-33.41229,-70.5559,'VSA-07 –VS 7165','VICTOR SOTTA 7165',4,0,0],
[-33.41222,-70.55617,'VSA-08–PTZ - VS 7131','VICTOR SOTTA 7131',4,1,0],
[-33.41217,-70.55668,'VSA-09 –VS 7097','VICTOR SOTTA 7097',4,0,0],
[-33.41217,-70.55668,'VSA-10 –VS 7097','VICTOR SOTTA 7097',4,0,0],
[-33.41209,-70.55703,'VSA-11 –VS 7068','VICTOR SOTTA 7068',4,0,0],
[-33.41208,-70.5571,'VSA-12 –VS 7060','VICTOR SOTTA 7060',4,0,0],
[-33.41196,-70.55786,'VSA-13 –VS HDM','VICTOR SOTTA & HERNANDO DE MAGALLANES',4,0,0],
[-33.41196,-70.55786,'VSA-14 – VS HDM','VICTOR SOTTA & HERNANDO DE MAGALLANES',4,0,0],
[-33.4052,-70.56873,'CMN-01 - MN LM','MANQUEHUE NORTE & LOS MILITARES',4,0,0],
[-33.40458,-70.56896,'CMN-02 - MN 444','MANQUEHUE NORTE 444',4,0,0],
[-33.40449,-70.56899,'CMN-03-PTZ - MN 444','MANQUEHUE NORTE 444',4,1,0],
[-33.40371,-70.56924,'CMN-04 - MN CEP','MANQUEHUE NORTE & CERRO EL PLOMO',4,0,0],
[-33.40416,-70.57019,'CMN-05 - CEP 6000','CERRO EL PLOMO 6000',4,0,0],
[-33.39748,-70.56752,'CEA-01 - B 800','BRASILIA 800',4,0,0],
[-33.39781,-70.56687,'CEA-02 - PTZ - B 800','BRASILIA 800',4,1,0],
[-33.39781,-70.56687,'CEA-03 - B 800','BRASILIA 800',4,0,0],
[-33.39834,-70.56723,'CEA-04 - CC NSR','NUESTRA SRA. DEL ROSARIO & CERRO COLORADO.',4,0,0],
[-33.39802,-70.56792,'CEA-05 - NSR 848','NUESTRA SRA. DEL ROSARIO 848',4,0,0],
[-33.3981,-70.56774,'CEA-06 - NSR 848','NUESTRA SRA. DEL ROSARIO 848',4,0,0],
[-33.41106,-70.55973,'CVMM-01 - CV VF','CONSTANCIO VIGIL & VIRGILIO FIGUEROA',4,0,0],
[-33.41045,-70.55924,'CVMM-02 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,0,0],
[-33.41045,-70.55924,'CVMM-03 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,0,0],
[-33.41045,-70.55924,'CVMM-04 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,0,0],
[-33.41033,-70.55975,'CVMM-05 - MM 6827','MADRE MAZARELLO 6827',4,0,0],
[-33.41018,-70.56056,'CVMM-06 - MM 6663','MADRE MAZARELLO 6663',4,0,0],
[-33.41013,-70.56061,'CVMM-07 - MM 6666','MADRE MAZARELLO 6666',4,0,0],
[-33.40997,-70.55899,'CVMM-08 - CV 313','CONSTANCIO VIGIL 313',4,0,0],
[-33.40983,-70.55892,'CVMM-09 - CV EO','CONSTANCIO VIGIL & ESTEBAN DELL ORTO',4,0,0],
[-33.40983,-70.55892,'CVMM-10-PTZ - CV EO','CONSTANCIO VIGIL & ESTEBAN DELL ORTO',4,1,0],
[-33.39359,-70.55028,'D-01 - D RR','Dakar 8632',4,0,0],
[-33.39342,-70.54984,'D-02 - D 8632','Dakar 8644',4,0,0],
[-33.39344,-70.54971,'D-03 - 8644','Dakar 8645',4,0,0],
[-33.39344,-70.54971,'D-04 - 8645','Dakar 8631',4,0,0],
[-33.3936,-70.54964,'D-05 - D 8631','Dakar 8635',4,0,0],
[-33.39365,-70.54963,'D-06 - D 8635','Dakar 8644',4,0,0],
[-33.39337,-70.54966,'D-07-PTZ - D 8644','Dakar 8677',4,1,0],
[-33.39324,-70.54932,'D-08 - D 8677','Dakar 8683',4,0,0],
[-33.39328,-70.5493,'D-09 - D 8683','Dakar & Costa De Marfil',4,0,0],
[-33.39312,-70.54887,'D-10 - D CDM','Camino El Alba & Camino De Las Vertientes',4,0,0],
[-33.4166,-70.57131,'LZ-01 - LZ 297 (N)','Luis Zeggers 806',4,0,0],
[-33.41616,-70.57147,'LZ-02 - LZ 806 (N)','Luis Zeggers 784',4,0,0],
[-33.41594,-70.57162,'LZ-03 - LZ 784 (O)','Luis Zeggers 707',4,0,0],
[-33.41563,-70.57164,'LZ-04 - LZ 707 (N)','Luis Zeggers 707',4,0,0],
[-33.41563,-70.57164,'LZ-05 - LZ 707 (S)','Luis Zeggers 655',4,0,0],
[-33.4156,-70.57171,'LZ-06-PTZ - LZ 655','Luis Zeggers 619',4,1,0],
[-33.41528,-70.57181,'LZ-07 - LZ 619 (O)','Luis Zeggers 619',4,0,0],
[-33.41528,-70.57181,'LZ-08 - LZ 619 (N)','Luis Zeggers 619',4,0,0],
[-33.41536,-70.57179,'LZ-09 - LZ 619 (S)','Luis Zeggers 495',4,0,0],
[-33.41473,-70.5719,'LZ-10 - LZ 495 (S)','Luis Zeggers & Del Inca',4,0,0],
[-33.41452,-70.57206,'LZ-11 - LZ & DEL INCA (S)','Pinares 636',4,0,0],
[-33.3946,-70.55318,'BP1-01 - P 636 (P)','Pinares 636',4,0,0],
[-33.3946,-70.55318,'BP1-02 - P 636 (O)','Pinares 540',4,0,0],
[-33.39464,-70.55266,'BP1-03 - P 540 (P)','Pinares 540',4,0,0],
[-33.39464,-70.55266,'BP1-04 - P 540 (O)','Pinares 365',4,0,0],
[-33.39487,-70.55188,'BP1-05 - P 365 (P)','Pinares 358',4,0,0],
[-33.39488,-70.55197,'BP1-06 - P 358 (O)','Pinares 200',4,0,0],
[-33.39515,-70.55115,'BP1-07 - P 200 (P)','Pinares 200',4,0,0],
[-33.39515,-70.55115,'BP1-08 - P 200 (O)','Pinares 150',4,0,0],
[-33.39537,-70.55069,'BP1-09 - P 150 (P)','Pinares 138',4,0,0],
[-33.39545,-70.55065,'BP1-10-PTZ - P 138','Pinares & Las Verbenas',4,1,0],
[-33.39563,-70.55031,'BP1-11 - P & LV (P)','Pinares & Bombay',4,0,0],
[-33.39537,-70.55068,'BP2-01 - P B (N)','Bombay 8562',4,0,0],
[-33.39487,-70.55025,'BP2-02 - B 8562 (S)','Bombay 8562',4,0,0],
[-33.39487,-70.55025,'BP2-03 - B 8562 (N)','Bombay 8586',4,0,0],
[-33.39465,-70.54992,'BP2-04 - B 8586 (N)','Bombay & Rosario Rosales',4,0,0],
[-33.3945,-70.54957,'BP2-05 - B RR (S)','Bombay & Rosario Rosales',4,0,0],
[-33.3945,-70.54957,'BP2-06-PTZ - B RR','Bombay 8647',4,1,0],
[-33.39427,-70.54922,'BP2-07 - B 8647 (S)','Bombay 8647',4,0,0],
[-33.39427,-70.54922,'BP2-08 - B 8647 (N)','Bombay 8671',4,0,0],
[-33.3941,-70.5488,'BP2-09 - B 8671 (NP)','Bombay 8731',4,0,0],
[-33.3939,-70.54826,'BP2-10 - B 8731 (P)','Bombay 8731',4,0,0],
[-33.39391,-70.54826,'BP2-11 - B 8731 (S)','Bombay 8825',4,0,0],
[-33.39363,-70.54747,'BP2-12 - B 8825 (N)','Bombay 8825',4,0,0],
[-33.39363,-70.54747,'BP2-13 - B 8825 (S)','Los Almendros 440',4,0,0],
[-33.41141,-70.56452,'PLA-01 - LA 440 (S)','Los Almendros 478',4,0,0],
[-33.41159,-70.56424,'PLA-02 - LA 478 (S)','Pasaje Los Almendros 469',4,0,0],
[-33.41158,-70.56446,'PLA-03 - PLA 469 (N)','Pasaje Los Almendros 465',4,0,0],
[-33.41174,-70.5646,'PLA-04-PTZ - PLA 465','Pasaje Los Almendros 459',4,1,0],
[-33.41187,-70.56471,'PLA-05 - PLA 459 (N)','Pasaje Los Almendros 459',4,0,0],
[-33.41187,-70.56471,'PLA-06 - PLA 459 (S)','Pasaje Los Almendros 451',4,0,0],
[-33.41197,-70.56491,'PLA-07 - PLA 451 (O)','La Reconquista 762',4,0,0],
[-33.41529,-70.5704,'MDZLR-01 - LR 762','La Reconquista 816',4,0,0],
[-33.41559,-70.57032,'MDZLR-02 - LR 816','La Reconquista 723',4,0,0],
[-33.41558,-70.57045,'MDZLR-03 - LR 723','La Reconquista 723',4,0,0],
[-33.41558,-70.57045,'MDZLR-04 - LR 723','La Reconquista 838',4,0,0],
[-33.41586,-70.57026,'MDZLR-05 - LR 838','La Reconquista 838',4,0,0],
[-33.41586,-70.57026,'MDZLR-06 - LR 838','Martín De Zamora 5471',4,0,0],
[-33.41619,-70.57023,'MDZLR-07 - MDZ 5471','Martín De Zamora 5471',4,0,0],
[-33.41624,-70.57019,'MDZLR-08-PTZ - MDZ 5471','Martín De Zamora 5415',4,1,0],
[-33.41637,-70.57061,'MDZLR-09 - MDZ 5415','Yolanda & Vital Apoquindo',4,0,0],
[-33.3939,-70.54824,'CCQ-01 - B 8745','Bombay 8745',5,0,0],
[-33.39356,-70.54845,'CCQ-02 - CDM 223','Costa de Marfil 223',5,0,0],
[-33.39357,-70.54853,'CCQ-03 - CDM 238','Costa de Marfil 238',5,0,0],
[-33.39347,-70.54859,'CCQ-04 - CDM 250','Costa de Marfil 250',5,0,0],
[-33.39342,-70.54861,'CCQ-05 - CDM 250','Costa de Marfil 250',5,0,0],
[-33.39311,-70.54877,'CCQ-06 - CDM D','Costa de Marfil & Dakar',5,0,0],
[-33.39313,-70.54878,'CCQ-07-PTZ - CDM D','Costa de Marfil & Dakar',5,1,0],
[-33.39292,-70.54887,'CCQ-08 - CDM 282','Costa de Marfil 282',5,0,0],
[-33.3926,-70.54901,'CCQ-09 - M 8680','Mardoñal 8680',5,0,0],
[-33.39284,-70.54816,'CCQ-10 - D 8826','Dakar 8826',5,0,0],
[-33.39286,-70.54811,'CCQ-11 - D 8826','Dakar 8826',5,0,0],
[-33.39268,-70.54775,'CCQ-12 - D 8876','Dakar 8876',5,0,0],
[-33.39262,-70.54765,'CCQ-13 - T D','Trinidad & Dakar',5,0,0],
[-33.39304,-70.54735,'CCQ-14 - T 239','Trinidad 239',5,0,0],
[-33.40788,-70.54511,'001 APOQUINDO - EL ALBA / PTZ','Apoquindo & Camino el Alba',6,1,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / PTZ','Alejandro Fleming & Vital Apoquindo',6,1,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / FIJA 1','Alejandro Fleming & Vital Apoquindo',6,3,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / FIJA 2','Alejandro Fleming & Vital Apoquindo',6,3,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / PARLANTE','Alejandro Fleming & Vital Apoquindo',6,6,1],
[-33.41249,-70.53825,'003 RIO GUADIANA - DIAGUITAS / PTZ','Diaguitas & Rio Guadiana',6,1,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / PTZ','Tomás Moro & IV Centenario',6,1,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 1','Tomás Moro & IV Centenario',6,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 2','Tomás Moro & IV Centenario',6,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 3','Tomás Moro & IV Centenario',6,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 4','Tomás Moro & IV Centenario',6,3,1],
[-33.40919,-70.56828,'005 APUMANQUE / SOS','Apoquindo & Manquehue Sur',6,5,1],
[-33.40919,-70.56828,'005 APUMANQUE / PTZ','Apoquindo & Manquehue Sur',6,1,1],
[-33.40919,-70.56828,'005 APUMANQUE / PTZ 2','Apoquindo & Manquehue Sur',6,1,1],
[-33.40919,-70.56828,'005 APUMANQUE / LPR','Apoquindo & Manquehue Sur',6,2,1],
[-33.40919,-70.56828,'005 APUMANQUE / PARLANTE','Apoquindo & Manquehue Sur',6,6,1],
[-33.39404,-70.54556,'006 PADRE HURTADO - LAS CONDES / PTZ','Las Condes & Padre Hurtado Norte',6,1,1],
[-33.39404,-70.54556,'006 PADRE HURTADO - LAS CONDES / FIJA','Las Condes & Padre Hurtado Norte',6,3,1],
[-33.42379,-70.53316,'007 PUNITAQUI - FLEMING / PTZ','Alejandro Fleming & Punitaqui',6,1,1],
[-33.40147,-70.56806,'008 CARRO MOVIL / PTZ','Carro Móvil',6,1,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / PTZ','Apoquindo & Las Condes',6,1,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 1','Apoquindo & Las Condes',6,3,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 2','Apoquindo & Las Condes',6,3,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 3','Apoquindo & Las Condes',6,3,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / PTZ','Tomás Moro & Apoquindo',6,1,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / FIJA 1','Tomás Moro & Apoquindo',6,3,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / FIJA 2','Tomás Moro & Apoquindo',6,3,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / PARLANTE','Tomás Moro & Apoquindo',6,6,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / PTZ','Padre Hurtado Central & Camino el Alba',6,1,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / FIJA 1','Padre Hurtado Central & Camino el Alba',6,3,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / FIJA 2','Padre Hurtado Central & Camino el Alba',6,3,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / PTZ','Francisco Bilbao & Tomás Moro',6,1,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / FIJA 1','Francisco Bilbao & Tomás Moro',6,3,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / FIJA 2','Francisco Bilbao & Tomás Moro',6,3,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / LPR 1','Francisco Bilbao & Tomás Moro',6,2,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / LPR 2','Francisco Bilbao & Tomás Moro',6,2,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / PTZ','Las Condes & Estoril',6,1,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / FIJA 1','Las Condes & Estoril',6,3,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / FIJA 2','Las Condes & Estoril',6,3,1],
[-33.39546,-70.50943,'014 SAN CARLOS DE APOQUINDO - LAS FLORES / PTZ','San Carlos de Apoquindo & Camino las Flores',6,1,1],
[-33.41477,-70.56533,'015 MANQUEHUE - MARTIN DE ZAMORA / PTZ','Manquehue Sur & Martín de Zamora',6,1,1],
[-33.42307,-70.55364,'016 TOMAS MORO - FLORENCIO BARRIOS / PTZ','Tomás Moro & Florencio Barrios',6,1,1],
[-33.43098,-70.56509,'017 MANQUEHUE - BILBAO / PTZ','Manquehue Sur & Francisco Bilbao',6,1,1],
[-33.4161,-70.53383,'018 COLON / PAUL HARRIS / PTZ','Av. Cristobal Colón & Paul Harris',6,1,1],
[-33.40538,-70.52569,'019 ARTURO MATTE - VISTA HERMOSA / PTZ','Arturo Matte Larrain & Colina Vista Hermosa',6,1,1],
[-33.40538,-70.52569,'019 ARTURO MATTE - VISTA HERMOSA / LPR','Arturo Matte Larrain & Colina Vista Hermosa',6,2,1],
[-33.40368,-70.52767,'020 VISTA HERMOSA 1890 / LPR','Colina Vista Hermosa 1890',6,2,1],
[-33.40368,-70.52767,'020 VISTA HERMOSA 1890 / PTZ','Colina Vista Hermosa 1890',6,1,1],
[-33.40825,-70.52384,'021 VISTA HERMOSA - QUEBRADA HONDA / LPR','Colina Vista Hermosa 2560',6,2,1],
[-33.40825,-70.52384,'021 VISTA HERMOSA - QUEBRADA HONDA / PTZ','Colina Vista Hermosa 2560',6,1,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / PTZ','Loma Larga & Alacalufes',6,1,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / SOS','Loma Larga & Alacalufes',6,5,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / PARLANTE','Loma Larga & Alacalufes',6,6,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / PTZ','Mapuches & Islas Guaitecas',6,1,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / SOS','Mapuches & Islas Guaitecas',6,5,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / PARLANTE','Mapuches & Islas Guaitecas',6,6,1],
[-33.41365,-70.53636,'024 CESFAM - LOMA LARGA / FIJA','Loma Larga & Nevados de Piuquenes',6,3,1],
[-33.41365,-70.53636,'024 CESFAM - LOMA LARGA / PTZ','Loma Larga & Nevados de Piuquenes',6,1,1],
[-33.40825,-70.5665,'025 APOQUINDO - ALONSO DE CORDOVA / PTZ','Apoquindo & Alonso de Cordova',6,1,1],
[-33.41641,-70.59412,'026 APOQUINDO - ENRIQUE FOSTER / PTZ','Apoquindo & Enrique Foster Sur',6,1,1],
[-33.41641,-70.59412,'026 APOQUINDO - ENRIQUE FOSTER / SOS','Apoquindo & Enrique Foster Sur',6,5,1],
[-33.41641,-70.59412,'RF 03 FOSTER B / PTZ','Enrique Foster & Apoquindo Norte',6,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / PTZ','Apoquindo & General Barceló',6,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / SOS','Apoquindo & General Barceló',6,5,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR /FIJA 1','Apoquindo & General Barceló',6,3,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR /FIJA 2','Apoquindo & General Barceló',6,3,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / PARLANTE','Apoquindo & General Barceló',6,6,1],
[-33.41343,-70.58272,'RF 05 ESCUELA MILITAR A / PTZ','Apoquindo & General Barceló',6,1,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / PTZ','Apoquindo & Gertrudis Echeñique',6,1,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / SOS','Apoquindo & Gertrudis Echeñique',6,5,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 1','Apoquindo & Gertrudis Echeñique',6,3,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 2','Apoquindo & Gertrudis Echeñique',6,3,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / PARLANTE','Apoquindo & Gertrudis Echeñique',6,6,1],
[-33.40801,-70.55562,'029 APOQUINDO - HERNANDO DE MAGALLANES / PTZ','Apoquindo & Hernando de Magallanes',6,1,1],
[-33.41124,-70.57596,'030 APOQUINDO - LA GLORIA / PTZ','Apoquindo & La Gloria',6,1,1],
[-33.39071,-70.52578,'031 ESTORIL - LAVANDULAS / PTZ','Camino de las Lavandulas & Estoril',6,1,1],
[-33.39071,-70.52578,'031 ESTORIL - LAVANDULAS / LPR','Camino de las Lavandulas & Estoril',6,2,1],
[-33.39417,-70.53093,'032 LAS FLORES - CAMINO LAS FLORES / LPR','Camino del Algarrobo & Camino las Flores',6,2,1],
[-33.39417,-70.53093,'032 LAS FLORES - FRAY PEDRO / LPR','Camino del Algarrobo & Fray Pedro Subercaseaux',6,2,1],
[-33.39417,-70.53093,'032 ROTONDA LAS FLORES / PTZ','Camino del Algarrobo & Fray Pedro Subercaseaux',6,1,1],
[-33.40127,-70.52604,'033 EL ALBA - PIEDRA ROJA / PTZ','Camino el Alba & Camino Piedra Roja',6,1,1],
[-33.40501,-70.53823,'034 EL ALBA - PAUL HARRIS / PTZ','Camino el Alba & Paul Harris',6,1,1],
[-33.40501,-70.53823,'034 EL ALBA - PAUL HARRIS / LPR','Camino el Alba & Paul Harris',6,2,1],
[-33.38614,-70.52113,'035 CHARLES HAMILTON - LA FUENTE / PTZ','Charles Hamilton & Camino La Fuente',6,1,1],
[-33.38614,-70.52113,'035 CHARLES HAMILTON - LA FUENTE / LPR','Charles Hamilton & Camino La Fuente',6,2,1],
[-33.38115,-70.51227,'036 CHARLES HAMILTON - SAN FRANCISCO / PTZ','Charles Hamilton & San Francisco de Asis',6,1,1],
[-33.38115,-70.51227,'036 CHARLES HAMILTON - SAN FRANCISCO / LPR','Charles Hamilton & San Francisco de Asis',6,2,1],
[-33.41377,-70.52982,'037 CARLOS PEÑA - VITAL APOQUINDO / PTZ','Vital Apoquindo & Carlos Peña Otaegui',6,1,1],
[-33.41366,-70.52985,'037 CARLOS PEÑA - VITAL APOQUINDO / LPR','Vital Apoquindo & Carlos Peña Otaegui',6,2,1],
[-33.41255,-70.52896,'038 COLINA MIRAVALLE - PEUMO / PTZ','Colina Miravalle & Colina del Peumo',6,1,1],
[-33.41255,-70.52896,'038 COLINA MIRAVALLE - PEUMO / LPR','Colina Miravalle & Colina del Peumo',6,2,1],
[-33.4059,-70.53319,'039 VITAL APOQUINDO - BLANCHE / LPR','Vital Apoquindo & General Blanche',6,2,1],
[-33.4059,-70.53319,'039 VITAL APOQUINDO - BLANCHE / PTZ','Vital Apoquindo & General Blanche',6,1,1],
[-33.38582,-70.53133,'040 ESTORIL - PAUL HARRIS / PTZ','Paul Harris & Estoril',6,1,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / PTZ','Av. Cristobal Colón & Manquehue Sur',6,1,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 1','Av. Cristobal Colón & Manquehue Sur',6,3,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 2','Av. Cristobal Colón & Manquehue Sur',6,3,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 3','Av. Cristobal Colón & Manquehue Sur',6,3,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / LPR','Manquehue Norte & Presidente Riesco',6,2,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / PTZ','Manquehue Norte & Presidente Riesco',6,1,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / FIJA 1','Manquehue Norte & Presidente Riesco',6,3,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / FIJA 2','Manquehue Norte & Presidente Riesco',6,3,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / PTZ','Kennedy Lateral & Nuestra Señora del Rosario',6,1,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / LPR','Kennedy Lateral & Nuestra Señora del Rosario',6,2,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / FIJA','Kennedy Lateral & Nuestra Señora del Rosario',6,3,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / LPR','San Crescente & Pdte. Errazuriz',6,2,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / PTZ','San Crescente & Pdte. Errazuriz',6,1,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / SOS','San Crescente & Pdte. Errazuriz',6,5,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / PTZ','Apoquindo & El Bosque Norte',6,1,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / SOS','Apoquindo & El Bosque Norte',6,5,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 1','Apoquindo & El Bosque Norte',6,3,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 2','Apoquindo & El Bosque Norte',6,3,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 3','Apoquindo & El Bosque Norte',6,3,1],
[-33.41755,-70.59989,'RF 01 EL BOSQUE A / PTZ','Apoquindo & El Bosque Norte',6,1,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / PTZ','Skate Padre Hurtado',6,1,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / SOS','Skate Padre Hurtado',6,5,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / PARLANTE','Skate Padre Hurtado',6,6,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / PTZ','Cerro Tololo & Cerro Negro',6,1,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / SOS','Cerro Tololo & Cerro Negro',6,5,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / PARLANTE','Cerro Tololo & Cerro Negro',6,6,1],
[-33.42248,-70.5318,'051 PUNITAQUI - PICHIDANGUI / PTZ','Punitaqui & Pichidangui',6,1,1],
[-33.42511,-70.55172,'052 FLEMING - CAÑUMANQUI / PTZ','Alejandro Fleming & Cañumanqui',6,1,1],
[-33.41472,-70.5859,'053 APOQUINDO - ASTURIAS / PTZ','Apoquindo & Asturias',6,1,1],
[-33.41688,-70.59745,'054 APOQUINDO - AUGUSTO LEGUIA / SOS','Apoquindo & Augusto Leguía',6,5,1],
[-33.41688,-70.59745,'054 APOQUINDO - AUGUSTO LEGUIA / PTZ','Apoquindo & Augusto Leguía',6,1,1],
[-33.41688,-70.59745,'054 APOQUINDO - AUGUSTO LEGUIA / FIJA 1','Apoquindo & Augusto Leguía',6,3,1],
[-33.41688,-70.59745,'054 APOQUINDO - AUGUSTO LEGUIA / FIJA 2','Apoquindo & Augusto Leguía',6,3,1],
[-33.4152,-70.58933,'055 APOQUINDO - LAS TORCAZAS / SOS','Apoquindo & Las Torcazas',6,5,1],
[-33.4152,-70.58933,'055 APOQUINDO - LAS TORCAZAS / PTZ','Apoquindo & Las Torcazas',6,1,1],
[-33.41677,-70.59579,'056 APOQUINDO - SAN CRESCENTE / PTZ','Apoquindo & San Crescente',6,1,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / SOS','Av Apoquindo & Rosario Norte',6,5,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / PTZ','Av Apoquindo & Rosario Norte',6,1,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / FIJA 1','Av Apoquindo & Rosario Norte',6,3,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / FIJA 2','Av Apoquindo & Rosario Norte',6,3,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / FIJA 3','Av Apoquindo & Rosario Norte',6,3,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / FIJA 4','Av Apoquindo & Rosario Norte',6,3,1],
[-33.40959,-70.57062,'057 APOQUINDO - ROSARIO NORTE / PARLANTE','Av Apoquindo & Rosario Norte',6,6,1],
[-33.42126,-70.57085,'058 ALONSO DE CAMARGO - SEBASTIAN ELCANO / PTZ','Sebastián Elcano & Alonso de Camargo',6,1,1],
[-33.42126,-70.57085,'058 ALONSO DE CAMARGO - SEBASTIAN EL CANO / FIJA 1','Sebastián Elcano & Alonso de Camargo',6,3,1],
[-33.39686,-70.56695,'059 KENNEDY - BRASILIA / PTZ','Av. Kennedy & Brasilia',6,1,1],
[-33.39686,-70.56695,'059 KENNEDY - BRASILIA / SOS','Av. Kennedy & Brasilia',6,5,1],
[-33.39686,-70.56695,'059 KENNEDY - BRASILIA / PARLANTE','Av. Kennedy & Brasilia',6,6,1],
[-33.39686,-70.56695,'059 KENNEDY - BRASILIA / LPR','Av. Kennedy & Brasilia',6,2,1],
[-33.39686,-70.56695,'059 KENNEDY - BRASILIA / FIJA','Av. Kennedy & Brasilia',6,3,1],
[-33.392,-70.55349,'060 KENNEDY - LAS TRANQUERAS / PTZ','Av. Kennedy & Las Tranqueras',6,1,1],
[-33.392,-70.55349,'060 KENNEDY - LAS TRANQUERAS / LPR 1','Av. Kennedy & Las Tranqueras',6,2,1],
[-33.392,-70.55349,'060 KENNEDY - LAS TRANQUERAS / LPR 2','Av. Kennedy & Las Tranqueras',6,2,1],
[-33.392,-70.55349,'060 KENNEDY - LAS TRANQUERAS / LPR 3','Av. Kennedy & Las Tranqueras',6,2,1],
[-33.392,-70.55349,'060 KENNEDY - LAS TRANQUERAS / FIJA','Av. Kennedy & Las Tranqueras',6,3,1],
[-33.39832,-70.55131,'061 LAS CONDES - BOCACCIO / PTZ','Av. Las Condes & Bocaccio',6,1,1],
[-33.39832,-70.55131,'061 LAS CONDES - BOCACCIO / FIJA 1','Av. Las Condes & Bocaccio',6,3,1],
[-33.39832,-70.55131,'061 LAS CONDES - BOCACCIO / FIJA 2','Av. Las Condes & Bocaccio',6,3,1],
[-33.40142,-70.55522,'062 LAS CONDES - LAS TRANQUERAS / SOS','Av. Las Condes & Las Tranqueras',6,5,1],
[-33.40142,-70.55522,'062 LAS CONDES - LAS TRANQUERAS / PTZ','Av. Las Condes & Las Tranqueras',6,1,1],
[-33.40142,-70.55522,'062 LAS CONDES - LAS TRANQUERAS / PARLANTE','Av. Las Condes & Las Tranqueras',6,6,1],
[-33.40505,-70.56848,'063 MANQUEHUE - LOS MILITARES / SOS','Av. Manquehue & Los Militares',6,5,1],
[-33.40505,-70.56848,'063 MANQUEHUE - LOS MILITARES / PTZ','Av. Manquehue & Los Militares',6,1,1],
[-33.40505,-70.56848,'063 MANQUEHUE - LOS MILITARES / FIJA 1','Av. Manquehue & Los Militares',6,3,1],
[-33.40505,-70.56848,'063 MANQUEHUE - LOS MILITARES / FIJA 2','Av. Manquehue & Los Militares',6,3,1],
[-33.40505,-70.56848,'063 MANQUEHUE - LOS MILITARES / PARLANTE','Av. Manquehue & Los Militares',6,6,1],
[-33.39711,-70.56035,'064 RIESCO - GERONIMO DE ALDERETE / PTZ','Av. Presidente Riesco & Gerónimo de Alderete',6,1,1],
[-33.40384,-70.57346,'065 RIESCO - ROSARIO NORTE / SOS','Av. Presidente Riesco & Rosario Norte',6,5,1],
[-33.40384,-70.57346,'065 RIESCO - ROSARIO NORTE / PTZ','Av. Presidente Riesco & Rosario Norte',6,1,1],
[-33.40384,-70.57346,'065 RIESCO - ROSARIO NORTE / PARLANTE','Av. Presidente Riesco & Rosario Norte',6,6,1],
[-33.40869,-70.60044,'066 KENNEDY - VITACURA / PTZ','Av. Vitacura & Calle Luz',6,1,1],
[-33.40869,-70.60044,'066 KENNEDY - VITACURA / FIJA 1','Av. Vitacura & Calle Luz',6,3,1],
[-33.40869,-70.60044,'066 KENNEDY - VITACURA / FIJA 2','Av. Vitacura & Calle Luz',6,3,1],
[-33.43121,-70.57864,'067 BILBAO LATADIA / PTZ','Bilbao & Latadía',6,1,1],
[-33.43121,-70.57864,'067 BILBAO LATADIA / FIJA 1','Bilbao & Latadía',6,3,1],
[-33.43121,-70.57864,'067 BILBAO LATADIA / FIJA 2','Bilbao & Latadía',6,3,1],
[-33.43121,-70.57864,'067 BILBAO & LATADIA (JUAN DE AUSTRIA) / LPR','Bilbao & Latadía',6,2,1],
[-33.43121,-70.57864,'067 BILBAO - LATADIA / LPR 1','Bilbao & Latadía',6,2,1],
[-33.43121,-70.57864,'067 BILBAO - LATADIA / LPR 2','Bilbao & Latadía',6,2,1],
[-33.41491,-70.51278,'068 BULNES CORREA - SAN RAMON / PTZ','Bulnes Correa & San Ramón',6,1,1],
[-33.41395,-70.60351,'069 VITACURA - ISIDORA GOYENECHEA / PTZ','Av. Vitacura & Isidora Goyenechea',6,1,1],
[-33.41395,-70.60351,'069 VITACURA - ISIDORA GOYENECHEA / FIJA 1','Av. Vitacura & Isidora Goyenechea',6,3,1],
[-33.41395,-70.60351,'069 VITACURA - ISIDORA GOYENECHEA / FIJA 2','Av. Vitacura & Isidora Goyenechea',6,3,1],
[-33.41395,-70.60351,'069 VITACURA - ISIDORA GOYENECHEA / LPR 1','Av. Vitacura & Isidora Goyenechea',6,2,1],
[-33.41395,-70.60351,'069 VITACURA - ISIDORA GOYENECHEA / LPR 2','Av. Vitacura & Isidora Goyenechea',6,2,1],
[-33.41157,-70.52049,'070 CARLOS PEÑA- LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas',6,1,1],
[-33.41698,-70.55256,'071 CHOAPA - TINGUIRIRICA / PTZ','Choapa & Tinguiririca',6,1,1],
[-33.42431,-70.58327,'072 COLON - MALAGA / PTZ','Av. Cristobal Colón & Malaga',6,1,1],
[-33.42624,-70.59072,'073 COLON - SANCHEZ FONTECILLA / PTZ','Av. Cristobal Colón & Mariano Sánchez Fontecilla',6,1,1],
[-33.42624,-70.59072,'073 COLON - SANCHEZ FONTECILLA / FIJA 1','Av. Cristobal Colón & Mariano Sánchez Fontecilla',6,3,1],
[-33.42624,-70.59072,'073 COLON - SANCHEZ FONTECILLA / FIJA 2','Av. Cristobal Colón & Mariano Sánchez Fontecilla',6,3,1],
[-33.42624,-70.59072,'073 COLON - SANCHEZ FONTECILLA / FIJA 3','Av. Cristobal Colón & Mariano Sánchez Fontecilla',6,3,1],
[-33.42624,-70.59072,'073 COLON - SANCHEZ FONTECILLA / LPR','Av. Cristobal Colón & Mariano Sánchez Fontecilla',6,2,1],
[-33.40129,-70.52291,'074 EL ALBA - LA FUENTE / PTZ','Camino el Alba & Camino La Fuente',6,1,1],
[-33.41951,-70.59951,'075 EL BOSQUE - CALLAO / PTZ','El Bosque Central & Callao',6,1,1],
[-33.41951,-70.59951,'075 EL BOSQUE - CALLAO / FIJA 1','El Bosque Central & Callao',6,3,1],
[-33.41951,-70.59951,'075 EL BOSQUE - CALLAO / FIJA 2','El Bosque Central & Callao',6,3,1],
[-33.41951,-70.59951,'075 EL BOSQUE - CALLAO / LPR 1','El Bosque Central & Callao',6,2,1],
[-33.41951,-70.59951,'075 EL BOSQUE - CALLAO / LPR 2','El Bosque Central & Callao',6,2,1],
[-33.42595,-70.58075,'076 FLANDES - VATICANO / PTZ','Flandes & Vaticano',6,1,1],
[-33.40755,-70.53721,'077 BLANCHE - PAUL HARRIS / PTZ','General Blanche & Paul Harris',6,1,1],
[-33.41445,-70.59457,'078 FOSTER - ISIDORA GOYENECHEA / SOS','Isidora Goyenechea & Enrique Foster',6,5,1],
[-33.41445,-70.59457,'078 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster',6,1,1],
[-33.41445,-70.59457,'078 FOSTER - ISIDORA GOYENECHEA / FIJA 1','Isidora Goyenechea & Enrique Foster',6,3,1],
[-33.41445,-70.59457,'078 FOSTER - ISIDORA GOYENECHEA / FIJA 2','Isidora Goyenechea & Enrique Foster',6,3,1],
[-33.41445,-70.59457,'078 FOSTER - ISIDORA GOYENECHEA / PARLANTE','Isidora Goyenechea & Enrique Foster',6,6,1],
[-33.41445,-70.59457,'RF 11 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster',6,1,1],
[-33.41353,-70.55879,'079 IV CENTENARIO - HDO DE MAGALLANES / SOS','IV Centenario & Hernando de Magallanes',6,5,1],
[-33.41353,-70.55879,'079 IV CENTENARIO - HDO DE MAGALLANES / PTZ','IV Centenario & Hernando de Magallanes',6,1,1],
[-33.41353,-70.55879,'079 IV CENTENARIO - HDO DE MAGALLANES / PARLANTE','IV Centenario & Hernando de Magallanes',6,6,1],
[-33.39599,-70.50602,'080 LA PLAZA - LAS FLORES / PTZ','La Plaza & Camino las Flores',6,1,1],
[-33.39276,-70.50379,'081 LA PLAZA - REP DE HONDURAS / PTZ','La Plaza & Rep. Honduras',6,1,1],
[-33.42734,-70.5642,'082 MANQUEHUE - LATADIA / PTZ','Latadía & Manquehue',6,1,1],
[-33.42775,-70.57012,'083 ROTONDA LATADIA / SOS','Latadía & Sebastián Elcano',6,5,1],
[-33.42775,-70.57012,'083 ROTONDA LATADIA / PTZ','Latadía & Sebastián Elcano',6,1,1],
[-33.42775,-70.57012,'083 ROTONDA LATADIA / PARLANTE','Latadía & Sebastián Elcano',6,6,1],
[-33.40078,-70.54445,'084 PADRE HURTADO - BOCACCIO / PTZ','Padre Hurtado Norte & Bocaccio',6,1,1],
[-33.39643,-70.54425,'085 PADRE HURTADO - EL ALAMEIN / PTZ','Padre Hurtado Norte & El Alamein',6,1,1],
[-33.4131,-70.53754,'086 NAME - SIERRA NEVADA / SOS','Pje. Cerro Name & Pje. Sierra Nevada',6,5,1],
[-33.4131,-70.53754,'086 NAME - SIERRA NEVADA / PTZ','Pje. Cerro Name & Pje. Sierra Nevada',6,1,1],
[-33.4131,-70.53754,'086 NAME - SIERRA NEVADA / FIJA 1','Pje. Cerro Name & Pje. Sierra Nevada',6,3,1],
[-33.4131,-70.53754,'086 NAME - SIERRA NEVADA / FIJA 2','Pje. Cerro Name & Pje. Sierra Nevada',6,3,1],
[-33.4131,-70.53754,'086 NAME - SIERRA NEVADA / PARLANTE','Pje. Cerro Name & Pje. Sierra Nevada',6,6,1],
[-33.41442,-70.53749,'087 DIAGUITAS - LEON BLANCO / SOS','Pje. Diaguitas & Pje. León Blanco',6,5,1],
[-33.41442,-70.53749,'087 DIAGUITAS - LEON BLANCO / PTZ','Pje. Diaguitas & Pje. León Blanco',6,1,1],
[-33.41442,-70.53749,'087 DIAGUITAS - LEON BLANCO / PARLANTE','Pje. Diaguitas & Pje. León Blanco',6,6,1],
[-33.41385,-70.53676,'089 NEVADO DE PIUQUENES - CERRO MARMOLEJO / PTZ','Pje. Marmolejo & Pje. Nevado de Piuquenes',6,1,1],
[-33.39232,-70.53822,'090 PAUL HARRIS - CHARLES HAMILTON / PTZ','Paul Harris & Charles Hamilton',6,1,1],
[-33.39232,-70.53822,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 1','Paul Harris & Charles Hamilton',6,3,1],
[-33.39232,-70.53822,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 2','Paul Harris & Charles Hamilton',6,3,1],
[-33.39232,-70.53822,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 3','Paul Harris & Charles Hamilton',6,3,1],
[-33.42024,-70.5884,'091 ERRAZURIZ - ALCANTARA / SOS','Pdte. Errazuriz & Alcantara',6,5,1],
[-33.42024,-70.5884,'091 ERRAZURIZ - ALCANTARA / PTZ','Pdte. Errazuriz & Alcantara',6,1,1],
[-33.42024,-70.5884,'091 ERRAZURIZ - ALCANTARA / PARLANTE','Pdte. Errazuriz & Alcantara',6,6,1],
[-33.41253,-70.59763,'092 RIESCO - AUGUSTO LEGUIA / PTZ','Pdte. Riesco & Augusto Leguía',6,1,1],
[-33.42361,-70.52731,'093 PLAZA FLEMING / PTZ','Alejandro Fleming 9695',6,1,1],
[-33.42361,-70.52731,'093 PLAZA FLEMING / PARLANTE','Alejandro Fleming 9695',6,6,1],
[-33.41327,-70.5702,'094 ROTONDA LA CAPITANIA / SOS','La Capitanía & Del Inca',6,5,1],
[-33.41327,-70.5702,'094 ROTONDA LA CAPITANIA / PTZ','La Capitanía & Del Inca',6,1,1],
[-33.41327,-70.5702,'094 ROTONDA LA CAPITANIA / PARLANTE','La Capitanía & Del Inca',6,6,1],
[-33.41537,-70.55143,'095 MONROE - ANDALIEN / SOS','Monroe & Andalién',6,5,1],
[-33.41537,-70.55143,'095 MONROE - ANDALIEN / PTZ','Monroe & Andalién',6,1,1],
[-33.41537,-70.55143,'095 MONROE - ANDALIEN / PARLANTE','Monroe & Andalién',6,6,1],
[-33.41193,-70.53544,'096 RIO GUADIANA - PAUL HARRIS / PTZ','Rio Guadiana & Paul Harris',6,1,1],
[-33.41193,-70.53544,'096 RIO GUADIANA - PAUL HARRIS / FIJA 1','Rio Guadiana & Paul Harris',6,3,1],
[-33.41193,-70.53544,'096 RIO GUADIANA - PAUL HARRIS / FIJA 2','Rio Guadiana & Paul Harris',6,3,1],
[-33.43045,-70.58512,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / PTZ','Sánchez Fontecilla & Isabel La Católica',6,1,1],
[-33.43045,-70.58512,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 1','Sánchez Fontecilla & Isabel La Católica',6,3,1],
[-33.43045,-70.58512,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 2','Sánchez Fontecilla & Isabel La Católica',6,3,1],
[-33.43045,-70.58512,'097 I. La Católica & S.Fontecilla / LPR 1','Sánchez Fontecilla & Isabel La Católica',6,2,1],
[-33.43045,-70.58512,'097 I. La Católica & S.Fontecilla / LPR 2','Sánchez Fontecilla & Isabel La Católica',6,2,1],
[-33.41352,-70.53961,'098 LEON NEGRO - FUEGUINOS / SOS','Sierra Nevada & Leon Negro',6,5,1],
[-33.41352,-70.53961,'098 LEON NEGRO - FUEGUINOS / PTZ','Sierra Nevada & Leon Negro',6,1,1],
[-33.41352,-70.53961,'098 LEON NEGRO - FUEGUINOS / PARLANTE','Sierra Nevada & Leon Negro',6,6,1],
[-33.40193,-70.57009,'099 PARQUE ARAUCANO SKATEPARK / PTZ','Skatepark Parque Araucano',6,1,1],
[-33.40193,-70.57009,'099 PARQUE ARAUCANO SKATEPARK / PARLANTE','Skatepark Parque Araucano',6,6,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / SOS','Tajamar & Vitacura',6,5,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / PTZ','Tajamar & Vitacura',6,1,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / FIJA 1','Tajamar & Vitacura',6,3,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / FIJA 2','Tajamar & Vitacura',6,3,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / FIJA 3','Tajamar & Vitacura',6,3,1],
[-33.41682,-70.60489,'100 TAJAMAR - VITACURA / PARLANTE','Tajamar & Vitacura',6,6,1],
[-33.42534,-70.55395,'101 TOMAS MORO - FLEMING / PTZ','Tomás Moro & Alejandro Fleming',6,1,1],
[-33.42534,-70.55395,'101 TOMAS MORO - FLEMING / SOS','Tomás Moro & Alejandro Fleming',6,5,1],
[-33.42534,-70.55395,'101 TOMAS MORO - FLEMING / PARLANTE','Tomás Moro & Alejandro Fleming',6,6,1],
[-33.41941,-70.55289,'102 TOMAS MORO - ATENAS / PTZ','Tomás Moro & Atenas',6,1,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / SOS','A. Vespucio & Latadía',6,5,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / PTZ','A. Vespucio & Latadía',6,1,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / FIJA 1','A. Vespucio & Latadía',6,3,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / FIJA 2','A. Vespucio & Latadía',6,3,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / FIJA 3','A. Vespucio & Latadía',6,3,1],
[-33.42815,-70.57481,'103 VESPUCIO - LATADIA / PARLANTE','A. Vespucio & Latadía',6,6,1],
[-33.4197,-70.5823,'104 VESPUCIO - RAPALLO / PTZ','A. Vespucio Sur & Rapallo',6,1,1],
[-33.4197,-70.5823,'104 VESPUCIO - RAPALLO / FIJA 1','A. Vespucio Sur & Rapallo',6,3,1],
[-33.41598,-70.58367,'105 VESPUCIO - NEVERIA / PTZ','A. Vespucio Sur & Nevería',6,1,1],
[-33.41598,-70.58367,'105 VESPUCIO - NEVERIA / FIJA 1','A. Vespucio Sur & Nevería',6,3,1],
[-33.41622,-70.59407,'106 APOQUINDO - FOSTER/ FIJA','Enrique Foster & Apoquindo Norte',6,3,1],
[-33.41639,-70.5941,'RF 03 FOSTER A / PTZ','Enrique Foster & Apoquindo Sur',6,1,1],
[-33.39245,-70.51481,'107 LAS TERRAZAS - VALLE NEVADO / PTZ','Circunvalación Las Terrazas & Valle Nevado',6,1,1],
[-33.36842,-70.50171,'108 QUINCHAMALI 1 / PTZ','DESCATAMENTO QUINCHAMALI',6,1,1],
[-33.36842,-70.50171,'108 QUINCHAMALI 2 / FIJA 1','DESCATAMENTO QUINCHAMALI',6,3,1],
[-33.36842,-70.50171,'108 QUINCHAMALI 3 / FIJA 2','DESCATAMENTO QUINCHAMALI',6,3,1],
[-33.41584,-70.59623,'109 CENTRO CIVICO / PTZ','Centro Civico / Apoquindo',6,1,1],
[-33.41584,-70.59623,'109 CENTRO CIVICO / LPR','Centro Civico / Apoquindo',6,2,1],
[-33.42354,-70.57904,'110 VESPUCIO - COLON / PTZ','Américo Vespucio & Cristóbal Colon',6,1,1],
[-33.42354,-70.57904,'110 VESPUCIO - COLON / FIJA 1','Américo Vespucio & Cristóbal Colon',6,3,1],
[-33.42354,-70.57904,'110 VESPUCIO - COLON / FIJA 2','Américo Vespucio & Cristóbal Colon',6,3,1],
[-33.42354,-70.57904,'110 VESPUCIO - COLON / FIJA 3','Américo Vespucio & Cristóbal Colon',6,3,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / PTZ','Francisco Bilbao & Américo Vespucio',6,1,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / FIJA 1','Francisco Bilbao & Américo Vespucio',6,3,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / FIJA 2','Francisco Bilbao & Américo Vespucio',6,3,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / FIJA 3','Francisco Bilbao & Américo Vespucio',6,3,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / LPR 1','Francisco Bilbao & Américo Vespucio',6,2,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / LPR 2','Francisco Bilbao & Américo Vespucio',6,2,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / LPR 3','Francisco Bilbao & Américo Vespucio',6,2,1],
[-33.43123,-70.5743,'111 VESPUCIO - BILBAO / LPR 4','Francisco Bilbao & Américo Vespucio',6,2,1],
[-33.4143,-70.59795,'112 ISIDORA GOYENECHEA - AUGUSTO LEGUIA / PTZ','Isidora Goyenechea & Augusto Leguía Norte',6,1,1],
[-33.39869,-70.57116,'113 MANQUEHUE - KENNEDY / PTZ','Manquehue Sur Poniente & Kenedy',6,1,1],
[-33.42535,-70.56426,'114 MANQUEHUE - ISABEL LA CATOLICA / PTZ','Manquehue & Isabel La Catolica',6,1,1],
[-33.42535,-70.56426,'114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 1','Manquehue & Isabel La Catolica',6,3,1],
[-33.42535,-70.56426,'114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 2','Manquehue & Isabel La Catolica',6,3,1],
[-33.43172,-70.58409,'115 SANCHEZ FONTECILLA - BILBAO / PTZ','Mariano Sánchez Fontecilla & Francisco Bilbao',6,1,1],
[-33.43172,-70.58409,'115 SANCHEZ FONTECILLA - BILBAO / FIJA 2','Mariano Sánchez Fontecilla & Francisco Bilbao',6,3,1],
[-33.43172,-70.58409,'115 SANCHEZ FONTECILLA - BILBAO / FIJA 1','Mariano Sánchez Fontecilla & Francisco Bilbao',6,3,1],
[-33.43172,-70.58409,'115 SANCHEZ FONTECILLA - BILBAO / LPR 1','Mariano Sánchez Fontecilla & Francisco Bilbao',6,2,1],
[-33.43172,-70.58409,'115 SANCHEZ FONTECILLA - BILBAO / LPR 2','Mariano Sánchez Fontecilla & Francisco Bilbao',6,2,1],
[-33.42449,-70.59269,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / PTZ','Mariano Sánchez Fontecilla & Martín de Zamora',6,1,1],
[-33.42449,-70.59269,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 1','Mariano Sánchez Fontecilla & Martín de Zamora',6,3,1],
[-33.42449,-70.59269,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 2','Mariano Sánchez Fontecilla & Martín de Zamora',6,3,1],
[-33.42449,-70.59269,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 1','Mariano Sánchez Fontecilla & Martín de Zamora',6,2,1],
[-33.42449,-70.59269,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 2','Mariano Sánchez Fontecilla & Martín de Zamora',6,2,1],
[-33.42146,-70.5966,'117 SANCHEZ FONTECILLA - ERRAZURIZ / PTZ','Mariano Sánchez Fontecilla & Presidente Errázuriz',6,1,1],
[-33.42146,-70.5966,'117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 1','Mariano Sánchez Fontecilla & Presidente Errázuriz',6,3,1],
[-33.42146,-70.59661,'117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 2','Mariano Sánchez Fontecilla & Presidente Errázuriz',6,3,1],
[-33.42055,-70.59037,'118 ERRAZURIZ - GERTRUDIZ ECHEÑIQUE / PTZ','Presidente Errázuriz & Gertrudiz Echeñique',6,1,1],
[-33.41763,-70.53074,'119 YOLANDA - LA PAZ / PTZ','Yolanda & La Paz',6,1,1],
[-33.42833,-70.54939,'120 CURACO - M CLARO VIAL / PTZ','Curcaco & Manuel Claro Vial',6,1,1],
[-33.40484,-70.58199,'121 ALONSO DE CORDOVA - CERRO COLORADO / PTZ','Alonso de Córdova & Cerro Colorado',6,1,1],
[-33.40484,-70.58199,'121 ALONSO DE CORDOVA - CERRO COLORADO / FIJA 1','Alonso de Córdova & Cerro Colorado',6,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / PTZ','Padre Hurtado Sur & Bilbao',6,1,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 1','Padre Hurtado Sur & Bilbao',6,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 2','Padre Hurtado Sur & Bilbao',6,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 3','Padre Hurtado Sur & Bilbao',6,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 1','Padre Hurtado Sur & Bilbao',6,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 2','Padre Hurtado Sur & Bilbao',6,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 3','Padre Hurtado Sur & Bilbao',6,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 4','Padre Hurtado Sur & Bilbao',6,2,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / PTZ','Bilbao & Florencio Barrios',6,1,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / FIJA 1','Bilbao & Florencio Barrios',6,3,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / FIJA 2','Bilbao & Florencio Barrios',6,3,1],
[-33.4307,-70.55993,'124 BILBAO - HUARAHUARA / PTZ','Bilbao & Huarahuara',6,1,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / PTZ','Bilbao & Sebastián Elcano',6,1,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / FIJA 1','Bilbao & Sebastián Elcano',6,3,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / FIJA 2','Bilbao & Sebastián Elcano',6,3,1],
[-33.4315,-70.58093,'126 BILBAO - ALCANTARA / PTZ','Bilbao & Alcantara',6,1,1],
[-33.4315,-70.58093,'126 BILBAO - ALCANTARA / FIJA 1','Bilbao & Alcantara',6,3,1],
[-33.41064,-70.58677,'127 PDTE RIESCO - VESPUCIO / PTZ','Pdte Riesco & Vespucio',6,1,1],
[-33.41064,-70.58677,'127 PDTE RIESCO - VESPUCIO / FIJA 1','Pdte Riesco & Vespucio',6,3,1],
[-33.41064,-70.58677,'127 PDTE RIESCO - VESPUCIO / FIJA 2','Pdte Riesco & Vespucio',6,3,1],
[-33.41064,-70.58677,'127 PDTE RIESCO - VESPUCIO / LPR 1','Pdte Riesco & Vespucio',6,2,1],
[-33.41064,-70.58677,'127 PDTE RIESCO - VESPUCIO / LPR 2','Pdte Riesco & Vespucio',6,2,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / PTZ','Kennedy & Rosario Norte',6,1,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / FIJA 1','Kennedy & Rosario Norte',6,3,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / FIJA 2','Kennedy & Rosario Norte',6,3,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / LPR 1','Kennedy & Rosario Norte',6,2,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / LPR 2','Kennedy & Rosario Norte',6,2,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / PTZ','Av. Kennedy & Gerónimo de Alderete',6,1,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 1','Av. Kennedy & Gerónimo de Alderete',6,3,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 2','Av. Kennedy & Gerónimo de Alderete',6,3,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / LPR 1','Av. Kennedy & Gerónimo de Alderete',6,2,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / LPR 2','Av. Kennedy & Gerónimo de Alderete',6,2,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 3','Av. Kennedy & Gerónimo de Alderete',6,3,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / PTZ','Av. Kennedy & Padre Hurtado',6,1,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / FIJA 1','Av. Kennedy & Padre Hurtado',6,3,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / FIJA 2','Av. Kennedy & Padre Hurtado',6,3,1],
[-33.38883,-70.54527,'131 KENNEDY - GILBERTO FUENZALIDA / PTZ','Kennedy & Gilberto Fuenzalida',6,1,1],
[-33.38673,-70.53833,'132 LAS CONDES - KENNEDY / PTZ','Av. Las Condes & Kennedy',6,1,1],
[-33.38673,-70.53833,'132 LAS CONDES - KENNEDY / FIJA 1','Av. Las Condes & Kennedy',6,3,1],
[-33.37805,-70.5281,'133 LAS CONDES - VALLE ALEGRE / PTZ','Av. Las Condes & Valle Alegre',6,1,1],
[-33.37619,-70.52562,'134 LAS CONDES - SAN DAMIAN / PTZ','Av. Las Condes & San Damián',6,1,1],
[-33.37619,-70.52562,'134 LAS CONDES - SAN DAMIAN / FIJA 1','Av. Las Condes & San Damián',6,3,1],
[-33.37619,-70.52562,'134 LAS CONDES - SAN DAMIAN / FIJA 2','Av. Las Condes & San Damián',6,3,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / PTZ','Av. Las Condes & San Francisco de Asis',6,1,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / FIJA 1','Av. Las Condes & San Francisco de Asis',6,3,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / FIJA 2','Av. Las Condes & San Francisco de Asis',6,3,1],
[-33.37417,-70.50212,'136 LA POSADA - SAN JOSE DE LA SIERRA / PTZ','La Posada & San Jose de la Sierra',6,1,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / PTZ','Av. Las Condes & Camino San Antonio',6,1,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 1','Av. Las Condes & Camino San Antonio',6,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 2','Av. Las Condes & Camino San Antonio',6,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 3','Av. Las Condes & Camino San Antonio',6,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 4','Av. Las Condes & Camino San Antonio',6,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 1','Av. Las Condes & Camino San Antonio',6,2,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 2','Av. Las Condes & Camino San Antonio',6,2,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 3','Av. Las Condes & Camino San Antonio',6,2,1],
[-33.37034,-70.50779,'138 LAS CONDES - FERNANDEZ CONCHA / PTZ','Av. Las Condes & Fernandez Concha',6,1,1],
[-33.36967,-70.50441,'139 LAS CONDES - SAN JOSE DE LA SIERRA / PTZ','AV. Las Condes & San José de la Sierra',6,1,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / PTZ','Camino a Farellones & Av. del Monte',6,1,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / FIJA 1','Camino a Farellones & Av. del Monte',6,3,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / LPR','Camino a Farellones & Av. del Monte',6,2,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / PTZ','Pdte Riesco & Vitacura',6,1,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 1','Pdte Riesco & Vitacura',6,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 2','Pdte Riesco & Vitacura',6,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 3','Pdte Riesco & Vitacura',6,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / LPR','Pdte Riesco & Vitacura',6,2,1],
[-33.41359,-70.58466,'142 VESPUCIO - LOS MILITARES / PTZ','Los Militares & Americo Vespucio',6,1,1],
[-33.41359,-70.58466,'142 VESPUCIO - LOS MILITARES / FIJA 1','Los Militares & Americo Vespucio',6,3,1],
[-33.41359,-70.58466,'142 VESPUCIO - LOS MILITARES / FIJA 2','Los Militares & Americo Vespucio',6,3,1],
[-33.40438,-70.58408,'143 KENNEDY - ALONSO DE CORDOVA / PTZ','Kennedy & Alonso de Cordova',6,1,1],
[-33.40438,-70.58408,'143 KENNEDY - ALONSO DE CORDOVA / FIJA 1','Kennedy & Alonso de Cordova',6,3,1],
[-33.42773,-70.58861,'144 SANCHEZ FONTECILLA - VATICANO / PTZ','Sanchez Fontecilla & Vaticano',6,1,1],
[-33.41468,-70.60554,'145 ANDRES BELLO - COSTANERA SUR / PTZ','Andres Bello & Costanera Sur',6,1,1],
[-33.40158,-70.50974,'146 BLANCHE - SAN CARLOS DE APOQUINDO / PTZ','U. LOS ANDES - San Carlos de Apoquindo & Blanche',6,1,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / PTZ','Colón & Padre Hurtado',6,1,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 1','Colón & Padre Hurtado',6,3,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 2','Colón & Padre Hurtado',6,3,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 3','Colón & Padre Hurtado',6,3,1],
[-33.41593,-70.60682,'148 ANDRES BELLO - TAJAMAR / PTZ','Nueva Tajamar & Andres Bello',6,1,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / PTZ','Cerro Colorado & Manquehue',6,1,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / FIJA 1','Cerro Colorado & Manquehue',6,3,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / FIJA 2','Cerro Colorado & Manquehue',6,3,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 1','Cerro Colorado & Manquehue',6,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 2','Cerro Colorado & Manquehue',6,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 3','Cerro Colorado & Manquehue',6,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 4','Cerro Colorado & Manquehue',6,2,1],
[-33.40043,-70.54767,'150 CHESTERTON - BOCACCIO / PTZ','Chesterton & Bocaccio',6,1,1],
[-33.40839,-70.55336,'151 INACAP APOQUINDO / PTZ','INACAP APOQUINDO',6,1,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / PTZ','Apoquindo & Tobalaba',6,1,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 1','Apoquindo & Tobalaba',6,3,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 2','Apoquindo & Tobalaba',6,3,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 3','Apoquindo & Tobalaba',6,3,1],
[-33.39951,-70.5068,'153 DUOC CAMINO EL ALBA - LA PLAZA / PTZ','DUOC - Camino El Alba & La PLaza',6,1,1],
[-33.42114,-70.57645,'154 COLON - FELIX DE AMESTI / PTZ','Colón & Felix de Amesti',6,1,1],
[-33.39031,-70.49988,'155 AV LA PLAZA - SAN FRANCISCO / PTZ','San Francisco de Asis & Av. La Plaza',6,1,1],
[-33.42511,-70.53321,'156 STA ZITA - CIRIO / PTZ','Sta Zita & Cirio',6,1,1],
[-33.39494,-70.51256,'157 LAS FLORES - SAN RAMON / PTZ','Las Flores & San Ramón',6,1,1],
[-33.40226,-70.57547,'158 CERRO COLORADO - ROSARIO NORTE / PTZ','Cerro Colorado & Rosario Norte',6,1,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / PTZ','Av. Padre Hurtado & Alejandro Fleming',6,1,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / FIJA 1','Av. Padre Hurtado & Alejandro Fleming',6,3,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / FIJA 2','Av. Padre Hurtado & Alejandro Fleming',6,3,1],
[-33.42185,-70.52968,'160 PAUL HARRIS - VITAL APOQUINDO / PTZ','Paul Harris & Vital Apoquindo',6,1,1],
[-33.4131,-70.54063,'161 PADRE HURTADO - RIO GUADIANA / PTZ','Padre Hurtado & Rio Guadiana',6,1,1],
[-33.41606,-70.5363,'162 COLON - LOMA LARGA / PTZ','Colón & Loma Larga',6,1,1],
[-33.39138,-70.50659,'163 SAN CARLOS DE APOQUINDO - REP DE HONDURAS / PTZ','República de Honduras & San Carlos de Apoquindo',6,1,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / PTZ','Vespucio & Presidente Errázuriz',6,1,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / FIJA 1','Vespucio & Presidente Errázuriz',6,3,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / FIJA 2','Vespucio & Presidente Errázuriz',6,3,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / LPR 1','Vespucio & Presidente Errázuriz',6,2,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / LPR 2','Vespucio & Presidente Errázuriz',6,2,1],
[-33.39457,-70.51576,'165 LAS TERRAZAS - CAMINO LAS FLORES / PTZ','Las Terrazas - Camino Las Flores',6,1,1],
[-33.40114,-70.51737,'166 CAMINO EL ALBA - BULNES CORREA / PTZ','Camino El Alba & Bulnes Correa',6,1,1],
[-33.40102,-70.51383,'167 CAMINO EL ALBA - SAN RAMON / PTZ','Camino El Alba & San Ramón',6,1,1],
[-33.41885,-70.57187,'168 COLON - SEBASTIAN ELCANO / PTZ','Av. Colón & Sebastián Elcano',6,1,1],
[-33.41271,-70.51259,'169 BULNES CORREA - CARLOS PEÑA OTAEGUI / PTZ','Fco bulnes Correa & Carlos Peña Otaegui',6,1,1],
[-33.38489,-70.49521,'170 AV LA PLAZA - SAN CARLOS DE APOQUINDO / PTZ','Av La Plaza & San Carlos de Apoquindo',6,1,1],
[-33.37888,-70.49468,'171 SAN JOSE DE LA SIERRA - HUEICOLLA / PTZ','San Jose de la Sierra & Hueicolla',6,1,1],
[-33.40514,-70.50247,'172 AV LA PLAZA (U LOS ANDES) / PTZ','Av La Plaza 2440',6,1,1],
[-33.4256,-70.58821,'173 COLON - MARCO POLO / PTZ','Colón & Marco Polo',6,1,1],
[-33.42079,-70.56445,'174 MANQUEHUE - ALONSO DE CAMARGO / PTZ','Manquehue & Alonso de Camargo',6,1,1],
[-33.42907,-70.56461,'175 MANQUEHUE - CARLOS ALVARADO / PTZ','Manquehue & Carlos Alvarado',6,1,1],
[-33.42025,-70.57836,'176 MARTIN DE ZAMORA - FELIX DE AMESTI / PTZ','Martin de Zamora & Felix de Amesti',6,1,1],
[-33.39966,-70.57454,'177 MARRIOT / PTZ','Av. Kennedy 5741',6,1,1],
[-33.39966,-70.57454,'177 MARRIOT / SOS','Av. Kennedy 5741',6,5,1],
[-33.39966,-70.57454,'177 MARRIOT / PARLANTE','Av. Kennedy 5741',6,6,1],
[-33.39515,-70.51701,'178 FRANCISCO BULNES - LAS FLORES / PTZ','Francisco Bulnes Correa & Las Flores',6,1,1],
[-33.39505,-70.52222,'179 LAS FLORES - LA FUENTE / PTZ','Las Flores & La Fuente',6,1,1],
[-33.38516,-70.50315,'180 EL CONVENTO - SAN FRANCISCO / PTZ','El Convento & San Francisco de Asis',6,1,1],
[-33.38767,-70.50102,'181 SAN FRANCISCO - SAN CARLOS DE APOQUINDO / PTZ','San Carlos de Apoquindo & San Francisco de Asis',6,1,1],
[-33.40764,-70.5106,'182 SAN RAMON - LOS OLIVILLOS / PTZ','San Ramon & Los Olivillos',6,1,1],
[-33.39027,-70.51493,'183 FRANCISCO BULNES - REPUBLICA DE HONDURAS / PTZ','Republica de Honduras & Francisco Bulnes Correa',6,1,1],
[-33.38765,-70.51911,'184 LAS LAVANDULAS - LA FUENTE / PTZ','Las Lavandulas & La Fuente',6,1,1],
[-33.38765,-70.51911,'184 LAS LAVANDULAS - LA FUENTE / FIJA 1','Las Lavandulas & La Fuente',6,3,1],
[-33.40583,-70.51622,'185 FRANCISCO BULNES - QUEBRADA HONDA / PTZ','Francisco Bulnes Correa & Quebrada Honda',6,1,1],
[-33.40353,-70.51943,'186 GENERAL BLANCHE - CAMINO OTOÑAL / PTZ','General Blanche & Camino Otoñal',6,1,1],
[-33.41213,-70.52532,'187 QUEBRADA HONDA - CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña Otaegui',6,1,1],
[-33.40946,-70.57024,'RF 07 ROSARIO NORTE / PTZ','Apoquindo & Rosario Norte',6,1,1],
[-33.40878,-70.56785,'RF 08 MANQUEHUE / PTZ','Manquehue & Apoquindo Norte',6,1,1],
[-33.40924,-70.56817,'RF 09 APUMANQUE / FIJA','Apumanque & Apoquindo Sur',6,3,1],
[-33.41365,-70.58266,'RF 05 ESCUELA MILITAR B / PTZ','Apoquindo & Felix de amesti',6,1,1],
[-33.42748,-70.5789,'188 ISABEL LA CATOLICA -CARLOS V / PTZ','Isabel la Católica & Carlos V',6,1,1],
[-33.39428,-70.5454,'189 PADRE HURTADO - LAS CONDES / PTZ','Padre Hurtado & Las Condes',6,1,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / FIJA 2','EL BOSQUE & SAN SEBASTIAN',6,3,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / FIJA 1','EL BOSQUE & SAN SEBASTIAN',6,3,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / PTZ','EL BOSQUE & SAN SEBASTIAN',6,1,1],
[-33.41481,-70.58706,'191 APOQUINDO - GOLDA MEIR / FIJA 1','APOQUINDO & GOLDA MEIR',6,3,1],
[-33.41481,-70.58706,'191 APOQUINDO - GOLDA MEIR / FIJA 2','APOQUINDO & GOLDA MEIR',6,3,1],
[-33.41481,-70.58706,'191 APOQUINDO - GOLDA MEIR / PTZ','APOQUINDO & GOLDA MEIR',6,1,1],
[-33.41184,-70.59113,'192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 1','PRESIDENTE RIESCO & LAS TORCAZAS',6,3,1],
[-33.41184,-70.59113,'192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 2','PRESIDENTE RIESCO & LAS TORCAZAS',6,3,1],
[-33.41184,-70.59113,'192 PRESIDENTE RIESCO - LAS TORCAZAS / PTZ','PRESIDENTE RIESCO & LAS TORCAZAS',6,1,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 1','ALONSO DE CÓRDOVA & LOS MILITARES',6,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 2','ALONSO DE CÓRDOVA & LOS MILITARES',6,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 3','ALONSO DE CÓRDOVA & LOS MILITARES',6,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / PTZ','ALONSO DE CÓRDOVA & LOS MILITARES',6,1,1],
[-33.42978,-70.54743,'194 FRANCISCO BILBAO - DUQUECO / FIJA 1','FRANCISCO BILBAO & DUQUECO',6,3,1],
[-33.42978,-70.54743,'194 FRANCISCO BILBAO - DUQUECO / FIJA 2','FRANCISCO BILBAO & DUQUECO',6,3,1],
[-33.42978,-70.54743,'194 FRANCISCO BILBAO - DUQUECO / PTZ','FRANCISCO BILBAO & DUQUECO',6,1,1],
[-33.41952,-70.55136,'195 GREDOS - IV CENTENARIO / FIJA 1','GREDOS & CUARTO CENTENARIO',6,3,1],
[-33.41952,-70.55136,'195 GREDOS - IV CENTENARIO / FIJA 2','GREDOS & CUARTO CENTENARIO',6,3,1],
[-33.41952,-70.55136,'195 GREDOS - IV CENTENARIO / FIJA PTZ','GREDOS & CUARTO CENTENARIO',6,1,1],
[-33.4133,-70.53797,'196 SIERRA NEVADA - DIAGUITAS / FIJA 1','SIERRA NEVADA & DIAGUITAS',6,3,1],
[-33.4133,-70.53797,'196 SIERRA NEVADA - DIAGUITAS / FIJA 2','SIERRA NEVADA & DIAGUITAS',6,3,1],
[-33.4133,-70.53797,'196 SIERRA NEVADA - DIAGUITAS / PTZ','SIERRA NEVADA & DIAGUITAS',6,1,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 1','NUEVA BILBAO & VITAL APOQUINDO',6,3,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 2','NUEVA BILBAO & VITAL APOQUINDO',6,3,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / PTZ','NUEVA BILBAO & VITAL APOQUINDO',6,1,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / FIJA 1','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',6,3,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / PTZ','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',6,1,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / LPR','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',6,2,1],
[-33.41287,-70.55242,'199 TOMAS MORO - IMPERIAL / FIJA 1','TOMAS MORO & IMPERIAL',6,3,1],
[-33.41287,-70.55242,'199 TOMAS MORO - IMPERIAL / PTZ','TOMAS MORO & IMPERIAL',6,1,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / FIJA 1','PRESIDENTE RIESCO & EL GOLF',6,3,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / FIJA 2','PRESIDENTE RIESCO & EL GOLF',6,3,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / PTZ','PRESIDENTE RIESCO & EL GOLF',6,1,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 1','ALEJANDRO FLEMING & FUENTE OVEJUNA',6,3,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 2','ALEJANDRO FLEMING & FUENTE OVEJUNA',6,3,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / PTZ','ALEJANDRO FLEMING & FUENTE OVEJUNA',6,1,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 1','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',6,3,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 2','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',6,3,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / PTZ','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',6,1,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / FIJA 1','ENCOMENDEROS & ROGER DE FLOR',6,3,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / PTZ','ENCOMENDEROS & ROGER DE FLOR',6,1,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / LPR 1','ENCOMENDEROS & ROGER DE FLOR',6,2,1],
[-33.41761,-70.5681,'204 CRISTOBAL COLON - DOMINGO BONDI / FIJA 1','CRISTÓBAL COLÓN & DOMINGO BONDI',6,3,1],
[-33.41761,-70.5681,'204 CRISTOBAL COLON - DOMINGO BONDI / PTZ','CRISTÓBAL COLÓN & DOMINGO BONDI',6,1,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 1','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',6,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 2','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',6,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 3','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',6,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / PTZ','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',6,1,1],
[-33.41108,-70.5622,'206 IV CENTENARIO - VIRGILIO FIGUEROA / FIJA 1','IV CENTENARIO & VIRGILIO FIGUEROA',6,3,1],
[-33.41108,-70.5622,'206 IV CENTENARIO - VIRGILIO FIGUEROA / PTZ','IV CENTENARIO & VIRGILIO FIGUEROA',6,1,1],
[-33.41751,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / FIJA 1','CRISTÓBAL COLÓN & IMPERIAL',6,3,1],
[-33.41751,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / FIJA 2','CRISTÓBAL COLÓN & IMPERIAL',6,3,1],
[-33.41751,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / PTZ','CRISTÓBAL COLÓN & IMPERIAL',6,1,1],
[-33.41797,-70.55566,'208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 1','ROBINSON CRUSOE & CRISTÓBAL CÓLON',6,3,1],
[-33.41797,-70.55566,'208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 2','ROBINSON CRUSOE & CRISTÓBAL CÓLON',6,3,1],
[-33.41797,-70.55566,'208 ROBINSON CRUSOE - CRISTOBAL COLON / PTZ','ROBINSON CRUSOE & CRISTÓBAL CÓLON',6,1,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / FIJA 1','VITAL APOQUINDO & LA QUEBRADA',6,3,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / FIJA 2','VITAL APOQUINDO & LA QUEBRADA',6,3,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / PTZ','VITAL APOQUINDO & LA QUEBRADA',6,1,1],
[-33.41222,-70.53694,'210 LOMA LARGA - RIO GUADIANA / FIJA 1','LOMA LARGA & RIO GUADIANA',6,3,1],
[-33.41222,-70.53694,'210 LOMA LARGA - RIO GUADIANA / PTZ','LOMA LARGA & RIO GUADIANA',6,1,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 1','FRANCISCO BILBAO & IV CENTENARIO',6,3,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 2','FRANCISCO BILBAO & IV CENTENARIO',6,3,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / PTZ','FRANCISCO BILBAO & IV CENTENARIO',6,1,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 1','Francisco Bilbao & IV Centenario',6,2,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 2','Francisco Bilbao & IV Centenario',6,2,1],
[-33.42892,-70.54172,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 3','Francisco Bilbao & IV Centenario',6,2,1],
[-33.41712,-70.56044,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 1','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',6,3,1],
[-33.41712,-70.56044,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 2','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',6,3,1],
[-33.41712,-70.56044,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 3','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',6,3,1],
[-33.41712,-70.56044,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / PTZ','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',6,1,1],
[-33.41662,-70.54133,'213 TALAVERA DE LA REINA - CRISTOBAL COLON / FIJA 1','TALAVERA DE LA REINA & CRISTOBAL COLON',6,3,1],
[-33.41662,-70.54133,'213 TALAVERA DE LA REINA - CRISTOBAL COLON / PTZ','TALAVERA DE LA REINA & CRISTOBAL COLON',6,1,1],
[-33.42496,-70.58574,'214 CRISTOBAL COLON - ALCANTARA / FIJA 1','CRISTÓBAL COLÓN & ALCÁNTARA',6,3,1],
[-33.42496,-70.58574,'214 CRISTOBAL COLON - ALCANTARA / PTZ','CRISTÓBAL COLÓN & ALCÁNTARA',6,1,1],
[-33.40236,-70.53383,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 1','CAMINO DEL ALGARROBO & CAMINO EL ALBA',6,3,1],
[-33.40236,-70.53383,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 2','CAMINO DEL ALGARROBO & CAMINO EL ALBA',6,3,1],
[-33.40236,-70.53383,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 3','CAMINO DEL ALGARROBO & CAMINO EL ALBA',6,3,1],
[-33.40236,-70.53383,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / PTZ','CAMINO DEL ALGARROBO & CAMINO EL ALBA',6,1,1],
[-33.41417,-70.53828,'216 CERRO ALTAR - NEVADO DE PIUQUENES / FIJA 1','NEVADA DE PIUQUENES & CERRO ALTAR',6,3,1],
[-33.41417,-70.53828,'216 CERRO ALTAR - NEVADO DE PIUQUENES / PTZ','NEVADA DE PIUQUENES & CERRO ALTAR',6,1,1],
[-33.41581,-70.53697,'217 DIAGUITAS - CERRO NEGRO / FIJA 1','DIAGUITAS & CERRO NEGRO',6,3,1],
[-33.41581,-70.53697,'217 DIAGUITAS - CERRO NEGRO / PTZ','DIAGUITAS & CERRO NEGRO',6,1,1],
[-33.42574,-70.53518,'218 VIA LACTEA - BELATRIX / FIJA 1','VÍA LACTEA & BELATRIX',6,3,1],
[-33.42574,-70.53518,'218 VIA LACTEA - BELATRIX / PTZ','VÍA LACTEA & BELATRIX',6,1,1],
[-33.42392,-70.53177,'219 ALEXANDER FLEMING - SANTA ZITA / FIJA 1','ALEXANDER FLEMING & SANTA ZITA',6,3,1],
[-33.42392,-70.53177,'219 ALEXANDER FLEMING - SANTA ZITA / FIJA 2','ALEXANDER FLEMING & SANTA ZITA',6,3,1],
[-33.42392,-70.53177,'219 ALEXANDER FLEMING - SANTA ZITA / PTZ','ALEXANDER FLEMING & SANTA ZITA',6,1,1],
[-33.42486,-70.5312,'220 LUCARO - LUCERO / FIJA 1','LUCARO & LUCERO',6,3,1],
[-33.42486,-70.5312,'220 LUCARO - LUCERO / FIJA 2','LUCARO & LUCERO',6,3,1],
[-33.42486,-70.5312,'220 LUCARO - LUCERO / PTZ','LUCARO & LUCERO',6,1,1],
[-33.41967,-70.5323,'221 OLGA - PAUL HARRIS / FIJA 1','OLGA & PAUL HARRIS',6,3,1],
[-33.41967,-70.5323,'221 OLGA - PAUL HARRIS / FIJA 2','OLGA & PAUL HARRIS',6,3,1],
[-33.41967,-70.5323,'221 OLGA - PAUL HARRIS / PTZ','OLGA & PAUL HARRIS',6,1,1],
[-33.41915,-70.53552,'222 LOS VILOS - SOCOMPA / FIJA 1','LOS VILOS & SOCOMPA',6,3,1],
[-33.41915,-70.53552,'222 LOS VILOS - SOCOMPA / FIJA 2','LOS VILOS & SOCOMPA',6,3,1],
[-33.41915,-70.53552,'222 LOS VILOS - SOCOMPA / PTZ','LOS VILOS & SOCOMPA',6,1,1],
[-33.41455,-70.59633,'223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 1','LA PASTORA & ISIDORA GOYENECHEA',6,3,1],
[-33.41455,-70.59633,'223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 2','LA PASTORA & ISIDORA GOYENECHEA',6,3,1],
[-33.41455,-70.59633,'223 LA PASTORA - ISIDORA GOYENECHEA / PTZ','LA PASTORA & ISIDORA GOYENECHEA',6,1,1],
[-33.41412,-70.60007,'224 ISIDORA GOYENECHEA - SAN SEBASTIAN / FIJA 1','ISIDORA GOYENECHEA & SAN SEBASTIAN',6,3,1],
[-33.41412,-70.60007,'224 ISIDORA GOYENECHEA - SAN SEBASTIAN / PTZ','ISIDORA GOYENECHEA & SAN SEBASTIAN',6,1,1],
[-33.4139,-70.6024,'225 ISIDORA GOYENECHEA - LUZ / FIJA 1','ISIDORA GOYENECHEA & LUZ',6,3,1],
[-33.4139,-70.6024,'225 ISIDORA GOYENECHEA - LUZ / FIJA 2','ISIDORA GOYENECHEA & LUZ',6,3,1],
[-33.4139,-70.6024,'225 ISIDORA GOYENECHEA - LUZ / PTZ','ISIDORA GOYENECHEA & LUZ',6,1,1],
[-33.41674,-70.60031,'226 ROGER DE FLOR - EL BOSQUE / FIJA 1','ROGER DE FLOR & EL BOSQUE NORTE',6,3,1],
[-33.41674,-70.60031,'226 ROGER DE FLOR - EL BOSQUE / PTZ','ROGER DE FLOR & EL BOSQUE NORTE',6,1,1],
[-33.41419,-70.59352,'227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 1','ISIDORA GOYENECHEA & MAGDALENA',6,3,1],
[-33.41419,-70.59352,'227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 2','ISIDORA GOYENECHEA & MAGDALENA',6,3,1],
[-33.41419,-70.59352,'227 ISIDORA GOYENECHEA - MAGDALENA / PTZ','ISIDORA GOYENECHEA & MAGDALENA',6,1,1],
[-33.41149,-70.60331,'228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 1','ANDRES BELLO & PRESIDENTE RIESCO',6,3,1],
[-33.41149,-70.60331,'228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 2','ANDRES BELLO & PRESIDENTE RIESCO',6,3,1],
[-33.41149,-70.60331,'228 ANDRES BELLO - PRESIDENTE RIESCO / PTZ','ANDRES BELLO & PRESIDENTE RIESCO',6,1,1],
[-33.41221,-70.59967,'229 PRESIDENTE RIESCO - SAN SEBASTIAN / PTZ','PRESIDENTE RIESCO & SAN SEBASTIAN',6,1,1],
[-33.41221,-70.59967,'229 PRESIDENTE RIESCO - SAN SEBASTIAN / FIJA 1','PRESIDENTE RIESCO & SAN SEBASTIAN',6,3,1],
[-33.37846,-70.50163,'230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / LPR','Charles Hamilton & San José de la Sierra',6,2,1],
[-33.37846,-70.50163,'230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / PTZ','CHARLES HAMILTON & SAN JOSÉ DE LA SIERRA',6,1,1],
[-33.4137,-70.57775,'231 NEVERIA - PUERTA DEL SOL / PTZ','NEVERIA & PUERTA DEL SOL',6,1,1],
[-33.41515,-70.56684,'232 LA CAPITANIA - MARTIN DE ZAMORA / FIJA 1','LA CAPITANIA & MARTIN DE ZAMORA',6,3,1],
[-33.41025,-70.57207,'233 APOQUINDO - LA CAPITANIA / PTZ','APOQUINDO & LA CAPITANIA',6,1,1],
[-33.41072,-70.57433,'234 APOQUINDO - JORGE IV / PTZ','APOQUINDO & JORGE IV',6,1,1],
[-33.42065,-70.53397,'235 ESTADIO PATRICIA / PTZ','PATRICIA & PICHIDANGUI',6,1,1],
[-33.42065,-70.53397,'235 ESTADIO PATRICIA / FIJA','PATRICIA & PICHIDANGUI',6,3,1],
[-33.42065,-70.53397,'235 ESTADIO PATRICIA / PARLANTE','PATRICIA & PICHIDANGUI',6,6,1],
[-33.42065,-70.53397,'235 ESTADIO PATRICIA / SOS','Patricia & Pichidangui',6,5,1],
[-33.41821,-70.58885,'236 RENATO SANCHEZ - ALCANTARA / PTZ','RENATO SANCHEZ & ALCANTARA',6,1,1],
[-33.41773,-70.5859,'237 RENATO SANCHEZ - MALAGA / PTZ','RENATO SANCHEZ & MALAGA',6,1,1],
[-33.41897,-70.5841,'238 PRESIDENTE ERRAZURIZ - ASTURIAS / PTZ','PRESIDENTE ERRAZURIZ & ASTURIAS',6,1,1],
[-33.42628,-70.57399,'239 ISABEL LA CATATOLICA #4601 / PTZ','ISABEL LA CATÓLICA 4601',6,1,1],
[-33.42628,-70.57399,'239 ISABEL LA CATATOLICA #4601 / FIJA 1','ISABEL LA CATÓLICA 4601',6,3,1],
[-33.42628,-70.57399,'239 ISABEL LA CATATOLICA #4601 / FIJA 2','ISABEL LA CATÓLICA 4601',6,3,1],
[-33.42628,-70.57399,'239 ISABEL LA CATATOLICA #4601 / LPR 1','ISABEL LA CATÓLICA 4601',6,2,1],
[-33.42628,-70.57399,'239 ISABEL LA CATATOLICA #4601 / LPR 2','ISABEL LA CATÓLICA 4601',6,2,1],
[-33.42252,-70.58393,'240 MARTÍN DE ZAMORA - MALAGA / PTZ','MARTÍN DE ZAMORA & MALAGA',6,1,1],
[-33.4154,-70.60404,'241 VITACURA & ZURICH / LPR 1','Vitacura & Zurich',6,2,1],
[-33.41755,-70.5992,'242 APOQUINDO SUR & EL BOSQUE / LPR 1','Apoquindo & El Bosque',6,2,1],
[-33.41755,-70.5992,'242 APOQUINDO SUR & EL BOSQUE / LPR 2','Apoquindo & El Bosque',6,2,1],
[-33.41734,-70.59926,'243 APOQUINDO NORTE & EL BOSQUE / LPR 1','Apoquindo & El Bosque',6,2,1],
[-33.41734,-70.59926,'243 APOQUINDO NORTE & EL BOSQUE / LPR 2','Apoquindo & El Bosque',6,2,1],
[-33.43074,-70.57005,'244 SEBASTIAN ELCANO ORIENTE & BILBAO / LPR','Sebastián Elcano & Francisco Bilbao',6,2,1],
[-33.43074,-70.57005,'244 SEBASTIAN ELCANO ORIENTE & BILBAO / FIJA','Sebastián Elcano & Francisco Bilbao',6,3,1],
[-33.43008,-70.56487,'245 MANQUEHUE & BILBAO / LPR 1','Manquehue Sur & Francisco Bilbao',6,2,1],
[-33.43008,-70.56487,'245 MANQUEHUE & BILBAO / LPR 2','Manquehue Sur & Francisco Bilbao',6,2,1],
[-33.42947,-70.55149,'246 FLORENCIO BARRIOS & BILBAO / LPR 1','Florencio Barrios & Francisco Bilbao',6,2,1],
[-33.42947,-70.55149,'246 FLORENCIO BARRIOS & BILBAO / LPR 2','Florencio Barrios & Francisco Bilbao',6,2,1],
[-33.40519,-70.58177,'247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 1','Alonso de Córdova 4471',6,2,1],
[-33.40519,-70.58177,'247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 2','Alonso de Córdova 4471',6,2,1],
[-33.39119,-70.54763,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 1','Padre Hurtado Norte & Pdte. Kennedy Lateral',6,2,1],
[-33.39119,-70.54763,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 2','Padre Hurtado Norte & Pdte. Kennedy Lateral',6,2,1],
[-33.39119,-70.54763,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 3','Padre Hurtado Norte & Pdte. Kennedy Lateral',6,2,1],
[-33.39119,-70.54763,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / FIJA','Padre Hurtado Norte & Pdte. Kennedy Lateral',6,3,1],
[-33.38508,-70.53272,'249 Estoril & P.Harris / LPR 1','Estoril & Av. Las Condes',6,2,1],
[-33.38508,-70.53272,'249 ESTORIL (PAUL HARRIS) PONIENTE LAS CONDES / FIJA','Estoril & Av. Las Condes',6,3,1],
[-33.37348,-70.51704,'250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / LPR','Nueva las Condes & San Francisco de Asis',6,2,1],
[-33.37348,-70.51704,'250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / FIJA','Nueva las Condes & San Francisco de Asis',6,3,1],
[-33.41578,-70.60273,'251 ZURICH & EBRO / PTZ','Zurich & Ebro',6,1,1],
[-33.41578,-70.60273,'251 ZURICH & EBRO / FIJA 1','Zurich & Ebro',6,3,1],
[-33.41578,-70.60273,'251 ZURICH & EBRO / FIJA 2','Zurich & Ebro',6,3,1],
[-33.41269,-70.58872,'252 HAMLET & LAS TORCAZAS / PTZ','Hamlet & Las Torcazas',6,1,1],
[-33.41269,-70.58872,'252 HAMLET & LAS TORCAZAS / FIJA 1','Hamlet & Las Torcazas',6,3,1],
[-33.41269,-70.58872,'252 HAMLET & LAS TORCAZAS / FIJA 2','Hamlet & Las Torcazas',6,3,1],
[-33.41869,-70.59088,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / PTZ','Gertrudis Echeñique & Renato Sánchez',6,1,1],
[-33.41869,-70.59088,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 1','Gertrudis Echeñique & Renato Sánchez',6,3,1],
[-33.41869,-70.59088,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 2','Gertrudis Echeñique & Renato Sánchez',6,3,1],
[-33.40533,-70.58599,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / PTZ','Américo Vespucio Norte & Presidente Kennedy',6,1,1],
[-33.40533,-70.58599,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 1','Américo Vespucio Norte & Presidente Kennedy',6,3,1],
[-33.40533,-70.58599,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 2','Américo Vespucio Norte & Presidente Kennedy',6,3,1],
[-33.40533,-70.58599,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 1','Américo Vespucio Norte & Presidente Kennedy',6,2,1],
[-33.40533,-70.58599,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 2','Américo Vespucio Norte & Presidente Kennedy',6,2,1],
[-33.40688,-70.58666,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / PTZ','Américo Vespucio Norte & Cerro Colorado',6,1,1],
[-33.40688,-70.58666,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 1','Américo Vespucio Norte & Cerro Colorado',6,3,1],
[-33.40688,-70.58666,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 2','Américo Vespucio Norte & Cerro Colorado',6,3,1],
[-33.42192,-70.58072,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / PTZ','Américo Vespucio Sur & Martín de Zamora',6,1,1],
[-33.42192,-70.58072,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 1','Américo Vespucio Sur & Martín de Zamora',6,3,1],
[-33.42192,-70.58072,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 2','Américo Vespucio Sur & Martín de Zamora',6,3,1],
[-33.42587,-70.57678,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / PTZ','Américo Vespucio Sur & Isabel La Católica (poniente)',6,1,1],
[-33.42587,-70.57678,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 1','Américo Vespucio Sur & Isabel La Católica (poniente)',6,3,1],
[-33.42587,-70.57678,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 2','Américo Vespucio Sur & Isabel La Católica (poniente)',6,3,1],
[-33.40372,-70.56898,'258 MANQUEHUE NORTE & CERRO EL PLOMO / PTZ','Manquehue Norte & Cerro El Plomo',6,1,1],
[-33.40372,-70.56898,'258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 1','Manquehue Norte & Cerro El Plomo',6,3,1],
[-33.40372,-70.56898,'258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 2','Manquehue Norte & Cerro El Plomo',6,3,1],
[-33.4025,-70.56629,'259 CERRO EL PLOMO & ESTOCOLMO / PTZ','Cerro El Plomo & Estocolmo',6,1,1],
[-33.4025,-70.56629,'259 CERRO EL PLOMO & ESTOCOLMO / FIJA 1','Cerro El Plomo & Estocolmo',6,3,1],
[-33.4025,-70.56629,'259 CERRO EL PLOMO & ESTOCOLMO / FIJA 2','Cerro El Plomo & Estocolmo',6,3,1],
[-33.40385,-70.56551,'260 LOS MILITARES & ESTOCOLMO / PTZ','Los Militares & Estocolmo',6,1,1],
[-33.40385,-70.56551,'260 LOS MILITARES & ESTOCOLMO / FIJA 1','Los Militares & Estocolmo',6,3,1],
[-33.40385,-70.56551,'260 LOS MILITARES & ESTOCOLMO / FIJA 2','Los Militares & Estocolmo',6,3,1],
[-33.4086,-70.57733,'261 LOS MILITARES & LA GLORIA / PTZ','Los Militares & La Gloria',6,1,1],
[-33.4086,-70.57733,'261 LOS MILITARES & LA GLORIA / FIJA 1','Los Militares & La Gloria',6,3,1],
[-33.4086,-70.57733,'261 LOS MILITARES & LA GLORIA / FIJA 2','Los Militares & La Gloria',6,3,1],
[-33.4078,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / PTZ','Alonso de Córdova & O\'Connell',6,1,1],
[-33.4078,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 1','Alonso de Córdova & O\'Connell',6,3,1],
[-33.4078,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 2','Alonso de Córdova & O\'Connell',6,3,1],
[-33.41217,-70.57848,'263 APOQUINDO & PUERTA DEL SOL / PTZ','Apoquindo & Puerta del Sol',6,1,1],
[-33.41217,-70.57848,'263 APOQUINDO & PUERTA DEL SOL / FIJA 1','Apoquindo & Puerta del Sol',6,3,1],
[-33.41217,-70.57848,'263 APOQUINDO & PUERTA DEL SOL / FIJA 2','Apoquindo & Puerta del Sol',6,3,1],
[-33.41063,-70.57325,'264 APOQUINDO & LUIS ZEGERS / PTZ','Apoquindo & Luis Zegers',6,1,1],
[-33.41063,-70.57325,'264 APOQUINDO & LUIS ZEGERS / FIJA 1','Apoquindo & Luis Zegers',6,3,1],
[-33.41063,-70.57325,'264 APOQUINDO & LUIS ZEGERS / FIJA 2','Apoquindo & Luis Zegers',6,3,1],
[-33.41234,-70.56595,'265 MANQUEHUE SUR & EL DIRECTOR / PTZ','Manquehue Sur & El Director',6,1,1],
[-33.41234,-70.56595,'265 MANQUEHUE SUR & EL DIRECTOR / FIJA 1','Manquehue Sur & El Director',6,3,1],
[-33.41234,-70.56595,'265 MANQUEHUE SUR & EL DIRECTOR / FIJA 2','Manquehue Sur & El Director',6,3,1],
[-33.41527,-70.57422,'266 ROSA O\'HIGGINS & DEL INCA / PTZ','Rosa O\'Higgins & Del Inca',6,1,1],
[-33.41527,-70.57422,'266 ROSA O\'HIGGINS & DEL INCA / FIJA 1','Rosa O\'Higgins & Del Inca',6,3,1],
[-33.41527,-70.57422,'266 ROSA O\'HIGGINS & DEL INCA / FIJA 2','Rosa O\'Higgins & Del Inca',6,3,1],
[-33.40791,-70.56341,'267 APOQUINDO & ESTEBAN DELL\'ORTO / PTZ','Apoquindo & Esteban Dell\'Orto',6,1,1],
[-33.40791,-70.56341,'267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 1','Apoquindo & Esteban Dell\'Orto',6,3,1],
[-33.40791,-70.56341,'267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 2','Apoquindo & Esteban Dell\'Orto',6,3,1],
[-33.40443,-70.55683,'268 LAS CONDES & GENERAL CAROL URZÚA / PTZ','Las Condes & General Carol Urzúa',6,1,1],
[-33.40443,-70.55683,'268 268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 1','Las Condes & General Carol Urzúa',6,3,1],
[-33.40443,-70.55683,'268 268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 2','Las Condes & General Carol Urzúa',6,3,1],
[-33.38648,-70.53887,'269 PRESIDENTE KENNEDY 9351 / PTZ','Presidente Kennedy 9351',6,1,1],
[-33.38648,-70.53887,'269 PRESIDENTE KENNEDY 9352 / FIJA 1','Presidente Kennedy 9352',6,3,1],
[-33.38648,-70.53887,'269 PRESIDENTE KENNEDY 9353 / FIJA 2','Presidente Kennedy 9353',6,3,1],
[-33.39237,-70.54314,'270 LAS CONDES & GILBERTO FUENZALIDA / PTZ','Las Condes & Gilberto Fuenzalida',6,1,1],
[-33.39237,-70.54314,'270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 1','Las Condes & Gilberto Fuenzalida',6,3,1],
[-33.39237,-70.54314,'270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 2','Las Condes & Gilberto Fuenzalida',6,3,1],
[-33.40821,-70.54784,'271 APOQUINDO & TALAVERA DE LA REINA / PTZ','Apoquindo & Talavera de La Reina',6,1,1],
[-33.40821,-70.54784,'271 APOQUINDO & TALAVERA DE LA REINA / FIJA 1','Apoquindo & Talavera de La Reina',6,3,1],
[-33.40821,-70.54784,'271 APOQUINDO & TALAVERA DE LA REINA / FIJA 2','Apoquindo & Talavera de La Reina',6,3,1],
[-33.40935,-70.54381,'272 LOS DOMÍNICOS & PATAGONIA / PTZ','Los Domínicos & Patagonia',6,1,1],
[-33.40935,-70.54381,'272 LOS DOMÍNICOS & PATAGONIA / FIJA 1','Los Domínicos & Patagonia',6,3,1],
[-33.40935,-70.54381,'272 LOS DOMÍNICOS & PATAGONIA / FIJA 2','Los Domínicos & Patagonia',6,3,1],
[-33.41269,-70.54748,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / PTZ','Los Domínicos & Santa Magdalena Sofía',6,1,1],
[-33.41269,-70.54748,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 1','Los Domínicos & Santa Magdalena Sofía',6,3,1],
[-33.41269,-70.54748,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 2','Los Domínicos & Santa Magdalena Sofía',6,3,1],
[-33.41131,-70.53877,'274 DIAGUITAS & CERRO MESON ALTO / PTZ','Diaguitas & Cerro Meson Alto',6,1,1],
[-33.41131,-70.53877,'274 DIAGUITAS & CERRO MESON ALTO','Diaguitas & Cerro Meson Alto',6,0,1],
[-33.41131,-70.53877,'274 DIAGUITAS & CERRO MESON ALTO / FIJA 2','Diaguitas & Cerro Meson Alto',6,3,1],
[-33.42323,-70.53479,'275 INCA DE ORO & TOTORALILLO / PTZ','Inca de Oro & Totoralillo',6,1,1],
[-33.42323,-70.53479,'275 INCA DE ORO & TOTORALILLO / FIJA 1','Inca de Oro & Totoralillo',6,3,1],
[-33.42323,-70.53479,'275 INCA DE ORO & TOTORALILLO / FIJA 2','Inca de Oro & Totoralillo',6,3,1],
[-33.39352,-70.53926,'276 PAUL HARRIS ORIENTE & ABADÍA / PTZ','Paul Harris Oriente & Abadía',6,1,1],
[-33.39352,-70.53926,'276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 1','Paul Harris Oriente & Abadía',6,3,1],
[-33.39352,-70.53926,'276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 2','Paul Harris Oriente & Abadía',6,3,1],
[-33.38692,-70.51255,'277 FRANCISCO BULNES CORREA & LOS MONJES / PTZ','Francisco Bulnes Correa & Los Monjes',6,1,1],
[-33.38692,-70.51255,'277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 1','Francisco Bulnes Correa & Los Monjes',6,3,1],
[-33.38692,-70.51255,'277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 2','Francisco Bulnes Correa & Los Monjes',6,3,1],
[-33.39243,-70.49635,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / PTZ','San Francisco de Asís & Genova Oriente',6,1,1],
[-33.39243,-70.49635,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 1','San Francisco de Asís & Genova Oriente',6,3,1],
[-33.39243,-70.49635,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 2','San Francisco de Asís & Genova Oriente',6,3,1],
[-33.40398,-70.51289,'279 SAN RAMÓN & DEL PARQUE / PTZ','San Ramón & Del Parque',6,1,1],
[-33.40398,-70.51289,'279 SAN RAMÓN & DEL PARQUE / FIJA 1','San Ramón & Del Parque',6,3,1],
[-33.40398,-70.51289,'279 SAN RAMÓN & DEL PARQUE / FIJA 2','San Ramón & Del Parque',6,3,1],
[-33.42585,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / PTZ','Sebastián Elcano & Isabel La Católica',6,1,1],
[-33.42585,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 1','Sebastián Elcano & Isabel La Católica',6,3,1],
[-33.42585,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 2','Sebastián Elcano & Isabel La Católica',6,3,1],
[-33.40995,-70.56375,'281 IV CENTENARIO & MARIA TERESA / PTZ','IV Centenario & María Teresa',6,1,1],
[-33.40701,-70.56122,'282 NUESTRA SEÑORA DEL ROSARIO & AV. LAAS CONDES / PTZ','Nuestra Sra del Rosario & Av. Las Condes',6,1,1],
[-33.42721,-70.56357,'283 NUEVA DELHI & LATADIA / PTZ','Nueva Delhi & Latadía',6,1,1],
[-33.42721,-70.56357,'283 NUEVA DELHI & LATADIA / FIJA 1','Nueva Delhi & Latadía',6,3,1],
[-33.42721,-70.56357,'283 NUEVA DELHI & LATADIA / FIJA 2','Nueva Delhi & Latadía',6,3,1],
[-33.41004,-70.53842,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / PTZ','Almirante Soublette & Comodoro Arturo Merino Benitez',6,1,1],
[-33.41004,-70.53842,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 1','Almirante Soublette & Comodoro Arturo Merino Benitez',6,3,1],
[-33.41004,-70.53842,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 2','Almirante Soublette & Comodoro Arturo Merino Benitez',6,3,1],
[-33.41454,-70.53622,'285 LOMA LARGA & LEON BLANCO / PTZ','Loma Larga & Leon Blanco',6,1,1],
[-33.41454,-70.53622,'285 LOMA LARGA & LEON BLANCO / FIJA 1','Loma Larga & Leon Blanco',6,3,1],
[-33.41454,-70.53622,'285 LOMA LARGA & LEON BLANCO / FIJA 2','Loma Larga & Leon Blanco',6,3,1],
[-33.41454,-70.53622,'285 LOMA LARGA & LEON BLANCO / FIJA 3','Loma Larga & Leon Blanco',6,3,1],
[-33.41454,-70.53622,'285 LOMA LARGA & LEON BLANCO / FIJA 4','Loma Larga & Leon Blanco',6,3,1],
[-33.41309,-70.5386,'286 FUEGUINOS & CERRO ALTAR / PTZ','Fueguinos & Cerro Altar',6,1,1],
[-33.41309,-70.5386,'286 FUEGUINOS & CERRO ALTAR / FIJA 1','Fueguinos & Cerro Altar',6,3,1],
[-33.41309,-70.5386,'286 FUEGUINOS & CERRO ALTAR / FIJA 2','Fueguinos & Cerro Altar',6,3,1],
[-33.41282,-70.53754,'287 FUEGUINOS & CERRO NAME / PTZ','Fueguinos & Cerro Name',6,1,1],
[-33.41282,-70.53754,'287 FUEGUINOS & CERRO NAME / FIJA 1','Fueguinos & Cerro Name',6,3,1],
[-33.41282,-70.53754,'287 FUEGUINOS & CERRO NAME / FIJA 2','Fueguinos & Cerro Name',6,3,1],
[-33.40908,-70.54233,'288 PADRE HURTADO & GENERAL BLANCHE / PTZ','Padre Hurtado & General Blanche',6,1,1],
[-33.40313,-70.51722,'289 FRANCISCO BULNES CORREA - GENERAL BLANCHE / PTZ','FRANCISCO BULNES CORREA & GENERAL BLANCHE',6,1,1],
[-33.39962,-70.51033,'290 SAN CARLOS DE APOQUINDO - CAMINO EL ALBA / PTZ','SAN CARLOS DE APOQUINDO & CAMINO EL ALBA',6,1,1],
[-33.39055,-70.51342,'291 CERRO CATEDRAL NORTE & REP DE HONDURAS / PTZ','REPUBLICA DE HONDURAS & CERRO CATEDRAL NORTE',6,1,1],
[-33.42313,-70.58665,'292 MARTIN DE ZAMORA & ALCANTARA PTZ','MARTIN DE ZAMORA & ALCANTARA',6,1,1],
[-33.41382,-70.60661,'293 TITANIUM PTZ','PARQUE TITANIUM',6,1,1],
[-33.41304,-70.60633,'293 TITANIUM FIJA 01','PARQUE TITANIUM',6,3,1],
[-33.41381,-70.60623,'293 TITANIUM FIJA 02','PARQUE TITANIUM',6,3,1],
[-33.4139,-70.60644,'293 TITANIUM FIJA 03','PARQUE TITANIUM',6,3,1],
[-33.4139,-70.60644,'293 TITANIUM FIJA 04','PARQUE TITANIUM',6,3,1],
[-33.42515,-70.56348,'296 ISABEL LA CATOLICA - MANQUEHUE ORIENTE / PTZ','Isabel la Católica & Manquehue Oriente',6,1,1],
[-33.43086,-70.57479,'297 VESPUCIO - BILBAO / LPR 1','Vespucio Poniente & Bilbao',6,2,1],
[-33.43086,-70.57479,'297 VESPUCIO - BILBAO / FIJA 1','Vespucio Poniente & Bilbao',6,3,1],
[-33.43086,-70.57479,'297 VESPUCIO - BILBAO / FIJA 2','Vespucio Poniente & Bilbao',6,3,1],
[-33.41065,-70.57916,'298 LOS MILITARES - ORINOCO / LPR 1','Los Militares & Orinoco',6,2,1],
[-33.41065,-70.57916,'298 LOS MILITARES - ORINOCO / LPR 2','Los Militares & Orinoco',6,2,1],
[-33.41065,-70.57916,'298 LOS MILITARES - ORINOCO / FIJA 1','Los Militares & Orinoco',6,3,1],
[-33.41065,-70.57916,'298 LOS MILITARES - ORINOCO / FIJA 2','Los Militares & Orinoco',6,3,1],
[-33.42387,-70.53145,'RI 01 FLEMING - SANTA ZITA / FISHEYE','FLEMING & SANTA ZITA',7,4,3],
[-33.42387,-70.53145,'RI 01 FLEMING - SANTA ZITA / SOS','FLEMING & SANTA ZITA',7,5,3],
[-33.40909,-70.56798,'RI 02 APOQUINDO - MANQUEHUE / FISHEYE','APOQUINDO & MANQUEHUE',7,4,3],
[-33.40909,-70.56798,'RI 02 APOQUINDO - MANQUEHUE / SOS','APOQUINDO & MANQUEHUE',7,5,3],
[-33.39219,-70.54302,'RI 03 LAS CONDES - GILBERTO FUENZALIDA / FISHEYE','LAS CONDES & GILBERTO FUENZALIDA',7,4,3],
[-33.39219,-70.54302,'RI 03 LAS CONDES - GILBERTO FUENZALIDA / SOS','LAS CONDES & GILBERTO FUENZALIDA',7,5,3],
[-33.41744,-70.59944,'RI 04 APOQUINDO - EL BOSQUE / FISHEYE','APOQUINDO & EL BOSQUE',7,4,3],
[-33.41744,-70.59944,'RI 04 APOQUINDO - EL BOSQUE / SOS','APOQUINDO & EL BOSQUE',7,5,3],
[-33.41706,-70.59756,'RI 05 APOQUINDO - A. LEGUIA SUR / FISHEYE','APOQUINDO & A. LEGUIA SUR',7,4,3],
[-33.41706,-70.59756,'RI 05 APOQUINDO - A. LEGUIA SUR / SOS','APOQUINDO & A. LEGUIA SUR',7,5,3],
[-33.41669,-70.59656,'RI 06 APOQUINDO - A. LEGUIA NORTE / FISHEYE','APOQUINDO & A. LEGUIA NORTE',7,4,3],
[-33.41669,-70.59656,'RI 06 APOQUINDO - A. LEGUIA NORTE / SOS','APOQUINDO & A. LEGUIA NORTE',7,5,3],
[-33.41644,-70.59431,'RI 07 APOQUINDO - E. FOSTER / FISHEYE','APOQUINDO & E. FOSTER',7,4,3],
[-33.41644,-70.59431,'RI 07 APOQUINDO - E. FOSTER / SOS','APOQUINDO & E. FOSTER',7,5,3],
[-33.41505,-70.58725,'RI 08 APOQUINDO - MALAGA / FISHEYE','APOQUINDO & MALAGA',7,4,3],
[-33.41505,-70.58725,'RI 08 APOQUINDO - MALAGA / SOS','APOQUINDO & MALAGA',7,5,3],
[-33.41469,-70.58669,'RI 09 APOQUINDO - GOLDA MEIR / FISHEYE','APOQUINDO & GOLDA MEIR',7,4,3],
[-33.41469,-70.58669,'RI 09 APOQUINDO - GOLDA MEIR / SOS','APOQUINDO & GOLDA MEIR',7,5,3],
[-33.41319,-70.58156,'RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / FISHEYE','APOQUINDO & ESCUELA MILITAR',7,4,3],
[-33.41319,-70.58156,'RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / SOS','APOQUINDO & ESCUELA MILITAR',7,5,3],
[-33.41352,-70.58422,'RI 11 LOS MILITARES - BARCELO / FISHEYE','LOS MILITARES & BARCELO',7,4,3],
[-33.41352,-70.58422,'RI 11 LOS MILITARES - BARCELO / SOS','LOS MILITARES & BARCELO',7,5,3],
[-33.41184,-70.57819,'RI 12 APOQUINDO - ORINOCO / FISHEYE','APOQUINDO & ORINOCO',7,4,3],
[-33.41184,-70.57819,'RI 12 APOQUINDO - ORINOCO / SOS','APOQUINDO & ORINOCO',7,5,3],
[-33.40994,-70.57169,'RI 13 APOQUINDO - BADAJOZ / FISHEYE','APOQUINDO & BADAJOZ',7,4,3],
[-33.40994,-70.57169,'RI 13 APOQUINDO - BADAJOZ / SOS','APOQUINDO & BADAJOZ',7,5,3],
[-33.41395,-70.58566,'RI 14 LOS MILITARES - VESPUCIO / FISHEYE','LOS MILITARES & VESPUCIO',7,4,3],
[-33.41395,-70.58566,'RI 14 LOS MILITARES - VESPUCIO / SOS','LOS MILITARES & VESPUCIO',7,5,3],
[-33.4013,-70.57867,'RI 15 L.KENNEDY - P.ARAUCO / FISHEYE','Av. Pdte. Kennedy Lateral & Parque Araucano',7,4,3],
[-33.4013,-70.57867,'RI 15 L.KENNEDY - P.ARAUCO / SOS','KENNEDY LATERAL & PARQUE ARAUCANO',7,5,3],
[-33.40319,-70.57781,'RI 16 CERRO COLORADO - A. DE CORDOVA / FISHEYE','CERRO COLORADO & A. DE CORDOVA',7,4,3],
[-33.40319,-70.57781,'RI 16 CERRO COLORADO - A. DE CORDOVA / SOS','CERRO COLORADO & A. DE CORDOVA',7,5,3],
[-33.40144,-70.57006,'RI 17 MANQUEHUE - C. COLORADO / FISHEYE','MANQUEHUE & C. COLORADO',7,4,3],
[-33.40144,-70.57006,'RI 17 MANQUEHUE - C. COLORADO / SOS','MANQUEHUE & C. COLORADO',7,5,3],
[-33.40544,-70.56844,'RI 18 MANQUEHUE - LOS MILITARES / FISHEYE','MANQUEHUE & LOS MILITARES',7,4,3],
[-33.40544,-70.56844,'RI 18 MANQUEHUE - LOS MILITARES / SOS','MANQUEHUE & LOS MILITARES',7,5,3],
[-33.40106,-70.55469,'RI 19 LAS CONDES - LAS TRANQUERAS / FISHEYE','LAS CONDES & LAS TRANQUERAS',7,4,3],
[-33.40106,-70.55469,'RI 19 LAS CONDES - LAS TRANQUERAS / SOS','LAS CONDES & LAS TRANQUERAS',7,5,3],
[-33.39856,-70.55152,'RI 20 LAS CONDES - BOCACCIO / FISHEYE','LAS CONDES & BOCACCIO',7,4,3],
[-33.39856,-70.55152,'RI 20 LAS CONDES - BOCACCIO / SOS','LAS CONDES & BOCACCIO',7,5,3],
[-33.39556,-70.54866,'RI 21 LAS CONDES - HOSPITAL FACH / FISHEYE','LAS CONDES & HOSPITAL FACH',7,4,3],
[-33.39556,-70.54866,'RI 21 LAS CONDES - HOSPITAL FACH / SOS','LAS CONDES & HOSPITAL FACH',7,5,3],
[-33.39381,-70.54519,'RI 22 LAS CONDES - P. HURTADO CENTRAL / FISHEYE','LAS CONDES & P. HURTADO CENTRAL',7,4,3],
[-33.39381,-70.54519,'RI 22 LAS CONDES - P. HURTADO CENTRAL / SOS','LAS CONDES & P. HURTADO CENTRAL',7,5,3],
[-33.39035,-70.54143,'RI 23 LAS CONDES - CHARLES HAMILTON / FISHEYE','LAS CONDES & CHARLES HAMILTON',7,4,3],
[-33.39035,-70.54143,'RI 23 LAS CONDES - CHARLES HAMILTON / SOS','LAS CONDES & CHARLES HAMILTON',7,5,3],
[-33.38456,-70.53457,'RI 24 LAS CONDES - RIO MAULE / FISHEYE','LAS CONDES & RIO MAULE',7,4,3],
[-33.38456,-70.53457,'RI 24 LAS CONDES - RIO MAULE / SOS','LAS CONDES & RIO MAULE',7,5,3],
[-33.39631,-70.50381,'RI 25 LAS FLORES - LA PLAZA / FISHEYE','LAS FLORES & LA PLAZA',7,4,3],
[-33.39631,-70.50381,'RI 25 LAS FLORES - LA PLAZA / SOS','LAS FLORES & LA PLAZA',7,5,3],
[-33.40085,-70.50656,'RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / FISHEYE','AV. LA PLAZA & M. ALVARO DE PORTILLO',7,4,3],
[-33.40085,-70.50656,'RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / SOS','AV. LA PLAZA & M. ALVARO DE PORTILLO',7,5,3],
[-33.40056,-70.51344,'RI 27 CAMINO EL ALBA - SAN RAMON / FISHEYE','CAMINO EL ALBA & SAN RAMON',7,4,3],
[-33.40056,-70.51344,'RI 27 CAMINO EL ALBA - SAN RAMON / SOS','CAMINO EL ALBA & SAN RAMON',7,5,3],
[-33.40673,-70.54434,'RI 28 CAMINO EL ALBA - LOS DOMINICOS / FISHEYE','CAMINO EL ALBA & LOS DOMINICOS',7,4,3],
[-33.40673,-70.54434,'RI 28 CAMINO EL ALBA - LOS DOMINICOS / SOS','CAMINO EL ALBA & LOS DOMINICOS',7,5,3],
[-33.40821,-70.54503,'RI 29 PATAGONIA - P. LOS DOMINICOS / FISHEYE','PATAGONIA & P. LOS DOMINICOS',7,4,3],
[-33.40821,-70.54503,'RI 29 PATAGONIA - P. LOS DOMINICOS / SOS','PATAGONIA & P. LOS DOMINICOS',7,5,3],
[-33.40868,-70.54511,'RI 30 PATAGONIA - S. CIUDADANA / FISHEYE','PATAGONIA & S. CIUDADANA',7,4,3],
[-33.40868,-70.54511,'RI 30 PATAGONIA - S. CIUDADANA / SOS','PATAGONIA & S. CIUDADANA',7,5,3],
[-33.40794,-70.54619,'RI 31 APOQUINDO - PARANA / FISHEYE','APOQUINDO & PARANA',7,4,3],
[-33.40794,-70.54619,'RI 31 APOQUINDO - PARANA / SOS','APOQUINDO & PARANA',7,5,3],
[-33.4085,-70.55232,'RI 32 APOQUINDO - TOMAS MORO / FISHEYE','APOQUINDO & TOMAS MORO',7,4,3],
[-33.4085,-70.55232,'RI 32 APOQUINDO - TOMAS MORO / SOS','APOQUINDO & TOMAS MORO',7,5,3],
[-33.40969,-70.54194,'RI 33 PADRE HURTADO - PATAGONIA / FISHEYE','PADRE HURTADO & PATAGONIA',7,4,3],
[-33.40969,-70.54194,'RI 33 PADRE HURTADO - PATAGONIA / SOS','PADRE HURTADO & PATAGONIA',7,5,3],
[-33.41331,-70.54031,'RI 34 PADRE HURTADO - RIO GUADIANA / FISHEYE','PADRE HURTADO & RIO GUADIANA',7,4,3],
[-33.41331,-70.54031,'RI 34 PADRE HURTADO - RIO GUADIANA / SOS','PADRE HURTADO & RIO GUADIANA',7,5,3],
[-33.41606,-70.53369,'RI 35 PAUL HARRIS - LA QUEBRADA / FISHEYE','PAUL HARRIS & LA QUEBRADA',7,4,3],
[-33.41606,-70.53369,'RI 35 PAUL HARRIS - LA QUEBRADA / SOS','PAUL HARRIS & LA QUEBRADA',7,5,3],
[-33.41669,-70.53244,'RI 36 AV. LA ESCUELA - LA QUEBRADA / FISHEYE','AV. LA ESCUELA & LA QUEBRADA',7,4,3],
[-33.41669,-70.53244,'RI 36 AV. LA ESCUELA - LA QUEBRADA / SOS','AV. LA ESCUELA & LA QUEBRADA',7,5,3],
[-33.42094,-70.53769,'RI 37 PADRE HURTADO - PATRICIA / FISHEYE','PADRE HURTADO & PATRICIA',7,4,3],
[-33.42094,-70.53769,'RI 37 PADRE HURTADO - PATRICIA / SOS','PADRE HURTADO & PATRICIA',7,5,3],
[-33.42869,-70.54069,'RI 38 BILBAO - PORTAL LA REINA / FISHEYE','BILBAO & PORTAL LA REINA',7,4,3],
[-33.42869,-70.54069,'RI 38 BILBAO - PORTAL LA REINA / SOS','BILBAO & PORTAL LA REINA',7,5,3],
[-33.42456,-70.54594,'RI 39 FLEMING - IV CENTENARIO / FISHEYE','FLEMING & IV CENTENARIO',7,4,3],
[-33.42456,-70.54594,'RI 39 FLEMING - IV CENTENARIO / SOS','FLEMING & IV CENTENARIO',7,5,3],
[-33.42494,-70.54944,'RI 40 FLEMING - FRENTE CLINICA CORDILLERA / FISHEYE','FLEMING & FRENTE CLINICA CORDILLERA',7,4,3],
[-33.42494,-70.54944,'RI 40 FLEMING - FRENTE CLINICA CORDILLERA / SOS','FLEMING & FRENTE CLINICA CORDILLERA',7,5,3],
[-33.42507,-70.55003,'RI 41 FLEMING - CLINICA CORDILLERA / FISHEYE','FLEMING & CLINICA CORDILLERA',7,4,3],
[-33.42507,-70.55003,'RI 41 FLEMING - CLINICA CORDILLERA / SOS','FLEMING & CLINICA CORDILLERA',7,5,3],
[-33.42573,-70.55403,'RI 42 TOMAS MORO - FLEMING / FISHEYE','TOMAS MORO & FLEMING',7,4,3],
[-33.42573,-70.55403,'RI 42 TOMAS MORO - FLEMING / SOS','TOMAS MORO & FLEMING',7,5,3],
[-33.4253,-70.55343,'RI 43 FLEMING - TOMAS MORO / FISHEYE','FLEMING & TOMAS MORO',7,4,3],
[-33.4253,-70.55343,'RI 43 FLEMING - TOMAS MORO / SOS','FLEMING & TOMAS MORO',7,5,3],
[-33.42244,-70.55344,'RI 44 TOMAS MORO - ALONSO DE CAMARGO / FISHEYE','TOMAS MORO & ALONSO DE CAMARGO',7,4,3],
[-33.42244,-70.55344,'RI 44 TOMAS MORO - ALONSO DE CAMARGO / SOS','TOMAS MORO & ALONSO DE CAMARGO',7,5,3],
[-33.41744,-70.55781,'RI 45 COLON - PIACENZA / FISHEYE','COLON & PIACENZA',7,4,3],
[-33.41744,-70.55781,'RI 45 COLON - PIACENZA / SOS','COLON & PIACENZA',7,5,3],
[-33.41706,-70.56006,'RI 46 COLON - H. DE MAGALLANES / FISHEYE','COLON & H. DE MAGALLANES',7,4,3],
[-33.41706,-70.56006,'RI 46 COLON - H. DE MAGALLANES / SOS','COLON & H. DE MAGALLANES',7,5,3],
[-33.41644,-70.56444,'RI 47 COLON - MANQUEHUE / FISHEYE','COLON & MANQUEHUE',7,4,3],
[-33.41644,-70.56444,'RI 47 COLON - MANQUEHUE / SOS','COLON & MANQUEHUE',7,5,3],
[-33.41857,-70.57161,'RI 48 COLON - SEBASTIAN ELCANO / FISHEYE','COLON & SEBASTIAN ELCANO',7,4,3],
[-33.41857,-70.57161,'RI 48 COLON - SEBASTIAN ELCANO / SOS','COLON & SEBASTIAN ELCANO',7,5,3],
[-33.42337,-70.57883,'RI 49 COLON - VESPUCIO / FISHEYE','COLON & VESPUCIO',7,4,3],
[-33.42337,-70.57883,'RI 49 COLON - VESPUCIO / SOS','COLON & VESPUCIO',7,5,3],
[-33.42363,-70.5787,'RI 50 VESPUCIO SUR - COLON / FISHEYE','VESPUCIO SUR & COLON',7,4,3],
[-33.42363,-70.5787,'RI 50 VESPUCIO SUR - COLON / SOS','VESPUCIO SUR & COLON',7,5,3],
[-33.41586,-70.5342,'RI 51 PAUL HARRIS - COLON / FISHEYE','PAUL HARRIS & COLON',7,4,3],
[-33.41586,-70.5342,'RI 51 PAUL HARRIS - COLON / SOS','PAUL HARRIS & COLON',7,5,3],
[-33.43024,-70.55387,'RI 52 BILBAO / TOMAS MORO / FISHEYE','BILBAO & TOMAS MORO',7,4,3],
[-33.43024,-70.55387,'RI 52 BILBAO / TOMAS MORO / SOS','BILBAO & TOMAS MORO',7,5,3],
[-33.39495,-70.56174,'RI 53 KENNEDY / GERONIMO ALDERETE / FISHEYE','KENNEDY & GERONIMO ALDERETE',7,4,3],
[-33.39495,-70.56174,'RI 53 KENNEDY / GERONIMO ALDERETE / SOS','KENNEDY & GERONIMO ALDERETE',7,5,3],
[-33.39213,-70.55361,'RI 54 KENNEDY / LAS TRANQUERAS / FISHEYE','KENNEDY & LAS TRANQUERAS',7,4,3],
[-33.39213,-70.55361,'RI 54 KENNEDY / LAS TRANQUERAS / SOS','KENNEDY & LAS TRANQUERAS',7,5,3],
[-33.373,-70.51807,'RI 55 LAS CONDES / CANTAGALLO / FISHEYE','LAS CONDES & CANTAGALLO',7,4,3],
[-33.373,-70.51807,'RI 55 LAS CONDES / CANTAGALLO / SOS','LAS CONDES & CANTAGALLO',7,5,3],
[-33.37346,-70.5171,'RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / FISHEYE','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS',7,4,3],
[-33.37346,-70.5171,'RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / SOS','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS',7,5,3],
[-33.43103,-70.56957,'RI 57 BILBAO / SEBASTIAN EL CANO / FISHEYE','BILBAO & SEBASTIAN EL CANO',7,4,3],
[-33.43103,-70.56957,'RI 57 BILBAO / SEBASTIAN EL CANO / SOS','BILBAO & SEBASTIAN EL CANO',7,5,3],
[-33.4314,-70.58073,'RI 58 BILBAO / ALCANTARA / FISHEYE','BILBAO & ALCANTARA',7,4,3],
[-33.4314,-70.58073,'RI 58 BILBAO / ALCANTARA / SOS','BILBAO & ALCANTARA',7,5,3],
[-33.42909,-70.57472,'RI 59 MANUEL BARRIOS / VESPUCIO / FISHEYE','MANUEL BARRIOS & VESPUCIO',7,4,3],
[-33.42909,-70.57472,'RI 59 MANUEL BARRIOS / VESPUCIO / SOS','MANUEL BARRIOS & VESPUCIO',7,5,3],
[-33.36972,-70.50455,'RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / FISHEYE','AV. LAS CONDES & SAN JOSE DE LA SIERRA',7,4,3],
[-33.36972,-70.50455,'RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / SOS','AV. LAS CONDES & SAN JOSE DE LA SIERRA',7,5,3],
[-33.40503,-70.55747,'PI 01 LAS CONDES - CAROL URZUA / PTZ','Av. Las condes &Carol Urzua',8,1,2],
[-33.40503,-70.55747,'PI 01 LAS CONDES - CAROL URZUA / SOS','Av. Las condes & Carol Urzua',8,5,2],
[-33.40503,-70.55747,'PI 01 LAS CONDES - CAROL URZUA / PARLANTE','Av. Las condes & Carol Urzua',8,6,2],
[-33.41747,-70.54597,'PI 02 COLON - FUENTEOVEJUNA / PTZ','C. Colon & Fuenteovejuna',8,1,2],
[-33.41747,-70.54597,'PI 02 COLON - FUENTEOVEJUNA / SOS','C. Colon & Fuenteovejuna',8,5,2],
[-33.41747,-70.54597,'PI 02 COLON - FUENTEOVEJUNA / PARLANTE','C. Colon & Fuenteovejuna',8,6,2],
[-33.41461,-70.53736,'PI 04 DIAGUITAS - ATACAMEÑOS / PTZ','Diaguitas & Atacameños',8,1,2],
[-33.41461,-70.53736,'PI 04 DIAGUITAS - ATACAMEÑOS / SOS','Diaguitas & Atacameños',8,5,2],
[-33.41461,-70.53736,'PI 04 DIAGUITAS - ATACAMEÑOS / PARLANTE','Diaguitas & Atacameños',8,6,2],
[-33.42833,-70.55106,'PI 05 F BARRIOS . M CLARO VIAL / PTZ','Florencio Barrios & Miguel Claro Vial',8,1,2],
[-33.42833,-70.55106,'PI 05 F BARRIOS . M CLARO VIAL / SOS','Florencio Barrios & Miguel Claro Vial',8,5,2],
[-33.42833,-70.55106,'PI 05 F BARRIOS . M CLARO VIAL / PARLANTE','Florencio Barrios & Miguel Claro Vial',8,6,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / PTZ','IV Centenario & Alejandro Fleming',8,1,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / SOS','IV Centenario & Alejandro Fleming',8,5,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / PARLANTE','IV Centenario & Alejandro Fleming',8,6,2],
[-33.42364,-70.54653,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / PTZ','IV Centenario & Fuenteovejuna',8,1,2],
[-33.42364,-70.54653,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / SOS','IV Centenario & Fuenteovejuna',8,5,2],
[-33.42364,-70.54653,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / PARLANTE','IV Centenario & Fuenteovejuna',8,6,2],
[-33.40106,-70.55517,'PI 08 LAS CONDES - LAS TRANQUERAS / PTZ','Las Tranqueras & Av. Las condes',8,1,2],
[-33.40106,-70.55517,'PI 08 LAS CONDES - LAS TRANQUERAS / SOS','Las Tranqueras & Av. Las condes',8,5,2],
[-33.40106,-70.55517,'PI 08 LAS CONDES - LAS TRANQUERAS / PARLANTE','Las Tranqueras & Av. Las condes',8,6,2],
[-33.41267,-70.53628,'PI 09 FUEGUINOS - PATAGONES / PTZ','Los Fueguinos & Patagones',8,1,2],
[-33.41267,-70.53628,'PI 09 FUEGUINOS - PATAGONES / SOS','Los Fueguinos & Patagones',8,5,2],
[-33.41267,-70.53628,'PI 09 FUEGUINOS - PATAGONES / PARLANTE','Los Fueguinos & Patagones',8,6,2],
[-33.41447,-70.53569,'PI 10 MAPUCHES - HUALTECAS / PTZ','Los mapuches & Las Hualtecas',8,1,2],
[-33.41447,-70.53569,'PI 10 MAPUCHES - HUALTECAS / SOS','Los mapuches & Las Hualtecas',8,5,2],
[-33.41447,-70.53569,'PI 10 MAPUCHES - HUALTECAS / PARLANTE','Los mapuches & Las Hualtecas',8,6,2],
[-33.42153,-70.53561,'PI 11 LOS VILOS - PEÑUELAS / PTZ','Los Vilos & Peñuelas',8,1,2],
[-33.42153,-70.53561,'PI 11 LOS VILOS - PEÑUELAS / SOS','Los Vilos & Peñuelas',8,5,2],
[-33.42153,-70.53561,'PI 11 LOS VILOS - PEÑUELAS / PARLANTE','Los Vilos & Peñuelas',8,6,2],
[-33.41811,-70.53575,'PI 12 LOS VILOS - SOCOMPA / PTZ','Los Vilos & Socompa',8,1,2],
[-33.41811,-70.53575,'PI 12 LOS VILOS - SOCOMPA / SOS','Los Vilos & Socompa',8,5,2],
[-33.41811,-70.53575,'PI 12 LOS VILOS - SOCOMPA / PARLANTE','Los Vilos & Socompa',8,6,2],
[-33.42886,-70.55372,'PI 13 M CLARO VIAL - CALEU / PTZ','Miguel Claro Vial & Caleu',8,1,2],
[-33.42886,-70.55372,'PI 13 M CLARO VIAL - CALEU / SOS','Miguel Claro Vial & Caleu',8,5,2],
[-33.42886,-70.55372,'PI 13 M CLARO VIAL - CALEU / PARLANTE','Miguel Claro Vial & Caleu',8,6,2],
[-33.42036,-70.53036,'PI 14 MARISOL - ROSITA / PTZ','Marisol & Rosita',8,1,2],
[-33.42036,-70.53036,'PI 14 MARISOL - ROSITA / SOS','Marisol & Rosita',8,5,2],
[-33.42036,-70.53036,'PI 14 MARISOL - ROSITA / PARLANTE','Marisol & Rosita',8,6,2],
[-33.403,-70.57403,'PI 15 PARQUE ARAUCANO CENTRAL / PTZ','Parque Araucano Central',8,1,2],
[-33.403,-70.57403,'PI 15 PARQUE ARAUCANO CENTRAL / SOS','Parque Araucano Central',8,5,2],
[-33.403,-70.57403,'PI 15 PARQUE ARAUCANO CENTRAL / PARLANTE','Parque Araucano Central',8,6,2],
[-33.403,-70.57258,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / PTZ','Parque Araucano Z. Deportiva',8,1,2],
[-33.403,-70.57258,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / SOS','Parque Araucano Z. Deportiva',8,5,2],
[-33.403,-70.57258,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / PARLANTE','Parque Araucano Z. Deportiva',8,6,2],
[-33.40406,-70.57678,'PI 17 PARQUE ARAUCANO PONIENTE / PTZ','Parque Araucano Poniente',8,1,2],
[-33.40406,-70.57678,'PI 17 PARQUE ARAUCANO PONIENTE / SOS','Parque Araucano Poniente',8,5,2],
[-33.40406,-70.57678,'PI 17 PARQUE ARAUCANO PONIENTE / PARLANTE','Parque Araucano Poniente',8,6,2],
[-33.40142,-70.57058,'PI 16 PARQUE ARAUCANO SKATEPARK / PTZ','Parque Araucano Oriente (skatepark)',8,1,2],
[-33.40142,-70.57058,'PI 16 PARQUE ARAUCANO SKATEPARK /SOS','Parque Araucano Oriente (skatepark)',8,5,2],
[-33.40142,-70.57058,'PI 16 PARQUE ARAUCANO SKATEPARK /PARLANTE','Parque Araucano Oriente (skatepark)',8,6,2],
[-33.40489,-70.54764,'PI 19 PARQUE MONTEGRANDE NORTE / PTZ','Parque Montegrande Norte',8,1,2],
[-33.40489,-70.54764,'PI 19 PARQUE MONTEGRANDE NORTE / SOS','Parque Montegrande Norte',8,5,2],
[-33.40489,-70.54764,'PI 19 PARQUE MONTEGRANDE NORTE / PARLANTE','Parque Montegrande Norte',8,6,2],
[-33.40636,-70.54833,'PI 20 PARQUE MONTEGRANDE / PTZ','Parque Montegrande II',8,1,2],
[-33.40636,-70.54833,'PI 20 PARQUE MONTEGRANDE / SOS','Parque Montegrande II',8,5,2],
[-33.40636,-70.54833,'PI 20 PARQUE MONTEGRANDE / PARLANTE','Parque Montegrande II',8,6,2],
[-33.42986,-70.54847,'PI 21 BILBAO - DUQUECO / PTZ','Plaza Bilbao & Duqueco',8,1,2],
[-33.42986,-70.54847,'PI 21 BILBAO - DUQUECO / SOS','Plaza Bilbao & Duqueco',8,5,2],
[-33.42986,-70.54847,'PI 21 BILBAO - DUQUECO / PARLANTE','Plaza Bilbao & Duqueco',8,6,2],
[-33.42925,-70.54297,'PI 22 BILBAO - IV CENTENARIO / SOS','Plaza Bilbao & Enrique Bunster',8,5,2],
[-33.42925,-70.54297,'PI 22 BILBAO - IV CENTENARIO / PTZ','Plaza Bilbao & Enrique Bunster',8,1,2],
[-33.42925,-70.54297,'PI 22 BILBAO - IV CENTENARIO / PARLANTE','Plaza Bilbao & Enrique Bunster',8,6,2],
[-33.41406,-70.55872,'PI 23 IV CENTENARIO - H DE MAGALLANES / PTZ','Plaza IV Centenario & H. Magallanes',8,1,2],
[-33.41406,-70.55872,'PI 23 IV CENTENARIO - H DE MAGALLANES / SOS','Plaza IV Centenario & H. Magallanes',8,5,2],
[-33.41406,-70.55872,'PI 23 IV CENTENARIO - H DE MAGALLANES / PARLANTE','Plaza IV Centenario & H. Magallanes',8,6,2],
[-33.40819,-70.55597,'PI 24 METRO H DE MAGALLANES / PTZ','Apoquindo & Hernando de magallanes',8,1,2],
[-33.40819,-70.55597,'PI 24 METRO H DE MAGALLANES / SOS','Apoquindo & Hernando de magallanes',8,5,2],
[-33.40819,-70.55597,'PI 24 METRO H DE MAGALLANES / PARLANTE','Apoquindo & Hernando de magallanes',8,6,2],
[-33.42042,-70.53517,'PI 25 PATRICIA & LOS VILOS / PTZ','Plaza Patricia & Los vilos',8,1,2],
[-33.42042,-70.53517,'PI 25 PATRICIA & LOS VILOS / SOS','Plaza Patricia & Los vilos',8,5,2],
[-33.42042,-70.53517,'PI 25 PATRICIA & LOS VILOS / PARLANTE','Plaza Patricia & Los vilos',8,6,2],
[-33.42575,-70.53297,'PI 26 VIA LACTEA - CIRIO / PTZ','Via Lactea & Cirio',8,1,2],
[-33.42575,-70.53297,'PI 26 VIA LACTEA - CIRIO / SOS','Via Lactea & Cirio',8,5,2],
[-33.42575,-70.53297,'PI 26 VIA LACTEA - CIRIO / PARLANTE','Via Lactea & Cirio',8,6,2],
[-33.42567,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / PTZ','Via Lactea & Padre Hurtado',8,1,2],
[-33.42567,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / SOS','Via Lactea & Padre Hurtado',8,5,2],
[-33.42567,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / PARLANTE','Via Lactea & Padre Hurtado',8,6,2],
[-33.41789,-70.55253,'PI 28 ROTONDA ATENAS - PETROBRAS / PTZ','Cristobal Colón & Los Dominicos',8,1,2],
[-33.41789,-70.55253,'PI 28 ROTONDA ATENAS - PETROBRAS / SOS','Cristobal Colón & Los Dominicos',8,5,2],
[-33.41789,-70.55253,'PI 28 ROTONDA ATENAS - PETROBRAS / PARLANTE','Cristobal Colón & Los Dominicos',8,6,2],
[-33.41484,-70.59847,'PI 32 CARMENCITA & DON CARLOS / PTZ','Carmencita & Don carlos',8,1,2],
[-33.41484,-70.59847,'PI 32 CARMENCITA & DON CARLOS / SOS','Carmencita & Don carlos',8,5,2],
[-33.41484,-70.59847,'PI 32 CARMENCITA & DON CARLOS / PARLANTE','Carmencita & Don carlos',8,6,2],
[-33.42026,-70.58937,'PI 37 PDTE ERRAZURIZ & POLONIA / PTZ','Presidente Errazuriz & Polonia',8,1,2],
[-33.42026,-70.58937,'PI 37 PDTE ERRAZURIZ & POLONIA / SOS','Presidente Errazuriz & Polonia',8,5,2],
[-33.42026,-70.58937,'PI 37 PDTE ERRAZURIZ & POLONIA / PARLANTE','Presidente Errazuriz & Polonia',8,6,2],
[-33.41334,-70.57048,'PI 38 LA CAPITANIA & DEL INCA / PTZ','Plaza La Capitania / Del Inca',8,1,2],
[-33.41334,-70.57048,'PI 38 LA CAPITANIA & DEL INCA / SOS','Plaza La Capitania / Del Inca',8,5,2],
[-33.41334,-70.57048,'PI 38 LA CAPITANIA & DEL INCA / PARLANTE','Plaza La Capitania / Del Inca',8,6,2],
[-33.42806,-70.58519,'PI 39 TARRAGONA & ALCANTARA / PTZ','Tarragona & Alcantara',8,1,2],
[-33.42806,-70.58519,'PI 39 TARRAGONA & ALCANTARA / SOS','Tarragona & Alcantara',8,5,2],
[-33.42806,-70.58519,'PI 39 TARRAGONA & ALCANTARA / PARLANTE','Tarragona & Alcantara',8,6,2],
[-33.41705,-70.54044,'PI 40 COLÓN & VISVIRI / PTZ','Cristobal colón & Visviri',8,1,2],
[-33.41705,-70.54044,'PI 40 COLÓN & VISVIRI / SOS','Cristobal colón & Visviri',8,5,2],
[-33.41705,-70.54044,'PI 40 COLÓN & VISVIRI / PARLANTE','Cristobal colón & Visviri',8,6,2],
[-33.42688,-70.57904,'PI 41 FDO DE ARAGON & CARLOS V / PTZ','Fernando de Aragon & Carlos V',8,1,2],
[-33.42688,-70.57904,'PI 41 FDO DE ARAGON & CARLOS V / SOS','Fernando de Aragon & Carlos V',8,5,2],
[-33.42688,-70.57904,'PI 41 FDO DE ARAGON & CARLOS V / PARLANTE','Fernando de Aragon & Carlos V',8,6,2],
[-33.42789,-70.57003,'PI 42 MANUEL BARRIOS & LATADIA / PTZ','Manuel Barrios & Latadia',8,1,2],
[-33.42789,-70.57003,'PI 42 MANUEL BARRIOS & LATADIA / SOS','Manuel Barrios & Latadia',8,5,2],
[-33.42789,-70.57003,'PI 42 MANUEL BARRIOS & LATADIA / PARLANTE','Manuel Barrios & Latadia',8,6,2],
[-33.42624,-70.56428,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / PTZ','Juan Esteban Montero & Manquehue',8,1,2],
[-33.42624,-70.56428,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / SOS','Juan Esteban Montero & Manquehue',8,5,2],
[-33.42624,-70.56428,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / PARLANTE','Juan Esteban Montero & Manquehue',8,6,2],
[-33.42063,-70.57069,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / PTZ','Martin Alonso Pinzon & Sebastian Elcano',8,1,2],
[-33.42063,-70.57069,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / SOS','Martin Alonso Pinzon & Sebastian Elcano',8,5,2],
[-33.42063,-70.57069,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / PARLANTE','Martin Alonso Pinzon & Sebastian Elcano',8,6,2],
[-33.42426,-70.56414,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / PTZ','Ingeniero Pedro Blanquier & Manquehue sur',8,1,2],
[-33.42426,-70.56414,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / SOS','Ingeniero Pedro Blanquier & Manquehue sur',8,5,2],
[-33.42426,-70.56414,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / PARLANTE','Ingeniero Pedro Blanquier & Manquehue sur',8,6,2],
[-33.4198,-70.56757,'PI 46 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / PTZ','Domingo Bondi & Martín Alonso Pinzón',8,1,2],
[-33.4198,-70.56757,'PI 45 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / SOS','Domingo Bondi & Martín Alonso Pinzón',8,5,2],
[-33.4198,-70.56757,'PI 45 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / PARLANTE','Domingo Bondi & Martín Alonso Pinzón',8,6,2],
[-33.41418,-70.58364,'PI 47 VESPUCIO & APOQUINDO / PTZ','Americo Vespucio Norte & Apoquindo',8,1,2],
[-33.41418,-70.58364,'PI 47 VESPUCIO & APOQUINDO / SOS','Americo Vespucio Norte & Apoquindo',8,5,2],
[-33.41418,-70.58364,'PI 47 VESPUCIO & APOQUINDO / PARLANTE','Americo Vespucio Norte & Apoquindo',8,6,2],
[-33.41784,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / PTZ','Cruz del Sur & del Inca',8,1,2],
[-33.41784,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / SOS','Cruz del Sur & del Inca',8,5,2],
[-33.41784,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / PARLANTE','Cruz del Sur & del Inca',8,6,2],
[-33.4112,-70.57509,'PI 49 COIMBRA & ROSA O\'HIGGINS / PTZ','Coimbra & Rosa O\'higgins',8,1,2],
[-33.4112,-70.57509,'PI 49 COIMBRA & ROSA O\'HIGGINS / SOS','Coimbra & Rosa O\'higgins',8,5,2],
[-33.4112,-70.57509,'PI 49 COIMBRA & ROSA O\'HIGGINS / PARLANTE','Coimbra & Rosa O\'higgins',8,6,2],
[-33.40946,-70.5691,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / PTZ','Apoquindo & Mar de los Sargazos',8,1,2],
[-33.40946,-70.5691,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / SOS','Apoquindo & Mar de los Sargazos',8,5,2],
[-33.40946,-70.5691,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / PARLANTE','Apoquindo & Mar de los Sargazos',8,6,2],
[-33.42484,-70.55954,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / PTZ','Av Alejandro Fleming & Isabel La Católica',8,1,2],
[-33.42484,-70.55954,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / SOS','Av Alejandro Fleming & Isabel La Católica',8,5,2],
[-33.42484,-70.55954,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / PARLANTE','Av Alejandro Fleming & Isabel La Católica',8,6,2],
[-33.40031,-70.56771,'PI 52 RIESCO & MANQUEHUE / PTZ','Presidente Riesco & Manquehue Norte',8,1,2],
[-33.40031,-70.56771,'PI 52 RIESCO & MANQUEHUE / SOS','Presidente Riesco & Manquehue Norte',8,5,2],
[-33.40031,-70.56771,'PI 52 RIESCO & MANQUEHUE / PARLANTE','Presidente Riesco & Manquehue Norte',8,6,2],
[-33.39723,-70.56692,'PI 53 KENNEDY & BRASILIA / PTZ','Presidente Kennedy & Brasilia',8,1,2],
[-33.39723,-70.56692,'PI 53 KENNEDY & BRASILIA / SOS','Presidente Kennedy & Brasilia',8,5,2],
[-33.39723,-70.56692,'PI 53 KENNEDY & BRASILIA / PARLANTE','Presidente Kennedy & Brasilia',8,6,2],
[-33.39758,-70.55865,'PI 54 MAR DE CORAL & GARCIA PICA / PTZ','Mar de Coral & Garcia Pica',8,1,2],
[-33.39758,-70.55865,'PI 54 MAR DE CORAL & GARCIA PICA / SOS','Mar de Coral & Garcia Pica',8,5,2],
[-33.39758,-70.55865,'PI 54 MAR DE CORAL & GARCIA PICA / PARLANTE','Mar de Coral & Garcia Pica',8,6,2],
[-33.39863,-70.55353,'PI 56 SOR JOSEFA & LAS VERBENAS / PTZ','Sor Josefa & Las Verbenas',8,1,2],
[-33.39863,-70.55353,'PI 56 SOR JOSEFA & LAS VERBENAS / SOS','Sor Josefa & Las Verbenas',8,5,2],
[-33.39863,-70.55353,'PI 56 SOR JOSEFA & LAS VERBENAS / PARLANTE','Sor Josefa & Las Verbenas',8,6,2],
[-33.41654,-70.555,'PI 58 LOS POZOS & IV CENTENARIO / PTZ','Los Pozos & Cuarto Centenario',8,1,2],
[-33.41654,-70.555,'PI 58 LOS POZOS & IV CENTENARIO / SOS','Los Pozos & Cuarto Centenario',8,5,2],
[-33.41654,-70.555,'PI 58 LOS POZOS & IV CENTENARIO / PARLANTE','Los Pozos & Cuarto Centenario',8,6,2],
[-33.4224,-70.5533,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / PTZ','Alonso de Camargo & Tomas Moro',8,1,2],
[-33.4224,-70.5533,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / SOS','Alonso de Camargo & Tomas Moro',8,5,2],
[-33.4224,-70.5533,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / PARLANTE','Alonso de Camargo & Tomas Moro',8,6,2],
[-33.42138,-70.55063,'PI 61 TEZCUCO & PRETORIA / PTZ','Tezcuco & Pretoria',8,1,2],
[-33.42138,-70.55063,'PI 61 TEZCUCO & PRETORIA / SOS','Tezcuco & Pretoria',8,5,2],
[-33.42138,-70.55063,'PI 61 TEZCUCO & PRETORIA / PARLANTE','Tezcuco & Pretoria',8,6,2],
[-33.41811,-70.54902,'PI 62 COLON & VIZCAYA / PTZ','Cristobal Colón & Vizcaya',8,1,2],
[-33.41811,-70.54902,'PI 62 COLON & VIZCAYA / SOS','Cristobal Colón & Vizcaya',8,5,2],
[-33.41811,-70.54902,'PI 62 COLON & VIZCAYA / PARLANTE','Cristobal Colón & Vizcaya',8,6,2],
[-33.41578,-70.55204,'PI 63 TINGUIRIRICA & MONROE / PTZ','Tinguiririca & Monroe',8,1,2],
[-33.41578,-70.55204,'PI 63 TINGUIRIRICA & MONROE / SOS','Tinguiririca & Monroe',8,5,2],
[-33.41578,-70.55204,'PI 63 TINGUIRIRICA & MONROE / PARLANTE','Tinguiririca & Monroe',8,6,2],
[-33.41586,-70.54249,'PI 64 ISLOTE SNIPE & RIO TAMESIS / PTZ','Islote Snipe & Rio Tamesis',8,1,2],
[-33.41586,-70.54249,'PI 64 ISLOTE SNIPE & RIO TAMESIS / SOS','Islote Snipe & Rio Tamesis',8,5,2],
[-33.41586,-70.54249,'PI 64 ISLOTE SNIPE & RIO TAMESIS / PARLANTE','Islote Snipe & Rio Tamesis',8,6,2],
[-33.41477,-70.54215,'PI 65 TALAVERA DE LA REINA & RIO CONGO / PTZ','Talavera de la Teina & Rio Congo',8,1,2],
[-33.41477,-70.54215,'PI 65 TALAVERA DE LA REINA & RIO CONGO / SOS','Talavera de la Teina & Rio Congo',8,5,2],
[-33.41477,-70.54215,'PI 65 TALAVERA DE LA REINA & RIO CONGO / PARLANTE','Talavera de la Teina & Rio Congo',8,6,2],
[-33.3945,-70.5412,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / PTZ','Cardenal Newman & Punta del Este',8,1,2],
[-33.3945,-70.5412,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / SOS','Cardenal newman & Punta del este',8,5,2],
[-33.3945,-70.5412,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / PARLANTE','Cardenal newman & Punta del este',8,6,2],
[-33.40823,-70.53774,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / PTZ','Viejos Estandartes & General Blanche',8,1,2],
[-33.40823,-70.53774,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / SOS','Viejos Estandartes & General Blanche',8,5,2],
[-33.40823,-70.53774,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / PARLANTE','Viejos Estandartes & General Blanche',8,6,2],
[-33.37327,-70.51844,'PI 71 NUEVA LAS CONDES & LAS CONDES / PTZ','Nueva Las Condes & Las Condes',8,1,2],
[-33.37327,-70.51844,'PI 71 NUEVA LAS CONDES & LAS CONDES / SOS','Nueva Las Condes & Las Condes',8,5,2],
[-33.37327,-70.51844,'PI 71 NUEVA LAS CONDES & LAS CONDES / PARLANTE','Nueva Las Condes & Las Condes',8,6,2],
[-33.40686,-70.53536,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / PTZ','General Blanche & Luis Matte Larrain',8,1,2],
[-33.40686,-70.53536,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / SOS','General Blanche & Luis Matte Larrain',8,5,2],
[-33.40686,-70.53536,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / PARLANTE','General Blanche & Luis Matte Larrain',8,6,2],
[-33.41345,-70.5417,'PI 75 RIO GUADIANA & LONTANANZA / PTZ','Rio Guadiana & Lontananza',8,1,2],
[-33.41345,-70.5417,'PI 75 RIO GUADIANA & LONTANANZA / SOS','Rio Guadiana & Lontananza',8,5,2],
[-33.41345,-70.5417,'PI 75 RIO GUADIANA & LONTANANZA / PARLANTE','Rio Guadiana & Lontananza',8,6,2],
[-33.41275,-70.54137,'PI 76 LA RECOBA & EL TORRENTE / PTZ','La Recoba & El Torrente',8,1,2],
[-33.41275,-70.54137,'PI 76 LA RECOBA & EL TORRENTE / SOS','La Recoba & El Torrente',8,5,2],
[-33.41275,-70.54137,'PI 76 LA RECOBA & EL TORRENTE / PARLANTE','La Recoba & El Torrente',8,6,2],
[-33.41676,-70.52984,'PI 77 LA QUEBRADA & VITAL APOQUINDO / PTZ','La Quebrada & Vital apoquindo',8,1,2],
[-33.41676,-70.52984,'PI 77 LA QUEBRADA & VITAL APOQUINDO / SOS','La Quebrada & Vital apoquindo',8,5,2],
[-33.41676,-70.52984,'PI 77 LA QUEBRADA & VITAL APOQUINDO / PARLANTE','La Quebrada & Vital apoquindo',8,6,2],
[-33.42066,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / PTZ','Rivadavia & Incahuasi',8,1,2],
[-33.42066,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / SOS','Rivadavia & Incahuasi',8,5,2],
[-33.42066,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / PARLANTE','Rivadavia & Incahuasi',8,6,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / PTZ','Padre Hurtado Sur & Inca de Oro',8,1,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / SOS','Padre Hurtado Sur & Inca de Oro',8,5,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / PARLANTE','Padre Hurtado Sur & Inca de Oro',8,6,2],
[-33.4264,-70.53746,'PI 81 ALTAIR & PLAZA ALTAIR / PTZ','Altair & Altair',8,1,2],
[-33.4264,-70.53746,'PI 81 ALTAIR & PLAZA ALTAIR / SOS','Altair & Altair',8,5,2],
[-33.4264,-70.53746,'PI 81 ALTAIR & PLAZA ALTAIR / PARLANTE','Altair & Altair',8,6,2],
[-33.41212,-70.50773,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña otaegui',8,1,2],
[-33.41212,-70.50773,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / SOS','Quebrada Honda & Carlos Peña otaegui',8,5,2],
[-33.41212,-70.50773,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / PARLANTE','Quebrada Honda & Carlos Peña otaegui',8,6,2],
[-33.40241,-70.51035,'PI 84 DEL PARQUE & SANTOS APOSTOLES / PTZ','Del Parque & Santos Apostoles',8,1,2],
[-33.40241,-70.51035,'PI 84 DEL PARQUE & SANTOS APOSTOLES / SOS','Del Parque & Santos Apostoles',8,5,2],
[-33.40241,-70.51035,'PI 84 DEL PARQUE & SANTOS APOSTOLES / PARLANTE','Del Parque & Santos Apostoles',8,6,2],
[-33.41144,-70.52051,'PI 85 CARLOS PEÑA & LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas',8,1,2],
[-33.41144,-70.52051,'PI 85 CARLOS PEÑA & LAS CONDESAS / SOS','Carlos Peña Otaegui & Las Condesas',8,5,2],
[-33.41144,-70.52051,'PI 85 CARLOS PEÑA & LAS CONDESAS / PARLANTE','Carlos Peña Otaegui & Las Condesas',8,6,2],
[-33.38964,-70.50769,'PI 87 LOS MONJES EL CONVENTO / PTZ','Los Monjes & El Convento',8,1,2],
[-33.38964,-70.50769,'PI 87 LOS MONJES EL CONVENTO / SOS','Los Monjes & El Convento',8,5,2],
[-33.38964,-70.50769,'PI 87 LOS MONJES EL CONVENTO / PARLANTE','Los Monjes & El Convento',8,6,2],
[-33.39338,-70.50766,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / PTZ','Cerro Catedral Sur & San Carlos de Apoquindo',8,1,2],
[-33.39338,-70.50766,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / SOS','Cerro Catedral Sur & San Carlos de Apoquindo',8,5,2],
[-33.39338,-70.50766,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / PARLANTE','Cerro Catedral Sur & San Carlos de Apoquindo',8,6,2],
[-33.39668,-70.51275,'PI 90 CERRO PROVINCIA & LOS PUMAS / PTZ','Cerro Provincia & Los Pumas',8,1,2],
[-33.39668,-70.51275,'PI 90 CERRO PROVINCIA & LOS PUMAS / SOS','Cerro Provincia & Los Pumas',8,5,2],
[-33.39668,-70.51275,'PI 90 CERRO PROVINCIA & LOS PUMAS / PARLANTE','Cerro Provincia & Los Pumas',8,6,2],
[-33.39824,-70.51534,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / PTZ','Camino las Vertientes & Camino de los Arrieros',8,1,2],
[-33.39824,-70.51534,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / SOS','Camino las Vertientes & Camino de los Arrieros',8,5,2],
[-33.39824,-70.51534,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / PARLANTE','Camino las Vertientes & Camino de los Arrieros',8,6,2],
[-33.42742,-70.54283,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / PTZ','IV Centenario & Manuel Claro Vial',8,1,2],
[-33.42742,-70.54283,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / SOS','IV Centenario & Manuel Claro Vial',8,5,2],
[-33.42742,-70.54283,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / PARLANTE','IV Centenario & Manuel Claro Vial',8,6,2],
[-33.42653,-70.54881,'PI 94 LOLCO & RUCALHUE / PTZ','Lolco & Rucalhue',8,1,2],
[-33.42653,-70.54881,'PI 94 LOLCO & RUCALHUE / SOS','Lolco & Rucalhue',8,5,2],
[-33.42653,-70.54881,'PI 94 LOLCO & RUCALHUE / PARLANTE','Lolco & Rucalhue',8,6,2],
[-33.41905,-70.53095,'PI 95 PLAZA OLGA NORTE / PTZ','Pasaje Olga Norte',8,1,2],
[-33.41905,-70.53095,'PI 95 PLAZA OLGA NORTEL / SOS','Pasaje Olga Norte',8,5,2],
[-33.41905,-70.53095,'PI 95 PLAZA OLGA NORTEL / PARLANTE','Pasaje Olga Norte',8,6,2],
[-33.41745,-70.52969,'PI 96 YOLANDA & VITAL APOQUINDO / PTZ','Yolanda & Vital Apoquindo',8,1,2],
[-33.41745,-70.52969,'PI 96 YOLANDA & VITAL APOQUINDO / SOS','Yolanda & Vital Apoquindo',8,5,2],
[-33.41745,-70.52969,'PI 96 YOLANDA & VITAL APOQUINDO / PARLANTE','Yolanda & Vital Apoquindo',8,6,2],
[-33.4184,-70.53021,'PI 97 YOLANDA INTERIOR / PTZ','Yolanda Interior',8,1,2],
[-33.4184,-70.53021,'PI 97 YOLANDA INTERIOR / SOS','Yolanda Interior',8,5,2],
[-33.4184,-70.53021,'PI 97 YOLANDA INTERIOR / PARLANTE','Yolanda Interior',8,6,2],
[-33.39783,-70.51101,'PI 98 CERRO EL CEPO & CERRO EL CEPO / PTZ','Cerro el Cepo & Cerro el Cepo',8,1,2],
[-33.39783,-70.51101,'PI 98 CERRO EL CEPO & CERRO EL CEPO / SOS','Cerro el Cepo & Cerro el Cepo',8,5,2],
[-33.39783,-70.51101,'PI 98 CERRO EL CEPO & CERRO EL CEPO / PARLANTE','Cerro el Cepo & Cerro el Cepo',8,6,2],
[-33.39629,-70.51066,'PI 99 CERRO LITORIA & CERRO LITORIA / PTZ','Cerro litoria & Cerro litoria',8,1,2],
[-33.39629,-70.51066,'PI 99 CERRO LITORIA & CERRO LITORIA / SOS','Cerro litoria & Cerro litoria',8,5,2],
[-33.39629,-70.51066,'PI 99 CERRO LITORIA & CERRO LITORIA / PARLANTE','Cerro litoria & Cerro litoria',8,6,2],
[-33.42307,-70.54231,'PI 102 EL TATIO & PICA / PTZ','El tatio & Pica',8,1,2],
[-33.42307,-70.54231,'PI 102 EL TATIO & PICA / SOS','El tatio & Pica',8,5,2],
[-33.42307,-70.54231,'PI 102 EL TATIO & PICA / PARLANTE','El tatio & Pica',8,6,2],
[-33.42373,-70.53504,'PI 103 ALEXANDER FLEMING & TOTORALILLO / PTZ','Alexander Fleming & Totoralillo',8,1,2],
[-33.42373,-70.53504,'PI 103 ALEXANDER FLEMING & TOTORALILLO / SOS','Alexander Fleming & Totoralillo',8,5,2],
[-33.42373,-70.53504,'PI 103 ALEXANDER FLEMING & TOTORALILLO / PARLANTE','Alexander Fleming & Totoralillo',8,6,2],
[-33.42502,-70.53318,'PI 104 SANTA ZITA & SANTA ZITA / PTZ','Santa Zita & Santa Zita',8,1,2],
[-33.42502,-70.53318,'PI 104 SANTA ZITA & SANTA ZITA / SOS','Santa Zita & Santa Zita',8,5,2],
[-33.42502,-70.53318,'PI 104 SANTA ZITA & SANTA ZITA / PARLANTE','Santa Zita & Santa Zita',8,6,2],
[-33.42374,-70.53315,'PI 105 FLEMING & PUNITAQUI / PTZ','Alexander Fleming & Punitaqui',8,1,2],
[-33.42374,-70.53315,'PI 105 FLEMING & PUNITAQUI / SOS','Alexander Fleming & Punitaqui',8,5,2],
[-33.42374,-70.53315,'PI 105 FLEMING & PUNITAQUI / PARLANTE','Alexander Fleming & Punitaqui',8,6,2],
[-33.40129,-70.55025,'PI 106 PETRARCA & BENVENUTTO CELLINI / PTZ','Petrarca & Benvenuto Cellini',8,1,2],
[-33.40129,-70.55025,'PI 106 PETRARCA & BENVENUTTO CELLINI / SOS','Petrarca & Benvenuto Cellini',8,5,2],
[-33.40129,-70.55025,'PI 106 PETRARCA & BENVENUTTO CELLINI / PARLANTE','Petrarca & Benvenuto Cellini',8,6,2],
[-33.40291,-70.55075,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / PTZ','Lorenzo de Medicis & Benvenuto Cellini',8,1,2],
[-33.40291,-70.55075,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / SOS','Lorenzo de Medicis & Benvenuto Cellini',8,5,2],
[-33.40291,-70.55075,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / PARLANTE','Lorenzo de Medicis & Benvenuto Cellini',8,6,2],
[-33.40444,-70.55353,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / PTZ','Padre Errazuriz & Miguel Angel Buonarotti',8,1,2],
[-33.40444,-70.55353,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / SOS','Padre Errazuriz & Miguel Angel Buonarotti',8,5,2],
[-33.40444,-70.55353,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / PARLANTE','Padre Errazuriz & Miguel Angel Buonarotti',8,6,2],
[-33.42055,-70.5375,'PI 109 PADRE HURTADO & PATRICIA / PTZ','Padre Hurtado Sur & Patricia',8,1,2],
[-33.42055,-70.5375,'PI 109 PADRE HURTADO & PATRICIA / SOS','Padre Hurtado Sur & Patricia',8,5,2],
[-33.42055,-70.5375,'PI 109 PADRE HURTADO & PATRICIA / PARLANTE','Padre Hurtado Sur & Patricia',8,6,2],
[-33.42022,-70.54533,'PI 110 TOCONAO & CHIUCHIU / PTZ','Toconao & Chiu chiu',8,1,2],
[-33.42022,-70.54533,'PI 110 TOCONAO & CHIUCHIU / SOS','Toconao & Chiu chiu',8,5,2],
[-33.42022,-70.54533,'PI 110 TOCONAO & CHIUCHIU / PARLANTE','Toconao & Chiu chiu',8,6,2],
[-33.41876,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / PTZ','Paul harris sur & Socompa',8,1,2],
[-33.41876,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / SOS','Paul harris sur & Socompa',8,5,2],
[-33.41876,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / PARLANTE','Paul harris sur & Socompa',8,6,2],
[-33.41286,-70.52387,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / PTZ','atalaya & carlos peña otaegui',8,1,2],
[-33.41286,-70.52387,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / SOS','atalaya & carlos peña otaegui',8,5,2],
[-33.41286,-70.52387,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / PARLANTE','atalaya & carlos peña otaegui',8,6,2],
[-33.41885,-70.54137,'PI 113 ZARAGOZA & AYQUINA / PTZ','zaragoza & ayquina',8,1,2],
[-33.41885,-70.54137,'PI 113 ZARAGOZA & AYQUINA / SOS','zaragoza & ayquina',8,5,2],
[-33.41885,-70.54137,'PI 113 ZARAGOZA & AYQUINA / PARLANTE','zaragoza & ayquina',8,6,2],
[-33.41854,-70.54524,'PI 114 LERIDA & TOCONAO / PTZ','Lerida & Toconao',8,1,2],
[-33.41854,-70.54524,'PI 114 LERIDA & TOCONAO / SOS','Lerida & Toconao',8,5,2],
[-33.41854,-70.54524,'PI 114 LERIDA & TOCONAO / PARLANTE','Lerida & Toconao',8,6,2],
[-33.41955,-70.54483,'PI 115 ZARAGOZA & TOCONAO / PTZ','Zaragoza & Toconao',8,1,2],
[-33.41955,-70.54483,'PI 115 ZARAGOZA & TOCONAO / SOS','Zaragoza & Toconao',8,5,2],
[-33.41955,-70.54483,'PI 115 ZARAGOZA & TOCONAO / PARLANTE','Zaragoza & Toconao',8,6,2],
[-33.41978,-70.57062,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / PTZ','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano',8,1,2],
[-33.41978,-70.57062,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / SOS','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano',8,5,2],
[-33.41978,-70.57062,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / PARLANTE','Martin Alonso Pinzon & Sebsatian Elcano',8,6,2],
[-33.42001,-70.5438,'PI 117 ZARAGOZA & PUREN / PTZ','Puren. Entre Zaragoza & Alonso de Camargo',8,1,2],
[-33.42001,-70.5438,'PI 117 ZARAGOZA & PUREN / SOS','Puren. Entre Zaragoza & Alonso de Camargo',8,5,2],
[-33.42001,-70.5438,'PI 117 ZARAGOZA & PUREN / PARLANTE','Puren. Entre Zaragoza & Alonso de Camargo',8,6,2],
[-33.40367,-70.56693,'PI 118 VILLA SAN LUIS A / PTZ','Cerro el Plomo & Estocolmo',8,1,2],
[-33.40367,-70.56693,'PI 118 VILLA SAN LUIS A / SOS','Cerro el Plomo & Estocolmo',8,5,2],
[-33.40367,-70.56693,'PI 118 VILLA SAN LUIS A / PARLANTE','Cerro el Plomo & Estocolmo',8,6,2],
[-33.40249,-70.5675,'PI 119 VILLA SAN LUIS B / PTZ','Cerro el Plomo & Estocolmo',8,1,2],
[-33.40249,-70.5675,'PI 119 VILLA SAN LUIS B / SOS','Cerro el Plomo & Estocolmo',8,5,2],
[-33.40249,-70.5675,'PI 119 VILLA SAN LUIS B / PARLANTE','Cerro el Plomo & Estocolmo',8,6,2],
[-33.4135,-70.59631,'PI 120 GLAMIS & LA PASTORA / PTZ','Glamis & La Pastora',8,1,2],
[-33.4135,-70.59631,'PI 120 GLAMIS & LA PASTORA / SOS','Glamis & La Pastora',8,5,2],
[-33.4135,-70.59631,'PI 120 GLAMIS & LA PASTORA / PARLANTE','Glamis & La Pastora',8,6,2],
[-33.40834,-70.57116,'PI 121 ROSARIO NORTE & EDIPO REY / PTZ','Rosario Norte & Edipo Rey',8,1,2],
[-33.40834,-70.57116,'PI 121 ROSARIO NORTE & EDIPO REY / SOS','Rosario Norte & Edipo Rey',8,5,2],
[-33.40834,-70.57116,'PI 121 ROSARIO NORTE & EDIPO REY / PARLANTE','Rosario Norte & Edipo Rey',8,6,2],
[-33.4177,-70.60212,'PI 122 TAJAMAR & ENCOMENDEROS / PTZ','Tajamar & Encomenderos',8,1,2],
[-33.4177,-70.60212,'PI 122 TAJAMAR & ENCOMENDEROS / SOS','Tajamar & Encomenderos',8,5,2],
[-33.4177,-70.60212,'PI 122 TAJAMAR & ENCOMENDEROS / PARLANTE','Tajamar & Encomenderos',8,6,2],
[-33.42338,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / PTZ','Ayquina & Ascotan',8,1,2],
[-33.42338,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / SOS','Ayquina & Ascotan',8,5,2],
[-33.42338,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / PARLANTE','Ayquina & Ascotan',8,6,2],
[-33.43116,-70.57866,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PTZ','Francisco Bilbao & Juan de Austria',8,1,2],
[-33.43116,-70.57866,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / SOS','Francisco Bilbao & Juan de Austria',8,5,2],
[-33.43116,-70.57866,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PARLANTE','Francisco Bilbao & Juan de Austria',8,6,2],
[-33.417,-70.54057,'PI 127 PARQUE SANTA ROSA / PTZ','Cristobal colón & Visviri',8,1,2],
[-33.417,-70.54057,'PI 127 PARQUE SANTA ROSA / SOS','Cristobal colón & Visviri',8,5,2],
[-33.417,-70.54057,'PI 127 PARQUE SANTA ROSA / PARLANTE','Cristobal colón & Visviri',8,6,2],
[-33.40528,-70.57246,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / PTZ','Rosario Norte & Cerro el Plomo',8,1,2],
[-33.40528,-70.57246,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / SOS','Rosario Norte & Cerro el Plomo',8,5,2],
[-33.40528,-70.57246,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / PARLANTE','Rosario Norte & Cerro el Plomo',8,6,2],
[-33.41358,-70.58361,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PTZ','Apoquindo & Gral Francisco Barceló',8,1,2],
[-33.41358,-70.58361,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / SOS','Apoquindo & Gral Francisco Barceló',8,5,2],
[-33.41358,-70.58361,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PARLANTE','Apoquindo & Gral Francisco Barceló',8,6,2],
[-33.4069,-70.56154,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / PTZ','Av. Las Condes & Nuestra Sra. del Rosario',8,1,2],
[-33.4069,-70.56154,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / SOS','Av. Las Condes & Nuestra Sra. del Rosario',8,5,2],
[-33.4069,-70.56154,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / PARLANTE','Av. Las Condes & Nuestra Sra. del Rosario',8,6,2],
[-33.39108,-70.51349,'PI 134 PLAZA CORAZÓN / PTZ','Republica de Honduras & Catedral Sur',8,1,2],
[-33.39108,-70.51349,'PI 134 PLAZA CORAZÓN / SOS','Republica de Honduras & Catedral Sur',8,5,2],
[-33.39108,-70.51349,'PI 134 PLAZA CORAZÓN / PARLANTE','Republica de Honduras & Catedral Sur',8,6,2],
[-33.42169,-70.54563,'PI 135 CHIU CHIU - CODPA / PTZ','Chiu Chiu & Codpa',8,1,2],
[-33.42169,-70.54563,'PI 135 CHIU CHIU - CODPA / SOS','Chiu Chiu & Codpa',8,5,2],
[-33.42169,-70.54563,'PI 135 CHIU CHIU - CODPA / PARLANTE','Chiu Chiu & Codpa',8,6,2],
[-33.42147,-70.54433,'PI 136 PARINACOTA - CODPA / PTZ','Codpa & Parinacota',8,1,2],
[-33.42147,-70.54433,'PI 136 PARINACOTA - CODPA / SOS','Codpa & Parinacota',8,5,2],
[-33.42147,-70.54433,'PI 136 PARINACOTA - CODPA / PARLANTE','Codpa & Parinacota',8,6,2],
[-33.42348,-70.54927,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / PTZ','Pintor R. Monvoisin & Pintora Aurora Mira',8,1,2],
[-33.42348,-70.54927,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / SOS','Pintor R. Monvoisin & Pintora Aurora Mira',8,5,2],
[-33.42348,-70.54927,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / PARLANTE','Pintor R. Monvoisin & Pintora Aurora Mira',8,6,2],
[-33.41885,-70.54048,'PI 138 VISVIRI - ZARAGOZA / PTZ','Visviri & Zaragoza',8,1,2],
[-33.41885,-70.54048,'PI 138 VISVIRI - ZARAGOZA / SOS','Visviri & Zaragoza',8,5,2],
[-33.41885,-70.54048,'PI 138 VISVIRI - ZARAGOZA / PARLANTE','Visviri & Zaragoza',8,6,2],
[-33.42661,-70.5531,'PI 141 TORRE FLEMING / PTZ','Lolco 7680',8,1,2],
[-33.42661,-70.5531,'PI 141 TORRE FLEMING / SOS','Lolco 7680',8,5,2],
[-33.42661,-70.5531,'PI 141 TORRE FLEMING / PARLANTE','Lolco 7680',8,6,2],
[-33.39687,-70.55264,'Pi 143 PLAZA SOR LAURA ROSA / PTZ','Sor Laura Rosa 220',8,1,2],
[-33.39687,-70.55264,'Pi 143 PLAZA SOR LAURA ROSA / SOS','Sor Laura Rosa 220',8,5,2],
[-33.39687,-70.55264,'Pi 143 PLAZA SOR LAURA ROSA / PARLANTE','Sor Laura Rosa 220',8,6,2],
[-33.42175,-70.54117,'Pi 144 TOCONCE & CHAPIQUIÑA / PTZ','Chapiquiña 8851',8,1,2],
[-33.42175,-70.54117,'Pi 144 TOCONCE & CHAPIQUIÑA / SOS','Chapiquiña 8851',8,5,2],
[-33.42175,-70.54117,'Pi 144 TOCONCE & CHAPIQUIÑA / PARLANTE','Chapiquiña 8851',8,6,2],
[-33.41461,-70.53454,'PI 145 PAUL HARRIS & ATACAMEÑOS / PTZ','Paul Harris & Atacameños',8,1,2],
[-33.41461,-70.53454,'PI 145 PAUL HARRIS & ATACAMEÑOS / SOS','Paul Harris & Atacameños',8,5,2],
[-33.41461,-70.53454,'PI 145 PAUL HARRIS & ATACAMEÑOS / PARLANTE','Paul Harris & Atacameños',8,6,2],
[-33.42544,-70.59156,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / PTZ','La niña & Sanchez Fontecilla',8,1,2],
[-33.42544,-70.59156,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / SOS','La niña & Sanchez Fontecilla',8,5,2],
[-33.42544,-70.59156,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / PARLANTE','La niña & Sanchez Fontecilla',8,6,2],
[-33.38836,-70.52532,'PI 147 CHARLES HAMILTON - LO FONTECILLA / PTZ','Charles Hamilton & Lo Fontecilla',8,1,2],
[-33.38836,-70.52532,'PI 147 CHARLES HAMILTON - LO FONTECILLA / SOS','Charles Hamilton & Lo Fontecilla',8,5,2],
[-33.38836,-70.52532,'PI 147 CHARLES HAMILTON - LO FONTECILLA / PARLANTE','Charles Hamilton & Lo Fontecilla',8,6,2],
[-33.40758,-70.54492,'PI 148 LOS DOMINICOS / PTZ','Los Dominicos (Pista Patinaje)',8,1,2],
[-33.40758,-70.54492,'PI 148 LOS DOMINICOS / SOS','Los Dominicos (Pista Patinaje)',8,5,2],
[-33.40758,-70.54492,'PI 148 LOS DOMINICOS / PARLANTE','Los Dominicos (Pista Patinaje)',8,6,2],
[-33.415,-70.59789,'PI 149 DON CARLOS & AUGUSTO LEGUIA / PTZ','Don Carlos & Augusto Leguia',8,1,2],
[-33.415,-70.59789,'PI 149 DON CARLOS & AUGUSTO LEGUIA / SOS','Don Carlos & Augusto Leguia',8,5,2],
[-33.415,-70.59789,'PI 149 DON CARLOS & AUGUSTO LEGUIA / PARLANTE','Don Carlos & Augusto Leguia',8,6,2],
[-33.39229,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / PTZ','Pdte. San Fuentes - Euzkadi',8,1,2],
[-33.39229,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / SOS','Pdte. San Fuentes - Euzkadi',8,5,2],
[-33.39229,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / PARLANTE','Pdte. San Fuentes - Euzkadi',8,6,2],
[-33.37412,-70.52055,'PI 153 COLEGIO LAS CONDES / PTZ','Av. Las condes 12125',8,1,2],
[-33.37412,-70.52055,'PI 153 COLEGIO LAS CONDES / SOS','Av. Las condes 12125',8,5,2],
[-33.37412,-70.52055,'PI 153 COLEGIO LAS CONDES / PARLANTE','Av. Las condes 12125',8,6,2],
[-33.42062,-70.53644,'PI 157 COLEGIO JUAN PABLO II / PTZ','Patricia 9040',8,1,2],
[-33.42062,-70.53644,'PI 157 COLEGIO JUAN PABLO II / SOS','Patricia 9040',8,5,2],
[-33.42062,-70.53644,'PI 157 COLEGIO JUAN PABLO II / PARLANTE','Patricia 9040',8,6,2],
[-33.4258,-70.53229,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / PTZ','VIA LACTEA & CIRIO',8,1,2],
[-33.4258,-70.53229,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / SOS','VIA LACTEA & CIRIO',8,5,2],
[-33.4258,-70.53229,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / PARLANTE','VIA LACTEA & CIRIO',8,6,2],
[-33.40034,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / PTZ','Cerro Altar 6811',8,1,2],
[-33.40034,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / SOS','Cerro Altar 6811',8,5,2],
[-33.40034,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / PARLANTE','Cerro Altar 6811',8,6,2],
[-33.40393,-70.53613,'PI 160 COLEGIO SAN FCO. DEL ALBA / PTZ','CAMINO EL ALBA & VITAL APOQUINDO',8,1,2],
[-33.40393,-70.53613,'PI 160 COLEGIO SAN FCO. DEL ALBA / SOS','CAMINO EL ALBA & VITAL APOQUINDO',8,5,2],
[-33.40393,-70.53613,'PI 160 COLEGIO SAN FCO. DEL ALBA / PARLANTE','CAMINO EL ALBA & VITAL APOQUINDO',8,6,2],
[-33.41596,-70.53612,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / PTZ','Av. Cristóbal Colón 9070',8,1,2],
[-33.41596,-70.53612,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / SOS','Av. Cristóbal Colón 9070',8,5,2],
[-33.41596,-70.53612,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / PARLANTE','Av. Cristóbal Colón 9070',8,6,2],
[-33.41604,-70.53456,'PI 162 COLEGIO PAUL HARRIS / PTZ','CRISTOBAL COLON 9188',8,1,2],
[-33.41604,-70.53456,'PI 162 COLEGIO PAUL HARRIS / SOS','CRISTOBAL COLON 9188',8,5,2],
[-33.41604,-70.53456,'PI 162 COLEGIO PAUL HARRIS / PARLANTE','CRISTOBAL COLON 9188',8,6,2],
[-33.42554,-70.55446,'PI 163 COLEGIO SIMON BOLIVAR / PTZ','TOMAS MORO 1651',8,1,2],
[-33.42554,-70.55446,'PI 163 COLEGIO SIMON BOLIVAR / SOS','TOMAS MORO 1651',8,5,2],
[-33.42554,-70.55446,'PI 163 COLEGIO SIMON BOLIVAR / PARLANTE','TOMAS MORO 1651',8,6,2],
[-33.40494,-70.5785,'PI 164 DEPARTAMENTO DE TRANSITO / PTZ','PDTE RIESCO 5296',8,1,2],
[-33.40494,-70.5785,'PI 164 DEPARTAMENTO DE TRANSITO / SOS','PDTE RIESCO 5296',8,5,2],
[-33.40494,-70.5785,'PI 164 DEPARTAMENTO DE TRANSITO / PARLANTE','PDTE RIESCO 5296',8,6,2],
[-33.39875,-70.56197,'PI 165 CIRCULO POLAR / PTZ','CÍRCULO POLAR 6652',8,1,2],
[-33.39875,-70.56197,'PI 165 CIRCULO POLAR / SOS','CÍRCULO POLAR 6652',8,5,2],
[-33.39875,-70.56197,'PI 165 CIRCULO POLAR / PARLANTE','CÍRCULO POLAR 6652',8,6,2],
[-33.41426,-70.58815,'PI 166 JEAN MERMOZ / PTZ','JEAN MERMOZ 4115',8,1,2],
[-33.41426,-70.58815,'PI 166 JEAN MERMOZ / SOS','JEAN MERMOZ 4115',8,5,2],
[-33.41426,-70.58815,'PI 166 JEAN MERMOZ / PARLANTE','JEAN MERMOZ 4115',8,6,2],
[-33.37008,-70.50556,'PI 167 COLEGIO SOUTHERN CROSS / PTZ','LAS CONDES 13525',8,1,2],
[-33.37008,-70.50556,'PI 167 COLEGIO SOUTHERN CROSS / SOS','LAS CONDES 13525',8,5,2],
[-33.37008,-70.50556,'PI 167 COLEGIO SOUTHERN CROSS / PARLANTE','LAS CONDES 13525',8,6,2],
[-33.3703,-70.50818,'PI 168 COLEGIO PEDRO DE VALDIVIA / PTZ','AV. LAS CONDES 13349',8,1,2],
[-33.3703,-70.50818,'PI 168 COLEGIO PEDRO DE VALDIVIA / SOS','AV. LAS CONDES 13349',8,5,2],
[-33.3703,-70.50818,'PI 168 COLEGIO PEDRO DE VALDIVIA / PARLANTE','AV. LAS CONDES 13349',8,6,2],
[-33.40313,-70.5645,'PI 169 COLEGIO SEK / PTZ','LOS MILITARES 6640',8,1,2],
[-33.40313,-70.5645,'PI 169 COLEGIO SEK / SOS','LOS MILITARES 6640',8,5,2],
[-33.40313,-70.5645,'PI 169 COLEGIO SEK / PARLANTE','LOS MILITARES 6640',8,6,2],
[-33.40064,-70.56664,'PI 170 COLEGIO ARABE / PTZ','PDTE. RIESCO 6437',8,1,2],
[-33.40064,-70.56664,'PI 170 COLEGIO ARABE / SOS','PDTE. RIESCO 6437',8,5,2],
[-33.40064,-70.56664,'PI 170 COLEGIO ARABE / PARLANTE','PDTE. RIESCO 6437',8,6,2],
[-33.42045,-70.58913,'PI 171 COLEGIO VILLA MARIA ACADEMY / PTZ','PDTE ERRÁZURIZ 3753',8,1,2],
[-33.42045,-70.58913,'PI 171 COLEGIO VILLA MARIA ACADEMY / SOS','PDTE ERRÁZURIZ 3753',8,5,2],
[-33.42045,-70.58913,'PI 171 COLEGIO VILLA MARIA ACADEMY / PARLANTE','PDTE ERRÁZURIZ 3753',8,6,2],
[-33.42,-70.58694,'PI 172 COLEGIO VERBO DIVINO / PTZ','PDTE ERRÁZURIZ 4055',8,1,2],
[-33.4196,-70.5469,'PI 173 COLEGIO COOCENDE / PTZ','ZARAGOZA 8065',8,1,2],
[-33.41064,-70.54963,'PI 174 COLEGIO SAGRADO CORAZÓN / PTZ','STA. MAGDALENA SOFÍA 277',8,1,2],
[-33.41064,-70.54963,'PI 174 COLEGIO SAGRADO CORAZÓN / SOS','STA. MAGDALENA SOFÍA 277',8,5,2],
[-33.41064,-70.54963,'PI 174 COLEGIO SAGRADO CORAZÓN / PARLANTE','STA. MAGDALENA SOFÍA 277',8,6,2],
[-33.40554,-70.54055,'PI 175 COLEGIO VIRGEN DE POMPEYA / PTZ','CAMINO EL ALBA N° 9145',8,1,2],
[-33.40554,-70.54055,'PI 175 COLEGIO VIRGEN DE POMPEYA / SOS','CAMINO EL ALBA N° 9145',8,5,2],
[-33.40554,-70.54055,'PI 175 COLEGIO VIRGEN DE POMPEYA / PARLANTE','CAMINO EL ALBA N° 9145',8,6,2],
[-33.38845,-70.53333,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / PTZ','CAMPANARIO 000',8,1,2],
[-33.38845,-70.53333,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / SOS','CAMPANARIO 000',8,5,2],
[-33.38845,-70.53333,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / PARLANTE','CAMPANARIO 000',8,6,2],
[-33.42554,-70.55512,'PI 177 COLEGIO ALEXANDER FLEMING / PTZ','AV. ALEJANDRO FLEMING 7315',8,1,2],
[-33.42554,-70.55512,'PI 177 COLEGIO ALEXANDER FLEMING / SOS','AV. ALEJANDRO FLEMING 7315',8,5,2],
[-33.42554,-70.55512,'PI 177 COLEGIO ALEXANDER FLEMING / PARLANTE','AV. ALEJANDRO FLEMING 7315',8,6,2],
[-33.42138,-70.55858,'PI 178 COLEGIO ACHIGA COMEDUC / PTZ','ALONSO DE CAMARGO 6615',8,1,2],
[-33.42138,-70.55858,'PI 178 COLEGIO ACHIGA COMEDUC / SOS','ALONSO DE CAMARGO 6615',8,5,2],
[-33.42138,-70.55858,'PI 178 COLEGIO ACHIGA COMEDUC / PARLANTE','ALONSO DE CAMARGO 6615',8,6,2],
[-33.41926,-70.58857,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PTZ','ALCÁNTARA 445',8,1,2],
[-33.41926,-70.58857,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / SOS','ALCÁNTARA 445',8,5,2],
[-33.41926,-70.58857,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PARLANTE','ALCÁNTARA 445',8,6,2],
[-33.40566,-70.56072,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / PTZ','LA PIEDAD 35',8,1,2],
[-33.40566,-70.56072,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / SOS','LA PIEDAD 35',8,5,2],
[-33.40566,-70.56072,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / PARLANTE','LA PIEDAD 35',8,6,2],
[-33.39521,-70.55403,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / PTZ','LAS TRANQUERAS 726',8,1,2],
[-33.39521,-70.55403,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / SOS','LAS TRANQUERAS 726',8,5,2],
[-33.39521,-70.55403,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / PARLANTE','LAS TRANQUERAS 726',8,6,2],
[-33.41127,-70.55229,'PI 182 COLEGIO SAN JORGE / PTZ','AVENIDA TOMÁS MORO 272',8,1,2],
[-33.41127,-70.55229,'PI 182 COLEGIO SAN JORGE / SOS','AVENIDA TOMÁS MORO 272',8,5,2],
[-33.41127,-70.55229,'PI 182 COLEGIO SAN JORGE / PARLANTE','AVENIDA TOMÁS MORO 272',8,6,2],
[-33.39897,-70.55991,'PI 183 COLEGIO EMAUS / PTZ','GERÓNIMO DE ALDERETE 481',8,1,2],
[-33.39897,-70.55991,'PI 183 COLEGIO EMAUS / SOS','GERÓNIMO DE ALDERETE 481',8,5,2],
[-33.39897,-70.55991,'PI 183 COLEGIO EMAUS / PARLANTE','GERÓNIMO DE ALDERETE 481',8,6,2],
[-33.42614,-70.57286,'PI 184 COLEGIO QUIMAY / PTZ','ISABEL LA CATOLICA 4774',8,1,2],
[-33.42614,-70.57286,'PI 184 COLEGIO QUIMAY / SOS','ISABEL LA CATOLICA 4774',8,5,2],
[-33.42614,-70.57286,'PI 184 COLEGIO QUIMAY / PARLANTE','ISABEL LA CATOLICA 4774',8,6,2],
[-33.41145,-70.52209,'PI 185 COLEGIO WENLOCK SCHOOL / PTZ','CALLE CARLOS PEÑA OTAEGUI 10880',8,1,2],
[-33.41145,-70.52209,'PI 185 COLEGIO WENLOCK SCHOOL / SOS','CALLE CARLOS PEÑA OTAEGUI 10880',8,5,2],
[-33.41145,-70.52209,'PI 185 COLEGIO WENLOCK SCHOOL / PARLANTE','CALLE CARLOS PEÑA OTAEGUI 10880',8,6,2],
[-33.41475,-70.56308,'PI 186 COLEGIO SAN JUAN EVANGELISTA / PTZ','MARTÍN DE ZAMORA 6395',8,1,2],
[-33.41475,-70.56308,'PI 186 COLEGIO SAN JUAN EVANGELISTA / SOS','MARTÍN DE ZAMORA 6395',8,5,2],
[-33.41475,-70.56308,'PI 186 COLEGIO SAN JUAN EVANGELISTA / PARLANTE','MARTÍN DE ZAMORA 6395',8,6,2],
[-33.41958,-70.5423,'PI 187 PLAZA EL TATIO / PTZ','CALLE PICA 1220',8,1,2],
[-33.41958,-70.5423,'PI 187 PLAZA EL TATIO / SOS','CALLE PICA 1220',8,5,2],
[-33.41958,-70.5423,'PI 187 PLAZA EL TATIO / PARLANTE','CALLE PICA 1220',8,6,2],
[-33.40716,-70.55483,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / PTZ','PADRE ERRAZURIZ 7001',8,1,2],
[-33.40716,-70.55483,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / SOS','PADRE ERRAZURIZ 7001',8,5,2],
[-33.40716,-70.55483,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / PARLANTE','PADRE ERRAZURIZ 7001',8,6,2],
[-33.42074,-70.54636,'PI 189 COLEGIO ALAMIRO / PTZ','FUENTE OVEJUNA 1235',8,1,2],
[-33.42074,-70.54636,'PI 189 COLEGIO ALAMIRO / SOS','FUENTE OVEJUNA 1235',8,5,2],
[-33.42074,-70.54636,'PI 189 COLEGIO ALAMIRO / PARLANTE','FUENTE OVEJUNA 1235',8,6,2],
[-33.40704,-70.5814,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / PTZ','PRESIDENTE RIESCO 4902',8,1,2],
[-33.40704,-70.5814,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / SOS','PRESIDENTE RIESCO 4902',8,5,2],
[-33.40704,-70.5814,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / PARLANTE','PRESIDENTE RIESCO 4902',8,6,2],
[-33.39825,-70.5678,'PI 191 COLEGIO ALEMAN DE SANTIAGO / PTZ','NUESTRA SEÑORA DEL ROSARIO 850',8,1,2],
[-33.39825,-70.5678,'PI 191 COLEGIO ALEMAN DE SANTIAGO / SOS','NUESTRA SEÑORA DEL ROSARIO 850',8,5,2],
[-33.39825,-70.5678,'PI 191 COLEGIO ALEMAN DE SANTIAGO / PARLANTE','NUESTRA SEÑORA DEL ROSARIO 850',8,6,2],
[-33.42565,-70.5702,'PI 192 COLEGIO ANDINO ANTILLANCA / PTZ','SEBASTIAN ELCANO 1590',8,1,2],
[-33.42565,-70.5702,'PI 192 COLEGIO ANDINO ANTILLANCA / SOS','SEBASTIAN ELCANO 1590',8,5,2],
[-33.42565,-70.5702,'PI 192 COLEGIO ANDINO ANTILLANCA / PARLANTE','SEBASTIAN ELCANO 1590',8,6,2],
[-33.38926,-70.53158,'PI 193 COLEGIO BRITISH HIGH SCHOOL / PTZ','LOS GLADIOLOS 10031',8,1,2],
[-33.38926,-70.53158,'PI 193 COLEGIO BRITISH HIGH SCHOOL / SOS','LOS GLADIOLOS 10031',8,5,2],
[-33.38926,-70.53158,'PI 193 COLEGIO BRITISH HIGH SCHOOL / PARLANTE','LOS GLADIOLOS 10031',8,6,2],
[-33.40915,-70.56477,'PI 194 COLEGIO LIFE SUPPORT / PTZ','IV CENTENARIO 68',8,1,2],
[-33.40915,-70.56477,'PI 194 COLEGIO LIFE SUPPORT / SOS','IV CENTENARIO 68',8,5,2],
[-33.40915,-70.56477,'PI 194 COLEGIO LIFE SUPPORT / PARLANTE','IV CENTENARIO 68',8,6,2],
[-33.41321,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / PTZ','IV CENTENARIO 605',8,1,2],
[-33.41321,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / SOS','IV CENTENARIO 605',8,5,2],
[-33.41321,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / PARLANTE','IV CENTENARIO 605',8,6,2],
[-33.40944,-70.56674,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / PTZ','AV. MANQUEHUE SUR 116',8,1,2],
[-33.40944,-70.56674,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / SOS','AV. MANQUEHUE SUR 116',8,5,2],
[-33.40944,-70.56674,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / PARLANTE','AV. MANQUEHUE SUR 116',8,6,2],
[-33.39629,-70.51389,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / PTZ','LOS PUMAS 12015',8,1,2],
[-33.39629,-70.51389,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / SOS','LOS PUMAS 12015',8,5,2],
[-33.39629,-70.51389,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / PARLANTE','LOS PUMAS 12015',8,6,2],
[-33.42927,-70.5867,'PI 198 COLEGIO COYANCURA / PTZ','MARIANO SANCHEZ FONTECILLA 1552',8,1,2],
[-33.42927,-70.5867,'PI 198 COLEGIO COYANCURA / SOS','MARIANO SANCHEZ FONTECILLA 1552',8,5,2],
[-33.42927,-70.5867,'PI 198 COLEGIO COYANCURA / PARLANTE','MARIANO SANCHEZ FONTECILLA 1552',8,6,2],
[-33.39437,-70.50486,'PI 199 COLEGIO CUMBRES / PTZ','AV. PLAZA 1150',8,1,2],
[-33.39437,-70.50486,'PI 199 COLEGIO CUMBRES / SOS','AV. PLAZA 1150',8,5,2],
[-33.39437,-70.50486,'PI 199 COLEGIO CUMBRES / PARLANTE','AV. PLAZA 1150',8,6,2],
[-33.39865,-70.54479,'PI 200 COLEGIO DALCAHUE / PTZ','PADRE HURTADO CENTRAL 605',8,1,2],
[-33.39865,-70.54479,'PI 200 COLEGIO DALCAHUE / SOS','PADRE HURTADO CENTRAL 605',8,5,2],
[-33.39865,-70.54479,'PI 200 COLEGIO DALCAHUE / PARLANTE','PADRE HURTADO CENTRAL 605',8,6,2],
[-33.37436,-70.52092,'PI 201 COLEGIO DUNALASTAIR / PTZ','AV. LAS CONDES 11931',8,1,2],
[-33.37436,-70.52092,'PI 201 COLEGIO DUNALASTAIR / SOS','AV. LAS CONDES 11931',8,5,2],
[-33.37436,-70.52092,'PI 201 COLEGIO DUNALASTAIR / PARLANTE','AV. LAS CONDES 11931',8,6,2],
[-33.39211,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / PTZ','CERRO CATEDRAL NORTE 12150',8,1,2],
[-33.39211,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / SOS','CERRO CATEDRAL NORTE 12150',8,5,2],
[-33.39211,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / PARLANTE','CERRO CATEDRAL NORTE 12150',8,6,2],
[-33.42405,-70.55501,'PI 203 COLEGIO INSTITUCION TERESIANA / PTZ','ISABEL LA CATOLICA 7445',8,1,2],
[-33.42405,-70.55501,'PI 203 COLEGIO INSTITUCION TERESIANA / SOS','ISABEL LA CATOLICA 7445',8,5,2],
[-33.42405,-70.55501,'PI 203 COLEGIO INSTITUCION TERESIANA / PARLANTE','ISABEL LA CATOLICA 7445',8,6,2],
[-33.41362,-70.51248,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / PTZ','FRANCISCO BULNES CORREA 3000',8,1,2],
[-33.41362,-70.51248,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / SOS','FRANCISCO BULNES CORREA 3000',8,5,2],
[-33.41362,-70.51248,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / PARLANTE','FRANCISCO BULNES CORREA 3000',8,6,2],
[-33.43058,-70.56359,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PTZ','FRANCISCO BILBAO 6300',8,1,2],
[-33.43058,-70.56359,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / SOS','FRANCISCO BILBAO 6300',8,5,2],
[-33.43058,-70.56359,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PARLANTE','FRANCISCO BILBAO 6300',8,6,2],
[-33.42056,-70.56873,'PI 206 COLEGIO LA GIOURETTE / PTZ','MAR DEL SUR 1238',8,1,2],
[-33.42056,-70.56873,'PI 206 COLEGIO LA GIOURETTE / SOS','MAR DEL SUR 1238',8,5,2],
[-33.42056,-70.56873,'PI 206 COLEGIO LA GIOURETTE / PARLANTE','MAR DEL SUR 1238',8,6,2],
[-33.37933,-70.50834,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / PTZ','AV. CHARLES HAMILTON 12880',8,1,2],
[-33.37933,-70.50834,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / SOS','AV. CHARLES HAMILTON 12880',8,5,2],
[-33.37933,-70.50834,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / PARLANTE','AV. CHARLES HAMILTON 12880',8,6,2],
[-33.40152,-70.52136,'PI 208 COLEGIO REDLAND SCHOOL / PTZ','CAMINO EL ALBA 11357',8,1,2],
[-33.40152,-70.52136,'PI 208 COLEGIO REDLAND SCHOOL / SOS','CAMINO EL ALBA 11357',8,5,2],
[-33.40152,-70.52136,'PI 208 COLEGIO REDLAND SCHOOL / PARLANTE','CAMINO EL ALBA 11357',8,6,2],
[-33.41944,-70.58848,'PI 209 COLEGIO SAIN PAUL MONTESSORI / PTZ','ALCÁNTARA 464',8,1,2],
[-33.41944,-70.58848,'PI 209 COLEGIO SAIN PAUL MONTESSORI / SOS','ALCÁNTARA 464',8,5,2],
[-33.41944,-70.58848,'PI 209 COLEGIO SAIN PAUL MONTESSORI / PARLANTE','ALCÁNTARA 464',8,6,2],
[-33.42955,-70.58364,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / PTZ','CANCILLER DOLLFUSS 1801',8,1,2],
[-33.42955,-70.58364,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / SOS','CANCILLER DOLLFUSS 1801',8,5,2],
[-33.42955,-70.58364,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / PARLANTE','CANCILLER DOLLFUSS 1801',8,6,2],
[-33.43041,-70.57418,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / PTZ','VICTOR RAE 4420',8,1,2],
[-33.43041,-70.57418,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / SOS','VICTOR RAE 4420',8,5,2],
[-33.43041,-70.57418,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / PARLANTE','VICTOR RAE 4420',8,6,2],
[-33.39377,-70.50508,'PI 212 COLEGIO NICOLAS DE MYRA / PTZ','AV PLAZA 1157',8,1,2],
[-33.39377,-70.50508,'PI 212 COLEGIO NICOLAS DE MYRA / SOS','AV PLAZA 1157',8,5,2],
[-33.39377,-70.50508,'PI 212 COLEGIO NICOLAS DE MYRA / PARLANTE','AV PLAZA 1157',8,6,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / PTZ','CAMINO EL ALBA 12881',8,1,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / SOS','CAMINO EL ALBA 12881',8,5,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / PARLANTE','CAMINO EL ALBA 12881',8,6,2],
[-33.39483,-70.52154,'PI 214 COLEGIO KILPATRICK / PTZ','CAMINO LAS FLORES 11280',8,1,2],
[-33.39483,-70.52154,'PI 214 COLEGIO KILPATRICK / SOS','CAMINO LAS FLORES 11280',8,5,2],
[-33.39483,-70.52154,'PI 214 COLEGIO KILPATRICK / PARLANTE','CAMINO LAS FLORES 11280',8,6,2],
[-33.41378,-70.57475,'PI 215 COLEGIO MOUNIER / PTZ','ROSA O\'HIGGINS 298',8,1,2],
[-33.41378,-70.57475,'PI 215 COLEGIO MOUNIER / SOS','ROSA O\'HIGGINS 298',8,5,2],
[-33.41378,-70.57475,'PI 215 COLEGIO MOUNIER / PARLANTE','ROSA O\'HIGGINS 298',8,6,2],
[-33.4249,-70.56184,'PI 216 COLEGIO GUNMAN / PTZ','ISABEL LA CATÓLICA 6366',8,1,2],
[-33.4249,-70.56184,'PI 216 COLEGIO GUNMAN / SOS','ISABEL LA CATÓLICA 6366',8,5,2],
[-33.4249,-70.56184,'PI 216 COLEGIO GUNMAN / PARLANTE','ISABEL LA CATÓLICA 6366',8,6,2],
    ];

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  8. CÁMARAS: UTILIDADES                                       ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const PROG_COLOR  = { B: '#ef4444', R: '#3b82f6', P: '#22c55e', F: '#a855f7' };
    const PROG_BORDER = { B: '#b91c1c', R: '#1d4ed8', P: '#15803d', F: '#7e22ce' };
    const PROG_NOMBRE = { B: 'Barrio Protegido', R: 'Red Municipal', P: 'Postes Inteligentes', F: 'Refugios Inteligentes' };

    /**
     * Extrae código corto según programa de cámara.
     * B: "LG1-01" | R: "001 FIJA" | P: "PI 01" | F: "RI 01"
     */
    function codigoCorto(cam) {
        const id = cam.codigo || '';
        const pg = cam.programa || 'R';
        const tipo = (cam.tipo || '').toUpperCase();

        switch (pg) {
            case 'B': {
                const m = id.match(/^([A-Za-z]{1,5}\d?)-?(\d{1,2})/);
                return m ? `${m[1]}-${m[2]}` : id.split(' ')[0] || '?';
            }
            case 'R': {
                const m = id.match(/^(\d{3})/);
                const num = m ? m[1] : '???';
                const t = tipo === 'LPR' ? 'LPR' : tipo === 'PTZ' ? 'PTZ' : tipo === 'FIJA' ? 'FIJA' : tipo || '';
                return `${num} ${t}`;
            }
            case 'P': {
                const m = id.match(/PI\s*(\d{1,2})/i);
                return m ? `PI ${m[1].padStart(2, '0')}` : 'PI';
            }
            case 'F': {
                const m = id.match(/RI\s*(\d{1,2})/i);
                return m ? `RI ${m[1].padStart(2, '0')}` : 'RI';
            }
            default:
                return id.substring(0, 8) || '?';
        }
    }

    /** Parsea array compacto a objetos de cámara */
    function parseCamarasRaw(raw) {
        return raw.map(c => ({
            lat: c[0], lng: c[1],
            nombre: c[2] || 'Cámara',
            codigo: c[2] || '',
            dir: c[3] || '',
            destacamento: DEST_LOOKUP[c[4]] || '',
            tipo: TIPO_LOOKUP[c[5]] || '',
            programa: PROG_LOOKUP[c[6]] || 'R',
        }));
    }

    /** Fetch cámaras: intenta FeatureServer, fallback a datos embebidos */
    async function fetchCamaras() {
        if (CONFIG.CAMARAS_FEATURESERVER) {
            try {
                const url = `${CONFIG.CAMARAS_FEATURESERVER}/query?where=1%3D1&outFields=*&f=json&returnGeometry=true&resultRecordCount=2000`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.features?.length > 0) {
                    const isMerc = data.spatialReference?.wkid === 102100 || data.spatialReference?.wkid === 3857;
                    return data.features.map(f => {
                        let lat, lng;
                        if (isMerc) {
                            lng = (f.geometry.x / 20037508.34) * 180;
                            lat = (Math.atan(Math.exp((f.geometry.y / 20037508.34) * Math.PI)) * 360 / Math.PI) - 90;
                        } else {
                            lng = f.geometry.x;
                            lat = f.geometry.y;
                        }
                        return {
                            lat, lng,
                            nombre: f.attributes.nombre_csv || f.attributes.nombre_hik || f.attributes.Name || 'Cámara',
                            codigo: f.attributes.id_camara || f.attributes.id_centro || '',
                            dir: f.attributes.direccion || '',
                            destacamento: f.attributes.destacamen || '',
                            tipo: f.attributes.tipo_de_c || '',
                            programa: 'R',
                        };
                    });
                }
            } catch (e) {
                console.warn('[MapaIntegrado] FeatureServer fetch failed, usando datos embebidos:', e);
            }
        }
        return parseCamarasRaw(CAMARAS_RAW);
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  9. CARGA DE LEAFLET                                          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function cargarLeaflet() {
        return new Promise((resolve, reject) => {
            if (window.L) {
                try {
                    GM_addStyle(GM_getResourceText('LEAFLET_CSS'));
                } catch {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = CONFIG.LEAFLET_CSS;
                    document.head.appendChild(link);
                }
                resolve();
                return;
            }
            // Fallback: carga dinámica
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = CONFIG.LEAFLET_CSS;
            document.head.appendChild(link);

            const s = document.createElement('script');
            s.src = CONFIG.LEAFLET_JS;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Leaflet load failed'));
            document.head.appendChild(s);
        });
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  10. UI: ESTILOS                                              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function getStyles() {
        return `
            #mapa-integrado-root {
                position:fixed; inset:0; z-index:99998;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                font-size:13px; color:#e2e4e9;
            }
            #mi-map { position:absolute; inset:0; z-index:1; }

            /* ═══ TOPBAR ═══ */
            #mi-topbar {
                position:fixed; top:0; left:0; right:0; z-index:1000;
                background:rgba(15,17,23,.92); backdrop-filter:blur(12px);
                border-bottom:1px solid rgba(255,255,255,.06);
                padding:10px 20px; display:flex; align-items:center; justify-content:space-between;
                height:52px;
            }
            #mi-topbar .left { display:flex; align-items:center; gap:14px; }
            #mi-topbar .right { display:flex; align-items:center; gap:18px; }
            #mi-topbar h1 { font-size:17px; font-weight:700; color:#fff; margin:0; }
            .mi-badge { background:rgba(37,99,235,.25); color:#60a5fa; padding:3px 10px; border-radius:10px; font-size:13px; font-weight:600; }
            .mi-badge.live { background:rgba(16,185,129,.2); color:#34d399; }
            .mi-badge.demo { background:rgba(245,158,11,.2); color:#fbbf24; }
            #mi-back {
                background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.1);
                color:#fff; padding:5px 14px; border-radius:6px; cursor:pointer;
                font:500 13px -apple-system,sans-serif; transition:all .2s;
            }
            #mi-back:hover { background:rgba(255,255,255,.15); }
            .mi-stat { font-size:13px; color:rgba(255,255,255,.5); }
            .mi-stat strong { color:rgba(255,255,255,.8); }
            .mi-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
            .mi-dot.p { background:#f87171; } .mi-dot.c { background:#60a5fa; }
            #mi-clock { font:600 15px -apple-system,sans-serif; color:rgba(255,255,255,.6); font-variant-numeric:tabular-nums; }
            #mi-refresh-info { font-size:12px; color:rgba(255,255,255,.35); display:flex; align-items:center; gap:5px; }
            .mi-spinner { width:10px;height:10px;border:2px solid rgba(96,165,250,.3);border-top-color:#60a5fa;border-radius:50%;display:none;animation:mi-spin .5s linear infinite; }
            .mi-spinner.on { display:inline-block; }
            @keyframes mi-spin { to{transform:rotate(360deg)} }

            /* ═══ PANEL ÚLTIMA HORA ═══ */
            #mi-panel {
                position:fixed; top:52px; right:0; width:480px; bottom:0; z-index:999;
                background:rgba(15,17,23,.94); backdrop-filter:blur(16px);
                border-left:1px solid rgba(255,255,255,.06);
                display:flex; flex-direction:column;
                transition:transform .25s cubic-bezier(.4,0,.2,1);
            }
            #mi-panel.collapsed { transform:translateX(100%); }
            #mi-panel-toggle {
                position:fixed; top:62px; right:492px; z-index:1001;
                background:rgba(15,17,23,.85); border:1px solid rgba(255,255,255,.1);
                color:#e2e4e9; padding:8px 14px; border-radius:6px; cursor:pointer;
                font:600 14px -apple-system,sans-serif; transition:all .25s;
            }
            #mi-panel.collapsed ~ #mi-panel-toggle { right:12px; }
            #mi-panel-toggle:hover { background:rgba(37,99,235,.25); }
            #mi-panel-body { flex:1; overflow-y:auto; padding:2px 0; }
            #mi-panel-body::-webkit-scrollbar { width:4px; }
            #mi-panel-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12); border-radius:2px; }

            .mi-sec {
                padding:7px 18px; font:700 11px -apple-system,sans-serif;
                text-transform:uppercase; letter-spacing:.7px; color:rgba(255,255,255,.3);
                background:rgba(255,255,255,.02); position:sticky; top:0; z-index:2;
            }
            .mi-card {
                padding:12px 18px; margin:0 8px 6px; border-radius:6px;
                cursor:pointer; transition:background .12s, opacity .15s; border-left:4px solid transparent;
            }
            .mi-card:hover { filter:brightness(1.3); }
            .mi-card.closed { opacity:0.45; }
            .mi-card.closed:hover { opacity:0.7; }
            .mi-card.pinned { border-left-color:#fbbf24!important; box-shadow:inset 0 0 0 1px rgba(251,191,36,.15); }
            .mi-sec.pinned-sec { color:rgba(251,191,36,.6); background:rgba(251,191,36,.04); }
            .mi-card.new { animation:mi-flash .6s ease 2; }
            @keyframes mi-flash { 0%,100%{background:transparent} 50%{background:rgba(251,191,36,.1)} }

            .mi-card-top { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px; }
            .mi-card-tipo { font-size:14px; font-weight:600; color:#fff; flex:1; line-height:1.3; }
            .mi-card-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
            .mi-card-est {
                font-size:10px; font-weight:700; padding:2px 7px; border-radius:3px;
                text-transform:uppercase; letter-spacing:.3px;
            }
            .mi-card-est.p { background:rgba(239,68,68,.15); color:#f87171; }
            .mi-card-est.c { background:rgba(96,165,250,.12); color:#60a5fa; }
            .mi-card-id {
                font:500 12px 'SF Mono',Consolas,monospace; color:rgba(255,255,255,.5);
                cursor:pointer; transition:color .12s; letter-spacing:.3px; margin-left:auto;
            }
            .mi-card-id:hover { color:#60a5fa; text-decoration:underline; }
            .mi-card-id.copied { color:#34d399; }
            .mi-card-info { display:flex; align-items:center; gap:8px; margin-bottom:3px; }
            .mi-card-hora { font-size:13px; color:rgba(255,255,255,.45); font-weight:500; }
            .mi-card-dir { font-size:13px; color:rgba(255,255,255,.55); line-height:1.3; margin-bottom:2px; }
            .mi-card-dir [data-action="copydir"]:hover { color:rgba(255,255,255,.8); text-decoration:underline; text-decoration-style:dashed; text-underline-offset:2px; }
            .mi-card-desc { font-size:12px; color:rgba(255,255,255,.35); line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:default; }
            .mi-card-desc:hover { color:rgba(255,255,255,.55); }
            #mi-desc-tip {
                position:fixed; z-index:99999; pointer-events:none; display:none;
                background:rgba(15,17,23,.95); color:rgba(255,255,255,.8); border:1px solid rgba(255,255,255,.15);
                padding:6px 10px; border-radius:6px; font:12px/1.4 -apple-system,sans-serif;
                white-space:normal; max-width:280px; width:max-content;
                box-shadow:0 4px 12px rgba(0,0,0,.5);
            }
            .mi-card-btns { display:flex; gap:4px; margin-top:8px; flex-wrap:wrap; }
            .mi-card-btns button {
                background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.07);
                color:rgba(255,255,255,.5); padding:4px 10px; border-radius:4px;
                font:500 11px -apple-system,sans-serif; cursor:pointer; transition:all .12s;
            }
            .mi-card-btns button:hover { background:rgba(37,99,235,.18); color:#60a5fa; border-color:rgba(37,99,235,.3); }
            .mi-card-btns button[data-action="locate"] { background:rgba(251,191,36,.12); color:#fbbf24; border-color:rgba(251,191,36,.2); font-weight:600; }
            .mi-card-btns button[data-action="locate"]:hover { background:rgba(251,191,36,.25); }
            .mi-card-btns button[data-action="ignore"] { margin-left:auto; color:rgba(255,255,255,.3); }
            .mi-card-btns button[data-action="ignore"]:hover { color:#f87171; background:rgba(239,68,68,.12); border-color:rgba(239,68,68,.2); }

            /* ═══ PLACEMENT MODE ═══ */
            #mi-placement-banner {
                position:fixed; top:58px; left:50%; transform:translateX(-50%); z-index:1100;
                background:rgba(251,191,36,.15); backdrop-filter:blur(12px);
                border:1.5px solid rgba(251,191,36,.4); border-radius:8px;
                padding:10px 24px; display:none; align-items:center; gap:14px;
                font:600 14px -apple-system,sans-serif; color:#fbbf24;
                box-shadow:0 4px 20px rgba(0,0,0,.4); pointer-events:none;
                animation:mi-pulse-border 1.5s ease-in-out infinite;
            }
            #mi-placement-banner.on { display:flex; }
            #mi-placement-banner .esc { color:rgba(255,255,255,.5); font-size:12px; font-weight:400; }
            @keyframes mi-pulse-border { 0%,100%{border-color:rgba(251,191,36,.4)} 50%{border-color:rgba(251,191,36,.8)} }
            .placement-active { cursor:crosshair!important; }
            .placement-active .leaflet-container { cursor:crosshair!important; }
            .placement-active * { cursor:crosshair!important; }

            /* ═══ LEYENDA ═══ */
            #mi-legend {
                position:fixed; bottom:16px; left:16px; z-index:999;
                background:rgba(15,17,23,.88); backdrop-filter:blur(8px);
                border:1px solid rgba(255,255,255,.08); border-radius:6px;
                padding:8px 14px; font-size:11px;
            }
            #mi-legend h4 { font:600 11px -apple-system,sans-serif; color:rgba(255,255,255,.4); margin:0 0 4px; text-transform:uppercase; letter-spacing:.5px; }
            .mi-leg { display:flex; align-items:center; gap:6px; margin:2px 0; color:rgba(255,255,255,.45); }
            .mi-leg-d { width:9px; height:9px; border-radius:50%; }

            .mi-cursor-tooltip {
                background:rgba(0,0,0,.8)!important; border:1px solid rgba(52,211,153,.4)!important;
                color:#34d399!important; font:700 14px -apple-system,sans-serif!important;
                padding:3px 8px!important; border-radius:4px!important; box-shadow:none!important;
            }
            .mi-cursor-tooltip::before { display:none!important; }

            /* ═══ NEARBY CAMERA LABELS ═══ */
            .mi-nearby-label {
                background:rgba(0,0,0,.85); backdrop-filter:blur(6px);
                border-radius:4px; padding:4px 8px;
                font:700 12px -apple-system,sans-serif;
                white-space:nowrap; pointer-events:none;
                border:1px solid rgba(255,255,255,.15);
                box-shadow:0 2px 8px rgba(0,0,0,.5);
                line-height:1.3;
            }
            .mi-nearby-square {
                display:inline-block; width:8px; height:8px;
                border-radius:1px; margin-right:4px; vertical-align:middle;
            }

            .mi-cam-popup .leaflet-popup-content-wrapper { padding:0!important; min-width:auto!important; }
            .mi-cam-popup .leaflet-popup-content { margin:6px 10px!important; }

            /* ═══ LEAFLET POPUP OVERRIDE ═══ */
            .leaflet-popup-content-wrapper {
                background:rgba(15,17,23,.95)!important; backdrop-filter:blur(12px);
                border:1px solid rgba(255,255,255,.1)!important; border-radius:8px!important;
                color:#e2e4e9!important; box-shadow:0 8px 32px rgba(0,0,0,.5)!important;
            }
            .leaflet-popup-tip { background:rgba(15,17,23,.95)!important; }
            .mi-proc-popup .leaflet-popup-content-wrapper {
                background:rgba(15,17,23,.85)!important; border-color:rgba(255,255,255,.06)!important;
                box-shadow:0 2px 12px rgba(0,0,0,.3)!important; backdrop-filter:blur(6px)!important;
                overflow:hidden!important; border-left:4px solid var(--mi-proc-color, rgba(255,255,255,.2))!important;
            }
            .mi-proc-popup .leaflet-popup-content { margin:10px 14px 10px!important; }
            .mi-proc-popup .leaflet-popup-tip { background:rgba(15,17,23,.55)!important; }
            .mi-proc-popup { pointer-events:none; }
            .mi-proc-popup .leaflet-popup-content-wrapper { pointer-events:auto; }
            .leaflet-popup-content { margin:10px 14px!important; font:14px -apple-system,sans-serif!important; line-height:1.4!important; }
        `;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  11. UI: CONSTRUCCIÓN                                         ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function construirUI() {
        const wrapper = document.getElementById('page-wrapper');
        if (wrapper) wrapper.style.display = 'none';
        const sidebar = document.querySelector('.navbar-default.navbar-static-side');
        if (sidebar) sidebar.style.display = 'none';

        const container = document.createElement('div');
        container.id = 'mapa-integrado-root';
        container.innerHTML = `
            <style>${getStyles()}</style>

            <!-- TOPBAR -->
            <div id="mi-topbar">
                <div class="left">
                    <button id="mi-back">← Volver</button>
                    <h1>🗺️ Mapa Integrado</h1>
                    <span class="mi-badge" id="mi-mode">Conectando...</span>
                </div>
                <div class="right">
                    <span class="mi-stat"><span class="mi-dot p"></span>Activos: <strong id="mi-cnt-p">0</strong></span>
                    <span class="mi-stat"><span class="mi-dot c"></span>Ignorados: <strong id="mi-cnt-c">0</strong></span>
                    <span id="mi-refresh-info">
                        <span class="mi-spinner" id="mi-spinner"></span>
                        <span id="mi-clock">--:--:--</span>
                        <span style="color:rgba(255,255,255,.15)">·</span>
                        <span>⟳ <span id="mi-countdown">--</span>s</span>
                    </span>
                </div>
            </div>

            <!-- MAPA -->
            <div id="mi-map" style="top:52px"></div>
            <div id="mi-placement-banner">
                <span>🎯 Click en el mapa para reubicar procedimiento</span>
                <span class="esc">ESC: Cancelar</span>
            </div>

            <!-- PANEL -->
            <div id="mi-panel">
                <div id="mi-panel-body"></div>
            </div>
            <button id="mi-panel-toggle">◀</button>

            <!-- LEYENDA -->
            <div id="mi-legend">
                <h4>Cámaras</h4>
                <div class="mi-leg"><span class="mi-leg-d" style="background:#ef4444;border-radius:1px"></span>Barrio Protegido</div>
                <div class="mi-leg"><span class="mi-leg-d" style="background:#3b82f6;border-radius:1px"></span>Red Municipal</div>
                <div class="mi-leg"><span class="mi-leg-d" style="background:#22c55e;border-radius:1px"></span>Postes Inteligentes</div>
                <div class="mi-leg"><span class="mi-leg-d" style="background:#a855f7;border-radius:1px"></span>Refugios Inteligentes</div>
                <div style="margin-top:4px;padding-top:3px;border-top:1px solid rgba(255,255,255,.06)">
                    <div style="font:600 8px -apple-system,sans-serif;color:rgba(255,255,255,.2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Controles</div>
                    <div class="mi-leg" style="color:rgba(255,255,255,.25)">WASD mover · +/- zoom</div>
                    <div class="mi-leg" style="color:rgba(255,255,255,.25)"><span style="color:#fbbf24">1</span> lápiz <span style="color:#f472b6">2</span> flecha <span style="color:#34d399">3</span> radio</div>
                    <div class="mi-leg" style="color:rgba(255,255,255,.25)">| Ctrl+Z deshacer · 0 borrar</div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        // Tooltip flotante para descripciones (position:fixed, sigue al cursor)
        const tip = document.createElement('div');
        tip.id = 'mi-desc-tip';
        container.appendChild(tip);

        S.ui.container = container;
        return container;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  12. SISTEMA DE DIBUJO                                        ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const DRAW_COLORS = { 1: '#fbbf24', 2: '#f472b6', 3: '#34d399' };
    const DRAW_NAMES  = { 1: 'Lápiz', 2: 'Flecha', 3: 'Radio' };

    function activarHerramientaDibujo(tool) {
        const d = S.draw;
        if (d.mode === tool) { desactivarDibujo(); return; }
        desactivarDibujo();
        d.mode = tool;
        if (!S.layers.draw) S.layers.draw = L.layerGroup().addTo(S.map);
        S.map.getContainer().style.cursor = 'crosshair';
        actualizarIndicadorDibujo();
    }

    function desactivarDibujo() {
        const d = S.draw;
        d.mode = null;
        d.isDrawing = false;
        d.isDragging = false;
        d.dragStart = null;
        d.pencilPoints = [];
        if (d.radiusCenterMarker) { S.layers.draw?.removeLayer(d.radiusCenterMarker); d.radiusCenterMarker = null; }
        d.radiusCenter = null;
        if (d.temp) { S.layers.draw?.removeLayer(d.temp); d.temp = null; }
        hideDistLabel();
        if (S.map) S.map.getContainer().style.cursor = '';
        actualizarIndicadorDibujo();
    }

    function undoLastDraw() {
        const d = S.draw;
        if (d.history.length === 0) return;
        const last = d.history.pop();
        if (S.layers.draw) S.layers.draw.removeLayer(last);
    }

    function actualizarIndicadorDibujo(customMsg) {
        let indicator = document.getElementById('mi-draw-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'mi-draw-indicator';
            indicator.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:1001;background:rgba(15,17,23,.92);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:6px 14px;font:600 11px -apple-system,sans-serif;color:#fff;display:none;pointer-events:none;';
            document.getElementById('mapa-integrado-root')?.appendChild(indicator);
        }
        const d = S.draw;
        if (d.mode) {
            const color = DRAW_COLORS[d.mode];
            indicator.innerHTML = customMsg
                ? `<span style="color:${color}">● </span>${esc(customMsg)} · <span style="color:rgba(255,255,255,.4)">ESC cancelar</span>`
                : `<span style="color:${color}">● ${DRAW_NAMES[d.mode]}</span> — Click en mapa · <span style="color:rgba(255,255,255,.4)">ESC cancelar</span>`;
            indicator.style.display = 'block';
        } else {
            indicator.style.display = 'none';
        }
    }

    // ── Floating distance label ──
    function showDistLabel(text) {
        const d = S.draw;
        if (!d.distLabel) {
            d.distLabel = document.createElement('div');
            d.distLabel.style.cssText = 'position:fixed;z-index:1002;background:rgba(0,0,0,.8);color:#fff;font:700 11px -apple-system,sans-serif;padding:2px 6px;border-radius:4px;pointer-events:none;display:none;';
            document.getElementById('mapa-integrado-root')?.appendChild(d.distLabel);
        }
        d.distLabel.textContent = text;
        d.distLabel.style.display = 'block';
    }

    function moveDistLabel(e) {
        const dl = S.draw.distLabel;
        if (dl && dl.style.display !== 'none') {
            dl.style.left = (e.clientX + 14) + 'px';
            dl.style.top = (e.clientY - 10) + 'px';
        }
    }

    function hideDistLabel() {
        const dl = S.draw.distLabel;
        if (dl) dl.style.display = 'none';
    }

    /** Convierte evento mouse a latlng del mapa */
    function mouseToLatLng(e) {
        const rect = S.map.getContainer().getBoundingClientRect();
        return S.map.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
    }

    /** Crea flecha con punta triangular sólida */
    function crearFlecha(from, to) {
        const color = DRAW_COLORS[2];
        const group = L.layerGroup();

        L.polyline([from, to], { color, weight: 5, opacity: 0.9, lineCap: 'round' }).addTo(group);

        const fromPx = S.map.latLngToContainerPoint(from);
        const toPx = S.map.latLngToContainerPoint(to);
        const dx = toPx.x - fromPx.x;
        const dy = toPx.y - fromPx.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 8) return group;

        const ux = dx / len, uy = dy / len;
        const px = -uy, py = ux;
        const headLen = Math.min(24, len * 0.35);
        const headW = headLen * 0.55;

        const basePx = L.point(toPx.x - ux * headLen, toPx.y - uy * headLen);
        const leftPx = L.point(basePx.x + px * headW, basePx.y + py * headW);
        const rightPx = L.point(basePx.x - px * headW, basePx.y - py * headW);

        const tip = S.map.containerPointToLatLng(toPx);
        const left = S.map.containerPointToLatLng(leftPx);
        const right = S.map.containerPointToLatLng(rightPx);

        L.polygon([tip, left, right], { color, fillColor: color, fillOpacity: 1, weight: 0 }).addTo(group);
        return group;
    }

    /** Registra handlers de dibujo en el mapa (usa AbortController) */
    function setupDrawHandlers(signal) {
        const mapEl = S.map.getContainer();
        const d = S.draw;

        // Global mousemove para dist label
        document.addEventListener('mousemove', moveDistLabel, { signal });

        // ══ TOOL 1: LÁPIZ FREEHAND ══
        mapEl.addEventListener('mousedown', (e) => {
            if (d.mode !== 1 || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            d.isDrawing = true;
            d.pencilPoints = [mouseToLatLng(e)];
            d.temp = L.polyline(d.pencilPoints, {
                color: DRAW_COLORS[1], weight: 3, opacity: 0.85,
                lineCap: 'round', lineJoin: 'round', smoothFactor: 1,
            }).addTo(S.layers.draw);
        }, { capture: true, signal });

        mapEl.addEventListener('mousemove', (e) => {
            if (d.mode !== 1 || !d.isDrawing || !d.temp) return;
            e.preventDefault();
            d.pencilPoints.push(mouseToLatLng(e));
            d.temp.setLatLngs(d.pencilPoints);
        }, { capture: true, signal });

        mapEl.addEventListener('mouseup', () => {
            if (d.mode !== 1 || !d.isDrawing) return;
            d.isDrawing = false;
            if (d.temp && d.pencilPoints.length > 3) {
                d.history.push(d.temp);
            } else if (d.temp) {
                S.layers.draw.removeLayer(d.temp);
            }
            d.temp = null;
            d.pencilPoints = [];
        }, { capture: true, signal });

        // ══ TOOL 2: FLECHA ══
        mapEl.addEventListener('mousedown', (e) => {
            if (d.mode !== 2 || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            d.isDragging = true;
            d.dragStart = mouseToLatLng(e);
            if (d.temp) { S.layers.draw.removeLayer(d.temp); d.temp = null; }
        }, { capture: true, signal });

        mapEl.addEventListener('mousemove', (e) => {
            if (d.mode !== 2 || !d.isDragging || !d.dragStart) return;
            e.preventDefault();
            const current = mouseToLatLng(e);
            const dist = d.dragStart.distanceTo(current);
            if (d.temp) S.layers.draw.removeLayer(d.temp);
            d.temp = crearFlecha(d.dragStart, current);
            d.temp.addTo(S.layers.draw);
            showDistLabel(fmtDist(dist));
            actualizarIndicadorDibujo('Flecha — ' + fmtDist(dist));
        }, { capture: true, signal });

        mapEl.addEventListener('mouseup', (e) => {
            if (d.mode !== 2 || !d.isDragging || !d.dragStart) return;
            d.isDragging = false;
            hideDistLabel();
            const end = mouseToLatLng(e);
            const dist = d.dragStart.distanceTo(end);
            if (dist < 10) {
                if (d.temp) { S.layers.draw.removeLayer(d.temp); d.temp = null; }
            } else if (d.temp) {
                d.history.push(d.temp);
                d.temp = null;
            }
            d.dragStart = null;
            actualizarIndicadorDibujo('Flecha — Arrastra inicio → fin');
        }, { capture: true, signal });

        // ══ TOOL 3: RADIO ══
        S.map.on('click', (e) => {
            // Placement mode: interceptar click antes de draw
            if (S.placement.active) {
                confirmarPlacement(e.latlng);
                return;
            }
            if (d.mode !== 3) return;
            const latlng = e.latlng;
            const color = DRAW_COLORS[3];

            if (!d.radiusCenter) {
                d.radiusCenter = latlng;
                d.radiusCenterMarker = L.circleMarker(latlng, {
                    radius: 4, fillColor: color, fillOpacity: 1, color: '#fff', weight: 2,
                }).addTo(S.layers.draw);
                actualizarIndicadorDibujo('Radio — Mueve mouse · Click confirmar');
            } else {
                const radius = d.radiusCenter.distanceTo(latlng);
                if (d.temp) S.layers.draw.removeLayer(d.temp);
                hideDistLabel();

                const group = L.layerGroup().addTo(S.layers.draw);
                L.circleMarker(d.radiusCenter, { radius: 3, fillColor: color, fillOpacity: 0.8, color: '#fff', weight: 1 }).addTo(group);
                L.circle(d.radiusCenter, { radius, color, fillColor: color, fillOpacity: 0.08, weight: 2, dashArray: '6,3' }).addTo(group);
                d.history.push(group);

                if (d.radiusCenterMarker) { S.layers.draw.removeLayer(d.radiusCenterMarker); d.radiusCenterMarker = null; }
                d.temp = null;
                d.radiusCenter = null;
                actualizarIndicadorDibujo('Radio — Click nuevo centro');
            }
        });

        S.map.on('mousemove', (e) => {
            if (d.mode !== 3 || !d.radiusCenter) return;
            const radius = d.radiusCenter.distanceTo(e.latlng);
            const color = DRAW_COLORS[3];
            if (d.temp) S.layers.draw.removeLayer(d.temp);
            d.temp = L.circle(d.radiusCenter, {
                radius, color, fillColor: color, fillOpacity: 0.06, weight: 1.5, dashArray: '4,4',
            }).addTo(S.layers.draw);
            showDistLabel(fmtDist(radius));
            actualizarIndicadorDibujo('Radio — ' + fmtDist(radius) + ' — Click confirmar');
        });
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  13. PANEL: RENDER Y EVENT DELEGATION                         ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function cardHTML(p) {
        const hora = p.fecha.match(/\d{2}:\d{2}/)?.[0] || p.fecha;
        const isPendiente = p.estado === 'PENDIENTE';
        const isPinned = S.procs.pinned.has(p.id);
        const hasCoords = !!resolveCoords(p.id, p.internalId);
        const dirIcon = hasCoords ? '📍' : '<span style="color:rgba(251,191,36,.6)">⚠</span>';
        const dirLine = p.dir
            ? `<div class="mi-card-dir">${dirIcon} <span data-action="copydir" data-copy="${esc(p.dir)}" style="cursor:pointer">${esc(p.dir)}</span></div>`
            : `<div class="mi-card-dir" style="color:rgba(251,191,36,.5)">⚠ Sin dirección</div>`;
        const descLine = p.desc ? `<div class="mi-card-desc" data-tooltip="${esc(p.desc)}">${esc(p.desc)}</div>` : '';
        const idDisplay = p.id.length > 4 ? p.id.slice(0, -4) + ' ' + p.id.slice(-4) : p.id;
        const detailUrl = p.internalId ? `/incidents/${p.internalId}` : '';
        return `
            <div class="mi-card${isPendiente ? '' : ' closed'}${isPinned ? ' pinned' : ''}" data-id="${esc(p.id)}" style="border-left-color:${isPendiente ? p.cat.border : 'transparent'};background:${p.cat.color}">
                <div class="mi-card-top">
                    <span class="mi-card-tipo" style="color:${p.cat.border}">${esc(p.tipo)}</span>
                    <div class="mi-card-right">
                        <span class="mi-card-est ${isPendiente ? 'p' : 'c'}">${isPendiente ? 'PENDIENTE' : 'CERRADO'}</span>
                    </div>
                </div>
                <div class="mi-card-info">
                    <span class="mi-card-hora">🕐 ${esc(hora)}</span>
                    <span class="mi-card-id" data-action="copy" data-copy="${esc(p.id)}">${esc(idDisplay)}</span>
                </div>
                ${dirLine}
                ${descLine}
                <div class="mi-card-btns">
                    <button data-action="locate" data-id="${esc(p.id)}">🎯 Reubicar</button>
                    <button data-action="pin" data-id="${esc(p.id)}" title="${isPinned ? 'Desfijar' : 'Fijar'}">${isPinned ? '📌 Desfijar' : '📍 Fijar'}</button>
                    ${detailUrl ? `<button data-action="detail" data-url="${esc(detailUrl)}">ℹ️</button>` : ''}
                    <button data-action="arcgis" data-dir="${esc(p.dir)}" data-pid="${esc(p.id)}">🗺️</button>
                    <button data-action="gmaps" data-dir="${esc(p.dir)}">📍</button>
                    <button data-action="ignore" data-id="${esc(p.id)}">✕</button>
                </div>
            </div>`;
    }

    function renderPanel() {
        const container = S.ui.container;
        if (!container) return;
        const body = container.querySelector('#mi-panel-body');

        // Merge: procedimientos actuales + fijados que ya salieron de la ventana temporal
        const currentIds = new Set(S.procs.all.map(p => p.id));
        const merged = [...S.procs.all];
        for (const [id, data] of S.procs.pinnedData) {
            if (!currentIds.has(id)) {
                merged.push(data); // Agregar fijado que ya no está en ventana
            }
        }

        // Actualizar datos de fijados (puede haber cambiado estado)
        for (const p of merged) {
            if (S.procs.pinned.has(p.id)) S.procs.pinnedData.set(p.id, p);
        }

        const active = merged.filter(p => !S.procs.ignored.has(p.id));
        const pinned = active.filter(p => S.procs.pinned.has(p.id));
        const notPinned = active.filter(p => !S.procs.pinned.has(p.id));
        const pendientes = notPinned.filter(p => p.estado === 'PENDIENTE');
        const cerrados = notPinned.filter(p => p.estado === 'CERRADO');
        const ignorados = merged.filter(p => S.procs.ignored.has(p.id));

        const procCntEl = container.querySelector('#mi-proc-cnt');
        if (procCntEl) procCntEl.textContent = active.length;
        container.querySelector('#mi-cnt-p').textContent = pendientes.length;
        container.querySelector('#mi-cnt-c').textContent = ignorados.length;

        let html = '';
        if (pinned.length > 0) {
            html += `<div class="mi-sec pinned-sec">📌 Fijados (${pinned.length})</div>`;
            html += pinned.map(cardHTML).join('');
        }
        if (pendientes.length > 0) {
            html += `<div class="mi-sec">Pendientes (${pendientes.length})</div>`;
            html += pendientes.map(cardHTML).join('');
        }
        if (cerrados.length > 0) {
            html += `<div class="mi-sec">Cerrados (${cerrados.length})</div>`;
            html += cerrados.map(cardHTML).join('');
        }
        if (!html) {
            html = '<div style="padding:30px;text-align:center;color:rgba(255,255,255,.2);font-size:11px">Sin procedimientos recientes</div>';
        }
        body.innerHTML = html;
    }

    /** Event delegation: un solo listener para todo el panel */
    function setupPanelDelegation(signal) {
        const body = S.ui.container?.querySelector('#mi-panel-body');
        if (!body) return;

        // Hover en card → highlight marcador en mapa
        body.addEventListener('mouseover', (e) => {
            const card = e.target.closest('.mi-card');
            if (!card) return;
            const entry = S.procs.markers.get(card.dataset.id);
            if (entry?.marker) {
                entry.marker.setStyle({ radius: 15, weight: 3 });
                entry.marker.openPopup();
            }
        }, { signal });

        body.addEventListener('mouseout', (e) => {
            const card = e.target.closest('.mi-card');
            if (!card) return;
            const entry = S.procs.markers.get(card.dataset.id);
            if (entry?.marker) {
                entry.marker.setStyle({ radius: entry.proc?.estado === 'PENDIENTE' ? 10 : 7, weight: entry.proc?.estado === 'PENDIENTE' ? 2.5 : 1.5 });
                entry.marker.closePopup();
            }
        }, { signal });

        body.addEventListener('click', (e) => {
            const target = e.target;

            // Acción por data-action
            const actionEl = target.closest('[data-action]');
            if (actionEl) {
                const action = actionEl.dataset.action;

                if (action === 'copy') {
                    e.stopPropagation();
                    const id = actionEl.dataset.copy;
                    navigator.clipboard.writeText(id).then(() => {
                        actionEl.classList.add('copied');
                        const orig = actionEl.textContent;
                        actionEl.textContent = '✓ Copiado';
                        setTimeout(() => { actionEl.textContent = orig; actionEl.classList.remove('copied'); }, 1200);
                    });
                    return;
                }

                if (action === 'copydir') {
                    e.stopPropagation();
                    const dir = actionEl.dataset.copy;
                    navigator.clipboard.writeText(dir).then(() => {
                        const orig = actionEl.innerHTML;
                        actionEl.innerHTML = '<span style="color:#34d399">✓ Dirección copiada</span>';
                        setTimeout(() => { actionEl.innerHTML = orig; }, 1000);
                    });
                    return;
                }

                if (action === 'arcgis') {
                    e.stopPropagation();
                    abrirEnArcGIS(actionEl.dataset.dir, actionEl.dataset.pid);
                    return;
                }

                if (action === 'gmaps') {
                    e.stopPropagation();
                    abrirEnGMaps(actionEl.dataset.dir);
                    return;
                }

                if (action === 'detail') {
                    e.stopPropagation();
                    window.open(actionEl.dataset.url, '_blank');
                    return;
                }

                if (action === 'ignore') {
                    e.stopPropagation();
                    const id = actionEl.dataset.id;
                    S.procs.ignored.add(id);
                    S.procs.pinned.delete(id);
                    S.procs.pinnedData.delete(id);
                    const entry = S.procs.markers.get(id);
                    if (entry?.marker) {
                        S.layers.proc.removeLayer(entry.marker);
                    }
                    S.procs.markers.delete(id);
                    S.layers.nearby?.clearLayers();
                    renderPanel();
                    renderPanelGeoStatus();
                    return;
                }

                if (action === 'pin') {
                    e.stopPropagation();
                    const id = actionEl.dataset.id;
                    if (S.procs.pinned.has(id)) {
                        // Desfijar
                        S.procs.pinned.delete(id);
                        S.procs.pinnedData.delete(id);
                    } else {
                        // Fijar — guardar datos completos
                        const proc = S.procs.all.find(p => p.id === id)
                            || S.procs.pinnedData.get(id)
                            || S.procs.markers.get(id)?.proc;
                        if (proc) {
                            S.procs.pinned.add(id);
                            S.procs.pinnedData.set(id, proc);
                        }
                    }
                    renderPanel();
                    renderPanelGeoStatus();
                    return;
                }

                if (action === 'locate') {
                    e.stopPropagation();
                    iniciarPlacement(actionEl.dataset.id);
                    return;
                }
            }

            // Click en card → centrar en mapa o iniciar ubicación manual
            const card = target.closest('.mi-card');
            if (card) {
                const entry = S.procs.markers.get(card.dataset.id);
                if (!entry) return;
                if (entry.coords) {
                    centrarEnProcedimiento(entry);
                } else {
                    // Sin ubicación → iniciar placement mode
                    iniciarPlacement(entry.proc.id);
                }
            }
        }, { signal });

        // ── Tooltip flotante para .mi-card-desc ──
        const tip = document.getElementById('mi-desc-tip');
        if (tip) {
            body.addEventListener('mouseover', (e) => {
                const desc = e.target.closest('.mi-card-desc');
                if (!desc || !desc.dataset.tooltip) return;
                tip.textContent = desc.dataset.tooltip;
                tip.style.display = 'block';
            }, { signal });
            body.addEventListener('mouseout', (e) => {
                const desc = e.target.closest('.mi-card-desc');
                if (desc) tip.style.display = 'none';
            }, { signal });
            body.addEventListener('mousemove', (e) => {
                if (tip.style.display === 'block') {
                    tip.style.left = (e.clientX + 12) + 'px';
                    tip.style.top = (e.clientY - 10) + 'px';
                }
            }, { signal });
        }
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  13b. REUBICACIÓN MANUAL (PLACEMENT MODE)                      ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function iniciarPlacement(procId) {
        // Si ya hay draw mode activo, cancelarlo
        if (S.draw.mode) {
            S.draw.mode = null;
            actualizarIndicadorDibujo(null);
        }

        S.placement.active = true;
        S.placement.procId = procId;

        // UI feedback
        const banner = S.ui.container?.querySelector('#mi-placement-banner');
        if (banner) banner.classList.add('on');
        S.ui.container?.classList.add('placement-active');

        // Highlight the card
        const card = S.ui.container?.querySelector(`.mi-card[data-id="${procId}"]`);
        if (card) card.style.outline = '2px solid #fbbf24';

        // Si ya tiene coords, panear ahí para dar contexto visual al operador
        const entry = S.procs.markers.get(procId);
        if (entry?.coords) {
            S.map.setView(entry.coords, Math.max(S.map.getZoom(), 16), { animate: true });
        } else if (entry?.proc?.dir) {
            // Sin coords → abrir ArcGIS para referencia
            abrirEnArcGIS(entry.proc.dir, procId);
        }
    }

    function cancelarPlacement() {
        if (!S.placement.active) return;
        const procId = S.placement.procId;
        S.placement.active = false;
        S.placement.procId = null;

        const banner = S.ui.container?.querySelector('#mi-placement-banner');
        if (banner) banner.classList.remove('on');
        S.ui.container?.classList.remove('placement-active');

        // Remove card highlight
        const card = S.ui.container?.querySelector(`.mi-card[data-id="${procId}"]`);
        if (card) card.style.outline = '';
    }

    function confirmarPlacement(latlng) {
        if (!S.placement.active || !S.placement.procId) return;
        const procId = S.placement.procId;
        const coords = [latlng.lat, latlng.lng];

        // Guardar coordenadas manuales (persisten a través de refreshes)
        S.procs.manualCoords.set(procId, coords);

        // Auto-fijar el procedimiento
        const entry = S.procs.markers.get(procId);
        if (entry?.proc) {
            S.procs.pinned.add(procId);
            S.procs.pinnedData.set(procId, entry.proc);
        }

        // Crear/actualizar marcador en el mapa
        agregarMarcadorProc(procId, coords, entry?.proc);

        // Mostrar cámaras cercanas
        mostrarCamarasCercanas(coords);

        // Centrar vista
        S.map.setView(coords, 17, { animate: true });

        // Limpiar placement mode
        cancelarPlacement();

        // Re-render panel para actualizar botones y estado
        renderPanel();
        renderPanelGeoStatus();
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  14. NAVEGACIÓN EXTERNA                                       ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function abrirEnArcGIS(dir, procId) {
        if (!dir) return;
        const q = prepararDireccion(dir) + ', Las Condes';
        const url = `${CONFIG.ARCGIS_VISOR_URL}&find=${encodeURIComponent(q)}`;
        const w = S.windows;
        if (w.arcgis && !w.arcgis.closed) {
            w.arcgis.location.href = url;
        } else {
            w.arcgis = window.open(url, 'arcgis_visor');
        }
    }

    function abrirEnGMaps(dir) {
        if (!dir) return;
        const q = dirParaGMaps(dir) + ', Las Condes, Santiago, Chile';
        const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
        const w = S.windows;
        if (w.gmaps && !w.gmaps.closed) {
            w.gmaps.location.href = url;
        } else {
            w.gmaps = window.open(url, 'gmaps_visor');
        }
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  15. MAPA: PROCEDIMIENTOS Y CÁMARAS                          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function centrarEnProcedimiento(entry) {
        const panelOpen = !document.querySelector('#mi-panel')?.classList.contains('collapsed');
        const panelW = panelOpen ? 480 : 0;
        const topbarH = 52;
        const mapSize = S.map.getSize();
        const centerX = (mapSize.x - panelW) / 2;
        const centerY = topbarH + ((mapSize.y - topbarH) / 2);

        S.map.setZoom(17, { animate: false });
        setTimeout(() => {
            const targetPoint = S.map.latLngToContainerPoint(entry.coords);
            S.map.panBy([targetPoint.x - centerX, targetPoint.y - centerY], { animate: true, duration: 0.4 });
            setTimeout(() => {
                // Mostrar cámaras cercanas (persisten)
                mostrarCamarasCercanas(entry.coords);
                // Popup breve — se cierra solo después de 2s ya que el mouse está en el panel
                entry.marker.openPopup();
                setTimeout(() => entry.marker.closePopup(), 2000);
            }, 450);
        }, 100);
    }

    function renderMapProcs() {
        S.layers.proc.clearLayers();
        S.procs.markers.clear();

        // Merge: actuales + fijados fuera de ventana
        const currentIds = new Set(S.procs.all.map(p => p.id));
        const visible = [...S.procs.all.filter(p => !S.procs.ignored.has(p.id))];
        for (const [id, data] of S.procs.pinnedData) {
            if (!currentIds.has(id) && !S.procs.ignored.has(id)) {
                visible.push(data);
            }
        }

        for (const p of visible) {
            const coords = resolveCoords(p.id, p.internalId);

            if (coords) {
                agregarMarcadorProc(p.id, coords, p);
            } else {
                S.procs.markers.set(p.id, { marker: null, coords: null, proc: p });
            }
        }

        renderPanelGeoStatus();
    }

    /** Agrega o actualiza marcador de procedimiento en el mapa */
    function agregarMarcadorProc(procId, coords, procData) {
        const existing = S.procs.markers.get(procId);
        const p = procData || existing?.proc;
        if (!p) return;

        // Si ya tiene marcador, remover
        if (existing?.marker) S.layers.proc?.removeLayer(existing.marker);

        const isPendiente = p.estado === 'PENDIENTE';
        const marker = L.circleMarker(coords, {
            radius: isPendiente ? 10 : 7,
            fillColor: p.cat.border,
            fillOpacity: isPendiente ? 0.85 : 0.35,
            color: isPendiente ? '#fff' : 'rgba(255,255,255,.3)',
            weight: isPendiente ? 2.5 : 1.5,
            pane: 'procPane',
        }).addTo(S.layers.proc);

        const hora = p.fecha.match(/\d{2}:\d{2}/)?.[0] || p.fecha;
        marker.bindPopup(`
            <div>
                <div style="font:700 15px -apple-system,sans-serif;color:${p.cat.border};margin-bottom:3px">ID: ${esc(p.id)}</div>
                <div style="color:rgba(255,255,255,.6);font-size:13px;margin-bottom:3px">📍 ${esc(p.dir)}</div>
                <div style="font-size:12px;color:rgba(255,255,255,.4)">🕐 ${esc(hora)} · ${esc(p.tipo)}${isPendiente ? '' : ' · CERRADO'}</div>
            </div>
        `, { className: 'mi-proc-popup', closeButton: false, autoPan: false });

        marker.on('popupopen', (e) => {
            const wrapper = e.popup.getElement()?.querySelector('.leaflet-popup-content-wrapper');
            if (wrapper) wrapper.style.borderLeftColor = p.cat.border;
        });
        marker.on('mouseover', () => marker.openPopup());
        marker.on('mouseout',  () => marker.closePopup());
        marker.on('click', () => mostrarCamarasCercanas(coords));

        S.procs.markers.set(procId, { marker, coords, proc: p });
    }

    /** Marca visualmente en el panel qué cards tienen/no tienen ubicación */
    function renderPanelGeoStatus() {
        const body = S.ui.container?.querySelector('#mi-panel-body');
        if (!body) return;
        body.querySelectorAll('.mi-card').forEach(card => {
            const entry = S.procs.markers.get(card.dataset.id);
            const dirEl = card.querySelector('.mi-card-dir');
            if (!entry?.coords && dirEl) {
                if (!dirEl.dataset.marked) {
                    dirEl.dataset.marked = '1';
                    const txt = dirEl.textContent.replace(/^📍\s*/, '').replace(/^⚠\s*/, '');
                    dirEl.innerHTML = `<span style="color:rgba(251,191,36,.6)">⚠</span> ${esc(txt)}`;
                    card.style.opacity = '0.7';
                }
            } else if (entry?.coords) {
                if (dirEl?.dataset.marked) {
                    delete dirEl.dataset.marked;
                    const txt = dirEl.textContent.replace(/^⚠\s*/, '');
                    dirEl.innerHTML = `📍 ${esc(txt)}`;
                    card.style.opacity = '';
                }
            }
        });
    }

    function mostrarCamarasCercanas(coords, radioMetros = CONFIG.NEARBY_RADIUS) {
        S.layers.nearby.clearLayers();
        if (!S.cameras.data.length) return;

        const cercanas = S.cameras.data
            .map(cam => ({ ...cam, dist: haversine(coords[0], coords[1], cam.lat, cam.lng) }))
            .filter(cam => cam.dist <= radioMetros)
            .sort((a, b) => a.dist - b.dist);

        if (!cercanas.length) return;

        L.circle(coords, {
            radius: radioMetros,
            color: 'rgba(255,255,255,.15)',
            fillColor: 'rgba(255,255,255,.03)',
            weight: 1,
            dashArray: '4,4',
        }).addTo(S.layers.nearby);

        const dirs = ['top', 'right', 'bottom', 'left'];
        cercanas.forEach((cam, idx) => {
            const pg = cam.programa || 'R';
            const color = PROG_COLOR[pg] || '#3b82f6';
            const dist = Math.round(cam.dist);
            const short = codigoCorto(cam);

            const icon = L.divIcon({
                className: '',
                html: `<div style="width:10px;height:10px;background:${color};border:2px solid #fff;border-radius:1px;box-shadow:0 0 8px ${color};"></div>`,
                iconSize: [10, 10],
                iconAnchor: [5, 5],
            });
            const nearMarker = L.marker([cam.lat, cam.lng], { icon, interactive: true }).addTo(S.layers.nearby);

            const dir = dirs[idx % dirs.length];
            const off = dir === 'top' ? [0, -8] : dir === 'bottom' ? [0, 8] : dir === 'right' ? [8, 0] : [-8, 0];
            const content = `<span class="mi-nearby-square" style="background:${color}"></span><strong>${esc(short)}</strong> <span style="font-size:8px;color:rgba(255,255,255,.3)">${dist}m</span>`;

            nearMarker.bindTooltip(content, {
                permanent: true, direction: dir, offset: off,
                className: 'mi-nearby-label', interactive: true,
            });

            // Click copia código
            nearMarker.on('click', () => {
                navigator.clipboard.writeText(short).then(() => {
                    nearMarker.setTooltipContent(`<span style="color:#34d399">✓ ${esc(short)}</span>`);
                    setTimeout(() => nearMarker.setTooltipContent(content), 800);
                });
            });
        });
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  16. REFRESH ADAPTATIVO                                       ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function getRefreshSec() {
        const pendientes = S.procs.all.filter(x => x.estado === 'PENDIENTE');
        const p = pendientes.length;
        if (p === 0) return CONFIG.REFRESH[0];

        const hayCritico = pendientes.some(x => CONFIG.CRITICAS.includes(x.cat.id));
        if (hayCritico) return CONFIG.REFRESH_CRITICO;

        if (p <= 3) return CONFIG.REFRESH[3];
        if (p <= 10) return CONFIG.REFRESH[10];
        return CONFIG.REFRESH.max;
    }

    function startRefreshCycle() {
        const r = S.refresh;
        if (r.timer) clearInterval(r.timer);
        r.countdown = getRefreshSec();

        const cdEl = S.ui.container?.querySelector('#mi-countdown');
        if (cdEl) cdEl.textContent = r.countdown;

        r.timer = setInterval(() => {
            r.countdown--;
            if (cdEl) cdEl.textContent = Math.max(0, r.countdown);
            if (r.countdown <= 0) {
                refreshData().then(() => {
                    // Limpiar ignorados que ya no son pendientes
                    const pendIds = new Set(S.procs.all.filter(x => x.estado === 'PENDIENTE').map(x => x.id));
                    for (const id of S.procs.ignored) {
                        if (!pendIds.has(id)) S.procs.ignored.delete(id);
                    }
                    r.countdown = getRefreshSec();
                });
            }
        }, 1000);
    }

    async function refreshData() {
        const container = S.ui.container;
        if (!container) return;

        container.querySelector('#mi-spinner')?.classList.add('on');

        // Fetch procedimientos + coordenadas en paralelo
        const [{ procs, live }, serverCoords] = await Promise.all([
            fetchProcedimientos(),
            fetchIncidentMapCoords(),
        ]);

        // Merge coords del servidor (sin sobrescribir las existentes para proc fijados)
        for (const [id, coords] of serverCoords) {
            S.procs.serverCoords.set(id, coords);
        }

        const modeEl = container.querySelector('#mi-mode');
        if (live && procs.length > 0) {
            modeEl.textContent = '● En vivo';
            modeEl.className = 'mi-badge live';
        } else if (live) {
            modeEl.textContent = 'Sin procedimientos recientes';
            modeEl.className = 'mi-badge';
        } else {
            modeEl.textContent = '⚠ Sin conexión';
            modeEl.className = 'mi-badge demo';
        }

        S.procs.all = procs;
        renderPanel();
        renderMapProcs();
        container.querySelector('#mi-spinner')?.classList.remove('on');
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  17. APP CONTROLLER: INIT Y CLEANUP                           ║
    // ╚═══════════════════════════════════════════════════════════════╝

    async function iniciarMapa(container) {
        try {
            await cargarLeaflet();
        } catch (e) {
            console.error('[MapaIntegrado] Leaflet failed:', e);
            container.querySelector('#mi-mode').textContent = '⚠ Error cargando mapa';
            container.querySelector('#mi-mode').className = 'mi-badge demo';
            return;
        }
        if (!window.L) {
            container.querySelector('#mi-mode').textContent = '⚠ Leaflet no disponible';
            container.querySelector('#mi-mode').className = 'mi-badge demo';
            return;
        }

        // AbortController para cleanup limpio de todos los listeners
        S.abortController = new AbortController();
        const signal = S.abortController.signal;

        // ── Mapa ──
        S.map = L.map('mi-map', {
            center: CONFIG.CENTER,
            zoom: CONFIG.ZOOM,
            zoomControl: false,
            attributionControl: false,
            keyboard: false,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(S.map);

        L.control.zoom({ position: 'topleft' }).addTo(S.map);
        S.map.doubleClickZoom.disable();

        // Custom panes para z-index: proc debajo, cámaras encima
        S.map.createPane('procPane');
        S.map.getPane('procPane').style.zIndex = 400;
        S.map.createPane('camPane');
        S.map.getPane('camPane').style.zIndex = 450;
        S.map.createPane('camPopupPane');
        S.map.getPane('camPopupPane').style.zIndex = 700; // sobre popups de proc (650)

        S.layers.proc = L.layerGroup().addTo(S.map);
        S.layers.cam = L.layerGroup().addTo(S.map);
        S.layers.nearby = L.layerGroup().addTo(S.map);
        S.layers.draw = L.layerGroup().addTo(S.map);

        // ── Cámaras ──
        S.cameras.data = await fetchCamaras();
        S.cameras.loaded = true;

        S.cameras.data.forEach(cam => {
            const pg = cam.programa || 'R';
            const color = PROG_COLOR[pg] || '#3b82f6';
            const border = PROG_BORDER[pg] || '#1d4ed8';
            const short = codigoCorto(cam);

            const size = 13;
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:${size}px;height:${size}px;background:${color};border:1.5px solid ${border};opacity:0.75;border-radius:1px;cursor:pointer;transition:transform .1s;"></div>`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            const marker = L.marker([cam.lat, cam.lng], { icon, pane: 'camPane' }).addTo(S.layers.cam);

            // Popup con event delegation seguro (sin inline onclick)
            const popupDiv = document.createElement('div');
            popupDiv.style.cssText = 'text-align:center;min-width:50px';

            const codeEl = document.createElement('div');
            codeEl.style.cssText = `font:700 15px -apple-system,sans-serif;color:${color};cursor:pointer;border-bottom:1px dashed rgba(255,255,255,.2);padding-bottom:2px`;
            codeEl.textContent = short;
            codeEl.addEventListener('click', () => {
                navigator.clipboard.writeText(short).then(() => {
                    codeEl.style.color = '#34d399';
                    codeEl.textContent = '✓';
                    setTimeout(() => { codeEl.style.color = color; codeEl.textContent = short; }, 800);
                });
            });
            popupDiv.appendChild(codeEl);

            if (cam.dir) {
                const dirEl = document.createElement('div');
                dirEl.style.cssText = 'font-size:11px;color:rgba(255,255,255,.35);margin-top:3px';
                dirEl.textContent = cam.dir;
                popupDiv.appendChild(dirEl);
            }

            marker.bindPopup(popupDiv, { closeButton: false, className: 'mi-cam-popup', pane: 'camPopupPane' });
        });

        // ── Dibujo ──
        setupDrawHandlers(signal);

        // ── Eventos UI ──
        container.querySelector('#mi-back').addEventListener('click', salir, { signal });
        container.querySelector('#mi-panel-toggle').addEventListener('click', () => {
            const panel = container.querySelector('#mi-panel');
            panel.classList.toggle('collapsed');
            container.querySelector('#mi-panel-toggle').textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
        }, { signal });

        // ── Panel delegation ──
        setupPanelDelegation(signal);

        // ── Reloj (trackeado para cleanup) ──
        S.ui.clockTimer = setInterval(() => {
            const el = container.querySelector('#mi-clock');
            if (el) el.textContent = new Date().toLocaleTimeString('es-CL', { hour12: false });
        }, 1000);

        // ── WASD navegación ──
        setupWASD(signal);

        // ── Keyboard shortcuts ──
        setupKeyboard(signal);

        // ── Primera carga ──
        await refreshData();
        startRefreshCycle();
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  18. TECLADO Y WASD                                           ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function setupWASD(signal) {
        const w = S.wasd;

        function tick() {
            let dx = 0, dy = 0;
            if (w.keys.has('a') || w.keys.has('arrowleft'))  dx -= CONFIG.PAN_PX;
            if (w.keys.has('d') || w.keys.has('arrowright')) dx += CONFIG.PAN_PX;
            if (w.keys.has('w') || w.keys.has('arrowup'))    dy -= CONFIG.PAN_PX;
            if (w.keys.has('s') || w.keys.has('arrowdown'))  dy += CONFIG.PAN_PX;
            if (dx !== 0 || dy !== 0) S.map.panBy([dx, dy], { animate: true, duration: 0.15 });
        }

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!document.getElementById('mapa-integrado-root')) return;

            const key = e.key.toLowerCase();
            if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) return;

            e.preventDefault();
            if (!w.keys.has(key)) {
                w.keys.add(key);
                if (!w.interval) {
                    tick();
                    w.interval = setInterval(tick, CONFIG.PAN_INTERVAL);
                }
            }
        }, { signal });

        document.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            w.keys.delete(key);
            if (w.keys.size === 0 && w.interval) {
                clearInterval(w.interval);
                w.interval = null;
            }
        }, { signal });
    }

    function setupKeyboard(signal) {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!document.getElementById('mapa-integrado-root')) return;

            const key = e.key.toLowerCase();

            // Ctrl+Z = undo
            if ((e.ctrlKey || e.metaKey) && key === 'z') {
                e.preventDefault();
                undoLastDraw();
                return;
            }

            // Zoom
            if (key === '+' || key === '=') { e.preventDefault(); S.map.zoomIn(); return; }
            if (key === '-') { e.preventDefault(); S.map.zoomOut(); return; }

            // Herramientas de dibujo
            if (['1', '2', '3'].includes(key)) {
                e.preventDefault();
                activarHerramientaDibujo(parseInt(key));
                return;
            }

            // Undo con pipe/backslash
            if (key === '\\' || key === '|' || e.code === 'Backslash') {
                e.preventDefault();
                undoLastDraw();
                return;
            }

            // Borrar todo
            if (key === '0' || key === 'delete') {
                e.preventDefault();
                if (S.layers.draw) S.layers.draw.clearLayers();
                S.draw.history = [];
                S.draw.radiusCenterMarker = null;
                S.draw.radiusCenter = null;
                desactivarDibujo();
                return;
            }

            // Escape
            if (key === 'escape') {
                e.preventDefault();
                if (S.placement.active) {
                    cancelarPlacement();
                } else if (S.draw.mode) {
                    desactivarDibujo();
                } else {
                    S.map.closePopup();
                    S.layers.nearby?.clearLayers();
                }
                return;
            }
        }, { signal });
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  19. LIFECYCLE: ACTIVAR / SALIR                               ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function activar() {
        if (document.getElementById('mapa-integrado-root')) return;
        console.log('[MapaIntegrado] ▶ Activando');
        const container = construirUI();
        iniciarMapa(container);
    }

    function salir() {
        // 1. Abortar todos los event listeners de una vez
        if (S.abortController) {
            S.abortController.abort();
            S.abortController = null;
        }

        // 2. Limpiar timers
        if (S.refresh.timer) { clearInterval(S.refresh.timer); S.refresh.timer = null; }
        if (S.ui.clockTimer) { clearInterval(S.ui.clockTimer); S.ui.clockTimer = null; }
        if (S.wasd.interval) { clearInterval(S.wasd.interval); S.wasd.interval = null; }
        S.wasd.keys.clear();

        // 3. Remover UI
        const root = document.getElementById('mapa-integrado-root');
        if (root) root.remove();

        // 4. Restaurar contenido original
        const wrapper = document.getElementById('page-wrapper');
        if (wrapper) wrapper.style.display = '';
        const sidebar = document.querySelector('.navbar-default.navbar-static-side');
        if (sidebar) sidebar.style.display = '';

        // 5. Limpiar mapa y estado
        if (S.map) { S.map.remove(); S.map = null; }
        S.layers = { proc: null, cam: null, nearby: null, draw: null };
        S.cameras.data = [];
        S.cameras.loaded = false;
        S.procs.all = [];
        S.procs.markers.clear();
        // Cancelar placement mode
        S.placement.active = false;
        S.placement.procId = null;
        // No limpiar procs.ignored, pinned, pinnedData, manualCoords, serverCoords — persisten entre activaciones
        S.refresh.countdown = 0;
        S.ui.container = null;

        // 6. Limpiar estado de dibujo
        S.draw = {
            mode: null, isDrawing: false, isDragging: false,
            dragStart: null, pencilPoints: [], radiusCenter: null,
            radiusCenterMarker: null, distLabel: null, temp: null, history: [],
        };

        // 7. Hash sin recargar
        history.pushState(null, '', window.location.pathname + window.location.search);
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  20. INIT: INYECCIÓN Y DETECCIÓN DE HASH                      ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function inyectarBoton() {
        const navbar = document.querySelector('.navbar-top-links.navbar-right');
        if (!navbar || document.getElementById('mi-launch-btn')) return;

        const li = document.createElement('li');
        li.style.padding = '15px 10px';
        li.innerHTML = `
            <a id="mi-launch-btn" href="${CONFIG.HASH}" style="
                background:linear-gradient(135deg,#1e40af,#2563eb); color:#fff;
                padding:6px 14px; border-radius:6px; font-weight:600; font-size:12px;
                text-decoration:none; display:flex; align-items:center; gap:4px;
            ">🗺️ Mapa</a>
        `;
        navbar.insertBefore(li, navbar.firstChild);
    }

    function checkHash() {
        if (window.location.hash === CONFIG.HASH) activar();
    }

    window.addEventListener('hashchange', checkHash);
    inyectarBoton();
    checkHash();

    console.log('[MapaIntegrado] ✅ v3.2 cargado. Usa #mapa-integrado para activar.');

})();
