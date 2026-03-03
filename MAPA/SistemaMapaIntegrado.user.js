// ==UserScript==
// @name         Sistema Mapa Integrado
// @namespace    http://tampermonkey.net/
// @version      5.3
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
        cameras: { data: [], sites: [], loaded: false },
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
    // 4,611 cámaras – ArcGIS FeatureServer (4,089) + KML-only (522) — 2026-03-02
    // dest_idx → DEST_LOOKUP, tipo_idx → TIPO_LOOKUP, prog_idx → PROG_LOOKUP
    const DEST_LOOKUP = ["CS1 Quinchamalí", "CS2 Errázuriz", "CS3 San Carlos", "CS4 Fleming", "CS5 Apoquindo", "CS6 El Golf", "Red Municipal", "Refugios Inteligentes", "Postes Inteligentes"];
    const TIPO_LOOKUP = ["", "PTZ", "LPR", "FIJA", "FISHEYE", "SOS", "PARLANTE", "VIDEOPORTERO"];
    const PROG_LOOKUP = ["B", "R", "P", "F"];

    const CAMARAS_RAW = [
[-33.40788,-70.54511,'001 APOQUINDO - EL ALBA / FIJA','Apoquindo & Camino el Alba',0,3,1],
[-33.40788,-70.54511,'001 APOQUINDO - EL ALBA / PTZ','Apoquindo & Camino el Alba',0,1,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / FIJA 1','Alejandro Fleming & Vital Apoquindo',0,3,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / FIJA 2','Alejandro Fleming & Vital Apoquindo',0,3,1],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / PTZ','Alejandro Fleming & Vital Apoquindo',0,1,1],
[-33.41249,-70.53825,'003 RIO GUADIANA - DIAGUITAS / PTZ','Diaguitas & Rio Guadiana',0,1,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 1','Tomás Moro & IV Centenario',0,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 2','Tomás Moro & IV Centenario',0,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 3','Tomás Moro & IV Centenario',0,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / FIJA 4','Tomás Moro & IV Centenario',0,3,1],
[-33.41751,-70.55331,'004 ROTONDA ATENAS / PTZ','Tomás Moro & IV Centenario',0,1,1],
[-33.40919,-70.56828,'005 APUMANQUE / LPR','Apoquindo & Manquehue Sur',0,2,1],
[-33.40919,-70.56828,'005 APUMANQUE / PTZ','Apoquindo & Manquehue Sur',0,1,1],
[-33.40919,-70.56828,'005 APUMANQUE / PTZ 2','Apoquindo & Manquehue Sur',0,1,1],
[-33.40919,-70.56828,'005 APUMANQUE / SOS','Apoquindo & Manquehue Sur',0,7,1],
[-33.39404,-70.54556,'006 PADRE HURTADO - LAS CONDES / FIJA','Las Condes & Padre Hurtado Norte',0,3,1],
[-33.39404,-70.54556,'006 PADRE HURTADO - LAS CONDES / PTZ','Las Condes & Padre Hurtado Norte',0,1,1],
[-33.42379,-70.53316,'007 PUNITAQUI - FLEMING / PTZ','Alejandro Fleming & Punitaqui',0,1,1],
[-33.401468,-70.568058,'008 CARRO MOVIL / PTZ','Carro Móvil',0,1,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 1','Apoquindo & Las Condes',0,3,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 2','Apoquindo & Las Condes',0,3,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / FIJA 3','Apoquindo & Las Condes',0,3,1],
[-33.40728,-70.56158,'009 APOQUINDO - LAS CONDES / PTZ','Apoquindo & Las Condes',0,1,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / FIJA 1','Tomás Moro & Apoquindo',0,3,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / FIJA 2','Tomás Moro & Apoquindo',0,3,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / PTZ','Tomás Moro & Apoquindo',0,1,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / FIJA 1','Padre Hurtado Central & Camino el Alba',0,3,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / FIJA 2','Padre Hurtado Central & Camino el Alba',0,3,1],
[-33.40618,-70.54346,'011 PADRE HURTADO - EL ALBA / PTZ','Padre Hurtado Central & Camino el Alba',0,1,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / FIJA 1','Francisco Bilbao & Tomás Moro',0,3,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / FIJA 2','Francisco Bilbao & Tomás Moro',0,3,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / LPR 1','Francisco Bilbao & Tomás Moro',0,2,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / LPR 2','Francisco Bilbao & Tomás Moro',0,2,1],
[-33.43024,-70.55412,'012 BILBAO - TOMAS MORO / PTZ','Francisco Bilbao & Tomás Moro',0,1,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / FIJA 1','Las Condes & Estoril',0,3,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / FIJA 2','Las Condes & Estoril',0,3,1],
[-33.38402,-70.53415,'013 LAS CONDES - ESTORIL / PTZ','Las Condes & Estoril',0,1,1],
[-33.39546,-70.50943,'014 SAN CARLOS DE APOQUINDO - LAS FLORES / PTZ','San Carlos de Apoquindo & Camino las Flores',0,1,1],
[-33.41477,-70.56533,'015 MANQUEHUE - MARTIN DE ZAMORA / PTZ','Manquehue Sur & Martín de Zamora',0,1,1],
[-33.42307,-70.55364,'016 TOMAS MORO - FLORENCIO BARRIOS / PTZ','Tomás Moro & Florencio Barrios',0,1,1],
[-33.43098,-70.56509,'017 MANQUEHUE - BILBAO / PTZ','Manquehue Sur & Francisco Bilbao',0,1,1],
[-33.4161,-70.53383,'018 COLON / PAUL HARRIS / PTZ','Av. Cristobal Colón & Paul Harris',0,1,1],
[-33.40538,-70.52569,'019 ARTURO MATTE - VISTA HERMOSA / LPR','Arturo Matte Larrain & Colina Vista Hermosa',0,2,1],
[-33.40538,-70.52569,'019 ARTURO MATTE - VISTA HERMOSA / PTZ','Arturo Matte Larrain & Colina Vista Hermosa',0,1,1],
[-33.40368,-70.52767,'020 VISTA HERMOSA 1890 / LPR','Colina Vista Hermosa 1890',0,2,1],
[-33.40368,-70.52767,'020 VISTA HERMOSA 1890 / PTZ','Colina Vista Hermosa 1890',0,1,1],
[-33.40825,-70.52384,'021 VISTA HERMOSA - QUEBRADA HONDA / LPR','Colina Vista Hermosa 2560',0,2,1],
[-33.40825,-70.52384,'021 VISTA HERMOSA - QUEBRADA HONDA / PTZ','Colina Vista Hermosa 2560',0,1,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / PTZ','Loma Larga & Alacalufes',0,1,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / SOS','Loma Larga & Alacalufes',0,7,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / PTZ','Mapuches & Islas Guaitecas',0,1,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / SOS','Mapuches & Islas Guaitecas',0,7,1],
[-33.41365,-70.53636,'024 CESFAM - LOMA LARGA / FIJA','Loma Larga & Nevados de Piuquenes',0,3,1],
[-33.41365,-70.53636,'024 CESFAM - LOMA LARGA / PTZ','Loma Larga & Nevados de Piuquenes',0,1,1],
[-33.408255,-70.5665,'025 APOQUINDO - ALONSO DE CORDOVA / PTZ','Apoquindo & Alonso de Cordova',0,1,1],
[-33.41641,-70.59412,'026 APOQUINDO - ENRIQUE FOSTER / PTZ','Apoquindo & Enrique Foster Sur',0,1,1],
[-33.41641,-70.59412,'026 APOQUINDO - ENRIQUE FOSTER / SOS','Apoquindo & Enrique Foster Sur',0,7,1],
[-33.41641,-70.59412,'026 APOQUNDO - ENRIQUE FOSTER / RF 03 FOSTER B / PTZ','Enrique Foster & Apoquindo Norte',0,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR NORTE / PTZ','Apoquindo & General Barceló',0,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR NORTE / SOS','Apoquindo & General Barceló',0,7,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR NORTE / RF 05 PTZ','Apoquindo & General Barceló',0,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR NORTE / FIJA 2','Apoquindo & General Barceló',0,3,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 1','Apoquindo & Gertrudis Echeñique',0,3,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 2','Apoquindo & Gertrudis Echeñique',0,3,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / PTZ','Apoquindo & Gertrudis Echeñique',0,1,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / SOS','Apoquindo & Gertrudis Echeñique',0,7,1],
[-33.408014,-70.555617,'029 APOQUINDO - HERNANDO DE MAGALLANES / PTZ','Apoquindo & Hernando de Magallanes',0,1,1],
[-33.41124,-70.57596,'030 APOQUINDO - LA GLORIA / PTZ','Apoquindo & La Gloria',0,1,1],
[-33.39071,-70.52578,'031 ESTORIL - LAVANDULAS / LPR','Camino de las Lavandulas & Estoril',0,2,1],
[-33.39071,-70.52578,'031 ESTORIL - LAVANDULAS / PTZ','Camino de las Lavandulas & Estoril',0,1,1],
[-33.39417,-70.53093,'032 LAS FLORES - CAMINO LAS FLORES / LPR','Camino del Algarrobo & Camino las Flores',0,2,1],
[-33.39417,-70.53093,'032 LAS FLORES - FRAY PEDRO / LPR','Camino del Algarrobo & Fray Pedro Subercaseaux',0,2,1],
[-33.39417,-70.53093,'032 ROTONDA LAS FLORES / PTZ','Camino del Algarrobo & Fray Pedro Subercaseaux',0,1,1],
[-33.401268,-70.526045,'033 EL ALBA - PIEDRA ROJA / PTZ','Camino el Alba & Camino Piedra Roja',0,1,1],
[-33.40501,-70.53823,'034 EL ALBA - PAUL HARRIS / LPR','Camino el Alba & Paul Harris',0,2,1],
[-33.40501,-70.53823,'034 EL ALBA - PAUL HARRIS / PTZ','Camino el Alba & Paul Harris',0,1,1],
[-33.386142,-70.521127,'035 CHARLES HAMILTON - LA FUENTE / LPR','Charles Hamilton & Camino La Fuente',0,2,1],
[-33.386142,-70.521127,'035 CHARLES HAMILTON - LA FUENTE / PTZ','Charles Hamilton & Camino La Fuente',0,1,1],
[-33.381152,-70.51227,'036 CHARLES HAMILTON - SAN FRANCISCO / LPR','Charles Hamilton & San Francisco de Asis',0,2,1],
[-33.381152,-70.51227,'036 CHARLES HAMILTON - SAN FRANCISCO / PTZ','Charles Hamilton & San Francisco de Asis',0,1,1],
[-33.41377,-70.52982,'037 CARLOS PEÑA - VITAL APOQUINDO / LPR','Vital Apoquindo & Carlos Peña Otaegui',0,2,1],
[-33.41377,-70.52982,'037 CARLOS PEÑA - VITAL APOQUINDO / LPR 2','Vital Apoquindo & Carlos Peña Otaegui',0,2,1],
[-33.41377,-70.52982,'037 CARLOS PEÑA - VITAL APOQUINDO / PTZ','Vital Apoquindo & Carlos Peña Otaegui',0,1,1],
[-33.41255,-70.52896,'038 COLINA MIRAVALLE - PEUMO / LPR','Colina Miravalle & Colina del Peumo',0,2,1],
[-33.41255,-70.52896,'038 COLINA MIRAVALLE - PEUMO / PTZ','Colina Miravalle & Colina del Peumo',0,1,1],
[-33.4059,-70.53319,'039 VITAL APOQUINDO - BLANCHE / LPR','Vital Apoquindo & General Blanche',0,2,1],
[-33.4059,-70.53319,'039 VITAL APOQUINDO - BLANCHE / PTZ','Vital Apoquindo & General Blanche',0,1,1],
[-33.38582,-70.53133,'040 ESTORIL - PAUL HARRIS / PTZ','Paul Harris & Estoril',0,1,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 1','Av. Cristobal Colón & Manquehue Sur',0,3,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 2','Av. Cristobal Colón & Manquehue Sur',0,3,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / FIJA 3','Av. Cristobal Colón & Manquehue Sur',0,3,1],
[-33.41654,-70.5648,'041 COLON - MANQUEHUE / PTZ','Av. Cristobal Colón & Manquehue Sur',0,1,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / FIJA 1','Manquehue Norte & Presidente Riesco',0,3,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / FIJA 2','Manquehue Norte & Presidente Riesco',0,3,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / LPR','Manquehue Norte & Presidente Riesco',0,2,1],
[-33.40234,-70.56968,'042 MANQUEHUE - RIESCO / PTZ','Manquehue Norte & Presidente Riesco',0,1,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / FIJA','Kennedy Lateral & Nuestra Señora del Rosario',0,3,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / LPR','Kennedy Lateral & Nuestra Señora del Rosario',0,2,1],
[-33.39767,-70.56892,'043 KENNEDY - N. SRA DEL ROSARIO / PTZ','Kennedy Lateral & Nuestra Señora del Rosario',0,1,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / LPR','San Crescente & Pdte. Errazuriz',0,2,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / PTZ','San Crescente & Pdte. Errazuriz',0,1,1],
[-33.42118,-70.59343,'044 SAN CRESCENTE - PDTE. ERRAZURIZ / SOS','San Crescente & Pdte. Errazuriz',0,7,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 1','Apoquindo & El Bosque Norte',0,3,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 2','Apoquindo & El Bosque Norte',0,3,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / FIJA 3','Apoquindo & El Bosque Norte',0,3,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / PTZ','Apoquindo & El Bosque Norte',0,1,1],
[-33.41755,-70.59989,'045 APOQUINDO EL BOSQUE / SOS','Apoquindo & El Bosque Norte',0,7,1],
[-33.417559,-70.599824,'045 APOQUINDO EL BOSQUE / RF 01 EL BOSQUE A / PTZ','Apoquindo & El Bosque Norte',0,1,1],
[-33.413653,-70.58266,'046 APOQUINDO - ESCUELA MILITAR SUR / RF 05 FIJA 1','Apoquindo & Felix de amesti',0,3,1],
[-33.413653,-70.58266,'046 APOQUINDO - ESCUELA MILITAR SUR / RF 05 FIJA 2','Apoquindo & Felix de amesti',0,3,1],
[-33.409493,-70.570306,'047 APOQUINDO ROSARIO NORTE / RF 07 ROSARIO NORTE / PTZ','Apoquindo & Rosario Norte',0,1,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / PTZ','Skate Padre Hurtado',0,1,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / SOS','Skate Padre Hurtado',0,7,1],
[-33.408777,-70.567855,'049 MANQUEHUE - O\'CONNELL / RF 08 MANQUEHUE / PTZ','Manquehue & Apoquindo Norte',0,1,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / PTZ','Cerro Tololo & Cerro Negro',0,1,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / SOS','Cerro Tololo & Cerro Negro',0,7,1],
[-33.42248,-70.5318,'051 PUNITAQUI - PICHIDANGUI / PTZ','Punitaqui & Pichidangui',0,1,1],
[-33.425115,-70.551724,'052 FLEMING - CAÑUMANQUI / PTZ','Alejandro Fleming & Cañumanqui',0,1,1],
[-33.414724,-70.585897,'053 APOQUINDO - ASTURIAS / PTZ','Apoquindo & Asturias',0,1,1],
[-33.416877,-70.597449,'054 APOQUINDO - AUGUSTO LEGUIA / FIJA 1','Apoquindo & Augusto Leguía',0,3,1],
[-33.416877,-70.597449,'054 APOQUINDO - AUGUSTO LEGUIA / FIJA 2','Apoquindo & Augusto Leguía',0,3,1],
[-33.416877,-70.597449,'054 APOQUINDO - AUGUSTO LEGUIA / PTZ','Apoquindo & Augusto Leguía',0,1,1],
[-33.416877,-70.597449,'054 APOQUINDO - AUGUSTO LEGUIA / SOS','Apoquindo & Augusto Leguía',0,7,1],
[-33.415202,-70.589327,'055 APOQUINDO - LAS TORCAZAS / PTZ','Apoquindo & Las Torcazas',0,1,1],
[-33.415202,-70.589327,'055 APOQUINDO - LAS TORCAZAS / SOS','Apoquindo & Las Torcazas',0,7,1],
[-33.416766,-70.595785,'056 APOQUINDO - SAN CRESCENTE / PTZ','Apoquindo & San Crescente',0,1,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / FIJA 1','Av Apoquindo & Rosario Norte',0,3,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / FIJA 2','Av Apoquindo & Rosario Norte',0,3,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / FIJA 3','Av Apoquindo & Rosario Norte',0,3,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / PTZ','Av Apoquindo & Rosario Norte',0,1,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / SOS','Av Apoquindo & Rosario Norte',0,7,1],
[-33.421259,-70.570853,'058 ALONSO DE CAMARGO - SEBASTIAN EL CANO / FIJA 1','Sebastián Elcano & Alonso de Camargo',0,3,1],
[-33.421259,-70.570853,'058 ALONSO DE CAMARGO - SEBASTIAN ELCANO / PTZ','Sebastián Elcano & Alonso de Camargo',0,1,1],
[-33.396858,-70.566948,'059 KENNEDY - BRASILIA / FIJA','Av. Kennedy & Brasilia',0,3,1],
[-33.396858,-70.566948,'059 KENNEDY - BRASILIA / LPR','Av. Kennedy & Brasilia',0,2,1],
[-33.396858,-70.566948,'059 KENNEDY - BRASILIA / PTZ','Av. Kennedy & Brasilia',0,1,1],
[-33.396858,-70.566948,'059 KENNEDY - BRASILIA / SOS','Av. Kennedy & Brasilia',0,7,1],
[-33.392003,-70.553489,'060 KENNEDY - LAS TRANQUERAS / FIJA','Av. Kennedy & Las Tranqueras',0,3,1],
[-33.392003,-70.553489,'060 KENNEDY - LAS TRANQUERAS / LPR 1','Av. Kennedy & Las Tranqueras',0,2,1],
[-33.392003,-70.553489,'060 KENNEDY - LAS TRANQUERAS / LPR 2','Av. Kennedy & Las Tranqueras',0,2,1],
[-33.392003,-70.553489,'060 KENNEDY - LAS TRANQUERAS / LPR 3','Av. Kennedy & Las Tranqueras',0,2,1],
[-33.392003,-70.553489,'060 KENNEDY - LAS TRANQUERAS / PTZ','Av. Kennedy & Las Tranqueras',0,1,1],
[-33.398316,-70.55131,'061 LAS CONDES - BOCACCIO / FIJA 1','Av. Las Condes & Bocaccio',0,3,1],
[-33.398316,-70.55131,'061 LAS CONDES - BOCACCIO / FIJA 2','Av. Las Condes & Bocaccio',0,3,1],
[-33.398316,-70.55131,'061 LAS CONDES - BOCACCIO / PTZ','Av. Las Condes & Bocaccio',0,1,1],
[-33.401421,-70.555218,'062 LAS CONDES - LAS TRANQUERAS / PTZ','Av. Las Condes & Las Tranqueras',0,1,1],
[-33.401421,-70.555218,'062 LAS CONDES - LAS TRANQUERAS / SOS','Av. Las Condes & Las Tranqueras',0,7,1],
[-33.405052,-70.568479,'063 MANQUEHUE - LOS MILITARES / FIJA 1','Av. Manquehue & Los Militares',0,3,1],
[-33.405052,-70.568479,'063 MANQUEHUE - LOS MILITARES / FIJA 2','Av. Manquehue & Los Militares',0,3,1],
[-33.405052,-70.568479,'063 MANQUEHUE - LOS MILITARES / PTZ','Av. Manquehue & Los Militares',0,1,1],
[-33.405052,-70.568479,'063 MANQUEHUE - LOS MILITARES / SOS','Av. Manquehue & Los Militares',0,7,1],
[-33.39711,-70.560346,'064 RIESCO - GERONIMO DE ALDERETE / PTZ','Av. Presidente Riesco & Gerónimo de Alderete',0,1,1],
[-33.403844,-70.573456,'065 RIESCO - ROSARIO NORTE / PTZ','Av. Presidente Riesco & Rosario Norte',0,1,1],
[-33.403844,-70.573456,'065 RIESCO - ROSARIO NORTE / SOS','Av. Presidente Riesco & Rosario Norte',0,7,1],
[-33.40869,-70.600436,'066 KENNEDY - VITACURA / FIJA 1','Av. Vitacura & Calle Luz',0,3,1],
[-33.40869,-70.600436,'066 KENNEDY - VITACURA / FIJA 2','Av. Vitacura & Calle Luz',0,3,1],
[-33.40869,-70.600436,'066 KENNEDY - VITACURA / PTZ','Av. Vitacura & Calle Luz',0,1,1],
[-33.431206,-70.578645,'067 BILBAO - LATADIA / LPR 1','Bilbao & Latadía',0,2,1],
[-33.431206,-70.578645,'067 BILBAO - LATADIA / LPR 2','Bilbao & Latadía',0,2,1],
[-33.431206,-70.578645,'067 BILBAO & LATADIA (JUAN DE AUSTRIA) / LPR','Bilbao & Latadía',0,2,1],
[-33.431206,-70.578645,'067 BILBAO LATADIA / FIJA 1','Bilbao & Latadía',0,3,1],
[-33.431206,-70.578645,'067 BILBAO LATADIA / FIJA 2','Bilbao & Latadía',0,3,1],
[-33.431206,-70.578645,'067 BILBAO LATADIA / PTZ','Bilbao & Latadía',0,1,1],
[-33.414913,-70.512784,'068 BULNES CORREA - SAN RAMON / PTZ','Bulnes Correa & San Ramón',0,1,1],
[-33.413946,-70.603507,'069 VITACURA - ISIDORA GOYENECHEA / FIJA 1','Av. Vitacura & Isidora Goyenechea',0,3,1],
[-33.413946,-70.603507,'069 VITACURA - ISIDORA GOYENECHEA / FIJA 2','Av. Vitacura & Isidora Goyenechea',0,3,1],
[-33.413946,-70.603507,'069 VITACURA - ISIDORA GOYENECHEA / LPR 1','Av. Vitacura & Isidora Goyenechea',0,2,1],
[-33.413946,-70.603507,'069 VITACURA - ISIDORA GOYENECHEA / LPR 2','Av. Vitacura & Isidora Goyenechea',0,2,1],
[-33.413946,-70.603507,'069 VITACURA - ISIDORA GOYENECHEA / PTZ','Av. Vitacura & Isidora Goyenechea',0,1,1],
[-33.411572,-70.52049,'070 CARLOS PEÑA- LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas',0,1,1],
[-33.416976,-70.55256,'071 CHOAPA - TINGUIRIRICA / PTZ','Choapa & Tinguiririca',0,1,1],
[-33.424314,-70.583266,'072 COLON - MALAGA / PTZ','Av. Cristobal Colón & Malaga',0,1,1],
[-33.426244,-70.590717,'073 COLON - SANCHEZ FONTECILLA / FIJA 1','Av. Cristobal Colón & Mariano Sánchez Fontecilla',0,3,1],
[-33.426244,-70.590717,'073 COLON - SANCHEZ FONTECILLA / FIJA 2','Av. Cristobal Colón & Mariano Sánchez Fontecilla',0,3,1],
[-33.426244,-70.590717,'073 COLON - SANCHEZ FONTECILLA / FIJA 3','Av. Cristobal Colón & Mariano Sánchez Fontecilla',0,3,1],
[-33.426244,-70.590717,'073 COLON - SANCHEZ FONTECILLA / LPR','Av. Cristobal Colón & Mariano Sánchez Fontecilla',0,2,1],
[-33.426244,-70.590717,'073 COLON - SANCHEZ FONTECILLA / PTZ','Av. Cristobal Colón & Mariano Sánchez Fontecilla',0,1,1],
[-33.401294,-70.522912,'074 EL ALBA - LA FUENTE / PTZ','Camino el Alba & Camino La Fuente',0,1,1],
[-33.419511,-70.599506,'075 EL BOSQUE - CALLAO / FIJA 1','El Bosque Central & Callao',0,3,1],
[-33.419511,-70.599506,'075 EL BOSQUE - CALLAO / FIJA 2','El Bosque Central & Callao',0,3,1],
[-33.419511,-70.599506,'075 EL BOSQUE - CALLAO / LPR 1','El Bosque Central & Callao',0,2,1],
[-33.419511,-70.599506,'075 EL BOSQUE - CALLAO / LPR 2','El Bosque Central & Callao',0,2,1],
[-33.419511,-70.599506,'075 EL BOSQUE - CALLAO / PTZ','El Bosque Central & Callao',0,1,1],
[-33.425952,-70.580754,'076 FLANDES - VATICANO / PTZ','Flandes & Vaticano',0,1,1],
[-33.407551,-70.537209,'077 BLANCHE - PAUL HARRIS / PTZ','General Blanche & Paul Harris',0,1,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / FIJA 1','Isidora Goyenechea & Enrique Foster',0,3,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / FIJA 2','Isidora Goyenechea & Enrique Foster',0,3,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster',0,1,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / SOS','Isidora Goyenechea & Enrique Foster',0,7,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / RF 11 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster',0,1,1],
[-33.413528,-70.558785,'079 IV CENTENARIO - HDO DE MAGALLANES / PTZ','IV Centenario & Hernando de Magallanes',0,1,1],
[-33.413528,-70.558785,'079 IV CENTENARIO - HDO DE MAGALLANES / SOS','IV Centenario & Hernando de Magallanes',0,7,1],
[-33.395986,-70.506019,'080 LA PLAZA - LAS FLORES / PTZ','La Plaza & Camino las Flores',0,1,1],
[-33.392763,-70.503793,'081 LA PLAZA - REP DE HONDURAS / PTZ','La Plaza & Rep. Honduras',0,1,1],
[-33.427341,-70.5642,'082 MANQUEHUE - LATADIA / PTZ','Latadía & Manquehue',0,1,1],
[-33.427755,-70.570121,'083 ROTONDA LATADIA / PTZ','Latadía & Sebastián Elcano',0,1,1],
[-33.427755,-70.570121,'083 ROTONDA LATADIA / SOS','Latadía & Sebastián Elcano',0,7,1],
[-33.400783,-70.544448,'084 PADRE HURTADO - BOCACCIO / PTZ','Padre Hurtado Norte & Bocaccio',0,1,1],
[-33.396426,-70.544252,'085 PADRE HURTADO - EL ALAMEIN / PTZ','Padre Hurtado Norte & El Alamein',0,1,1],
[-33.413103,-70.537537,'086 NAME - SIERRA NEVADA / FIJA 1','Pje. Cerro Name & Pje. Sierra Nevada',0,3,1],
[-33.413103,-70.537537,'086 NAME - SIERRA NEVADA / FIJA 2','Pje. Cerro Name & Pje. Sierra Nevada',0,3,1],
[-33.413103,-70.537537,'086 NAME - SIERRA NEVADA / PTZ','Pje. Cerro Name & Pje. Sierra Nevada',0,1,1],
[-33.413103,-70.537537,'086 NAME - SIERRA NEVADA / SOS','Pje. Cerro Name & Pje. Sierra Nevada',0,7,1],
[-33.414423,-70.537494,'087 DIAGUITAS - LEON BLANCO / PTZ','Pje. Diaguitas & Pje. León Blanco',0,1,1],
[-33.409235,-70.568171,'088 APUMANQUE (FARO) / RF 09 APUMANQUE / FIJA','Apumanque & Apoquindo Sur',0,3,1],
[-33.413853,-70.53676,'089 NEVADO DE PIUQUENES - CERRO MARMOLEJO / PTZ','Pje. Marmolejo & Pje. Nevado de Piuquenes',0,1,1],
[-33.392319,-70.538217,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 1','Paul Harris & Charles Hamilton',0,3,1],
[-33.392319,-70.538217,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 2','Paul Harris & Charles Hamilton',0,3,1],
[-33.392319,-70.538217,'090 PAUL HARRIS - CHARLES HAMILTON / FIJA 3','Paul Harris & Charles Hamilton',0,3,1],
[-33.392319,-70.538217,'090 PAUL HARRIS - CHARLES HAMILTON / PTZ','Paul Harris & Charles Hamilton',0,1,1],
[-33.420242,-70.588399,'091 ERRAZURIZ - ALCANTARA / PTZ','Pdte. Errazuriz & Alcantara',0,1,1],
[-33.420242,-70.588399,'091 ERRAZURIZ - ALCANTARA / SOS','Pdte. Errazuriz & Alcantara',0,7,1],
[-33.412534,-70.597635,'092 RIESCO - AUGUSTO LEGUIA / PTZ','Pdte. Riesco & Augusto Leguía',0,1,1],
[-33.423615,-70.527308,'093 PLAZA FLEMING / PTZ','Alejandro Fleming 9695',0,1,1],
[-33.413274,-70.570203,'094 ROTONDA LA CAPITANIA / PTZ','La Capitanía & Del Inca',0,1,1],
[-33.413274,-70.570203,'094 ROTONDA LA CAPITANIA / SOS','La Capitanía & Del Inca',0,7,1],
[-33.415373,-70.551429,'095 MONROE - ANDALIEN / PTZ','Monroe & Andalién',0,1,1],
[-33.415373,-70.551429,'095 MONROE - ANDALIEN / SOS','Monroe & Andalién',0,7,1],
[-33.411931,-70.535445,'096 RIO GUADIANA - PAUL HARRIS / FIJA 1','Rio Guadiana & Paul Harris',0,3,1],
[-33.411931,-70.535445,'096 RIO GUADIANA - PAUL HARRIS / FIJA 2','Rio Guadiana & Paul Harris',0,3,1],
[-33.411931,-70.535445,'096 RIO GUADIANA - PAUL HARRIS / PTZ','Rio Guadiana & Paul Harris',0,1,1],
[-33.430451,-70.585123,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / LPR 1','Sánchez Fontecilla & Isabel La Católica',0,2,1],
[-33.430451,-70.585123,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / LPR 2','Sánchez Fontecilla & Isabel La Católica',0,2,1],
[-33.430451,-70.585123,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 1','Sánchez Fontecilla & Isabel La Católica',0,3,1],
[-33.430451,-70.585123,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 2','Sánchez Fontecilla & Isabel La Católica',0,3,1],
[-33.430451,-70.585123,'097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / PTZ','Sánchez Fontecilla & Isabel La Católica',0,1,1],
[-33.413522,-70.539614,'098 LEON NEGRO - FUEGUINOS / PTZ','Sierra Nevada & Leon Negro',0,1,1],
[-33.413522,-70.539614,'098 LEON NEGRO - FUEGUINOS / SOS','Sierra Nevada & Leon Negro',0,7,1],
[-33.401927,-70.570086,'099 PARQUE ARAUCANO SKATEPARK / PTZ','Skatepark Parque Araucano',0,1,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / FIJA 1','Tajamar & Vitacura',0,3,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / FIJA 2','Tajamar & Vitacura',0,3,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / FIJA 3','Tajamar & Vitacura',0,3,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / PTZ','Tajamar & Vitacura',0,1,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / SOS','Tajamar & Vitacura',0,7,1],
[-33.425341,-70.553952,'101 TOMAS MORO - FLEMING / PTZ','Tomás Moro & Alejandro Fleming',0,1,1],
[-33.425341,-70.553952,'101 TOMAS MORO - FLEMING / SOS','Tomás Moro & Alejandro Fleming',0,7,1],
[-33.419409,-70.552891,'102 TOMAS MORO - ATENAS / PTZ','Tomás Moro & Atenas',0,1,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / FIJA 1','A. Vespucio & Latadía',0,3,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / FIJA 2','A. Vespucio & Latadía',0,3,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / FIJA 3','A. Vespucio & Latadía',0,3,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / PTZ','A. Vespucio & Latadía',0,1,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / SOS','A. Vespucio & Latadía',0,7,1],
[-33.419697,-70.582303,'104 VESPUCIO - RAPALLO / FIJA 1','A. Vespucio Sur & Rapallo',0,3,1],
[-33.419697,-70.582303,'104 VESPUCIO - RAPALLO / PTZ','A. Vespucio Sur & Rapallo',0,1,1],
[-33.415982,-70.583668,'105 VESPUCIO - NEVERIA / FIJA 1','A. Vespucio Sur & Nevería',0,3,1],
[-33.415982,-70.583668,'105 VESPUCIO - NEVERIA / PTZ','A. Vespucio Sur & Nevería',0,1,1],
[-33.41622,-70.594066,'106 APOQUINDO - FOSTER/ FIJA','Enrique Foster & Apoquindo Norte',0,3,1],
[-33.41639,-70.594105,'106 APOQUINOD - FOSTER / RF 03 FOSTER A / PTZ','Enrique Foster & Apoquindo Sur',0,1,1],
[-33.392448,-70.514809,'107 LAS TERRAZAS - VALLE NEVADO / PTZ','Circunvalación Las Terrazas & Valle Nevado',0,1,1],
[-33.368424,-70.501713,'108 QUINCHAMALI 1 / PTZ','DESCATAMENTO QUINCHAMALI',0,1,1],
[-33.368424,-70.501713,'108 QUINCHAMALI 2 / FIJA 1','DESCATAMENTO QUINCHAMALI',0,3,1],
[-33.368424,-70.501713,'108 QUINCHAMALI 3 / FIJA 2','DESCATAMENTO QUINCHAMALI',0,3,1],
[-33.415837,-70.59623,'109 CENTRO CIVICO / LPR','Centro Civico / Apoquindo',0,2,1],
[-33.415837,-70.59623,'109 CENTRO CIVICO / PTZ','Centro Civico / Apoquindo',0,1,1],
[-33.423541,-70.57904,'110 VESPUCIO - COLON / FIJA 1','Américo Vespucio & Cristóbal Colon',0,3,1],
[-33.423541,-70.57904,'110 VESPUCIO - COLON / FIJA 2','Américo Vespucio & Cristóbal Colon',0,3,1],
[-33.423541,-70.57904,'110 VESPUCIO - COLON / FIJA 3','Américo Vespucio & Cristóbal Colon',0,3,1],
[-33.423541,-70.57904,'110 VESPUCIO - COLON / PTZ','Américo Vespucio & Cristóbal Colon',0,1,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / FIJA 1','Francisco Bilbao & Américo Vespucio',0,3,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / FIJA 2','Francisco Bilbao & Américo Vespucio',0,3,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / FIJA 3','Francisco Bilbao & Américo Vespucio',0,3,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / LPR 1','Francisco Bilbao & Américo Vespucio',0,2,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / LPR 2','Francisco Bilbao & Américo Vespucio',0,2,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / LPR 3','Francisco Bilbao & Américo Vespucio',0,2,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / LPR 4','Francisco Bilbao & Américo Vespucio',0,2,1],
[-33.431231,-70.574305,'111 VESPUCIO - BILBAO / PTZ','Francisco Bilbao & Américo Vespucio',0,1,1],
[-33.414304,-70.597954,'112 ISIDORA GOYENECHEA - AUGUSTO LEGUIA / PTZ','Isidora Goyenechea & Augusto Leguía Norte',0,1,1],
[-33.398687,-70.571163,'113 MANQUEHUE - KENNEDY / PTZ','Manquehue Sur Poniente & Kenedy',0,1,1],
[-33.425349,-70.564257,'114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 1','Manquehue & Isabel La Catolica',0,3,1],
[-33.425349,-70.564257,'114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 2','Manquehue & Isabel La Catolica',0,3,1],
[-33.425349,-70.564257,'114 MANQUEHUE - ISABEL LA CATOLICA / PTZ','Manquehue & Isabel La Catolica',0,1,1],
[-33.431723,-70.584086,'115 SANCHEZ FONTECILLA - BILBAO / FIJA 1','Mariano Sánchez Fontecilla & Francisco Bilbao',0,3,1],
[-33.431723,-70.584086,'115 SANCHEZ FONTECILLA - BILBAO / FIJA 2','Mariano Sánchez Fontecilla & Francisco Bilbao',0,3,1],
[-33.431723,-70.584086,'115 SANCHEZ FONTECILLA - BILBAO / LPR 1','Mariano Sánchez Fontecilla & Francisco Bilbao',0,2,1],
[-33.431723,-70.584086,'115 SANCHEZ FONTECILLA - BILBAO / LPR 2','Mariano Sánchez Fontecilla & Francisco Bilbao',0,2,1],
[-33.431723,-70.584086,'115 SANCHEZ FONTECILLA - BILBAO / PTZ','Mariano Sánchez Fontecilla & Francisco Bilbao',0,1,1],
[-33.424493,-70.592689,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 1','Mariano Sánchez Fontecilla & Martín de Zamora',0,3,1],
[-33.424493,-70.592689,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 2','Mariano Sánchez Fontecilla & Martín de Zamora',0,3,1],
[-33.424493,-70.592689,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 1','Mariano Sánchez Fontecilla & Martín de Zamora',0,2,1],
[-33.424493,-70.592689,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 2','Mariano Sánchez Fontecilla & Martín de Zamora',0,2,1],
[-33.424493,-70.592689,'116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / PTZ','Mariano Sánchez Fontecilla & Martín de Zamora',0,1,1],
[-33.421457,-70.5966,'117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 1','Mariano Sánchez Fontecilla & Presidente Errázuriz',0,3,1],
[-33.421457,-70.5966,'117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 2','Mariano Sánchez Fontecilla & Presidente Errázuriz',0,3,1],
[-33.421457,-70.5966,'117 SANCHEZ FONTECILLA - ERRAZURIZ / PTZ','Mariano Sánchez Fontecilla & Presidente Errázuriz',0,1,1],
[-33.420547,-70.590365,'118 ERRAZURIZ - GERTRUDIZ ECHEÑIQUE / PTZ','Presidente Errázuriz & Gertrudiz Echeñique',0,1,1],
[-33.417629,-70.530741,'119 YOLANDA - LA PAZ / PTZ','Yolanda & La Paz',0,1,1],
[-33.428334,-70.549394,'120 CURACO - M CLARO VIAL / PTZ','Curcaco & Manuel Claro Vial',0,1,1],
[-33.40484,-70.58199,'121 ALONSO DE CORDOVA - CERRO COLORADO / FIJA 1','Alonso de Córdova & Cerro Colorado',0,3,1],
[-33.40484,-70.58199,'121 ALONSO DE CORDOVA - CERRO COLORADO / PTZ','Alonso de Córdova & Cerro Colorado',0,1,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 1','Padre Hurtado Sur & Bilbao',0,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 2','Padre Hurtado Sur & Bilbao',0,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / FIJA 3','Padre Hurtado Sur & Bilbao',0,3,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 1','Padre Hurtado Sur & Bilbao',0,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 2','Padre Hurtado Sur & Bilbao',0,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 3','Padre Hurtado Sur & Bilbao',0,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / LPR 4','Padre Hurtado Sur & Bilbao',0,2,1],
[-33.42869,-70.53913,'122 PADRE HURTADO - BILBAO / PTZ','Padre Hurtado Sur & Bilbao',0,1,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / FIJA 1','Bilbao & Florencio Barrios',0,3,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / FIJA 2','Bilbao & Florencio Barrios',0,3,1],
[-33.42999,-70.55171,'123 BILBAO - FLORENCIO BARRIOS / PTZ','Bilbao & Florencio Barrios',0,1,1],
[-33.4307,-70.55993,'124 BILBAO - HUARAHUARA / PTZ','Bilbao & Huarahuara',0,1,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / FIJA 1','Bilbao & Sebastián Elcano',0,3,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / FIJA 2','Bilbao & Sebastián Elcano',0,3,1],
[-33.43112,-70.57006,'125 BILBAO - SEBASTIAN ELCANO / PTZ','Bilbao & Sebastián Elcano',0,1,1],
[-33.4315,-70.58093,'126 BILBAO - ALCANTARA / FIJA 1','Bilbao & Alcantara',0,3,1],
[-33.4315,-70.58093,'126 BILBAO - ALCANTARA / PTZ','Bilbao & Alcantara',0,1,1],
[-33.410636,-70.586769,'127 PDTE RIESCO - VESPUCIO / FIJA 1','Pdte Riesco & Vespucio',0,3,1],
[-33.410636,-70.586769,'127 PDTE RIESCO - VESPUCIO / FIJA 2','Pdte Riesco & Vespucio',0,3,1],
[-33.410636,-70.586769,'127 PDTE RIESCO - VESPUCIO / LPR 1','Pdte Riesco & Vespucio',0,2,1],
[-33.410636,-70.586769,'127 PDTE RIESCO - VESPUCIO / LPR 2','Pdte Riesco & Vespucio',0,2,1],
[-33.410636,-70.586769,'127 PDTE RIESCO - VESPUCIO / PTZ','Pdte Riesco & Vespucio',0,1,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / FIJA 1','Kennedy & Rosario Norte',0,3,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / FIJA 2','Kennedy & Rosario Norte',0,3,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / LPR 1','Kennedy & Rosario Norte',0,2,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / LPR 2','Kennedy & Rosario Norte',0,2,1],
[-33.40048,-70.57678,'128 KENNEDY - ROSARIO NORTE / PTZ','Kennedy & Rosario Norte',0,1,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 1','Av. Kennedy & Gerónimo de Alderete',0,3,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 2','Av. Kennedy & Gerónimo de Alderete',0,3,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / FIJA 3','Av. Kennedy & Gerónimo de Alderete',0,3,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / LPR 1','Av. Kennedy & Gerónimo de Alderete',0,2,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / LPR 2','Av. Kennedy & Gerónimo de Alderete',0,2,1],
[-33.39477,-70.56152,'129 KENNEDY - GERONIMO DE ALDERETE / PTZ','Av. Kennedy & Gerónimo de Alderete',0,1,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / FIJA 1','Av. Kennedy & Padre Hurtado',0,3,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / FIJA 2','Av. Kennedy & Padre Hurtado',0,3,1],
[-33.38992,-70.54828,'130 KENNEDY - PADRE HURTADO / PTZ','Av. Kennedy & Padre Hurtado',0,1,1],
[-33.38883,-70.54527,'131 KENNEDY - GILBERTO FUENZALIDA / PTZ','Kennedy & Gilberto Fuenzalida',0,1,1],
[-33.38673,-70.53833,'132 LAS CONDES - KENNEDY / FIJA 1','Av. Las Condes & Kennedy',0,3,1],
[-33.38673,-70.53833,'132 LAS CONDES - KENNEDY / PTZ','Av. Las Condes & Kennedy',0,1,1],
[-33.37805,-70.5281,'133 LAS CONDES - VALLE ALEGRE / PTZ','Av. Las Condes & Valle Alegre',0,1,1],
[-33.376189,-70.525616,'134 LAS CONDES - SAN DAMIAN / FIJA 1','Av. Las Condes & San Damián',0,3,1],
[-33.376189,-70.525616,'134 LAS CONDES - SAN DAMIAN / FIJA 2','Av. Las Condes & San Damián',0,3,1],
[-33.376189,-70.525616,'134 LAS CONDES - SAN DAMIAN / PTZ','Av. Las Condes & San Damián',0,1,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / FIJA 1','Av. Las Condes & San Francisco de Asis',0,3,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / FIJA 2','Av. Las Condes & San Francisco de Asis',0,3,1],
[-33.37275,-70.51748,'135 LAS CONDES - SAN FRANCISCO / PTZ','Av. Las Condes & San Francisco de Asis',0,1,1],
[-33.37417,-70.50212,'136 LA POSADA - SAN JOSE DE LA SIERRA / PTZ','La Posada & San Jose de la Sierra',0,1,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 1','Av. Las Condes & Camino San Antonio',0,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 2','Av. Las Condes & Camino San Antonio',0,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 3','Av. Las Condes & Camino San Antonio',0,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / FIJA 4','Av. Las Condes & Camino San Antonio',0,3,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 1','Av. Las Condes & Camino San Antonio',0,2,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 2','Av. Las Condes & Camino San Antonio',0,2,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / LPR 3','Av. Las Condes & Camino San Antonio',0,2,1],
[-33.37091,-70.51162,'137 LAS CONDES - SAN ANTONIO / PTZ','Av. Las Condes & Camino San Antonio',0,1,1],
[-33.37034,-70.50779,'138 LAS CONDES - FERNANDEZ CONCHA / PTZ','Av. Las Condes & Fernandez Concha',0,1,1],
[-33.36967,-70.50441,'139 LAS CONDES - SAN JOSE DE LA SIERRA / PTZ','AV. Las Condes & San José de la Sierra',0,1,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / FIJA 1','Camino a Farellones & Av. del Monte',0,3,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / LPR','Camino a Farellones & Av. del Monte',0,2,1],
[-33.36701,-70.49694,'140 CAMINO FARELLONES - AV EL MONTE / PTZ','Camino a Farellones & Av. del Monte',0,1,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 1','Pdte Riesco & Vitacura',0,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 2','Pdte Riesco & Vitacura',0,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / FIJA 3','Pdte Riesco & Vitacura',0,3,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / LPR','Pdte Riesco & Vitacura',0,2,1],
[-33.41159,-70.60273,'141 VITACURA - RIESCO / PTZ','Pdte Riesco & Vitacura',0,1,1],
[-33.413588,-70.58466,'142 VESPUCIO - LOS MILITARES / FIJA 1','Los Militares & Americo Vespucio',0,3,1],
[-33.413588,-70.58466,'142 VESPUCIO - LOS MILITARES / FIJA 2','Los Militares & Americo Vespucio',0,3,1],
[-33.413588,-70.58466,'142 VESPUCIO - LOS MILITARES / PTZ','Los Militares & Americo Vespucio',0,1,1],
[-33.40438,-70.58408,'143 KENNEDY - ALONSO DE CORDOVA / FIJA 1','Kennedy & Alonso de Cordova',0,3,1],
[-33.40438,-70.58408,'143 KENNEDY - ALONSO DE CORDOVA / PTZ','Kennedy & Alonso de Cordova',0,1,1],
[-33.42773,-70.58861,'144 SANCHEZ FONTECILLA - VATICANO / PTZ','Sanchez Fontecilla & Vaticano',0,1,1],
[-33.41468,-70.60554,'145 ANDRES BELLO - COSTANERA SUR / PTZ','Andres Bello & Costanera Sur',0,1,1],
[-33.40158,-70.50974,'146 BLANCHE - SAN CARLOS DE APOQUINDO / PTZ','U. LOS ANDES - San Carlos de Apoquindo & Blanche',0,1,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 1','Colón & Padre Hurtado',0,3,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 2','Colón & Padre Hurtado',0,3,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / FIJA 3','Colón & Padre Hurtado',0,3,1],
[-33.41626,-70.53908,'147 COLON - PADRE HURTADO / PTZ','Colón & Padre Hurtado',0,1,1],
[-33.41593,-70.60682,'148 ANDRES BELLO - TAJAMAR / PTZ','Nueva Tajamar & Andres Bello',0,1,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / FIJA 1','Cerro Colorado & Manquehue',0,3,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / FIJA 2','Cerro Colorado & Manquehue',0,3,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 1','Cerro Colorado & Manquehue',0,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 2','Cerro Colorado & Manquehue',0,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 3','Cerro Colorado & Manquehue',0,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / LPR 4','Cerro Colorado & Manquehue',0,2,1],
[-33.40054,-70.57028,'149 CERRO COLORADO - MANQUEHUE / PTZ','Cerro Colorado & Manquehue',0,1,1],
[-33.40043,-70.54767,'150 CHESTERTON - BOCACCIO / PTZ','Chesterton & Bocaccio',0,1,1],
[-33.40839,-70.55336,'151 INACAP APOQUINDO / PTZ','INACAP APOQUINDO',0,1,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 1','Apoquindo & Tobalaba',0,3,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 2','Apoquindo & Tobalaba',0,3,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / FIJA 3','Apoquindo & Tobalaba',0,3,1],
[-33.41807,-70.6013,'152 APOQUINDO - TOBALABA / PTZ','Apoquindo & Tobalaba',0,1,1],
[-33.39951,-70.5068,'153 DUOC CAMINO EL ALBA - LA PLAZA / FIJA','DUOC - Camino El Alba & La PLaza',0,3,1],
[-33.42114,-70.57645,'154 COLON - FELIX DE AMESTI / PTZ','Colón & Felix de Amesti',0,1,1],
[-33.39031,-70.49988,'155 AV LA PLAZA - SAN FRANCISCO / PTZ','San Francisco de Asis & Av. La Plaza',0,1,1],
[-33.42511,-70.53321,'156 STA ZITA - CIRIO / PTZ','Sta Zita & Cirio',0,1,1],
[-33.39494,-70.51256,'157 LAS FLORES - SAN RAMON / PTZ','Las Flores & San Ramón',0,1,1],
[-33.40226,-70.57547,'158 CERRO COLORADO - ROSARIO NORTE / PTZ','Cerro Colorado & Rosario Norte',0,1,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / FIJA 1','Av. Padre Hurtado & Alejandro Fleming',0,3,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / FIJA 2','Av. Padre Hurtado & Alejandro Fleming',0,3,1],
[-33.42376,-70.53797,'159 PADRE HURTADO - FLEMING / PTZ','Av. Padre Hurtado & Alejandro Fleming',0,1,1],
[-33.42185,-70.52968,'160 PAUL HARRIS - VITAL APOQUINDO / PTZ','Paul Harris & Vital Apoquindo',0,1,1],
[-33.4131,-70.54063,'161 PADRE HURTADO - RIO GUADIANA / PTZ','Padre Hurtado & Rio Guadiana',0,1,1],
[-33.41606,-70.5363,'162 COLON - LOMA LARGA / PTZ','Colón & Loma Larga',0,1,1],
[-33.39138,-70.50659,'163 SAN CARLOS DE APOQUINDO - REP DE HONDURAS / PTZ','República de Honduras & San Carlos de Apoquindo',0,1,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / FIJA 1','Vespucio & Presidente Errázuriz',0,3,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / FIJA 2','Vespucio & Presidente Errázuriz',0,3,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / LPR 1','Vespucio & Presidente Errázuriz',0,2,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / LPR 2','Vespucio & Presidente Errázuriz',0,2,1],
[-33.41882,-70.58231,'164 VESPUCIO - PDTE ERRAZURIZ / PTZ','Vespucio & Presidente Errázuriz',0,1,1],
[-33.39457,-70.51576,'165 LAS TERRAZAS - CAMINO LAS FLORES / PTZ','Las Terrazas - Camino Las Flores',0,1,1],
[-33.40114,-70.51737,'166 CAMINO EL ALBA - BULNES CORREA / PTZ','Camino El Alba & Bulnes Correa',0,1,1],
[-33.40102,-70.51383,'167 CAMINO EL ALBA - SAN RAMON / PTZ','Camino El Alba & San Ramón',0,1,1],
[-33.41885,-70.57187,'168 COLON - SEBASTIAN ELCANO / PTZ','Av. Colón & Sebastián Elcano',0,1,1],
[-33.41271,-70.51259,'169 BULNES CORREA - CARLOS PEÑA OTAEGUI / PTZ','Fco bulnes Correa & Carlos Peña Otaegui',0,1,1],
[-33.384894,-70.495206,'170 AV LA PLAZA - SAN CARLOS DE APOQUINDO / PTZ','Av La Plaza & San Carlos de Apoquindo',0,1,1],
[-33.378881,-70.494678,'171 SAN JOSE DE LA SIERRA - HUEICOLLA / PTZ','San Jose de la Sierra & Hueicolla',0,1,1],
[-33.405137,-70.502465,'172 AV LA PLAZA (U LOS ANDES) / PTZ','Av La Plaza 2440',0,1,1],
[-33.425597,-70.588208,'173 COLON - MARCO POLO / PTZ','Colón & Marco Polo',0,1,1],
[-33.42079,-70.564455,'174 MANQUEHUE - ALONSO DE CAMARGO / PTZ','Manquehue & Alonso de Camargo',0,1,1],
[-33.429068,-70.564614,'175 MANQUEHUE - CARLOS ALVARADO / PTZ','Manquehue & Carlos Alvarado',0,1,1],
[-33.420254,-70.578361,'176 MARTIN DE ZAMORA - FELIX DE AMESTI / PTZ','Martin de Zamora & Felix de Amesti',0,1,1],
[-33.399665,-70.574542,'177 MARRIOT / PTZ','Av. Kennedy 5741',0,1,1],
[-33.399665,-70.574542,'177 MARRIOT / SOS','Av. Kennedy 5741',0,7,1],
[-33.395151,-70.517012,'178 FRANCISCO BULNES - LAS FLORES / PTZ','Francisco Bulnes Correa & Las Flores',0,1,1],
[-33.395054,-70.522219,'179 LAS FLORES - LA FUENTE / PTZ','Las Flores & La Fuente',0,1,1],
[-33.385163,-70.503149,'180 EL CONVENTO - SAN FRANCISCO / PTZ','El Convento & San Francisco de Asis',0,1,1],
[-33.387669,-70.501016,'181 SAN FRANCISCO - SAN CARLOS DE APOQUINDO / PTZ','San Carlos de Apoquindo & San Francisco de Asis',0,1,1],
[-33.407638,-70.510605,'182 SAN RAMON - LOS OLIVILLOS / PTZ','San Ramon & Los Olivillos',0,1,1],
[-33.39027,-70.514928,'183 FRANCISCO BULNES - REPUBLICA DE HONDURAS / PTZ','Republica de Honduras & Francisco Bulnes Correa',0,1,1],
[-33.387651,-70.51911,'184 LAS LAVANDULAS - LA FUENTE / FIJA 1','Las Lavandulas & La Fuente',0,3,1],
[-33.387651,-70.51911,'184 LAS LAVANDULAS - LA FUENTE / PTZ','Las Lavandulas & La Fuente',0,1,1],
[-33.405826,-70.516216,'185 FRANCISCO BULNES - QUEBRADA HONDA / PTZ','Francisco Bulnes Correa & Quebrada Honda',0,1,1],
[-33.403527,-70.51943,'186 GENERAL BLANCHE - CAMINO OTOÑAL / PTZ','General Blanche & Camino Otoñal',0,1,1],
[-33.412133,-70.52532,'187 QUEBRADA HONDA - CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña Otaegui',0,1,1],
[-33.427483,-70.578904,'188 ISABEL LA CATOLICA -CARLOS V / PTZ','Isabel la Católica & Carlos V',0,1,1],
[-33.394277,-70.545404,'189 PADRE HURTADO - LAS CONDES / PTZ','Padre Hurtado & Las Condes',0,1,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / FIJA 1','EL BOSQUE & SAN SEBASTIAN',0,3,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / FIJA 2','EL BOSQUE & SAN SEBASTIAN',0,3,1],
[-33.41539,-70.60106,'190 EL BOSQUE - SAN SEBASTIAN / PTZ','EL BOSQUE & SAN SEBASTIAN',0,1,1],
[-33.414805,-70.587055,'191 APOQUINDO - GOLDA MEIR / FIJA 1','APOQUINDO & GOLDA MEIR',0,3,1],
[-33.414805,-70.587055,'191 APOQUINDO - GOLDA MEIR / FIJA 2','APOQUINDO & GOLDA MEIR',0,3,1],
[-33.414805,-70.587055,'191 APOQUINDO - GOLDA MEIR / PTZ','APOQUINDO & GOLDA MEIR',0,1,1],
[-33.411838,-70.591128,'192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 1','PRESIDENTE RIESCO & LAS TORCAZAS',0,3,1],
[-33.411838,-70.591128,'192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 2','PRESIDENTE RIESCO & LAS TORCAZAS',0,3,1],
[-33.411838,-70.591128,'192 PRESIDENTE RIESCO - LAS TORCAZAS / PTZ','PRESIDENTE RIESCO & LAS TORCAZAS',0,1,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 1','ALONSO DE CÓRDOVA & LOS MILITARES',0,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 2','ALONSO DE CÓRDOVA & LOS MILITARES',0,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 3','ALONSO DE CÓRDOVA & LOS MILITARES',0,3,1],
[-33.40668,-70.57307,'193 ALONSO DE CORDOVA - LOS MILITARES / PTZ','ALONSO DE CÓRDOVA & LOS MILITARES',0,1,1],
[-33.429776,-70.547426,'194 FRANCISCO BILBAO - DUQUECO / FIJA 1','FRANCISCO BILBAO & DUQUECO',0,3,1],
[-33.429776,-70.547426,'194 FRANCISCO BILBAO - DUQUECO / FIJA 2','FRANCISCO BILBAO & DUQUECO',0,3,1],
[-33.429776,-70.547426,'194 FRANCISCO BILBAO - DUQUECO / PTZ','FRANCISCO BILBAO & DUQUECO',0,1,1],
[-33.419519,-70.551361,'195 GREDOS - IV CENTENARIO / FIJA 1','GREDOS & CUARTO CENTENARIO',0,3,1],
[-33.419519,-70.551361,'195 GREDOS - IV CENTENARIO / FIJA 2','GREDOS & CUARTO CENTENARIO',0,3,1],
[-33.419519,-70.551361,'195 GREDOS - IV CENTENARIO / FIJA PTZ','GREDOS & CUARTO CENTENARIO',0,1,1],
[-33.413302,-70.537968,'196 SIERRA NEVADA - DIAGUITAS / FIJA 1','SIERRA NEVADA & DIAGUITAS',0,3,1],
[-33.413302,-70.537968,'196 SIERRA NEVADA - DIAGUITAS / FIJA 2','SIERRA NEVADA & DIAGUITAS',0,3,1],
[-33.413302,-70.537968,'196 SIERRA NEVADA - DIAGUITAS / PTZ','SIERRA NEVADA & DIAGUITAS',0,1,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 1','NUEVA BILBAO & VITAL APOQUINDO',0,3,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 2','NUEVA BILBAO & VITAL APOQUINDO',0,3,1],
[-33.4271,-70.52965,'197 NUEVA BILBAO - VITAL APOQUINDO / PTZ','NUEVA BILBAO & VITAL APOQUINDO',0,1,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / FIJA 1','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',0,3,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / LPR','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',0,2,1],
[-33.43077,-70.56367,'198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / PTZ','FRANCISCO BILBAO & HERNANDO DE MAGALLANES',0,1,1],
[-33.412869,-70.55242,'199 TOMAS MORO - IMPERIAL / FIJA 1','TOMAS MORO & IMPERIAL',0,3,1],
[-33.412869,-70.55242,'199 TOMAS MORO - IMPERIAL / PTZ','TOMAS MORO & IMPERIAL',0,1,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / FIJA 1','PRESIDENTE RIESCO & EL GOLF',0,3,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / FIJA 2','PRESIDENTE RIESCO & EL GOLF',0,3,1],
[-33.41213,-70.59259,'200 PRESIDENTE RIESCO - EL GOLF / PTZ','PRESIDENTE RIESCO & EL GOLF',0,1,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 1','ALEJANDRO FLEMING & FUENTE OVEJUNA',0,3,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 2','ALEJANDRO FLEMING & FUENTE OVEJUNA',0,3,1],
[-33.42463,-70.54632,'201 ALEJANDRO FLEMING - FUENTE OVEJUNA / PTZ','ALEJANDRO FLEMING & FUENTE OVEJUNA',0,1,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 1','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',0,3,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 2','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',0,3,1],
[-33.40167,-70.56071,'202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / PTZ','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA',0,1,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / FIJA 1','ENCOMENDEROS & ROGER DE FLOR',0,3,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / LPR 1','ENCOMENDEROS & ROGER DE FLOR',0,2,1],
[-33.41701,-70.60193,'203 ENCOMENDEROS - ROGER DE FLOR / PTZ','ENCOMENDEROS & ROGER DE FLOR',0,1,1],
[-33.417615,-70.568104,'204 CRISTOBAL COLON - DOMINGO BONDI / FIJA 1','CRISTÓBAL COLÓN & DOMINGO BONDI',0,3,1],
[-33.417615,-70.568104,'204 CRISTOBAL COLON - DOMINGO BONDI / PTZ','CRISTÓBAL COLÓN & DOMINGO BONDI',0,1,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 1','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',0,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 2','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',0,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 3','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',0,3,1],
[-33.40556,-70.57913,'205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / PTZ','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA',0,1,1],
[-33.41108,-70.5622,'206 IV CENTENARIO - VIRGILIO FIGUEROA / FIJA 1','IV CENTENARIO & VIRGILIO FIGUEROA',0,3,1],
[-33.41108,-70.5622,'206 IV CENTENARIO - VIRGILIO FIGUEROA / PTZ','IV CENTENARIO & VIRGILIO FIGUEROA',0,1,1],
[-33.417507,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / FIJA 1','CRISTÓBAL COLÓN & IMPERIAL',0,3,1],
[-33.417507,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / FIJA 2','CRISTÓBAL COLÓN & IMPERIAL',0,3,1],
[-33.417507,-70.54716,'207 CRISTOBAL COLON - IMPERIAL / PTZ','CRISTÓBAL COLÓN & IMPERIAL',0,1,1],
[-33.417972,-70.555661,'208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 1','ROBINSON CRUSOE & CRISTÓBAL CÓLON',0,3,1],
[-33.417972,-70.555661,'208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 2','ROBINSON CRUSOE & CRISTÓBAL CÓLON',0,3,1],
[-33.417972,-70.555661,'208 ROBINSON CRUSOE - CRISTOBAL COLON / PTZ','ROBINSON CRUSOE & CRISTÓBAL CÓLON',0,1,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / FIJA 1','VITAL APOQUINDO & LA QUEBRADA',0,3,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / FIJA 2','VITAL APOQUINDO & LA QUEBRADA',0,3,1],
[-33.41645,-70.52947,'209 VITAL APOQUINDO - LA QUEBRADA / PTZ','VITAL APOQUINDO & LA QUEBRADA',0,1,1],
[-33.412219,-70.536938,'210 LOMA LARGA - RIO GUADIANA / FIJA 1','LOMA LARGA & RIO GUADIANA',0,3,1],
[-33.412219,-70.536938,'210 LOMA LARGA - RIO GUADIANA / PTZ','LOMA LARGA & RIO GUADIANA',0,1,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 1','FRANCISCO BILBAO & IV CENTENARIO',0,3,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 2','FRANCISCO BILBAO & IV CENTENARIO',0,3,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 1','Francisco Bilbao & IV Centenario',0,2,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 2','Francisco Bilbao & IV Centenario',0,2,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / LPR 3','Francisco Bilbao & IV Centenario',0,2,1],
[-33.428915,-70.541721,'211 FRANCISCO BILBAO - IV CENTENARIO / PTZ','FRANCISCO BILBAO & IV CENTENARIO',0,1,1],
[-33.417123,-70.560436,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 1','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',0,3,1],
[-33.417123,-70.560436,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 2','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',0,3,1],
[-33.417123,-70.560436,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 3','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',0,3,1],
[-33.417123,-70.560436,'212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / PTZ','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES',0,1,1],
[-33.416619,-70.541325,'213 TALAVERA DE LA REINA - CRISTOBAL COLON / FIJA 1','TALAVERA DE LA REINA & CRISTOBAL COLON',0,3,1],
[-33.416619,-70.541325,'213 TALAVERA DE LA REINA - CRISTOBAL COLON / PTZ','TALAVERA DE LA REINA & CRISTOBAL COLON',0,1,1],
[-33.42496,-70.585738,'214 CRISTOBAL COLON - ALCANTARA / FIJA 1','CRISTÓBAL COLÓN & ALCÁNTARA',0,3,1],
[-33.42496,-70.585738,'214 CRISTOBAL COLON - ALCANTARA / PTZ','CRISTÓBAL COLÓN & ALCÁNTARA',0,1,1],
[-33.402362,-70.533829,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 1','CAMINO DEL ALGARROBO & CAMINO EL ALBA',0,3,1],
[-33.402362,-70.533829,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 2','CAMINO DEL ALGARROBO & CAMINO EL ALBA',0,3,1],
[-33.402362,-70.533829,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 3','CAMINO DEL ALGARROBO & CAMINO EL ALBA',0,3,1],
[-33.402362,-70.533829,'215 CAMINO EL ALGARROBO - CAMINO EL ALBA / PTZ','CAMINO DEL ALGARROBO & CAMINO EL ALBA',0,1,1],
[-33.41417,-70.538279,'216 CERRO ALTAR - NEVADO DE PIUQUENES / FIJA 1','NEVADA DE PIUQUENES & CERRO ALTAR',0,3,1],
[-33.41417,-70.538279,'216 CERRO ALTAR - NEVADO DE PIUQUENES / PTZ','NEVADA DE PIUQUENES & CERRO ALTAR',0,1,1],
[-33.415809,-70.536966,'217 DIAGUITAS - CERRO NEGRO / FIJA 1','DIAGUITAS & CERRO NEGRO',0,3,1],
[-33.415809,-70.536966,'217 DIAGUITAS - CERRO NEGRO / PTZ','DIAGUITAS & CERRO NEGRO',0,1,1],
[-33.425745,-70.53518,'218 VIA LACTEA - BELATRIX / FIJA 1','VÍA LACTEA & BELATRIX',0,3,1],
[-33.425745,-70.53518,'218 VIA LACTEA - BELATRIX / PTZ','VÍA LACTEA & BELATRIX',0,1,1],
[-33.423915,-70.531771,'219 ALEXANDER FLEMING - SANTA ZITA / FIJA 1','ALEXANDER FLEMING & SANTA ZITA',0,3,1],
[-33.423915,-70.531771,'219 ALEXANDER FLEMING - SANTA ZITA / FIJA 2','ALEXANDER FLEMING & SANTA ZITA',0,3,1],
[-33.423915,-70.531771,'219 ALEXANDER FLEMING - SANTA ZITA / PTZ','ALEXANDER FLEMING & SANTA ZITA',0,1,1],
[-33.424857,-70.531199,'220 LUCARO - LUCERO / FIJA 1','LUCARO & LUCERO',0,3,1],
[-33.424857,-70.531199,'220 LUCARO - LUCERO / FIJA 2','LUCARO & LUCERO',0,3,1],
[-33.424857,-70.531199,'220 LUCARO - LUCERO / PTZ','LUCARO & LUCERO',0,1,1],
[-33.419672,-70.532299,'221 OLGA - PAUL HARRIS / FIJA 1','OLGA & PAUL HARRIS',0,3,1],
[-33.419672,-70.532299,'221 OLGA - PAUL HARRIS / FIJA 2','OLGA & PAUL HARRIS',0,3,1],
[-33.419672,-70.532299,'221 OLGA - PAUL HARRIS / PTZ','OLGA & PAUL HARRIS',0,1,1],
[-33.419146,-70.535518,'222 LOS VILOS - SOCOMPA / FIJA 1','LOS VILOS & SOCOMPA',0,3,1],
[-33.419146,-70.535518,'222 LOS VILOS - SOCOMPA / FIJA 2','LOS VILOS & SOCOMPA',0,3,1],
[-33.419146,-70.535518,'222 LOS VILOS - SOCOMPA / PTZ','LOS VILOS & SOCOMPA',0,1,1],
[-33.41455,-70.596326,'223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 1','LA PASTORA & ISIDORA GOYENECHEA',0,3,1],
[-33.41455,-70.596326,'223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 2','LA PASTORA & ISIDORA GOYENECHEA',0,3,1],
[-33.41455,-70.596326,'223 LA PASTORA - ISIDORA GOYENECHEA / PTZ','LA PASTORA & ISIDORA GOYENECHEA',0,1,1],
[-33.414125,-70.600074,'224 ISIDORA GOYENECHEA - SAN SEBASTIAN / FIJA 1','ISIDORA GOYENECHEA & SAN SEBASTIAN',0,3,1],
[-33.414125,-70.600074,'224 ISIDORA GOYENECHEA - SAN SEBASTIAN / PTZ','ISIDORA GOYENECHEA & SAN SEBASTIAN',0,1,1],
[-33.413898,-70.602403,'225 ISIDORA GOYENECHEA - LUZ / FIJA 1','ISIDORA GOYENECHEA & LUZ',0,3,1],
[-33.413898,-70.602403,'225 ISIDORA GOYENECHEA - LUZ / FIJA 2','ISIDORA GOYENECHEA & LUZ',0,3,1],
[-33.413898,-70.602403,'225 ISIDORA GOYENECHEA - LUZ / PTZ','ISIDORA GOYENECHEA & LUZ',0,1,1],
[-33.416739,-70.600311,'226 ROGER DE FLOR - EL BOSQUE / FIJA 1','ROGER DE FLOR & EL BOSQUE NORTE',0,3,1],
[-33.416739,-70.600311,'226 ROGER DE FLOR - EL BOSQUE / PTZ','ROGER DE FLOR & EL BOSQUE NORTE',0,1,1],
[-33.414185,-70.593525,'227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 1','ISIDORA GOYENECHEA & MAGDALENA',0,3,1],
[-33.414185,-70.593525,'227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 2','ISIDORA GOYENECHEA & MAGDALENA',0,3,1],
[-33.414185,-70.593525,'227 ISIDORA GOYENECHEA - MAGDALENA / PTZ','ISIDORA GOYENECHEA & MAGDALENA',0,1,1],
[-33.411494,-70.603307,'228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 1','ANDRES BELLO & PRESIDENTE RIESCO',0,3,1],
[-33.411494,-70.603307,'228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 2','ANDRES BELLO & PRESIDENTE RIESCO',0,3,1],
[-33.411494,-70.603307,'228 ANDRES BELLO - PRESIDENTE RIESCO / PTZ','ANDRES BELLO & PRESIDENTE RIESCO',0,1,1],
[-33.41221,-70.599665,'229 PRESIDENTE RIESCO - SAN SEBASTIAN / FIJA 1','PRESIDENTE RIESCO & SAN SEBASTIAN',0,3,1],
[-33.41221,-70.599665,'229 PRESIDENTE RIESCO - SAN SEBASTIAN / PTZ','PRESIDENTE RIESCO & SAN SEBASTIAN',0,1,1],
[-33.37846,-70.501625,'230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / LPR','Charles Hamilton & San José de la Sierra',0,2,1],
[-33.37846,-70.501625,'230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / PTZ','CHARLES HAMILTON & SAN JOSÉ DE LA SIERRA',0,1,1],
[-33.413703,-70.577755,'231 NEVERIA - PUERTA DEL SOL / PTZ','NEVERIA & PUERTA DEL SOL',0,1,1],
[-33.415153,-70.566841,'232 LA CAPITANIA - MARTIN DE ZAMORA / FIJA 1','LA CAPITANIA & MARTIN DE ZAMORA',0,3,1],
[-33.410247,-70.572071,'233 APOQUINDO - LA CAPITANIA / PTZ','APOQUINDO & LA CAPITANIA',0,1,1],
[-33.410719,-70.574329,'234 APOQUINDO - JORGE IV / PTZ','APOQUINDO & JORGE IV',0,1,1],
[-33.420651,-70.533969,'235 ESTADIO PATRICIA / FIJA','PATRICIA & PICHIDANGUI',0,3,1],
[-33.420651,-70.533969,'235 ESTADIO PATRICIA / PTZ','PATRICIA & PICHIDANGUI',0,1,1],
[-33.420651,-70.533969,'235 ESTADIO PATRICIA / SOS','Patricia & Pichidangui',0,7,1],
[-33.418215,-70.588849,'236 RENATO SANCHEZ - ALCANTARA / PTZ','RENATO SANCHEZ & ALCANTARA',0,1,1],
[-33.417728,-70.585905,'237 RENATO SANCHEZ - MALAGA / PTZ','RENATO SANCHEZ & MALAGA',0,1,1],
[-33.418966,-70.584098,'238 PRESIDENTE ERRAZURIZ - ASTURIAS / PTZ','PRESIDENTE ERRAZURIZ & ASTURIAS',0,1,1],
[-33.426284,-70.573986,'239 ISABEL LA CATOLICA #4601 / FIJA 1','ISABEL LA CATÓLICA 4601',0,3,1],
[-33.426284,-70.573986,'239 ISABEL LA CATOLICA #4601 / FIJA 2','ISABEL LA CATÓLICA 4601',0,3,1],
[-33.426284,-70.573986,'239 ISABEL LA CATOLICA #4601 / LPR 1','ISABEL LA CATÓLICA 4601',0,2,1],
[-33.426284,-70.573986,'239 ISABEL LA CATOLICA #4601 / LPR 2','ISABEL LA CATÓLICA 4601',0,2,1],
[-33.426284,-70.573986,'239 ISABEL LA CATOLICA #4601 / PTZ','ISABEL LA CATÓLICA 4601',0,1,1],
[-33.422519,-70.583931,'240 MARTÍN DE ZAMORA - MALAGA / PTZ','MARTÍN DE ZAMORA & MALAGA',0,1,1],
[-33.415401,-70.604042,'241 VITACURA & ZURICH / LPR 1','Vitacura & Zurich',0,2,1],
[-33.417549,-70.5992,'242 APOQUINDO SUR & EL BOSQUE / LPR 1','Apoquindo & El Bosque',0,2,1],
[-33.417549,-70.5992,'242 APOQUINDO SUR & EL BOSQUE / LPR 2','Apoquindo & El Bosque',0,2,1],
[-33.417341,-70.599257,'243 APOQUINDO NORTE & EL BOSQUE / LPR 1','Apoquindo & El Bosque',0,2,1],
[-33.417341,-70.599257,'243 APOQUINDO NORTE & EL BOSQUE / LPR 2','Apoquindo & El Bosque',0,2,1],
[-33.430741,-70.570046,'244 SEBASTIAN ELCANO ORIENTE & BILBAO / FIJA','Sebastián Elcano & Francisco Bilbao',0,3,1],
[-33.430741,-70.570046,'244 SEBASTIAN ELCANO ORIENTE & BILBAO / LPR','Sebastián Elcano & Francisco Bilbao',0,2,1],
[-33.430077,-70.56487,'245 MANQUEHUE & BILBAO / LPR 1','Manquehue Sur & Francisco Bilbao',0,2,1],
[-33.430077,-70.56487,'245 MANQUEHUE & BILBAO / LPR 2','Manquehue Sur & Francisco Bilbao',0,2,1],
[-33.429471,-70.551494,'246 FLORENCIO BARRIOS & BILBAO / LPR 1','Florencio Barrios & Francisco Bilbao',0,2,1],
[-33.429471,-70.551494,'246 FLORENCIO BARRIOS & BILBAO / LPR 2','Florencio Barrios & Francisco Bilbao',0,2,1],
[-33.405192,-70.581774,'247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 1','Alonso de Córdova 4471',0,2,1],
[-33.405192,-70.581774,'247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 2','Alonso de Córdova 4471',0,2,1],
[-33.391187,-70.547628,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / FIJA','Padre Hurtado Norte & Pdte. Kennedy Lateral',0,3,1],
[-33.391187,-70.547628,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 1','Padre Hurtado Norte & Pdte. Kennedy Lateral',0,2,1],
[-33.391187,-70.547628,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 2','Padre Hurtado Norte & Pdte. Kennedy Lateral',0,2,1],
[-33.391187,-70.547628,'248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 3','Padre Hurtado Norte & Pdte. Kennedy Lateral',0,2,1],
[-33.385083,-70.532717,'249 INGRESO ESTORIL - LAS CONDES / FIJA','Estoril & Av. Las Condes',0,3,1],
[-33.385083,-70.532717,'249 INGRESO ESTORIL - LAS CONDES / LPR 1','Estoril & Av. Las Condes',0,2,1],
[-33.373483,-70.517037,'250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / FIJA','Nueva las Condes & San Francisco de Asis',0,3,1],
[-33.373483,-70.517037,'250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / LPR','Nueva las Condes & San Francisco de Asis',0,2,1],
[-33.373483,-70.517037,'250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / LPR 2','Nueva las Condes & San Francisco de Asis',0,2,1],
[-33.415785,-70.60273,'251 ZURICH & EBRO / FIJA 1','Zurich & Ebro',0,3,1],
[-33.415785,-70.60273,'251 ZURICH & EBRO / FIJA 2','Zurich & Ebro',0,3,1],
[-33.415785,-70.60273,'251 ZURICH & EBRO / PTZ','Zurich & Ebro',0,1,1],
[-33.412694,-70.588724,'252 HAMLET & LAS TORCAZAS / FIJA 1','Hamlet & Las Torcazas',0,3,1],
[-33.412694,-70.588724,'252 HAMLET & LAS TORCAZAS / FIJA 2','Hamlet & Las Torcazas',0,3,1],
[-33.412694,-70.588724,'252 HAMLET & LAS TORCAZAS / PTZ','Hamlet & Las Torcazas',0,1,1],
[-33.41869,-70.590882,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 1','Gertrudis Echeñique & Renato Sánchez',0,3,1],
[-33.41869,-70.590882,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 2','Gertrudis Echeñique & Renato Sánchez',0,3,1],
[-33.41869,-70.590882,'253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / PTZ','Gertrudis Echeñique & Renato Sánchez',0,1,1],
[-33.405326,-70.585993,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 1','Américo Vespucio Norte & Presidente Kennedy',0,3,1],
[-33.405326,-70.585993,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 2','Américo Vespucio Norte & Presidente Kennedy',0,3,1],
[-33.405326,-70.585993,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 1','Américo Vespucio Norte & Presidente Kennedy',0,2,1],
[-33.405326,-70.585993,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 2','Américo Vespucio Norte & Presidente Kennedy',0,2,1],
[-33.405326,-70.585993,'254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / PTZ','Américo Vespucio Norte & Presidente Kennedy',0,1,1],
[-33.406879,-70.586659,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 1','Américo Vespucio Norte & Cerro Colorado',0,3,1],
[-33.406879,-70.586659,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 2','Américo Vespucio Norte & Cerro Colorado',0,3,1],
[-33.406879,-70.586659,'255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / PTZ','Américo Vespucio Norte & Cerro Colorado',0,1,1],
[-33.421921,-70.580718,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 1','Américo Vespucio Sur & Martín de Zamora',0,3,1],
[-33.421921,-70.580718,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 2','Américo Vespucio Sur & Martín de Zamora',0,3,1],
[-33.421921,-70.580718,'256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / PTZ','Américo Vespucio Sur & Martín de Zamora',0,1,1],
[-33.425868,-70.576776,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 1','Américo Vespucio Sur & Isabel La Católica (poniente)',0,3,1],
[-33.425868,-70.576776,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 2','Américo Vespucio Sur & Isabel La Católica (poniente)',0,3,1],
[-33.425868,-70.576776,'257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / PTZ','Américo Vespucio Sur & Isabel La Católica (poniente)',0,1,1],
[-33.403723,-70.568983,'258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 1','Manquehue Norte & Cerro El Plomo',0,3,1],
[-33.403723,-70.568983,'258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 2','Manquehue Norte & Cerro El Plomo',0,3,1],
[-33.403723,-70.568983,'258 MANQUEHUE NORTE & CERRO EL PLOMO / PTZ','Manquehue Norte & Cerro El Plomo',0,1,1],
[-33.4025,-70.566286,'259 CERRO EL PLOMO & ESTOCOLMO / FIJA 1','Cerro El Plomo & Estocolmo',0,3,1],
[-33.4025,-70.566286,'259 CERRO EL PLOMO & ESTOCOLMO / FIJA 2','Cerro El Plomo & Estocolmo',0,3,1],
[-33.4025,-70.566286,'259 CERRO EL PLOMO & ESTOCOLMO / PTZ','Cerro El Plomo & Estocolmo',0,1,1],
[-33.403851,-70.565511,'260 LOS MILITARES & ESTOCOLMO / FIJA 1','Los Militares & Estocolmo',0,3,1],
[-33.403851,-70.565511,'260 LOS MILITARES & ESTOCOLMO / FIJA 2','Los Militares & Estocolmo',0,3,1],
[-33.403851,-70.565511,'260 LOS MILITARES & ESTOCOLMO / PTZ','Los Militares & Estocolmo',0,1,1],
[-33.408602,-70.577331,'261 LOS MILITARES & LA GLORIA / FIJA 1','Los Militares & La Gloria',0,3,1],
[-33.408602,-70.577331,'261 LOS MILITARES & LA GLORIA / FIJA 2','Los Militares & La Gloria',0,3,1],
[-33.408602,-70.577331,'261 LOS MILITARES & LA GLORIA / PTZ','Los Militares & La Gloria',0,1,1],
[-33.407796,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 1','Alonso de Córdova & O\'Connell',0,3,1],
[-33.407796,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 2','Alonso de Córdova & O\'Connell',0,3,1],
[-33.407796,-70.56868,'262 ALONSO DE CÓRDOVA & O\'CONNELL / PTZ','Alonso de Córdova & O\'Connell',0,1,1],
[-33.412174,-70.578476,'263 APOQUINDO & PUERTA DEL SOL / FIJA 1','Apoquindo & Puerta del Sol',0,3,1],
[-33.412174,-70.578476,'263 APOQUINDO & PUERTA DEL SOL / FIJA 2','Apoquindo & Puerta del Sol',0,3,1],
[-33.412174,-70.578476,'263 APOQUINDO & PUERTA DEL SOL / PTZ','Apoquindo & Puerta del Sol',0,1,1],
[-33.410633,-70.573248,'264 APOQUINDO & LUIS ZEGERS / FIJA 1','Apoquindo & Luis Zegers',0,3,1],
[-33.410633,-70.573248,'264 APOQUINDO & LUIS ZEGERS / FIJA 2','Apoquindo & Luis Zegers',0,3,1],
[-33.410633,-70.573248,'264 APOQUINDO & LUIS ZEGERS / PTZ','Apoquindo & Luis Zegers',0,1,1],
[-33.41234,-70.565949,'265 MANQUEHUE SUR & EL DIRECTOR / FIJA 1','Manquehue Sur & El Director',0,3,1],
[-33.41234,-70.565949,'265 MANQUEHUE SUR & EL DIRECTOR / FIJA 2','Manquehue Sur & El Director',0,3,1],
[-33.41234,-70.565949,'265 MANQUEHUE SUR & EL DIRECTOR / PTZ','Manquehue Sur & El Director',0,1,1],
[-33.415274,-70.574224,'266 ROSA O\'HIGGINS & DEL INCA / FIJA 1','Rosa O\'Higgins & Del Inca',0,3,1],
[-33.415274,-70.574224,'266 ROSA O\'HIGGINS & DEL INCA / FIJA 2','Rosa O\'Higgins & Del Inca',0,3,1],
[-33.415274,-70.574224,'266 ROSA O\'HIGGINS & DEL INCA / PTZ','Rosa O\'Higgins & Del Inca',0,1,1],
[-33.407912,-70.563413,'267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 1','Apoquindo & Esteban Dell\'Orto',0,3,1],
[-33.407912,-70.563413,'267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 2','Apoquindo & Esteban Dell\'Orto',0,3,1],
[-33.407912,-70.563413,'267 APOQUINDO & ESTEBAN DELL\'ORTO / PTZ','Apoquindo & Esteban Dell\'Orto',0,1,1],
[-33.404426,-70.556827,'268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 1','Las Condes & General Carol Urzúa',0,3,1],
[-33.404426,-70.556827,'268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 2','Las Condes & General Carol Urzúa',0,3,1],
[-33.404426,-70.556827,'268 LAS CONDES & GENERAL CAROL URZÚA / PTZ','Las Condes & General Carol Urzúa',0,1,1],
[-33.386478,-70.538867,'269 PRESIDENTE KENNEDY 9351 / PTZ','Presidente Kennedy 9351',0,1,1],
[-33.386478,-70.538867,'269 PRESIDENTE KENNEDY 9352 / FIJA 1','Presidente Kennedy 9352',0,3,1],
[-33.386478,-70.538867,'269 PRESIDENTE KENNEDY 9353 / FIJA 2','Presidente Kennedy 9353',0,3,1],
[-33.39237,-70.543142,'270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 1','Las Condes & Gilberto Fuenzalida',0,3,1],
[-33.39237,-70.543142,'270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 2','Las Condes & Gilberto Fuenzalida',0,3,1],
[-33.39237,-70.543142,'270 LAS CONDES & GILBERTO FUENZALIDA / PTZ','Las Condes & Gilberto Fuenzalida',0,1,1],
[-33.408208,-70.547839,'271 APOQUINDO & TALAVERA DE LA REINA / FIJA 1','Apoquindo & Talavera de La Reina',0,3,1],
[-33.408208,-70.547839,'271 APOQUINDO & TALAVERA DE LA REINA / FIJA 2','Apoquindo & Talavera de La Reina',0,3,1],
[-33.408208,-70.547839,'271 APOQUINDO & TALAVERA DE LA REINA / PTZ','Apoquindo & Talavera de La Reina',0,1,1],
[-33.409355,-70.543813,'272 LOS DOMÍNICOS & PATAGONIA / FIJA 1','Los Domínicos & Patagonia',0,3,1],
[-33.409355,-70.543813,'272 LOS DOMÍNICOS & PATAGONIA / FIJA 2','Los Domínicos & Patagonia',0,3,1],
[-33.409355,-70.543813,'272 LOS DOMÍNICOS & PATAGONIA / PTZ','Los Domínicos & Patagonia',0,1,1],
[-33.412691,-70.547483,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 1','Los Domínicos & Santa Magdalena Sofía',0,3,1],
[-33.412691,-70.547483,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 2','Los Domínicos & Santa Magdalena Sofía',0,3,1],
[-33.412691,-70.547483,'273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / PTZ','Los Domínicos & Santa Magdalena Sofía',0,1,1],
[-33.411312,-70.538768,'274 DIAGUITAS & CERRO MESON ALTO','Diaguitas & Cerro Meson Alto',0,3,1],
[-33.411312,-70.538768,'274 DIAGUITAS & CERRO MESON ALTO / FIJA 2','Diaguitas & Cerro Meson Alto',0,3,1],
[-33.411312,-70.538768,'274 DIAGUITAS & CERRO MESON ALTO / PTZ','Diaguitas & Cerro Meson Alto',0,1,1],
[-33.423232,-70.534788,'275 INCA DE ORO & TOTORALILLO / FIJA 1','Inca de Oro & Totoralillo',0,3,1],
[-33.423232,-70.534788,'275 INCA DE ORO & TOTORALILLO / FIJA 2','Inca de Oro & Totoralillo',0,3,1],
[-33.423232,-70.534788,'275 INCA DE ORO & TOTORALILLO / PTZ','Inca de Oro & Totoralillo',0,1,1],
[-33.393515,-70.539256,'276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 1','Paul Harris Oriente & Abadía',0,3,1],
[-33.393515,-70.539256,'276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 2','Paul Harris Oriente & Abadía',0,3,1],
[-33.393515,-70.539256,'276 PAUL HARRIS ORIENTE & ABADÍA / PTZ','Paul Harris Oriente & Abadía',0,1,1],
[-33.386918,-70.512545,'277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 1','Francisco Bulnes Correa & Los Monjes',0,3,1],
[-33.386918,-70.512545,'277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 2','Francisco Bulnes Correa & Los Monjes',0,3,1],
[-33.386918,-70.512545,'277 FRANCISCO BULNES CORREA & LOS MONJES / PTZ','Francisco Bulnes Correa & Los Monjes',0,1,1],
[-33.392427,-70.496347,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 1','San Francisco de Asís & Genova Oriente',0,3,1],
[-33.392427,-70.496347,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 2','San Francisco de Asís & Genova Oriente',0,3,1],
[-33.392427,-70.496347,'278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / PTZ','San Francisco de Asís & Genova Oriente',0,1,1],
[-33.403978,-70.512889,'279 SAN RAMÓN & DEL PARQUE / FIJA 1','San Ramón & Del Parque',0,3,1],
[-33.403978,-70.512889,'279 SAN RAMÓN & DEL PARQUE / FIJA 2','San Ramón & Del Parque',0,3,1],
[-33.403978,-70.512889,'279 SAN RAMÓN & DEL PARQUE / PTZ','San Ramón & Del Parque',0,1,1],
[-33.425846,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 1','Sebastián Elcano & Isabel La Católica',0,3,1],
[-33.425846,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 2','Sebastián Elcano & Isabel La Católica',0,3,1],
[-33.425846,-70.57029,'280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / PTZ','Sebastián Elcano & Isabel La Católica',0,1,1],
[-33.409948,-70.563751,'281 IV CENTENARIO & MARIA TERESA / PTZ','IV Centenario & María Teresa',0,1,1],
[-33.40701,-70.56122,'282 NUESTRA SEÑORA DEL ROSARIO & AV. LAS CONDES / PTZ','Nuestra Sra del Rosario & Av. Las Condes',0,1,1],
[-33.42721,-70.563569,'283 NUEVA DELHI & LATADIA / FIJA 1','Nueva Delhi & Latadía',0,3,1],
[-33.42721,-70.563569,'283 NUEVA DELHI & LATADIA / FIJA 2','Nueva Delhi & Latadía',0,3,1],
[-33.42721,-70.563569,'283 NUEVA DELHI & LATADIA / PTZ','Nueva Delhi & Latadía',0,1,1],
[-33.410038,-70.538415,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 1','Almirante Soublette & Comodoro Arturo Merino Benitez',0,3,1],
[-33.410038,-70.538415,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 2','Almirante Soublette & Comodoro Arturo Merino Benitez',0,3,1],
[-33.410038,-70.538415,'284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / PTZ','Almirante Soublette & Comodoro Arturo Merino Benitez',0,1,1],
[-33.414543,-70.536223,'285 LOMA LARGA & LEON BLANCO / FIJA 1','Loma Larga & Leon Blanco',0,3,1],
[-33.414543,-70.536223,'285 LOMA LARGA & LEON BLANCO / FIJA 2','Loma Larga & Leon Blanco',0,3,1],
[-33.414543,-70.536223,'285 LOMA LARGA & LEON BLANCO / FIJA 3','Loma Larga & Leon Blanco',0,3,1],
[-33.414543,-70.536223,'285 LOMA LARGA & LEON BLANCO / FIJA 4','Loma Larga & Leon Blanco',0,3,1],
[-33.414543,-70.536223,'285 LOMA LARGA & LEON BLANCO / PTZ','Loma Larga & Leon Blanco',0,1,1],
[-33.413088,-70.538597,'286 FUEGUINOS & CERRO ALTAR / FIJA 1','Fueguinos & Cerro Altar',0,3,1],
[-33.413088,-70.538597,'286 FUEGUINOS & CERRO ALTAR / FIJA 2','Fueguinos & Cerro Altar',0,3,1],
[-33.413088,-70.538597,'286 FUEGUINOS & CERRO ALTAR / PTZ','Fueguinos & Cerro Altar',0,1,1],
[-33.412815,-70.537536,'287 CERRO NAME & FUEGUINOS / FIJA 1','Fueguinos & Cerro Name',0,3,1],
[-33.412815,-70.537536,'287 CERRO NAME & FUEGUINOS / FIJA 2','Fueguinos & Cerro Name',0,3,1],
[-33.412815,-70.537536,'287 CERRO NAME & FUEGUINOS / PTZ','Fueguinos & Cerro Name',0,1,1],
[-33.409081,-70.542328,'288 PADRE HURTADO & GENERAL BLANCHE / PTZ','Padre Hurtado & General Blanche',0,1,1],
[-33.409081,-70.542328,'288 PADRE HURTADO & GENERAL BLANCHE / FIJA','Padre Hurtado & General Blanche',0,3,1],
[-33.403132,-70.517221,'289 FRANCISCO BULNES CORREA - GENERAL BLANCHE / PTZ','FRANCISCO BULNES CORREA & GENERAL BLANCHE',0,1,1],
[-33.39962,-70.510327,'290 SAN CARLOS DE APOQUINDO - CAMINO EL ALBA / PTZ','SAN CARLOS DE APOQUINDO & CAMINO EL ALBA',0,1,1],
[-33.390545,-70.513418,'291 CERRO CATEDRAL NORTE & REP DE HONDURAS / PTZ','REPUBLICA DE HONDURAS & CERRO CATEDRAL NORTE',0,1,1],
[-33.423132,-70.586652,'292 MARTIN DE ZAMORA & ALCANTARA / PTZ','MARTIN DE ZAMORA & ALCANTARA',0,1,1],
[-33.425147,-70.563476,'293 ISABEL LA CATOLICA - MANQUEHUE ORIENTE / PTZ','Isabel la Católica & Manquehue Oriente',0,1,1],
[-33.430863,-70.574788,'294 VESPUCIO - BILBAO / FIJA 1','Vespucio Poniente & Bilbao',0,3,1],
[-33.430863,-70.574788,'294 VESPUCIO - BILBAO / FIJA 2','Vespucio Poniente & Bilbao',0,3,1],
[-33.430863,-70.574788,'294 VESPUCIO - BILBAO / LPR 1','Vespucio Poniente & Bilbao',0,2,1],
[-33.410653,-70.579161,'295 LOS MILITARES - ORINOCO / FIJA 1','Los Militares & Orinoco',0,3,1],
[-33.410653,-70.579161,'295 LOS MILITARES - ORINOCO / FIJA 2','Los Militares & Orinoco',0,3,1],
[-33.410653,-70.579161,'295 LOS MILITARES - ORINOCO / LPR 1','Los Militares & Orinoco',0,2,1],
[-33.410653,-70.579161,'295 LOS MILITARES - ORINOCO / LPR 2','Los Militares & Orinoco',0,2,1],
[-33.399191,-70.537196,'296 CERRO CALAN / PTZ ZOOM','Camino el Observatorio 1515',0,1,1],
[-33.416135,-70.594693,'297 EDIFICIO APOQUINDO 3400 / PTZ ZOOM','Apoquindo 3400',0,1,1],
[-33.400059,-70.574348,'298 EDIFICIO MARRIOT / PTZ ZOOM','Presidente Kennedy 5741',0,1,1],
[-33.429545,-70.548788,'299 EDIFICIO BILBAO 8080 / PTZ ZOOM','Francisco Bilbao 8080',0,1,1],
[-33.418271,-70.554798,'300 EDIFICIO COLON 7337 / PTZ ZOOM','Av. Cristóbal Colón 7337',0,1,1],
[-33.413587,-70.582602,'301 EDIFICIO ESCUELA MILITAR / PTZ ZOOM','Evaristo Lillo 29',0,1,1],
[-33.410121,-70.528968,'302 CERRO MIRADOR / PTZ ZOOM','San Vicente Ferrer 2494',0,1,1],
[-33.418069,-70.553606,'303 ROTONDA ATENAS - CRISTOBAL COLON','ROTONDA ATENAS & CRISTOBAL COLON',0,1,1],
[-33.407479,-70.558462,'304 APOQUINDO - CAROL URZUA','APOQUINDO & CAROL URZUA',0,1,1],
[-33.373437,-70.518407,'305 ESTACIONAMIENTO CANTAGALLO / FIJA 1','Av Las Condes & Nueva Las Condes',0,3,1],
[-33.373437,-70.518407,'305 ESTACIONAMIENTO CANTAGALLO / FIJA 2','Av Las Condes & Nueva Las Condes',0,3,1],
[-33.42387,-70.53145,'RI 01 FLEMING - SANTA ZITA / FISHEYE','FLEMING & SANTA ZITA',0,4,3],
[-33.42387,-70.53145,'RI 01 FLEMING - SANTA ZITA / SOS','FLEMING & SANTA ZITA',0,7,3],
[-33.40909,-70.56798,'RI 02 APOQUINDO - MANQUEHUE / FISHEYE','APOQUINDO & MANQUEHUE',0,4,3],
[-33.40909,-70.56798,'RI 02 APOQUINDO - MANQUEHUE / SOS','APOQUINDO & MANQUEHUE',0,7,3],
[-33.39219,-70.54302,'RI 03 LAS CONDES - GILBERTO FUENZALIDA / FISHEYE','LAS CONDES & GILBERTO FUENZALIDA',0,4,3],
[-33.39219,-70.54302,'RI 03 LAS CONDES - GILBERTO FUENZALIDA / SOS','LAS CONDES & GILBERTO FUENZALIDA',0,7,3],
[-33.41744,-70.59944,'RI 04 APOQUINDO - EL BOSQUE / FISHEYE','APOQUINDO & EL BOSQUE',0,4,3],
[-33.41744,-70.59944,'RI 04 APOQUINDO - EL BOSQUE / SOS','APOQUINDO & EL BOSQUE',0,7,3],
[-33.41706,-70.59756,'RI 05 APOQUINDO - A. LEGUIA SUR / FISHEYE','APOQUINDO & A. LEGUIA SUR',0,4,3],
[-33.41706,-70.59756,'RI 05 APOQUINDO - A. LEGUIA SUR / SOS','APOQUINDO & A. LEGUIA SUR',0,7,3],
[-33.41669,-70.59656,'RI 06 APOQUINDO - A. LEGUIA NORTE / FISHEYE','APOQUINDO & A. LEGUIA NORTE',0,4,3],
[-33.41669,-70.59656,'RI 06 APOQUINDO - A. LEGUIA NORTE / SOS','APOQUINDO & A. LEGUIA NORTE',0,7,3],
[-33.41644,-70.59431,'RI 07 APOQUINDO - E. FOSTER / FISHEYE','APOQUINDO & E. FOSTER',0,4,3],
[-33.41644,-70.59431,'RI 07 APOQUINDO - E. FOSTER / SOS','APOQUINDO & E. FOSTER',0,7,3],
[-33.41505,-70.58725,'RI 08 APOQUINDO - MALAGA / FISHEYE','APOQUINDO & MALAGA',0,4,3],
[-33.41505,-70.58725,'RI 08 APOQUINDO - MALAGA / SOS','APOQUINDO & MALAGA',0,7,3],
[-33.41469,-70.58669,'RI 09 APOQUINDO - GOLDA MEIR / FISHEYE','APOQUINDO & GOLDA MEIR',0,4,3],
[-33.41469,-70.58669,'RI 09 APOQUINDO - GOLDA MEIR / SOS','APOQUINDO & GOLDA MEIR',0,7,3],
[-33.41319,-70.58156,'RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / FISHEYE','APOQUINDO & ESCUELA MILITAR',0,4,3],
[-33.41319,-70.58156,'RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / SOS','APOQUINDO & ESCUELA MILITAR',0,7,3],
[-33.41352,-70.58422,'RI 11 LOS MILITARES - BARCELO / FISHEYE','LOS MILITARES & BARCELO',0,4,3],
[-33.41352,-70.58422,'RI 11 LOS MILITARES - BARCELO / SOS','LOS MILITARES & BARCELO',0,7,3],
[-33.41184,-70.57819,'RI 12 APOQUINDO - ORINOCO / FISHEYE','APOQUINDO & ORINOCO',0,4,3],
[-33.41184,-70.57819,'RI 12 APOQUINDO - ORINOCO / SOS','APOQUINDO & ORINOCO',0,7,3],
[-33.40994,-70.57169,'RI 13 APOQUINDO - BADAJOZ / FISHEYE','APOQUINDO & BADAJOZ',0,4,3],
[-33.40994,-70.57169,'RI 13 APOQUINDO - BADAJOZ / SOS','APOQUINDO & BADAJOZ',0,7,3],
[-33.41395,-70.58566,'RI 14 LOS MILITARES - VESPUCIO / FISHEYE','LOS MILITARES & VESPUCIO',0,4,3],
[-33.41395,-70.58566,'RI 14 LOS MILITARES - VESPUCIO / SOS','LOS MILITARES & VESPUCIO',0,7,3],
[-33.4013,-70.57867,'RI 15 L.KENNEDY - P.ARAUCO / FISHEYE','Av. Pdte. Kennedy Lateral & Parque Araucano',0,4,3],
[-33.4013,-70.57867,'RI 15 L.KENNEDY - P.ARAUCO / SOS','KENNEDY LATERAL & PARQUE ARAUCANO',0,7,3],
[-33.40319,-70.57781,'RI 16 CERRO COLORADO - A. DE CORDOVA / FISHEYE','CERRO COLORADO & A. DE CORDOVA',0,4,3],
[-33.40319,-70.57781,'RI 16 CERRO COLORADO - A. DE CORDOVA / SOS','CERRO COLORADO & A. DE CORDOVA',0,7,3],
[-33.40144,-70.57006,'RI 17 MANQUEHUE - C. COLORADO / FISHEYE','MANQUEHUE & C. COLORADO',0,4,3],
[-33.40144,-70.57006,'RI 17 MANQUEHUE - C. COLORADO / SOS','MANQUEHUE & C. COLORADO',0,7,3],
[-33.40544,-70.56844,'RI 18 MANQUEHUE - LOS MILITARES / FISHEYE','MANQUEHUE & LOS MILITARES',0,4,3],
[-33.40544,-70.56844,'RI 18 MANQUEHUE - LOS MILITARES / SOS','MANQUEHUE & LOS MILITARES',0,7,3],
[-33.40106,-70.55469,'RI 19 LAS CONDES - LAS TRANQUERAS / FISHEYE','LAS CONDES & LAS TRANQUERAS',0,4,3],
[-33.40106,-70.55469,'RI 19 LAS CONDES - LAS TRANQUERAS / SOS','LAS CONDES & LAS TRANQUERAS',0,7,3],
[-33.39856,-70.55152,'RI 20 LAS CONDES - BOCACCIO / FISHEYE','LAS CONDES & BOCACCIO',0,4,3],
[-33.39856,-70.55152,'RI 20 LAS CONDES - BOCACCIO / SOS','LAS CONDES & BOCACCIO',0,7,3],
[-33.39556,-70.54866,'RI 21 LAS CONDES - HOSPITAL FACH / FISHEYE','LAS CONDES & HOSPITAL FACH',0,4,3],
[-33.39556,-70.54866,'RI 21 LAS CONDES - HOSPITAL FACH / SOS','LAS CONDES & HOSPITAL FACH',0,7,3],
[-33.39381,-70.54519,'RI 22 LAS CONDES - P. HURTADO CENTRAL / FISHEYE','LAS CONDES & P. HURTADO CENTRAL',0,4,3],
[-33.39381,-70.54519,'RI 22 LAS CONDES - P. HURTADO CENTRAL / SOS','LAS CONDES & P. HURTADO CENTRAL',0,7,3],
[-33.39035,-70.54143,'RI 23 LAS CONDES - CHARLES HAMILTON / FISHEYE','LAS CONDES & CHARLES HAMILTON',0,4,3],
[-33.39035,-70.54143,'RI 23 LAS CONDES - CHARLES HAMILTON / SOS','LAS CONDES & CHARLES HAMILTON',0,7,3],
[-33.384562,-70.534568,'RI 24 LAS CONDES - RIO MAULE / FISHEYE','LAS CONDES & RIO MAULE',0,4,3],
[-33.384562,-70.534568,'RI 24 LAS CONDES - RIO MAULE / SOS','LAS CONDES & RIO MAULE',0,7,3],
[-33.39631,-70.50381,'RI 25 LAS FLORES - LA PLAZA / FISHEYE','LAS FLORES & LA PLAZA',0,4,3],
[-33.39631,-70.50381,'RI 25 LAS FLORES - LA PLAZA / SOS','LAS FLORES & LA PLAZA',0,7,3],
[-33.400855,-70.506563,'RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / FISHEYE','AV. LA PLAZA & M. ALVARO DE PORTILLO',0,4,3],
[-33.400855,-70.506563,'RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / SOS','AV. LA PLAZA & M. ALVARO DE PORTILLO',0,7,3],
[-33.40056,-70.51344,'RI 27 CAMINO EL ALBA - SAN RAMON / FISHEYE','CAMINO EL ALBA & SAN RAMON',0,4,3],
[-33.40056,-70.51344,'RI 27 CAMINO EL ALBA - SAN RAMON / SOS','CAMINO EL ALBA & SAN RAMON',0,7,3],
[-33.40673,-70.54434,'RI 28 CAMINO EL ALBA - LOS DOMINICOS / FISHEYE','CAMINO EL ALBA & LOS DOMINICOS',0,4,3],
[-33.40673,-70.54434,'RI 28 CAMINO EL ALBA - LOS DOMINICOS / SOS','CAMINO EL ALBA & LOS DOMINICOS',0,7,3],
[-33.40821,-70.54503,'RI 29 PATAGONIA - P. LOS DOMINICOS / FISHEYE','PATAGONIA & P. LOS DOMINICOS',0,4,3],
[-33.40821,-70.54503,'RI 29 PATAGONIA - P. LOS DOMINICOS / SOS','PATAGONIA & P. LOS DOMINICOS',0,7,3],
[-33.40868,-70.54511,'RI 30 PATAGONIA - S. CIUDADANA / FISHEYE','PATAGONIA & S. CIUDADANA',0,4,3],
[-33.40868,-70.54511,'RI 30 PATAGONIA - S. CIUDADANA / SOS','PATAGONIA & S. CIUDADANA',0,7,3],
[-33.40794,-70.54619,'RI 31 APOQUINDO - PARANA / FISHEYE','APOQUINDO & PARANA',0,4,3],
[-33.40794,-70.54619,'RI 31 APOQUINDO - PARANA / SOS','APOQUINDO & PARANA',0,7,3],
[-33.4085,-70.55232,'RI 32 APOQUINDO - TOMAS MORO / FISHEYE','APOQUINDO & TOMAS MORO',0,4,3],
[-33.4085,-70.55232,'RI 32 APOQUINDO - TOMAS MORO / SOS','APOQUINDO & TOMAS MORO',0,7,3],
[-33.40969,-70.54194,'RI 33 PADRE HURTADO - PATAGONIA / FISHEYE','PADRE HURTADO & PATAGONIA',0,4,3],
[-33.40969,-70.54194,'RI 33 PADRE HURTADO - PATAGONIA / SOS','PADRE HURTADO & PATAGONIA',0,7,3],
[-33.41331,-70.54031,'RI 34 PADRE HURTADO - RIO GUADIANA / FISHEYE','PADRE HURTADO & RIO GUADIANA',0,4,3],
[-33.41331,-70.54031,'RI 34 PADRE HURTADO - RIO GUADIANA / SOS','PADRE HURTADO & RIO GUADIANA',0,7,3],
[-33.41606,-70.53369,'RI 35 PAUL HARRIS - LA QUEBRADA / FISHEYE','PAUL HARRIS & LA QUEBRADA',0,4,3],
[-33.41606,-70.53369,'RI 35 PAUL HARRIS - LA QUEBRADA / SOS','PAUL HARRIS & LA QUEBRADA',0,7,3],
[-33.41669,-70.53244,'RI 36 AV. LA ESCUELA - LA QUEBRADA / FISHEYE','AV. LA ESCUELA & LA QUEBRADA',0,4,3],
[-33.41669,-70.53244,'RI 36 AV. LA ESCUELA - LA QUEBRADA / SOS','AV. LA ESCUELA & LA QUEBRADA',0,7,3],
[-33.42094,-70.53769,'RI 37 PADRE HURTADO - PATRICIA / FISHEYE','PADRE HURTADO & PATRICIA',0,4,3],
[-33.42094,-70.53769,'RI 37 PADRE HURTADO - PATRICIA / SOS','PADRE HURTADO & PATRICIA',0,7,3],
[-33.42869,-70.54069,'RI 38 BILBAO - PORTAL LA REINA / FISHEYE','BILBAO & PORTAL LA REINA',0,4,3],
[-33.42869,-70.54069,'RI 38 BILBAO - PORTAL LA REINA / SOS','BILBAO & PORTAL LA REINA',0,7,3],
[-33.42456,-70.54594,'RI 39 FLEMING - IV CENTENARIO / FISHEYE','FLEMING & IV CENTENARIO',0,4,3],
[-33.42456,-70.54594,'RI 39 FLEMING - IV CENTENARIO / SOS','FLEMING & IV CENTENARIO',0,7,3],
[-33.42494,-70.54944,'RI 40 FLEMING - FRENTE CLINICA CORDILLERA / FISHEYE','FLEMING & FRENTE CLINICA CORDILLERA',0,4,3],
[-33.42494,-70.54944,'RI 40 FLEMING - FRENTE CLINICA CORDILLERA / SOS','FLEMING & FRENTE CLINICA CORDILLERA',0,7,3],
[-33.42507,-70.55003,'RI 41 FLEMING - CLINICA CORDILLERA / FISHEYE','FLEMING & CLINICA CORDILLERA',0,4,3],
[-33.42507,-70.55003,'RI 41 FLEMING - CLINICA CORDILLERA / SOS','FLEMING & CLINICA CORDILLERA',0,7,3],
[-33.42573,-70.55403,'RI 42 TOMAS MORO - FLEMING / FISHEYE','TOMAS MORO & FLEMING',0,4,3],
[-33.42573,-70.55403,'RI 42 TOMAS MORO - FLEMING / SOS','TOMAS MORO & FLEMING',0,7,3],
[-33.4253,-70.55343,'RI 43 FLEMING - TOMAS MORO / FISHEYE','FLEMING & TOMAS MORO',0,4,3],
[-33.4253,-70.55343,'RI 43 FLEMING - TOMAS MORO / SOS','FLEMING & TOMAS MORO',0,7,3],
[-33.42244,-70.55344,'RI 44 TOMAS MORO - ALONSO DE CAMARGO / FISHEYE','TOMAS MORO & ALONSO DE CAMARGO',0,4,3],
[-33.42244,-70.55344,'RI 44 TOMAS MORO - ALONSO DE CAMARGO / SOS','TOMAS MORO & ALONSO DE CAMARGO',0,7,3],
[-33.41744,-70.55781,'RI 45 COLON - PIACENZA / FISHEYE','COLON & PIACENZA',0,4,3],
[-33.41744,-70.55781,'RI 45 COLON - PIACENZA / SOS','COLON & PIACENZA',0,7,3],
[-33.41706,-70.56006,'RI 46 COLON - H. DE MAGALLANES / FISHEYE','COLON & H. DE MAGALLANES',0,4,3],
[-33.41706,-70.56006,'RI 46 COLON - H. DE MAGALLANES / SOS','COLON & H. DE MAGALLANES',0,7,3],
[-33.41644,-70.56444,'RI 47 COLON - MANQUEHUE / FISHEYE','COLON & MANQUEHUE',0,4,3],
[-33.41644,-70.56444,'RI 47 COLON - MANQUEHUE / SOS','COLON & MANQUEHUE',0,7,3],
[-33.41857,-70.57161,'RI 48 COLON - SEBASTIAN ELCANO / FISHEYE','COLON & SEBASTIAN ELCANO',0,4,3],
[-33.41857,-70.57161,'RI 48 COLON - SEBASTIAN ELCANO / SOS','COLON & SEBASTIAN ELCANO',0,7,3],
[-33.423374,-70.578832,'RI 49 COLON - VESPUCIO / FISHEYE','COLON & VESPUCIO',0,4,3],
[-33.423374,-70.578832,'RI 49 COLON - VESPUCIO / SOS','COLON & VESPUCIO',0,7,3],
[-33.423632,-70.578703,'RI 50 VESPUCIO SUR - COLON / FISHEYE','VESPUCIO SUR & COLON',0,4,3],
[-33.423632,-70.578703,'RI 50 VESPUCIO SUR - COLON / SOS','VESPUCIO SUR & COLON',0,7,3],
[-33.415865,-70.534202,'RI 51 PAUL HARRIS - COLON / FISHEYE','PAUL HARRIS & COLON',0,4,3],
[-33.415865,-70.534202,'RI 51 PAUL HARRIS - COLON / SOS','PAUL HARRIS & COLON',0,7,3],
[-33.430241,-70.553874,'RI 52 BILBAO / TOMAS MORO / FISHEYE','BILBAO & TOMAS MORO',0,4,3],
[-33.430241,-70.553874,'RI 52 BILBAO / TOMAS MORO / SOS','BILBAO & TOMAS MORO',0,7,3],
[-33.394949,-70.561739,'RI 53 KENNEDY / GERONIMO ALDERETE / FISHEYE','KENNEDY & GERONIMO ALDERETE',0,4,3],
[-33.394949,-70.561739,'RI 53 KENNEDY / GERONIMO ALDERETE / SOS','KENNEDY & GERONIMO ALDERETE',0,7,3],
[-33.392126,-70.553605,'RI 54 KENNEDY / LAS TRANQUERAS / FISHEYE','KENNEDY & LAS TRANQUERAS',0,4,3],
[-33.392126,-70.553605,'RI 54 KENNEDY / LAS TRANQUERAS / SOS','KENNEDY & LAS TRANQUERAS',0,7,3],
[-33.372996,-70.518065,'RI 55 LAS CONDES / CANTAGALLO / FISHEYE','LAS CONDES & CANTAGALLO',0,4,3],
[-33.372996,-70.518065,'RI 55 LAS CONDES / CANTAGALLO / SOS','LAS CONDES & CANTAGALLO',0,7,3],
[-33.373458,-70.517101,'RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / FISHEYE','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS',0,4,3],
[-33.373458,-70.517101,'RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / SOS','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS',0,7,3],
[-33.431031,-70.569571,'RI 57 BILBAO / SEBASTIAN EL CANO / FISHEYE','BILBAO & SEBASTIAN EL CANO',0,4,3],
[-33.431031,-70.569571,'RI 57 BILBAO / SEBASTIAN EL CANO / SOS','BILBAO & SEBASTIAN EL CANO',0,7,3],
[-33.431403,-70.580734,'RI 58 BILBAO / ALCANTARA / FISHEYE','BILBAO & ALCANTARA',0,4,3],
[-33.431403,-70.580734,'RI 58 BILBAO / ALCANTARA / SOS','BILBAO & ALCANTARA',0,7,3],
[-33.42909,-70.574719,'RI 59 MANUEL BARRIOS / VESPUCIO / FISHEYE','MANUEL BARRIOS & VESPUCIO',0,4,3],
[-33.42909,-70.574719,'RI 59 MANUEL BARRIOS / VESPUCIO / SOS','MANUEL BARRIOS & VESPUCIO',0,7,3],
[-33.369716,-70.504553,'RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / FISHEYE','AV. LAS CONDES & SAN JOSE DE LA SIERRA',0,4,3],
[-33.369716,-70.504553,'RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / SOS','AV. LAS CONDES & SAN JOSE DE LA SIERRA',0,7,3],
[-33.405028,-70.557472,'PI 01 LAS CONDES - CAROL URZUA / PTZ','Av. Las condes &Carol Urzua',0,1,2],
[-33.405028,-70.557472,'PI 01 LAS CONDES - CAROL URZUA / SOS','Av. Las condes & Carol Urzua',0,7,2],
[-33.417472,-70.545972,'PI 02 COLON - FUENTEOVEJUNA / PTZ','C. Colon & Fuenteovejuna',0,1,2],
[-33.417472,-70.545972,'PI 02 COLON - FUENTEOVEJUNA / SOS','C. Colon & Fuenteovejuna',0,7,2],
[-33.414611,-70.537361,'PI 04 DIAGUITAS - ATACAMEÑOS / PTZ','Diaguitas & Atacameños',0,1,2],
[-33.414611,-70.537361,'PI 04 DIAGUITAS - ATACAMEÑOS / SOS','Diaguitas & Atacameños',0,7,2],
[-33.428333,-70.551056,'PI 05 F BARRIOS . M CLARO VIAL / PTZ','Florencio Barrios & Miguel Claro Vial',0,1,2],
[-33.428333,-70.551056,'PI 05 F BARRIOS . M CLARO VIAL / SOS','Florencio Barrios & Miguel Claro Vial',0,7,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / PTZ','IV Centenario & Alejandro Fleming',0,1,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / SOS','IV Centenario & Alejandro Fleming',0,7,2],
[-33.423639,-70.546528,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / PTZ','IV Centenario & Fuenteovejuna',0,1,2],
[-33.423639,-70.546528,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / SOS','IV Centenario & Fuenteovejuna',0,7,2],
[-33.401056,-70.555167,'PI 08 LAS CONDES - LAS TRANQUERAS / PTZ','Las Tranqueras & Av. Las condes',0,1,2],
[-33.401056,-70.555167,'PI 08 LAS CONDES - LAS TRANQUERAS / SOS','Las Tranqueras & Av. Las condes',0,7,2],
[-33.412667,-70.536278,'PI 09 FUEGUINOS - PATAGONES / PTZ','Los Fueguinos & Patagones',0,1,2],
[-33.412667,-70.536278,'PI 09 FUEGUINOS - PATAGONES / SOS','Los Fueguinos & Patagones',0,7,2],
[-33.414472,-70.535694,'PI 10 MAPUCHES - HUALTECAS / PTZ','Los mapuches & Las Hualtecas',0,1,2],
[-33.414472,-70.535694,'PI 10 MAPUCHES - HUALTECAS / SOS','Los mapuches & Las Hualtecas',0,7,2],
[-33.421528,-70.535611,'PI 11 LOS VILOS - PEÑUELAS / SOS','Los Vilos & Peñuelas',0,7,2],
[-33.421528,-70.535611,'PI 11 LOS VILOS - PEÑUELAS / PTZ','Los Vilos & Peñuelas',0,1,2],
[-33.418111,-70.53575,'PI 12 LOS VILOS - SOCOMPA / SOS','Los Vilos & Socompa',0,7,2],
[-33.418111,-70.53575,'PI 12 LOS VILOS - SOCOMPA / PTZ','Los Vilos & Socompa',0,1,2],
[-33.428861,-70.553722,'PI 13 M CLARO VIAL - CALEU / SOS','Miguel Claro Vial & Caleu',0,7,2],
[-33.428861,-70.553722,'PI 13 M CLARO VIAL - CALEU / PTZ','Miguel Claro Vial & Caleu',0,1,2],
[-33.420361,-70.530361,'PI 14 MARISOL - ROSITA / SOS','Marisol & Rosita',0,7,2],
[-33.420361,-70.530361,'PI 14 MARISOL - ROSITA / PTZ','Marisol & Rosita',0,1,2],
[-33.403,-70.574028,'PI 15 PARQUE ARAUCANO CENTRAL / SOS','Parque Araucano Central',0,7,2],
[-33.403,-70.574028,'PI 15 PARQUE ARAUCANO CENTRAL / PTZ','Parque Araucano Central',0,1,2],
[-33.403,-70.572583,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / SOS','Parque Araucano Z. Deportiva',0,7,2],
[-33.403,-70.572583,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / PTZ','Parque Araucano Z. Deportiva',0,1,2],
[-33.404056,-70.576778,'PI 17 PARQUE ARAUCANO PONIENTE / SOS','Parque Araucano Poniente',0,7,2],
[-33.404056,-70.576778,'PI 17 PARQUE ARAUCANO PONIENTE / PTZ','Parque Araucano Poniente',0,1,2],
[-33.401417,-70.570583,'PI 16 PARQUE ARAUCANO SKATEPARK /SOS','Parque Araucano Oriente (skatepark)',0,7,2],
[-33.401417,-70.570583,'PI 16 PARQUE ARAUCANO SKATEPARK / PTZ','Parque Araucano Oriente (skatepark)',0,1,2],
[-33.404889,-70.547639,'PI 19 PARQUE MONTEGRANDE NORTE / SOS','Parque Montegrande Norte',0,7,2],
[-33.404889,-70.547639,'PI 19 PARQUE MONTEGRANDE NORTE / PTZ','Parque Montegrande Norte',0,1,2],
[-33.406361,-70.548333,'PI 20 PARQUE MONTEGRANDE / SOS','Parque Montegrande II',0,7,2],
[-33.406361,-70.548333,'PI 20 PARQUE MONTEGRANDE / PTZ','Parque Montegrande II',0,1,2],
[-33.429861,-70.548472,'PI 21 BILBAO - DUQUECO / SOS','Plaza Bilbao & Duqueco',0,7,2],
[-33.429861,-70.548472,'PI 21 BILBAO - DUQUECO / PTZ','Plaza Bilbao & Duqueco',0,1,2],
[-33.42925,-70.542972,'PI 22 BILBAO - IV CENTENARIO / SOS','Plaza Bilbao & Enrique Bunster',0,7,2],
[-33.42925,-70.542972,'PI 22 BILBAO - IV CENTENARIO / PTZ','Plaza Bilbao & Enrique Bunster',0,1,2],
[-33.414056,-70.558722,'PI 23 IV CENTENARIO - H DE MAGALLANES / SOS','Plaza IV Centenario & H. Magallanes',0,7,2],
[-33.414056,-70.558722,'PI 23 IV CENTENARIO - H DE MAGALLANES / PTZ','Plaza IV Centenario & H. Magallanes',0,1,2],
[-33.408194,-70.555972,'PI 24 METRO H DE MAGALLANES / SOS','Apoquindo & Hernando de magallanes',0,7,2],
[-33.408194,-70.555972,'PI 24 METRO H DE MAGALLANES / PTZ','Apoquindo & Hernando de magallanes',0,1,2],
[-33.420417,-70.535167,'PI 25 PATRICIA & LOS VILOS / SOS','Plaza Patricia & Los vilos',0,7,2],
[-33.420417,-70.535167,'PI 25 PATRICIA & LOS VILOS / PTZ','Plaza Patricia & Los vilos',0,1,2],
[-33.42575,-70.532972,'PI 26 VIA LACTEA - CIRIO / SOS','Via Lactea & Cirio',0,7,2],
[-33.42575,-70.532972,'PI 26 VIA LACTEA - CIRIO / PTZ','Via Lactea & Cirio',0,1,2],
[-33.425667,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / SOS','Via Lactea & Padre Hurtado',0,7,2],
[-33.425667,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / PTZ','Via Lactea & Padre Hurtado',0,1,2],
[-33.417889,-70.552528,'PI 28 ROTONDA ATENAS - PETROBRAS / SOS','Cristobal Colón & Los Dominicos',0,7,2],
[-33.417889,-70.552528,'PI 28 ROTONDA ATENAS - PETROBRAS / PTZ','Cristobal Colón & Los Dominicos',0,1,2],
[-33.414844,-70.598468,'PI 32 CARMENCITA & DON CARLOS / SOS','Carmencita & Don carlos',0,7,2],
[-33.414844,-70.598468,'PI 32 CARMENCITA & DON CARLOS / PTZ','Carmencita & Don carlos',0,1,2],
[-33.420261,-70.589371,'PI 37 PDTE ERRAZURIZ & POLONIA / SOS','Presidente Errazuriz & Polonia',0,7,2],
[-33.420261,-70.589371,'PI 37 PDTE ERRAZURIZ & POLONIA / PTZ','Presidente Errazuriz & Polonia',0,1,2],
[-33.413338,-70.570481,'PI 38 LA CAPITANIA & DEL INCA / SOS','Plaza La Capitania / Del Inca',0,7,2],
[-33.413338,-70.570481,'PI 38 LA CAPITANIA & DEL INCA / PTZ','Plaza La Capitania / Del Inca',0,1,2],
[-33.428061,-70.585189,'PI 39 TARRAGONA & ALCANTARA / SOS','Tarragona & Alcantara',0,7,2],
[-33.428061,-70.585189,'PI 39 TARRAGONA & ALCANTARA / PTZ','Tarragona & Alcantara',0,1,2],
[-33.417046,-70.540436,'PI 40 COLÓN & VISVIRI / SOS','Cristobal colón & Visviri',0,7,2],
[-33.417046,-70.540436,'PI 40 COLÓN & VISVIRI / PTZ','Cristobal colón & Visviri',0,1,2],
[-33.426883,-70.579043,'PI 41 FDO DE ARAGON & CARLOS V / SOS','Fernando de Aragon & Carlos V',0,7,2],
[-33.426883,-70.579043,'PI 41 FDO DE ARAGON & CARLOS V / PTZ','Fernando de Aragon & Carlos V',0,1,2],
[-33.427893,-70.570032,'PI 42 MANUEL BARRIOS & LATADIA / SOS','Manuel Barrios & Latadia',0,7,2],
[-33.427893,-70.570032,'PI 42 MANUEL BARRIOS & LATADIA / PTZ','Manuel Barrios & Latadia',0,1,2],
[-33.426241,-70.564279,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / SOS','Juan Esteban Montero & Manquehue',0,7,2],
[-33.426241,-70.564279,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / PTZ','Juan Esteban Montero & Manquehue',0,1,2],
[-33.420626,-70.570691,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / SOS','Martin Alonso Pinzon & Sebastian Elcano',0,7,2],
[-33.420626,-70.570691,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / PTZ','Martin Alonso Pinzon & Sebastian Elcano',0,1,2],
[-33.424257,-70.564144,'PI 45 PEDRO BLANQUIER & MANQUEHUE SUR / SOS','Ingeniero Pedro Blanquier & Manquehue sur',0,7,2],
[-33.424257,-70.564144,'PI 45 PEDRO BLANQUIER & MANQUEHUE SUR / PTZ','Ingeniero Pedro Blanquier & Manquehue sur',0,1,2],
[-33.4198,-70.567566,'PI 46 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / SOS','Domingo Bondi & Martín Alonso Pinzón',0,7,2],
[-33.4198,-70.567566,'PI 46 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / PTZ','Domingo Bondi & Martín Alonso Pinzón',0,1,2],
[-33.414184,-70.583637,'PI 47 VESPUCIO & APOQUINDO / SOS','Americo Vespucio Norte & Apoquindo',0,7,2],
[-33.414184,-70.583637,'PI 47 VESPUCIO & APOQUINDO / PTZ','Americo Vespucio Norte & Apoquindo',0,1,2],
[-33.417836,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / SOS','Cruz del Sur & del Inca',0,7,2],
[-33.417836,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / PTZ','Cruz del Sur & del Inca',0,1,2],
[-33.411205,-70.575094,'PI 49 COIMBRA & ROSA O\'HIGGINS / SOS','Coimbra & Rosa O\'higgins',0,7,2],
[-33.411205,-70.575094,'PI 49 COIMBRA & ROSA O\'HIGGINS / PTZ','Coimbra & Rosa O\'higgins',0,1,2],
[-33.409463,-70.569096,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / SOS','Apoquindo & Mar de los Sargazos',0,7,2],
[-33.409463,-70.569096,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / PTZ','Apoquindo & Mar de los Sargazos',0,1,2],
[-33.424845,-70.559541,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / SOS','Av Alejandro Fleming & Isabel La Católica',0,7,2],
[-33.424845,-70.559541,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / PTZ','Av Alejandro Fleming & Isabel La Católica',0,1,2],
[-33.400311,-70.567711,'PI 52 RIESCO & MANQUEHUE / SOS','Presidente Riesco & Manquehue Norte',0,7,2],
[-33.400311,-70.567711,'PI 52 RIESCO & MANQUEHUE / PTZ','Presidente Riesco & Manquehue Norte',0,1,2],
[-33.397226,-70.566921,'PI 53 KENNEDY & BRASILIA / SOS','Presidente Kennedy & Brasilia',0,7,2],
[-33.397226,-70.566921,'PI 53 KENNEDY & BRASILIA / PTZ','Presidente Kennedy & Brasilia',0,1,2],
[-33.397583,-70.558647,'PI 54 MAR DE CORAL & GARCIA PICA / SOS','Mar de Coral & Garcia Pica',0,7,2],
[-33.397583,-70.558647,'PI 54 MAR DE CORAL & GARCIA PICA / PTZ','Mar de Coral & Garcia Pica',0,1,2],
[-33.398631,-70.553527,'PI 56 SOR JOSEFA & LAS VERBENAS / SOS','Sor Josefa & Las Verbenas',0,7,2],
[-33.398631,-70.553527,'PI 56 SOR JOSEFA & LAS VERBENAS / PTZ','Sor Josefa & Las Verbenas',0,1,2],
[-33.416535,-70.555004,'PI 58 LOS POZOS & IV CENTENARIO / SOS','Los Pozos & Cuarto Centenario',0,7,2],
[-33.416535,-70.555004,'PI 58 LOS POZOS & IV CENTENARIO / PTZ','Los Pozos & Cuarto Centenario',0,1,2],
[-33.422398,-70.553295,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / SOS','Alonso de Camargo & Tomas Moro',0,7,2],
[-33.422398,-70.553295,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / PTZ','Alonso de Camargo & Tomas Moro',0,1,2],
[-33.421377,-70.550633,'PI 61 TEZCUCO & PRETORIA / SOS','Tezcuco & Pretoria',0,7,2],
[-33.421377,-70.550633,'PI 61 TEZCUCO & PRETORIA / PTZ','Tezcuco & Pretoria',0,1,2],
[-33.418114,-70.549016,'PI 62 COLON & VIZCAYA / SOS','Cristobal Colón & Vizcaya',0,7,2],
[-33.418114,-70.549016,'PI 62 COLON & VIZCAYA / PTZ','Cristobal Colón & Vizcaya',0,1,2],
[-33.415783,-70.552042,'PI 63 TINGUIRIRICA & MONROE / SOS','Tinguiririca & Monroe',0,7,2],
[-33.415783,-70.552042,'PI 63 TINGUIRIRICA & MONROE / PTZ','Tinguiririca & Monroe',0,1,2],
[-33.415865,-70.542488,'PI 64 ISLOTE SNIPE & RIO TAMESIS / SOS','Islote Snipe & Rio Tamesis',0,7,2],
[-33.415865,-70.542488,'PI 64 ISLOTE SNIPE & RIO TAMESIS / PTZ','Islote Snipe & Rio Tamesis',0,1,2],
[-33.414765,-70.542148,'PI 65 TALAVERA DE LA REINA & RIO CONGO / SOS','Talavera de la Teina & Rio Congo',0,7,2],
[-33.414765,-70.542148,'PI 65 TALAVERA DE LA REINA & RIO CONGO / PTZ','Talavera de la Teina & Rio Congo',0,1,2],
[-33.394502,-70.541198,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / SOS','Cardenal newman & Punta del este',0,7,2],
[-33.394502,-70.541198,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / PTZ','Cardenal Newman & Punta del Este',0,1,2],
[-33.408229,-70.537743,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / SOS','Viejos Estandartes & General Blanche',0,7,2],
[-33.408229,-70.537743,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / PTZ','Viejos Estandartes & General Blanche',0,1,2],
[-33.37327,-70.518441,'PI 71 NUEVA LAS CONDES & LAS CONDES / SOS','Nueva Las Condes & Las Condes',0,7,2],
[-33.37327,-70.518441,'PI 71 NUEVA LAS CONDES & LAS CONDES / PTZ','Nueva Las Condes & Las Condes',0,1,2],
[-33.406856,-70.535362,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / SOS','General Blanche & Luis Matte Larrain',0,7,2],
[-33.406856,-70.535362,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / PTZ','General Blanche & Luis Matte Larrain',0,1,2],
[-33.41345,-70.541702,'PI 75 RIO GUADIANA & LONTANANZA / SOS','Rio Guadiana & Lontananza',0,7,2],
[-33.41345,-70.541702,'PI 75 RIO GUADIANA & LONTANANZA / PTZ','Rio Guadiana & Lontananza',0,1,2],
[-33.412755,-70.541369,'PI 76 LA RECOBA & EL TORRENTE / SOS','La Recoba & El Torrente',0,7,2],
[-33.412755,-70.541369,'PI 76 LA RECOBA & EL TORRENTE / PTZ','La Recoba & El Torrente',0,1,2],
[-33.416755,-70.529836,'PI 77 LA QUEBRADA & VITAL APOQUINDO / SOS','La Quebrada & Vital apoquindo',0,7,2],
[-33.416755,-70.529836,'PI 77 LA QUEBRADA & VITAL APOQUINDO / PTZ','La Quebrada & Vital apoquindo',0,1,2],
[-33.420665,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / SOS','Rivadavia & Incahuasi',0,7,2],
[-33.420665,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / PTZ','Rivadavia & Incahuasi',0,1,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / SOS','Padre Hurtado Sur & Inca de Oro',0,7,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / PTZ','Padre Hurtado Sur & Inca de Oro',0,1,2],
[-33.426401,-70.537459,'PI 81 ALTAIR & PLAZA ALTAIR / SOS','Altair & Altair',0,7,2],
[-33.426401,-70.537459,'PI 81 ALTAIR & PLAZA ALTAIR / PTZ','Altair & Altair',0,1,2],
[-33.412117,-70.507735,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / SOS','Quebrada Honda & Carlos Peña otaegui',0,7,2],
[-33.412117,-70.507735,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña otaegui',0,1,2],
[-33.402408,-70.510345,'PI 84 DEL PARQUE & SANTOS APOSTOLES / SOS','Del Parque & Santos Apostoles',0,7,2],
[-33.402408,-70.510345,'PI 84 DEL PARQUE & SANTOS APOSTOLES / PTZ','Del Parque & Santos Apostoles',0,1,2],
[-33.411443,-70.520512,'PI 85 CARLOS PEÑA & LAS CONDESAS / SOS','Carlos Peña Otaegui & Las Condesas',0,7,2],
[-33.411443,-70.520512,'PI 85 CARLOS PEÑA & LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas',0,1,2],
[-33.389637,-70.50769,'PI 87 LOS MONJES EL CONVENTO / SOS','Los Monjes & El Convento',0,7,2],
[-33.389637,-70.50769,'PI 87 LOS MONJES EL CONVENTO / PTZ','Los Monjes & El Convento',0,1,2],
[-33.39338,-70.507662,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / SOS','Cerro Catedral Sur & San Carlos de Apoquindo',0,7,2],
[-33.39338,-70.507662,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / PTZ','Cerro Catedral Sur & San Carlos de Apoquindo',0,1,2],
[-33.396678,-70.512747,'PI 90 CERRO PROVINCIA & LOS PUMAS / SOS','Cerro Provincia & Los Pumas',0,7,2],
[-33.396678,-70.512747,'PI 90 CERRO PROVINCIA & LOS PUMAS / PTZ','Cerro Provincia & Los Pumas',0,1,2],
[-33.398237,-70.515344,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / SOS','Camino las Vertientes & Camino de los Arrieros',0,7,2],
[-33.398237,-70.515344,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / PTZ','Camino las Vertientes & Camino de los Arrieros',0,1,2],
[-33.427425,-70.542827,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / SOS','IV Centenario & Manuel Claro Vial',0,7,2],
[-33.427425,-70.542827,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / PTZ','IV Centenario & Manuel Claro Vial',0,1,2],
[-33.426526,-70.548812,'PI 94 LOLCO & RUCALHUE / SOS','Lolco & Rucalhue',0,7,2],
[-33.426526,-70.548812,'PI 94 LOLCO & RUCALHUE / PTZ','Lolco & Rucalhue',0,1,2],
[-33.41905,-70.530946,'PI 95 PLAZA OLGA NORTE / SOS','Pasaje Olga Norte',0,7,2],
[-33.41905,-70.530946,'PI 95 PLAZA OLGA NORTE / PTZ','Pasaje Olga Norte',0,1,2],
[-33.417454,-70.529687,'PI 96 YOLANDA & VITAL APOQUINDO / SOS','Yolanda & Vital Apoquindo',0,7,2],
[-33.417454,-70.529687,'PI 96 YOLANDA & VITAL APOQUINDO / PTZ','Yolanda & Vital Apoquindo',0,1,2],
[-33.418403,-70.530209,'PI 97 YOLANDA INTERIOR / SOS','Yolanda Interior',0,7,2],
[-33.418403,-70.530209,'PI 97 YOLANDA INTERIOR / PTZ','Yolanda Interior',0,1,2],
[-33.397826,-70.511007,'PI 98 CERRO EL CEPO & CERRO EL CEPO / SOS','Cerro el Cepo & Cerro el Cepo',0,7,2],
[-33.397826,-70.511007,'PI 98 CERRO EL CEPO & CERRO EL CEPO / PTZ','Cerro el Cepo & Cerro el Cepo',0,1,2],
[-33.39629,-70.510664,'PI 99 CERRO LITORIA & CERRO LITORIA / SOS','Cerro litoria & Cerro litoria',0,7,2],
[-33.39629,-70.510664,'PI 99 CERRO LITORIA & CERRO LITORIA / PTZ','Cerro litoria & Cerro litoria',0,1,2],
[-33.423071,-70.542308,'PI 102 EL TATIO & PICA / PTZ','El tatio & Pica',0,1,2],
[-33.423071,-70.542308,'PI 102 EL TATIO & PICA / SOS','El tatio & Pica',0,7,2],
[-33.423731,-70.535043,'PI 103 ALEXANDER FLEMING & TOTORALILLO / PTZ','Alexander Fleming & Totoralillo',0,1,2],
[-33.423731,-70.535043,'PI 103 ALEXANDER FLEMING & TOTORALILLO / SOS','Alexander Fleming & Totoralillo',0,7,2],
[-33.425016,-70.533183,'PI 104 SANTA ZITA & SANTA ZITA / PTZ','Santa Zita & Santa Zita',0,1,2],
[-33.425016,-70.533183,'PI 104 SANTA ZITA & SANTA ZITA / SOS','Santa Zita & Santa Zita',0,7,2],
[-33.423745,-70.533152,'PI 105 FLEMING & PUNITAQUI / PTZ','Alexander Fleming & Punitaqui',0,1,2],
[-33.423745,-70.533152,'PI 105 FLEMING & PUNITAQUI / SOS','Alexander Fleming & Punitaqui',0,7,2],
[-33.401295,-70.550247,'PI 106 PETRARCA & BENVENUTTO CELLINI / PTZ','Petrarca & Benvenuto Cellini',0,1,2],
[-33.401295,-70.550247,'PI 106 PETRARCA & BENVENUTTO CELLINI / SOS','Petrarca & Benvenuto Cellini',0,7,2],
[-33.402913,-70.550754,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / PTZ','Lorenzo de Medicis & Benvenuto Cellini',0,1,2],
[-33.402913,-70.550754,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / SOS','Lorenzo de Medicis & Benvenuto Cellini',0,7,2],
[-33.404444,-70.553531,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / PTZ','Padre Errazuriz & Miguel Angel Buonarotti',0,1,2],
[-33.404444,-70.553531,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / SOS','Padre Errazuriz & Miguel Angel Buonarotti',0,7,2],
[-33.420547,-70.537497,'PI 109 PADRE HURTADO & PATRICIA / PTZ','Padre Hurtado Sur & Patricia',0,1,2],
[-33.420547,-70.537497,'PI 109 PADRE HURTADO & PATRICIA / SOS','Padre Hurtado Sur & Patricia',0,7,2],
[-33.42022,-70.545332,'PI 110 TOCONAO & CHIUCHIU / PTZ','Toconao & Chiu chiu',0,1,2],
[-33.42022,-70.545332,'PI 110 TOCONAO & CHIUCHIU / SOS','Toconao & Chiu chiu',0,7,2],
[-33.418758,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / PTZ','Paul harris sur & Socompa',0,1,2],
[-33.418758,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / SOS','Paul harris sur & Socompa',0,7,2],
[-33.412861,-70.523871,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / PTZ','atalaya & carlos peña otaegui',0,1,2],
[-33.412861,-70.523871,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / SOS','atalaya & carlos peña otaegui',0,7,2],
[-33.418849,-70.541374,'PI 113 ZARAGOZA & AYQUINA / PTZ','zaragoza & ayquina',0,1,2],
[-33.418849,-70.541374,'PI 113 ZARAGOZA & AYQUINA / SOS','zaragoza & ayquina',0,7,2],
[-33.418537,-70.545239,'PI 114 LERIDA & TOCONAO / PTZ','Lerida & Toconao',0,1,2],
[-33.418537,-70.545239,'PI 114 LERIDA & TOCONAO / SOS','Lerida & Toconao',0,7,2],
[-33.419553,-70.544831,'PI 115 ZARAGOZA & TOCONAO / PTZ','Zaragoza & Toconao',0,1,2],
[-33.419553,-70.544831,'PI 115 ZARAGOZA & TOCONAO / SOS','Zaragoza & Toconao',0,7,2],
[-33.419785,-70.570616,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / PTZ','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano',0,1,2],
[-33.419785,-70.570616,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / SOS','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano',0,7,2],
[-33.420014,-70.543798,'PI 117 ZARAGOZA & PUREN / PTZ','Puren. Entre Zaragoza & Alonso de Camargo',0,1,2],
[-33.420014,-70.543798,'PI 117 ZARAGOZA & PUREN / SOS','Puren. Entre Zaragoza & Alonso de Camargo',0,7,2],
[-33.403675,-70.566929,'PI 118 VILLA SAN LUIS A / PTZ','Cerro el Plomo & Estocolmo',0,1,2],
[-33.403675,-70.566929,'PI 118 VILLA SAN LUIS A / SOS','Cerro el Plomo & Estocolmo',0,7,2],
[-33.40249,-70.567499,'PI 119 VILLA SAN LUIS B / PTZ','Cerro el Plomo & Estocolmo',0,1,2],
[-33.40249,-70.567499,'PI 119 VILLA SAN LUIS B / SOS','Cerro el Plomo & Estocolmo',0,7,2],
[-33.413497,-70.596308,'PI 120 GLAMIS & LA PASTORA / PTZ','Glamis & La Pastora',0,1,2],
[-33.413497,-70.596308,'PI 120 GLAMIS & LA PASTORA / SOS','Glamis & La Pastora',0,7,2],
[-33.408344,-70.571159,'PI 121 ROSARIO NORTE & EDIPO REY / PTZ','Rosario Norte & Edipo Rey',0,1,2],
[-33.408344,-70.571159,'PI 121 ROSARIO NORTE & EDIPO REY / SOS','Rosario Norte & Edipo Rey',0,7,2],
[-33.417699,-70.602121,'PI 122 TAJAMAR & ENCOMENDEROS / PTZ','Tajamar & Encomenderos',0,1,2],
[-33.417699,-70.602121,'PI 122 TAJAMAR & ENCOMENDEROS / SOS','Tajamar & Encomenderos',0,7,2],
[-33.423377,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / PTZ','Ayquina & Ascotan',0,1,2],
[-33.423377,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / SOS','Ayquina & Ascotan',0,7,2],
[-33.431162,-70.578661,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PTZ','Francisco Bilbao & Juan de Austria',0,1,2],
[-33.431162,-70.578661,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / SOS','Francisco Bilbao & Juan de Austria',0,7,2],
[-33.416996,-70.540565,'PI 127 PARQUE SANTA ROSA / PTZ','Cristobal colón & Visviri',0,1,2],
[-33.416996,-70.540565,'PI 127 PARQUE SANTA ROSA / SOS','Cristobal colón & Visviri',0,7,2],
[-33.405275,-70.572463,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / PTZ','Rosario Norte & Cerro el Plomo',0,1,2],
[-33.405275,-70.572463,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / SOS','Rosario Norte & Cerro el Plomo',0,7,2],
[-33.413585,-70.583606,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PTZ','Apoquindo & Gral Francisco Barceló',0,1,2],
[-33.413585,-70.583606,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / SOS','Apoquindo & Gral Francisco Barceló',0,7,2],
[-33.406898,-70.561535,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / PTZ','Av. Las Condes & Nuestra Sra. del Rosario',0,1,2],
[-33.406898,-70.561535,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / SOS','Av. Las Condes & Nuestra Sra. del Rosario',0,7,2],
[-33.391084,-70.513489,'PI 134 PLAZA CORAZÓN / PTZ','Republica de Honduras & Catedral Sur',0,1,2],
[-33.391084,-70.513489,'PI 134 PLAZA CORAZÓN / SOS','Republica de Honduras & Catedral Sur',0,7,2],
[-33.421694,-70.545627,'PI 135 CHIU CHIU - CODPA / PTZ','Chiu Chiu & Codpa',0,1,2],
[-33.421694,-70.545627,'PI 135 CHIU CHIU - CODPA / SOS','Chiu Chiu & Codpa',0,7,2],
[-33.42147,-70.544334,'PI 136 PARINACOTA - CODPA / PTZ','Codpa & Parinacota',0,1,2],
[-33.42147,-70.544334,'PI 136 PARINACOTA - CODPA / SOS','Codpa & Parinacota',0,7,2],
[-33.423481,-70.549274,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / PTZ','Pintor R. Monvoisin & Pintora Aurora Mira',0,1,2],
[-33.423481,-70.549274,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / SOS','Pintor R. Monvoisin & Pintora Aurora Mira',0,7,2],
[-33.418847,-70.540482,'PI 138 VISVIRI - ZARAGOZA / PTZ','Visviri & Zaragoza',0,1,2],
[-33.418847,-70.540482,'PI 138 VISVIRI - ZARAGOZA / SOS','Visviri & Zaragoza',0,7,2],
[-33.426615,-70.553101,'PI 141 TORRE FLEMING / PTZ','Lolco 7680',0,1,2],
[-33.426615,-70.553101,'PI 141 TORRE FLEMING / SOS','Lolco 7680',0,7,2],
[-33.396871,-70.552641,'Pi 143 PLAZA SOR LAURA ROSA / PTZ','Sor Laura Rosa 220',0,1,2],
[-33.396871,-70.552641,'Pi 143 PLAZA SOR LAURA ROSA / SOS','Sor Laura Rosa 220',0,7,2],
[-33.421748,-70.541165,'Pi 144 TOCONCE & CHAPIQUIÑA / PTZ','Chapiquiña 8851',0,1,2],
[-33.421748,-70.541165,'Pi 144 TOCONCE & CHAPIQUIÑA / SOS','Chapiquiña 8851',0,7,2],
[-33.414607,-70.534543,'PI 145 PAUL HARRIS & ATACAMEÑOS / PTZ','Paul Harris & Atacameños',0,1,2],
[-33.414607,-70.534543,'PI 145 PAUL HARRIS & ATACAMEÑOS / SOS','Paul Harris & Atacameños',0,7,2],
[-33.425435,-70.591556,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / PTZ','La niña & Sanchez Fontecilla',0,1,2],
[-33.425435,-70.591556,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / SOS','La niña & Sanchez Fontecilla',0,7,2],
[-33.388356,-70.525315,'PI 147 CHARLES HAMILTON - LO FONTECILLA / PTZ','Charles Hamilton & Lo Fontecilla',0,1,2],
[-33.388356,-70.525315,'PI 147 CHARLES HAMILTON - LO FONTECILLA / SOS','Charles Hamilton & Lo Fontecilla',0,7,2],
[-33.407581,-70.544921,'PI 148 LOS DOMINICOS / PTZ','Los Dominicos (Pista Patinaje)',0,1,2],
[-33.407581,-70.544921,'PI 148 LOS DOMINICOS / SOS','Los Dominicos (Pista Patinaje)',0,7,2],
[-33.415,-70.597893,'PI 149 DON CARLOS & AUGUSTO LEGUIA / PTZ','Don Carlos & Augusto Leguia',0,1,2],
[-33.415,-70.597893,'PI 149 DON CARLOS & AUGUSTO LEGUIA / SOS','Don Carlos & Augusto Leguia',0,7,2],
[-33.392293,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / PTZ','Pdte. San Fuentes - Euzkadi',0,1,2],
[-33.392293,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / SOS','Pdte. San Fuentes - Euzkadi',0,7,2],
[-33.374123,-70.520551,'PI 153 COLEGIO LAS CONDES / PTZ','Av. Las condes 12125',0,1,2],
[-33.374123,-70.520551,'PI 153 COLEGIO LAS CONDES / SOS','Av. Las condes 12125',0,7,2],
[-33.42062,-70.536441,'PI 157 COLEGIO JUAN PABLO II / PTZ','Patricia 9040',0,1,2],
[-33.42062,-70.536441,'PI 157 COLEGIO JUAN PABLO II / SOS','Patricia 9040',0,7,2],
[-33.425799,-70.532285,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / PTZ','VIA LACTEA & CIRIO',0,1,2],
[-33.425799,-70.532285,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / SOS','VIA LACTEA & CIRIO',0,7,2],
[-33.400343,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / PTZ','Cerro Altar 6811',0,1,2],
[-33.400343,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / SOS','Cerro Altar 6811',0,7,2],
[-33.403933,-70.536128,'PI 160 COLEGIO SAN FCO. DEL ALBA / PTZ','CAMINO EL ALBA & VITAL APOQUINDO',0,1,2],
[-33.403933,-70.536128,'PI 160 COLEGIO SAN FCO. DEL ALBA / SOS','CAMINO EL ALBA & VITAL APOQUINDO',0,7,2],
[-33.415965,-70.536116,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / PTZ','Av. Cristóbal Colón 9070',0,1,2],
[-33.415965,-70.536116,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / SOS','Av. Cristóbal Colón 9070',0,7,2],
[-33.416044,-70.534556,'PI 162 COLEGIO PAUL HARRIS / PTZ','CRISTOBAL COLON 9188',0,1,2],
[-33.416044,-70.534556,'PI 162 COLEGIO PAUL HARRIS / SOS','CRISTOBAL COLON 9188',0,7,2],
[-33.425536,-70.554461,'PI 163 COLEGIO SIMON BOLIVAR / PTZ','TOMAS MORO 1651',0,1,2],
[-33.425536,-70.554461,'PI 163 COLEGIO SIMON BOLIVAR / SOS','TOMAS MORO 1651',0,7,2],
[-33.404941,-70.578501,'PI 164 DEPARTAMENTO DE TRANSITO / PTZ','PDTE RIESCO 5296',0,1,2],
[-33.404941,-70.578501,'PI 164 DEPARTAMENTO DE TRANSITO / SOS','PDTE RIESCO 5296',0,7,2],
[-33.398751,-70.561971,'PI 165 CIRCULO POLAR / PTZ','CÍRCULO POLAR 6652',0,1,2],
[-33.398751,-70.561971,'PI 165 CIRCULO POLAR / SOS','CÍRCULO POLAR 6652',0,7,2],
[-33.414261,-70.588148,'PI 166 JEAN MERMOZ / PTZ','JEAN MERMOZ 4115',0,1,2],
[-33.414261,-70.588148,'PI 166 JEAN MERMOZ / SOS','JEAN MERMOZ 4115',0,7,2],
[-33.37008,-70.505555,'PI 167 COLEGIO SOUTHERN CROSS / PTZ','LAS CONDES 13525',0,1,2],
[-33.37008,-70.505555,'PI 167 COLEGIO SOUTHERN CROSS / SOS','LAS CONDES 13525',0,7,2],
[-33.370302,-70.508184,'PI 168 COLEGIO PEDRO DE VALDIVIA / PTZ','AV. LAS CONDES 13349',0,1,2],
[-33.370302,-70.508184,'PI 168 COLEGIO PEDRO DE VALDIVIA / SOS','AV. LAS CONDES 13349',0,7,2],
[-33.403125,-70.564497,'PI 169 COLEGIO SEK / PTZ','LOS MILITARES 6640',0,1,2],
[-33.403125,-70.564497,'PI 169 COLEGIO SEK / SOS','LOS MILITARES 6640',0,7,2],
[-33.400645,-70.566639,'PI 170 COLEGIO ARABE / PTZ','PDTE. RIESCO 6437',0,1,2],
[-33.400645,-70.566639,'PI 170 COLEGIO ARABE / SOS','PDTE. RIESCO 6437',0,7,2],
[-33.420455,-70.589129,'PI 171 COLEGIO VILLA MARIA ACADEMY / PTZ','PDTE ERRÁZURIZ 3753',0,1,2],
[-33.420455,-70.589129,'PI 171 COLEGIO VILLA MARIA ACADEMY / SOS','PDTE ERRÁZURIZ 3753',0,7,2],
[-33.419995,-70.586936,'PI 172 COLEGIO VERBO DIVINO / PTZ','PDTE ERRÁZURIZ 4055',0,1,2],
[-33.419995,-70.586936,'PI 172 COLEGIO VERBO DIVINO / SOS','PDTE ERRÁZURIZ 4055',0,7,2],
[-33.419605,-70.546899,'PI 173 COLEGIO COOCENDE / PTZ','ZARAGOZA 8065',0,1,2],
[-33.410642,-70.549632,'PI 174 COLEGIO SAGRADO CORAZÓN / PTZ','STA. MAGDALENA SOFÍA 277',0,1,2],
[-33.410642,-70.549632,'PI 174 COLEGIO SAGRADO CORAZÓN / SOS','STA. MAGDALENA SOFÍA 277',0,7,2],
[-33.405538,-70.540548,'PI 175 COLEGIO VIRGEN DE POMPEYA / PTZ','CAMINO EL ALBA N° 9145',0,1,2],
[-33.405538,-70.540548,'PI 175 COLEGIO VIRGEN DE POMPEYA / SOS','CAMINO EL ALBA N° 9145',0,7,2],
[-33.38845,-70.533326,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / PTZ','CAMPANARIO 000',0,1,2],
[-33.38845,-70.533326,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / SOS','CAMPANARIO 000',0,7,2],
[-33.425544,-70.555118,'PI 177 COLEGIO ALEXANDER FLEMING / PTZ','AV. ALEJANDRO FLEMING 7315',0,1,2],
[-33.425544,-70.555118,'PI 177 COLEGIO ALEXANDER FLEMING / SOS','AV. ALEJANDRO FLEMING 7315',0,7,2],
[-33.421384,-70.558582,'PI 178 COLEGIO ACHIGA COMEDUC / PTZ','ALONSO DE CAMARGO 6615',0,1,2],
[-33.421384,-70.558582,'PI 178 COLEGIO ACHIGA COMEDUC / SOS','ALONSO DE CAMARGO 6615',0,7,2],
[-33.419263,-70.588568,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PTZ','ALCÁNTARA 445',0,1,2],
[-33.419263,-70.588568,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / SOS','ALCÁNTARA 445',0,7,2],
[-33.405655,-70.560724,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / PTZ','LA PIEDAD 35',0,1,2],
[-33.405655,-70.560724,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / SOS','LA PIEDAD 35',0,7,2],
[-33.395207,-70.554028,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / PTZ','LAS TRANQUERAS 726',0,1,2],
[-33.395207,-70.554028,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / SOS','LAS TRANQUERAS 726',0,7,2],
[-33.411268,-70.552289,'PI 182 COLEGIO SAN JORGE / PTZ','AVENIDA TOMÁS MORO 272',0,1,2],
[-33.411268,-70.552289,'PI 182 COLEGIO SAN JORGE / SOS','AVENIDA TOMÁS MORO 272',0,7,2],
[-33.398973,-70.559905,'PI 183 COLEGIO EMAUS / PTZ','GERÓNIMO DE ALDERETE 481',0,1,2],
[-33.398973,-70.559905,'PI 183 COLEGIO EMAUS / SOS','GERÓNIMO DE ALDERETE 481',0,7,2],
[-33.426145,-70.572864,'PI 184 COLEGIO QUIMAY / PTZ','ISABEL LA CATOLICA 4774',0,1,2],
[-33.426145,-70.572864,'PI 184 COLEGIO QUIMAY / SOS','ISABEL LA CATOLICA 4774',0,7,2],
[-33.41145,-70.522091,'PI 185 COLEGIO WENLOCK SCHOOL / PTZ','CALLE CARLOS PEÑA OTAEGUI 10880',0,1,2],
[-33.41145,-70.522091,'PI 185 COLEGIO WENLOCK SCHOOL / SOS','CALLE CARLOS PEÑA OTAEGUI 10880',0,7,2],
[-33.414752,-70.563079,'PI 186 COLEGIO SAN JUAN EVANGELISTA / PTZ','MARTÍN DE ZAMORA 6395',0,1,2],
[-33.414752,-70.563079,'PI 186 COLEGIO SAN JUAN EVANGELISTA / SOS','MARTÍN DE ZAMORA 6395',0,7,2],
[-33.419581,-70.542305,'PI 187 PLAZA EL TATIO / PTZ','CALLE PICA 1220',0,1,2],
[-33.419581,-70.542305,'PI 187 PLAZA EL TATIO / SOS','CALLE PICA 1220',0,7,2],
[-33.407159,-70.554827,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / PTZ','PADRE ERRAZURIZ 7001',0,1,2],
[-33.407159,-70.554827,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / SOS','PADRE ERRAZURIZ 7001',0,7,2],
[-33.420743,-70.546357,'PI 189 COLEGIO ALAMIRO / PTZ','FUENTE OVEJUNA 1235',0,1,2],
[-33.420743,-70.546357,'PI 189 COLEGIO ALAMIRO / SOS','FUENTE OVEJUNA 1235',0,7,2],
[-33.40704,-70.581401,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / PTZ','PRESIDENTE RIESCO 4902',0,1,2],
[-33.40704,-70.581401,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / SOS','PRESIDENTE RIESCO 4902',0,7,2],
[-33.398249,-70.567799,'PI 191 COLEGIO ALEMAN DE SANTIAGO / PTZ','NUESTRA SEÑORA DEL ROSARIO 850',0,1,2],
[-33.398249,-70.567799,'PI 191 COLEGIO ALEMAN DE SANTIAGO / SOS','NUESTRA SEÑORA DEL ROSARIO 850',0,7,2],
[-33.425653,-70.570196,'PI 192 COLEGIO ANDINO ANTILLANCA / PTZ','SEBASTIAN ELCANO 1590',0,1,2],
[-33.425653,-70.570196,'PI 192 COLEGIO ANDINO ANTILLANCA / SOS','SEBASTIAN ELCANO 1590',0,7,2],
[-33.389257,-70.531581,'PI 193 COLEGIO BRITISH HIGH SCHOOL / PTZ','LOS GLADIOLOS 10031',0,1,2],
[-33.389257,-70.531581,'PI 193 COLEGIO BRITISH HIGH SCHOOL / SOS','LOS GLADIOLOS 10031',0,7,2],
[-33.40915,-70.564771,'PI 194 COLEGIO LIFE SUPPORT / PTZ','IV CENTENARIO 68',0,1,2],
[-33.40915,-70.564771,'PI 194 COLEGIO LIFE SUPPORT / SOS','IV CENTENARIO 68',0,7,2],
[-33.413211,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / PTZ','IV CENTENARIO 605',0,1,2],
[-33.413211,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / SOS','IV CENTENARIO 605',0,7,2],
[-33.409437,-70.566742,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / PTZ','AV. MANQUEHUE SUR 116',0,1,2],
[-33.409437,-70.566742,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / SOS','AV. MANQUEHUE SUR 116',0,7,2],
[-33.396287,-70.513887,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / PTZ','LOS PUMAS 12015',0,1,2],
[-33.396287,-70.513887,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / SOS','LOS PUMAS 12015',0,7,2],
[-33.429265,-70.586696,'PI 198 COLEGIO COYANCURA / PTZ','MARIANO SANCHEZ FONTECILLA 1552',0,1,2],
[-33.429265,-70.586696,'PI 198 COLEGIO COYANCURA / SOS','MARIANO SANCHEZ FONTECILLA 1552',0,7,2],
[-33.394369,-70.504856,'PI 199 COLEGIO CUMBRES / PTZ','AV. PLAZA 1150',0,1,2],
[-33.394369,-70.504856,'PI 199 COLEGIO CUMBRES / SOS','AV. PLAZA 1150',0,7,2],
[-33.398647,-70.544789,'PI 200 COLEGIO DALCAHUE / PTZ','PADRE HURTADO CENTRAL 605',0,1,2],
[-33.398647,-70.544789,'PI 200 COLEGIO DALCAHUE / SOS','PADRE HURTADO CENTRAL 605',0,7,2],
[-33.374363,-70.520918,'PI 201 COLEGIO DUNALASTAIR / PTZ','AV. LAS CONDES 11931',0,1,2],
[-33.374363,-70.520918,'PI 201 COLEGIO DUNALASTAIR / SOS','AV. LAS CONDES 11931',0,7,2],
[-33.392114,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / PTZ','CERRO CATEDRAL NORTE 12150',0,1,2],
[-33.392114,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / SOS','CERRO CATEDRAL NORTE 12150',0,7,2],
[-33.424052,-70.555008,'PI 203 COLEGIO INSTITUCION TERESIANA / PTZ','ISABEL LA CATOLICA 7445',0,1,2],
[-33.424052,-70.555008,'PI 203 COLEGIO INSTITUCION TERESIANA / SOS','ISABEL LA CATOLICA 7445',0,7,2],
[-33.413619,-70.512481,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / PTZ','FRANCISCO BULNES CORREA 3000',0,1,2],
[-33.413619,-70.512481,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / SOS','FRANCISCO BULNES CORREA 3000',0,7,2],
[-33.43058,-70.563589,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PTZ','FRANCISCO BILBAO 6300',0,1,2],
[-33.43058,-70.563589,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / SOS','FRANCISCO BILBAO 6300',0,7,2],
[-33.420564,-70.568728,'PI 206 COLEGIO LA GIOURETTE / PTZ','MAR DEL SUR 1238',0,1,2],
[-33.420564,-70.568728,'PI 206 COLEGIO LA GIOURETTE / SOS','MAR DEL SUR 1238',0,7,2],
[-33.379334,-70.508343,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / PTZ','AV. CHARLES HAMILTON 12880',0,1,2],
[-33.379334,-70.508343,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / SOS','AV. CHARLES HAMILTON 12880',0,7,2],
[-33.401524,-70.521361,'PI 208 COLEGIO REDLAND SCHOOL / PTZ','CAMINO EL ALBA 11357',0,1,2],
[-33.401524,-70.521361,'PI 208 COLEGIO REDLAND SCHOOL / SOS','CAMINO EL ALBA 11357',0,7,2],
[-33.419439,-70.588478,'PI 209 COLEGIO SAIN PAUL MONTESSORI / PTZ','ALCÁNTARA 464',0,1,2],
[-33.419439,-70.588478,'PI 209 COLEGIO SAIN PAUL MONTESSORI / SOS','ALCÁNTARA 464',0,7,2],
[-33.429551,-70.583641,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / PTZ','CANCILLER DOLLFUSS 1801',0,1,2],
[-33.429551,-70.583641,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / SOS','CANCILLER DOLLFUSS 1801',0,7,2],
[-33.430412,-70.574176,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / PTZ','VICTOR RAE 4420',0,1,2],
[-33.430412,-70.574176,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / SOS','VICTOR RAE 4420',0,7,2],
[-33.39377,-70.505077,'PI 212 COLEGIO NICOLAS DE MYRA / PTZ','AV PLAZA 1157',0,1,2],
[-33.39377,-70.505077,'PI 212 COLEGIO NICOLAS DE MYRA / SOS','AV PLAZA 1157',0,7,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / PTZ','CAMINO EL ALBA 12881',0,1,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / SOS','CAMINO EL ALBA 12881',0,7,2],
[-33.39483,-70.521538,'PI 214 COLEGIO KILPATRICK / PTZ','CAMINO LAS FLORES 11280',0,1,2],
[-33.39483,-70.521538,'PI 214 COLEGIO KILPATRICK / SOS','CAMINO LAS FLORES 11280',0,7,2],
[-33.413781,-70.574749,'PI 215 COLEGIO MOUNIER / PTZ','ROSA O\'HIGGINS 298',0,1,2],
[-33.413781,-70.574749,'PI 215 COLEGIO MOUNIER / SOS','ROSA O\'HIGGINS 298',0,7,2],
[-33.424902,-70.56184,'PI 216 COLEGIO GUNMAN / PTZ','ISABEL LA CATÓLICA 6366',0,1,2],
[-33.424902,-70.56184,'PI 216 COLEGIO GUNMAN / SOS','ISABEL LA CATÓLICA 6366',0,7,2],
[-33.38943,-70.531894,'LG1-01 - C 490','CAMPANARIO 499',4,3,0],
[-33.38943,-70.531894,'LG2-06 - LG 9861','CAMPANARIO 499',4,3,0],
[-33.389714,-70.532341,'LG1-02 - C 490','LOS GLADIOLOS 9930',4,3,0],
[-33.389714,-70.532341,'LG1-03 - LG 9930','LOS GLADIOLOS 9930',4,3,0],
[-33.389758,-70.532412,'LG1-04 - LG 9930','LOS GLADIOLOS 9885',4,3,0],
[-33.390279,-70.532877,'LG1-05 - LG 9885','LOS GLADIOLOS 9805',4,3,0],
[-33.389779,-70.533631,'LG1-07 - LG 9805','QUEPE 410',4,3,0],
[-33.389779,-70.533631,'LG1-08 - Q 433','QUEPE 410',4,3,0],
[-33.390497,-70.533115,'LG1-09 - Q 433','LOS GLADIOLOS 9763',4,3,0],
[-33.390778,-70.533428,'LG1-11 - LG 9763','LOS GLADIOLOS 9716',4,3,0],
[-33.390778,-70.533428,'LG1-12 - LG 9595','LOS GLADIOLOS 9716',4,3,0],
[-33.390758,-70.53349,'LG1-17 - H 386','LOS GLADIOLOS 9716',4,3,0],
[-33.391276,-70.533934,'LG1-18 - LG 9619','LOS GLADIOLOS 9619',4,3,0],
[-33.389974,-70.53262,'LG2-10 - Q 394','LOS GLADIOLOS 9861',4,3,0],
[-33.38929,-70.534331,'LG2-13 - LG 9595','PAUL HARRIS QUEPE',4,3,0],
[-33.39015,-70.534345,'LG2-14 - LG 9716','HUENTELAUQUEN 410',4,3,0],
[-33.39015,-70.534345,'LG2-15 - H 421','HUENTELAUQUEN 410',4,3,0],
[-33.389673,-70.535018,'LG2-16 - H 421','PAUL HARRIS HUENTELAUQUEN',4,3,0],
[-33.391317,-70.533955,'LG2-19 - M 511','MARBERIA 511',4,3,0],
[-33.391317,-70.533955,'LG2-20 - M 511','MARBERIA 511',4,3,0],
[-33.39079,-70.534701,'LG2-21 - M 433','MARBERIA 433',4,3,0],
[-33.39079,-70.534701,'LG2-22 - M 433','MARBERIA 433',4,3,0],
[-33.39012,-70.535617,'LG2-23 - M 361','PAUL HARRIS MARBERIA',4,3,0],
[-33.393223,-70.507113,'CSJ-01-PTZ - CSJ 12350','CUMBRE SAN JUAN 12350',0,1,0],
[-33.393223,-70.507113,'CSJ-02 - CSJ 12350','CUMBRE SAN JUAN 12350',0,3,0],
[-33.393223,-70.507113,'CSJ-03 - CSJ 12350','CUMBRE SAN JUAN 12350',0,3,0],
[-33.39324,-70.506804,'CSJ-04 - CSJ 12415','CUMBRE SAN JUAN 12415',0,3,0],
[-33.393625,-70.507064,'CSJ-05 - CSJ 12408','CUMBRE SAN JUAN 12408',0,3,0],
[-33.393625,-70.507064,'CSJ-06 - CSJ 12408','CUMBRE SAN JUAN 12408',0,3,0],
[-33.394005,-70.506323,'CSJ-07 - CSJ 12485','CUMBRE SAN JUAN 12485',0,3,0],
[-33.393645,-70.50595,'CSJ-08 - CSJ 12490','CUMBRE SAN JUAN 12490',0,3,0],
[-33.393645,-70.50595,'CSJ-09 - CSJ 12490','CUMBRE SAN JUAN 12490',0,3,0],
[-33.393645,-70.50595,'CSJ-10 - CSJ 12490','CUMBRE SAN JUAN 12490',0,3,0],
[-33.39324,-70.506804,'CSJ-11 - CSJ 12415','CUMBRE SAN JUAN 12415',0,3,0],
[-33.39324,-70.506804,'CSJ-12 - CSJ 12415','CUMBRE SAN JUAN 12415',0,3,0],
[-33.399393,-70.51017,'CLH-01 - SCDA 12212','SAN CARLOS DE APOQUINDO 12212',0,3,0],
[-33.399393,-70.51017,'CLH-02 - SCDA 12212','SAN CARLOS DE APOQUINDO 12212',0,3,0],
[-33.399098,-70.510554,'CLH-03 - CDLH 12298','CAMINO DE LAS HOJAS 12298',0,3,0],
[-33.399098,-70.510554,'CLH-04 - CDLH 12298','CAMINO DE LAS HOJAS 12298',0,3,0],
[-33.399084,-70.511045,'CLH-05 - CDLH 12233','CAMINO DE LAS HOJAS 12233',0,3,0],
[-33.399084,-70.511045,'CLH-06 - CDLH 12233','CAMINO DE LAS HOJAS 12233',0,3,0],
[-33.399084,-70.511045,'CLH-07 - CDLH 12233','CAMINO DE LAS HOJAS 12233',0,3,0],
[-33.399256,-70.511468,'CLH-08 - CDLH 12151','CAMINO DE LAS HOJAS 12151',0,3,0],
[-33.399256,-70.511468,'CLH-09 - CDLH 12151','CAMINO DE LAS HOJAS 12151',0,3,0],
[-33.39934,-70.511447,'CLH-10 - CDLH 12151','CAMINO DE LAS HOJAS 12151',0,3,0],
[-33.399422,-70.511768,'CLH-11 - CDLH 12145','CAMINO DE LAS HOJAS 12145',0,3,0],
[-33.399412,-70.512074,'CLH-12 - CP 1490','CERRO PINTOR 1490',0,3,0],
[-33.399412,-70.512074,'CLH-13 - CP 1490','CERRO PINTOR 1490',0,3,0],
[-33.420973,-70.545116,'CCT-01 - ADC 8607','ALONSO DE CAMARGO 8607',3,3,0],
[-33.420973,-70.545116,'CCT-02 - ADC 8607','ALONSO DE CAMARGO 8607',3,3,0],
[-33.421033,-70.545705,'CCT-03 - ADC 8591','ALONSO DE CAMARGO 8591',3,3,0],
[-33.421033,-70.545705,'CCT-04 - ADC 8591','ALONSO DE CAMARGO 8591',3,3,0],
[-33.420543,-70.545785,'CCT-05 - CC 1229','CHIU CHIU 1229',3,3,0],
[-33.420313,-70.545748,'CCT-06 - CC 1207','CHIU CHIU 1207',3,3,0],
[-33.419983,-70.545809,'CCT-07 - CC 1179','CHIU CHIU 1179',3,3,0],
[-33.419983,-70.545809,'CCT-08 - CC 1179','CHIU CHIU 1179',3,3,0],
[-33.419572,-70.54583,'CCT-09 - CC 1164','CHIU CHIU 1164',3,3,0],
[-33.419487,-70.545783,'CCT-10 - Z 8580','ZARAGOZA 8580',3,3,0],
[-33.419527,-70.545124,'CCT-11 - T 1208','TOCONAO 1208',3,3,0],
[-33.420021,-70.545108,'CCT-12 - T 1208','TOCONAO 1208',3,3,0],
[-33.421033,-70.545705,'CCT-13 - ADC 8591','ALONSO DE CAMARGO 8591',3,3,0],
[-33.39023,-70.529788,'LC-01 - LC 10123','LOS CARPINTEROS 10123',4,3,0],
[-33.389731,-70.530339,'LC-02 - LC 10176','LOS CARPINTEROS 10176',4,3,0],
[-33.389731,-70.530339,'LC-03 - LC 10176','LOS CARPINTEROS 10176',4,3,0],
[-33.389696,-70.530396,'LC-04-PTZ - LC 10132','LOS CARPINTEROS 10132',4,1,0],
[-33.407191,-70.535608,'LEGB-01 - GB 9395','GENERAL BLANCHE 9395',0,3,0],
[-33.40776,-70.535354,'LEGB-02 - LE 379','LA ESCUELA 379',0,3,0],
[-33.407658,-70.535216,'LEGB-03 - LE 374','LA ESCUELA 374',0,3,0],
[-33.407658,-70.535216,'LEGB-04 - LE 374','LA ESCUELA 374',0,3,0],
[-33.408405,-70.534912,'LEGB-05 - LE 442','LA ESCUELA 442',0,3,0],
[-33.408405,-70.534912,'LEGB-06 - LE 442','LA ESCUELA 442',0,3,0],
[-33.408886,-70.53492,'LEGB-07 - LE 475','LA ESCUELA 475',0,3,0],
[-33.388783,-70.503802,'SB-01 - SB 12295','SAN BENITO 12295',0,3,0],
[-33.388058,-70.504297,'SB-02 - SB 12222','SAN BENITO 12222',0,3,0],
[-33.388122,-70.504565,'SB-03 - SB 12196','SAN BENITO 12196',0,3,0],
[-33.387741,-70.504928,'SB-04 - SB 12154','SAN BENITO 12154',0,3,0],
[-33.387741,-70.504928,'SB-05 - SB 12154','SAN BENITO 12154',0,3,0],
[-33.387409,-70.505304,'SB-06 - SB 12150','San Benito 12150',0,3,0],
[-33.387608,-70.505664,'SB-07 - EC 803','EL CONVENTO 803',0,3,0],
[-33.38803,-70.50519,'SB-08-PTZ - EO 12161','EL OBISPO 12161',0,1,0],
[-33.388295,-70.504738,'SB-09 - EO - 12195','EL OBISPO 12195',0,3,0],
[-33.388469,-70.504848,'SB-10 - EM 821','EL MONASTERIO 821',0,3,0],
[-33.388917,-70.505406,'SB-11 - EM 838','EL MONASTERIO 838',0,3,0],
[-33.388578,-70.504847,'SB-12 - EM 826','EL MONASTERIO 826',0,3,0],
[-33.388397,-70.504493,'SB-13 - EM 814','EL MONASTERIO 814',0,3,0],
[-33.413754,-70.531416,'CLV-01-PTZ - LV 934','LOMA VERDE 934',0,1,0],
[-33.413754,-70.531416,'CLV-02 - LV 934','LOMA VERDE 934',0,3,0],
[-33.413328,-70.53151,'CLV-03 - LV 929','LOMA VERDE 929',0,3,0],
[-33.413109,-70.531569,'CLV-04 - LV 926','LOMA VERDE 926',0,3,0],
[-33.413109,-70.531569,'CLV-05 - LV 926','LOMA VERDE 926',0,3,0],
[-33.412328,-70.532126,'CLV-06 - LV 912','LOMA VERDE 912',0,3,0],
[-33.412328,-70.532126,'CLV-07 - LV 912','LOMA VERDE 912',0,3,0],
[-33.412374,-70.532568,'CLV-08-PTZ - LE 906','LA ESCUELA 906',0,1,0],
[-33.412374,-70.532568,'CLV-09 - LE 906','LA ESCUELA 906',0,3,0],
[-33.39965,-70.568561,'CC-01 - CC 6160','CERRO COLORADO 6160',5,3,0],
[-33.39965,-70.568561,'CC-02 - CC 6160','CERRO COLORADO 6160',5,3,0],
[-33.400034,-70.569333,'CC-03 - CC 6130','CERRO COLORADO 6130',5,3,0],
[-33.400034,-70.569333,'CC-05 - CC 6130','CERRO COLORADO 6130',5,3,0],
[-33.400056,-70.569319,'CC-04 - CC 6130','CERRO COLORADO 6130',5,3,0],
[-33.400056,-70.569319,'CC-06 - CC 6130','CERRO COLORADO 6130',5,3,0],
[-33.400395,-70.570072,'CC-07 - CC 6110','CERRO COLORADO 6110',5,3,0],
[-33.409928,-70.558034,'PIN-01 - AI 286','ARQUITECTO ICTINOS 286',4,3,0],
[-33.409832,-70.55804,'PIN-02 - AI 273','ARQUITECTO ICTINOS 273',4,3,0],
[-33.409832,-70.55804,'PIN-03 - AI 273','ARQUITECTO ICTINOS 273',4,3,0],
[-33.409347,-70.557806,'PIN-04 - AI 245','ARQUITECTO ICTINOS 245',4,3,0],
[-33.409347,-70.557806,'PIN-05 - AI 245','ARQUITECTO ICTINOS 245',4,3,0],
[-33.409009,-70.557646,'PIN-06 - AI 225','ARQUITECTO ICTINOS 225',4,3,0],
[-33.408814,-70.557526,'PIN-07-PTZ - AI 203','ARQUITECTO ICTINOS 203',4,1,0],
[-33.408814,-70.557526,'PIN-08 - AI 203','ARQUITECTO ICTINOS 203',4,3,0],
[-33.390988,-70.520902,'CLFLF-01 - CLF 1158','CAMINO LA FUENTE 1158',0,3,0],
[-33.390973,-70.520827,'CLFLF-02 - CLF 1158','CAMINO LA FUENTE 1158',0,3,0],
[-33.389049,-70.511096,'B-01-PTZ - LM 970','LOS MAITENES 970',0,1,0],
[-33.388937,-70.511084,'B-02 - LM 937','LOS MAITENES 937',0,3,0],
[-33.388422,-70.511982,'B-03 - B 11882','BEURON 11882',0,3,0],
[-33.388422,-70.511982,'B-04 - B 11882','BEURON 11882',0,3,0],
[-33.38795,-70.512999,'B-05 - B 11821','BEURON 11821',0,3,0],
[-33.38795,-70.512999,'B-06 - B 11821','BEURON 11821',0,3,0],
[-33.387845,-70.513236,'B-07-PTZ - FBC 912','FRANCISCO BULNES CORREA 912',0,1,0],
[-33.390245,-70.50935,'EC-01 - EC 994','EL CAMPANIL 994',0,3,0],
[-33.389796,-70.509045,'EC-02 - EC 980','EL CAMPANIL 980',0,3,0],
[-33.389796,-70.509045,'EC-03 - EC 980','EL CAMPANIL 980',0,3,0],
[-33.3895,-70.508843,'EC-04 - EC 950','EL CAMPANIL 950',0,3,0],
[-33.3895,-70.508843,'EC-05 - EC 950','EL CAMPANIL 950',0,3,0],
[-33.389172,-70.508627,'EC-06 - EC 926','EL CAMPANIL 926',0,3,0],
[-33.389172,-70.508627,'EC-07 - EC 926','EL CAMPANIL 926',0,3,0],
[-33.388799,-70.508379,'EC-08 - LM 12060','LOS MONJES 12060',0,3,0],
[-33.388711,-70.508664,'EC-09 - LM 12042','LOS MONJES 12042',0,3,0],
[-33.391924,-70.530754,'FC-01 - CH 9633','CHARLES HAMILTON 9633',4,3,0],
[-33.392333,-70.531854,'FC-02 - CH 9351','CHARLES HAMILTON 9351',4,3,0],
[-33.39254,-70.532566,'FC-03-PTZ - CH 9307','CHARLES HAMILTON 9307',4,1,0],
[-33.392685,-70.532414,'FC-04 - FPS 925','FRAY PEDRO SUBERCASEUX 925',4,3,0],
[-33.39411,-70.531075,'FC-05 - RLF 1205','ROTONDA LAS FLORES 1205',4,3,0],
[-33.42344,-70.540735,'T-01 - T A','TOCONCE & ASCOTAN',3,3,0],
[-33.42344,-70.540735,'T-02 - T A','TOCONCE & ASCOTAN',3,3,0],
[-33.42344,-70.540735,'T-03 - T A','TOCONCE & ASCOTAN',3,3,0],
[-33.422847,-70.540798,'T-04 - T 1520','TOCONCE 1530',3,3,0],
[-33.422847,-70.540798,'T-05 - T 1520','TOCONCE 1530',3,3,0],
[-33.4224,-70.540813,'T-06 -PTZ - T 1501','TOCONCE 1481',3,1,0],
[-33.422288,-70.540765,'T-07 - T 1496','TOCONCE & ROBERTO GUZMAN',3,3,0],
[-33.422627,-70.54078,'T-08 - T RG','TOCONCE 1501',3,3,0],
[-33.422228,-70.54034,'T-09 - PTZ - RG 1439','ROBERTO GUZMAN 8885',3,1,0],
[-33.40464,-70.540375,'CI-01 - I 9154','ISLANDIA 9154',4,3,0],
[-33.404894,-70.541645,'CI-02 - I 9116','ISLANDIA 9116',4,3,0],
[-33.404781,-70.541101,'CI-03-PTZ - I 9127','ISLANDIA 9127',4,1,0],
[-33.404304,-70.54127,'CI-04 - C 1360','CANTERBURY 1360',4,3,0],
[-33.404304,-70.54127,'CI-05 - C 1360','CANTERBURY 1360',4,3,0],
[-33.403969,-70.541374,'CI-06 - C 1343','CARTERBURY 1343',4,3,0],
[-33.403969,-70.541374,'CI-07 - C 1343','CARTERBURY 1343',4,3,0],
[-33.403592,-70.541497,'CI-08 - C 1221','CANTERBURY 1221',4,3,0],
[-33.403592,-70.541497,'CI-09 - C 1221','CANTERBURY 1221',4,3,0],
[-33.410775,-70.533063,'LML3-01 - LML 732','LUIS MATTE LARRAIN 764',0,3,0],
[-33.410326,-70.5336,'LML3-02 - LML 680','LUIS MATTE LARRAIN 680',0,3,0],
[-33.410326,-70.5336,'LML3-03-PTZ - LML 680','LUIS MATTE LARRAIN 680',0,1,0],
[-33.410099,-70.533447,'LML3-04 - LML 657','LUIS MATTE LARRAIN 657',0,3,0],
[-33.410099,-70.533447,'LML3-05 - LML 657','LUIS MATTE LARRAIN 657',0,3,0],
[-33.409623,-70.533632,'LML3-06 - LML 621','LUIS MATTE LARRAIN 621',0,3,0],
[-33.408695,-70.533985,'LML3-07 - LML 496','LUIS MATTE LARRAIN 9880',0,3,0],
[-33.403076,-70.50994,'SA-01 - SA 2266','SANTOS APOSTOLES 2266',0,3,0],
[-33.404961,-70.50929,'SA-02 - SA 2416','SANTOS APOSTOLES 2416',0,3,0],
[-33.404961,-70.50929,'SA-03 - SA 2416','SANTOS APOSTOLES 2416',0,3,0],
[-33.406308,-70.508797,'SA-04 - SA 2542','SANTOS APOSTOLES 2542',0,3,0],
[-33.403352,-70.519332,'O-01 - GB 1598','GENERAL BLANCHE 1598',0,3,0],
[-33.40373,-70.51927,'O-02 - CO 1801','CAMINO OTOÑAL 1801',0,3,0],
[-33.404472,-70.519085,'O-03 - CO 1902','CAMINO OTOÑAL 1902',0,3,0],
[-33.40447,-70.51908,'O-04 - CO 1902','CAMINO OTOÑAL 1902',0,3,0],
[-33.40516,-70.51882,'O-05-PTZ - CO 1958','CAMINO OTOÑAL 1958',0,1,0],
[-33.405586,-70.518617,'O-06 - CO 2046','CAMINO OTOÑAL 2046',0,3,0],
[-33.405586,-70.518617,'O-07 - CO 2046','CAMINO OTOÑAL 2046',0,3,0],
[-33.406121,-70.518273,'O-08 - CO 2595','CAMINO OTOÑAL 2595',0,3,0],
[-33.406551,-70.518004,'O-09 - CO 2881','CAMINO OTOÑAL 2881',0,3,0],
[-33.421729,-70.594829,'MU-01 - U 547','Unamuno 547',5,3,0],
[-33.421815,-70.594728,'MU-02 - U 550','Unamuno 550',5,3,0],
[-33.421941,-70.594563,'MU-03 - U 560','Unamuno 560',5,3,0],
[-33.422211,-70.594213,'MU-04 - U 607','Unamuno 607',5,3,0],
[-33.422211,-70.594213,'MU-05 - U 607','Unamuno 607',5,3,0],
[-33.422645,-70.593641,'MU-06 - U 691','Unamuno 691',5,3,0],
[-33.42299,-70.593162,'MU-07 - U 779','Unamuno 779',5,3,0],
[-33.42299,-70.593162,'MU-08 - U 779','Unamuno 779',5,3,0],
[-33.422751,-70.594144,'MU-09 - M 2956','Marne 2956',5,3,0],
[-33.422751,-70.594144,'MU-10 - M 2956','Marne 2956',5,3,0],
[-33.422388,-70.593732,'MU-11 - M 3031','Marne 3031',5,3,0],
[-33.422138,-70.593463,'MU-12 - M 3172','Marne 3172',5,3,0],
[-33.422138,-70.593463,'MU-13 - M 3172','Marne 3172',5,3,0],
[-33.421836,-70.593169,'MU-14 - SC 585','San Crescente 585',5,3,0],
[-33.423479,-70.592556,'MU-15 - U 853','Unamuno 853',5,3,0],
[-33.423479,-70.592556,'MU-16 - U 853','Unamuno 853',5,3,0],
[-33.381614,-70.517817,'BEN-01-PTZ - CLV 11933','CAMINO LA VIÑA 11933',0,1,0],
[-33.381657,-70.51777,'BEN-02 - CFJ 765','CAMINO FRAY JORGE 765',0,3,0],
[-33.381657,-70.51777,'BEN-03 - CFJ 765','CAMINO FRAY JORGE 765',0,3,0],
[-33.382285,-70.517268,'BEN-04-PTZ - CFJ 777','CAMINO FRAY JORGE 777',0,1,0],
[-33.382376,-70.517199,'BEN-05 - CFJ 798','CAMINO FRAY JORGE 798',0,3,0],
[-33.382376,-70.517199,'BEN-06 - CFJ 798','CAMINO FRAY JORGE 798',0,3,0],
[-33.382653,-70.516991,'BEN-07 - CFJ 807','CAMINO FRAY JORGE 807',0,3,0],
[-33.377158,-70.516457,'FBA-01 - FB 12236','FRAY BERNARDO 12236',0,3,0],
[-33.377158,-70.516457,'FBA-02 - FB 12236','FRAY BERNARDO 12236',0,3,0],
[-33.377538,-70.517135,'FBA-03 - FB 12195','FRAY BERNARDO 12195',0,3,0],
[-33.377538,-70.517135,'FBA-04 - FB 12200','FRAY BERNARDO 12200',0,3,0],
[-33.377457,-70.517016,'FBA-05 - FB 12120','FRAY BERNARDO 12120',0,3,0],
[-33.377457,-70.517016,'FBA-06 - FB 12120','FRAY BERNARDO 12120',0,3,0],
[-33.377606,-70.517351,'FBA-07-PTZ - FB 12109','FRAY BERNARDO 12109',0,1,0],
[-33.377333,-70.516811,'FBB-01 - FB 11958','FRAY BERBARDO 11958',0,3,0],
[-33.377333,-70.516811,'FBB-02 - FB 11958','FRAY BERBARDO 11958',0,3,0],
[-33.378301,-70.51888,'FBB-03 - FB 11854','FRAY BERBARDO 11854',0,3,0],
[-33.378301,-70.51888,'FBB-04 - FB 11854','FRAY BERBARDO 11854',0,3,0],
[-33.37814,-70.50718,'CSA-01 - CSA 1026','CAMINO SAN ANTONIO 1026',0,3,0],
[-33.37814,-70.50718,'CSA-02 - CSA 1026','CAMINO SAN ANTONIO 1026',0,3,0],
[-33.37702,-70.50778,'CSA-03-PTZ - CSA 910','CAMINO SAN ANTONIO 910',0,1,0],
[-33.37702,-70.50778,'CSA-04 - CSA 910','CAMINO SAN ANTONIO 910',0,3,0],
[-33.376524,-70.50815,'CSA-05 - CSA 821','CAMINO SAN ANTONIO 821',0,3,0],
[-33.376203,-70.508436,'CSA-06 - CSA 782','CAMINO SAN ANTONIO 782',0,3,0],
[-33.376085,-70.508573,'CSA-07 - CSA 782','CAMINO SAN ANTONIO 782',0,3,0],
[-33.395612,-70.541096,'CNN-01 - CN 470','CARDENAL NEWMAN 470',4,3,0],
[-33.395561,-70.541145,'CNN-02 - CN 470','CARDENAL NEWMAN 470',4,3,0],
[-33.394254,-70.540768,'CNN-03 - CN 394','CARDENAL NEWMAN 394',4,3,0],
[-33.394051,-70.541652,'CNN-04 - D 9136','DUNKERQUE 9136',4,3,0],
[-33.396678,-70.541083,'CNS-01 - CN 507','CARDENAL NEWMAN 507',4,3,0],
[-33.396678,-70.541083,'CNS-02 - CN 507','CARDENAL NEWMAN 507',4,3,0],
[-33.397513,-70.541119,'CNS-03-PTZ - CN 536','CARDENAL NEWMAN 536',4,1,0],
[-33.398592,-70.541134,'CNS-04 - CN 576','CARDENAL NEWMAN 576',4,3,0],
[-33.398592,-70.541134,'CNS-05 - CN 576','CARDENAL NEWMAN 576',4,3,0],
[-33.410742,-70.5987,'CSL-01 - LP 2991','LAS PENAS 2991',5,3,0],
[-33.411047,-70.597371,'CSL-02 - LP 3114','LAS PENAS 3114 C',5,3,0],
[-33.411047,-70.597371,'CSL-03 - LP 3114','LAS PENAS 3114 C',5,3,0],
[-33.411445,-70.596287,'CSL-04 - LP 3297','LAS PEÑAS 3297',5,3,0],
[-33.411445,-70.596287,'CSL-05 - LP 3297','LAS PEÑAS 3297',5,3,0],
[-33.41144,-70.598399,'CSL-06 - CDA 3051','CRISTAL DE ABELLI 3051',5,3,0],
[-33.41144,-70.598399,'CSL-07 - CDA 3051','CRISTAL DE ABELLI 3051',5,3,0],
[-33.41352,-70.528766,'CP-01 - CPO 9702','Carlos Peña Otagui 9702',0,3,0],
[-33.413642,-70.528827,'CP-02 - CP 921','Colina del Peumo 921',0,3,0],
[-33.414141,-70.528748,'CP-03 - CP 927','Colina del Peumo 927',0,3,0],
[-33.414402,-70.528688,'CP-04-PTZ - CP 935','Colina del Peumo 935',0,1,0],
[-33.414402,-70.528688,'CP-05 - CP 935','Colina del Peumo 935',0,3,0],
[-33.414533,-70.528662,'CP-06 - CP 937','Colina del Peumo 937',0,3,0],
[-33.414533,-70.528662,'CP-07 - CP 937','Colina del Peumo 937',0,3,0],
[-33.414416,-70.528432,'CP-08 - CP 951','Colina del Peumo 951',0,3,0],
[-33.414363,-70.528006,'CP-09-PTZ - CP 956','Colina del Peumo 956',0,1,0],
[-33.414363,-70.528006,'CP-10 - CP 956','Colina del Peumo 956',0,3,0],
[-33.414374,-70.527713,'CP-11 - CP 968','Colina del Peumo 968',0,3,0],
[-33.414374,-70.527713,'CP-12 - CP 968','Colina del Peumo 968',0,3,0],
[-33.41448,-70.527266,'CP-13 - CP 974','Colina del Peumo 974',0,3,0],
[-33.41448,-70.527266,'CP-14 - CP 974','Colina del Peumo 974',0,3,0],
[-33.414544,-70.52698,'CP-15 - CP 978','Colina del Peumo 978',0,3,0],
[-33.414485,-70.526958,'CP-16 - CP 981','Colina del Peumo 981',0,3,0],
[-33.380287,-70.524857,'VF-01 - FL 11335','FRAY LEON 11335',0,3,0],
[-33.380904,-70.526131,'VF-02 - FL 11200','FRAY LEON 11200',0,3,0],
[-33.380904,-70.526131,'VF-05 - FL 11200','FRAY LEON 11200',0,3,0],
[-33.381467,-70.527558,'VF-03 - FL 11140','FRAY LEON 11140',0,3,0],
[-33.381039,-70.527558,'VF-04 - FL 11180','FRAY LEON 11180',0,3,0],
[-33.381775,-70.52578,'VF-06 - VA 430','VALLE ALEGRE 430',0,3,0],
[-33.381775,-70.52578,'VF-07 - VA 430','VALLE ALEGRE 430',0,3,0],
[-33.382056,-70.526353,'VF-08 - VA 505','VALLE ALEGRE 505',0,3,0],
[-33.381857,-70.525963,'VF-09 - VA 505','VALLE ALEGRE 505',0,3,0],
[-33.382134,-70.525564,'VF-10 - VA 445','VALLE ALEGRE 445',0,3,0],
[-33.376052,-70.515586,'LCS-09 - CSFDA 387','CAMINO SAN FRANCISCO DE ASIS 387',0,3,0],
[-33.374421,-70.511138,'LCN-01 - FM 12853','FRAY MARTIN 12853',0,3,0],
[-33.37385,-70.511349,'LCN-02-PTZ - LC 316','LA CABAÑA 316',0,1,0],
[-33.372892,-70.511883,'LCN-03 - LC 270','LA CABAÑA 270',0,3,0],
[-33.372892,-70.511883,'LCN-04 - LC 270','LA CABAÑA 270',0,3,0],
[-33.376161,-70.510442,'LCS-01 - CLP 12866','CAMINO LA POSADA 12866',0,3,0],
[-33.376074,-70.510167,'LCS-02 - CLP 12889','CAMINO LA POSADA 12889',0,3,0],
[-33.375553,-70.510364,'LCS-03 - LC 606','LA CABAÑA 606',0,3,0],
[-33.375553,-70.510364,'LCS-04 - LC 606','LA CABAÑA 606',0,3,0],
[-33.375193,-70.510603,'LCS-05 - LC 606','LA CABAÑA 606',0,3,0],
[-33.375802,-70.512199,'LCS-06 - FB 12702','FRAY BERNARDO 12702',0,3,0],
[-33.375802,-70.512199,'LCS-07 - FB 12702','FRAY BERNARDO 12702',0,3,0],
[-33.375699,-70.512456,'LCS-08 - FG 483','FRAY GABRIEL 483',0,3,0],
[-33.412614,-70.527987,'CMIR-01-PTZ - CM 9721','COLINA MIRAVALLE 9721',0,1,0],
[-33.412685,-70.526491,'CMIR-02 - CM 9783','COLINA MIRAVALLE 9783',0,3,0],
[-33.412685,-70.526491,'CMIR-03 - CM 9783','COLINA MIRAVALLE 9783',0,3,0],
[-33.411286,-70.52566,'CMIR-04 - CM 9881','COLINA MIRAVALLE 9881',0,3,0],
[-33.412694,-70.526511,'CMIR-05 - CM 9783','COLINA MIRAVALLE 9783',0,3,0],
[-33.408207,-70.516901,'ECV-01 - CO 2490','CAMINO OTOÑAL 2490',0,3,0],
[-33.408207,-70.516901,'ECV-05 - CO 2490','CAMINO OTOÑAL 2490',0,3,0],
[-33.408682,-70.516608,'ECV-02-PTZ - CO 2491','CAMINO OTOÑAL 2491',0,1,0],
[-33.407899,-70.517119,'ECV-03 - CO 2396','CAMINO OTOÑAL 2396',0,3,0],
[-33.407899,-70.517119,'ECV-06 - CO 2396','CAMINO OTOÑAL 2396',0,3,0],
[-33.40884,-70.516518,'ECV-04 - CO 2510','CAMINO OTOÑAL 2510',0,3,0],
[-33.408515,-70.516056,'ECV-07 - EC 11695','EL CORRALERO 11695',0,3,0],
[-33.408515,-70.516056,'ECV-09 - EC 11695','EL CORRALERO 11695',0,3,0],
[-33.408199,-70.515345,'ECV-08 - EC 11797','EL CORRALERO 11797',0,3,0],
[-33.407877,-70.515205,'ECV-10 - FBC 2483','FRANCISCO BULNES CORREA 2483',0,3,0],
[-33.408317,-70.514906,'ECV-11-PTZ - FBC 2541','FRANCISCO BULNES CORREA 2541',0,1,0],
[-33.375137,-70.501751,'SJS-01 - SJDLS 780','SAN JOSE DE LA SIERRA 780',0,3,0],
[-33.375578,-70.501535,'SJS-02 - SJDLS 710','SAN JOSE DE LA SIERRA 710',0,3,0],
[-33.375578,-70.501535,'SJS-03 - SJDLS 720','SAN JOSE DE LA SIERRA 720',0,3,0],
[-33.375979,-70.501337,'SJS-04-PTZ - SJDLS 845','SAN JOSE DE LA SIERRA 845',0,1,0],
[-33.376707,-70.500995,'SJS-05 - SJDLS 890','SAN JOSE DE LA SIERRA 890',0,3,0],
[-33.376707,-70.500995,'SJS-06 - SJDLS 890','SAN JOSE DE LA SIERRA 890',0,3,0],
[-33.388524,-70.538776,'DLCM-01 - PAPC 60','PASAJE ARTURO PEREZ CANTO 60',4,3,0],
[-33.388524,-70.538776,'DLCM-02 - PAPC 60','PASAJE ARTURO PEREZ CANTO 60',4,3,0],
[-33.388598,-70.537522,'DLCM-03-PTZ - L 9669','LUXEMBURGO 9669',4,1,0],
[-33.388517,-70.537271,'DLCM-04 - L 9711','LUXEMBURGO 9711',4,3,0],
[-33.388517,-70.537271,'DLCM-05 - L 9711','LUXEMBURGO 9711',4,3,0],
[-33.387748,-70.536388,'DLCM-06 - L 9875','LUXEMBURGO 9875',4,3,0],
[-33.387748,-70.536388,'DLCM-07 - L 9875','LUXEMBURGO 9875',4,3,0],
[-33.387205,-70.535922,'DLCM-08 - L 9910','LUXEMBURGO 9910',4,3,0],
[-33.387205,-70.535922,'DLCM-09 - L 9910','LUXEMBURGO 9910',4,3,0],
[-33.387366,-70.536906,'DLCM-10 - DLCM 9854','DOCTOR LUIS CALVO MACKENNA 9854',4,3,0],
[-33.387884,-70.537567,'DLCM-11 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759',4,3,0],
[-33.387884,-70.537567,'DLCM-12 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759',4,3,0],
[-33.388125,-70.538319,'DLCM-13 - CAMA 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',4,3,0],
[-33.388125,-70.538319,'DLCM-14 - CAMA 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',4,3,0],
[-33.396971,-70.519365,'CEO-01 - CO 1382','CAMINO OTOÑAL 1382',0,3,0],
[-33.39683,-70.519401,'CEO-02 - CO 1390','CAMINO OTOÑAL 1390',0,3,0],
[-33.396971,-70.519415,'CEO-03-PTZ - CO 1382','CAMINO OTOÑAL 1382',0,1,0],
[-33.396531,-70.519312,'CEO-04 - CO 1368','CAMINO OTOÑAL 1368',0,3,0],
[-33.396156,-70.519266,'CEO-05 - CO 1326','CAMINO OTOÑAL 1326',0,3,0],
[-33.422479,-70.584054,'M-01 - M 897','MALAGA 897',5,3,0],
[-33.42226,-70.584059,'M-02 - M 888','MALAGA 888',5,3,0],
[-33.422181,-70.584148,'M-03 - M 859','MALAGA 859',5,3,0],
[-33.422181,-70.584148,'M-04 - M 859','MALAGA 859',5,3,0],
[-33.421382,-70.584424,'M-05 - M 808','MALAGA 808',5,3,0],
[-33.421362,-70.58452,'M-06 - M 782','MALAGA 749',5,3,0],
[-33.421098,-70.5846,'M-07 - M 701','MALAGA 701',5,3,0],
[-33.421098,-70.5846,'M-08 - M 701','MALAGA 701',5,3,0],
[-33.421098,-70.5846,'M-09 - M 701','MALAGA 701',5,3,0],
[-33.420873,-70.5846,'M-10 - M 782','MALAGA 720',5,3,0],
[-33.420631,-70.584838,'M-11-PTZ - M 670','MALAGA 670',5,1,0],
[-33.420553,-70.584856,'M-12 - M 661','MALAGA 661',5,3,0],
[-33.420525,-70.584747,'M-13 - M R','MALAGA & RAPALLO',5,3,0],
[-33.420119,-70.585006,'M-14 - M 557','MALAGA 557',5,3,0],
[-33.420119,-70.585006,'M-15 - M 557','MALAGA 557',5,3,0],
[-33.420068,-70.585046,'M-16 - M 529','MALAGA 529',5,3,0],
[-33.417643,-70.579625,'LS-01 - LS 511','LA SERENA 511',5,3,0],
[-33.417643,-70.579625,'LS-02 - LS 511','LA SERENA 511',5,3,0],
[-33.418432,-70.579079,'LS-03-PTZ - LS 640','LA SERENA 640',5,1,0],
[-33.419347,-70.578373,'LS-04 - LS 841','LA SERENA 841',5,3,0],
[-33.419347,-70.578373,'LS-05 - LS 841','LA SERENA 841',5,3,0],
[-33.415484,-70.581533,'FDA-01 - FDA 218','FELIX DE AMESTI 218',5,3,0],
[-33.415484,-70.581533,'FDA-02 - FDA 218','FELIX DE AMESTI 218',5,3,0],
[-33.415833,-70.581349,'FDA-03 - FDA 255','FELIX DE AMESTI 255',5,3,0],
[-33.415833,-70.581349,'FDA-04 - FDA 255','FELIX DE AMESTI 255',5,3,0],
[-33.416395,-70.581042,'FDA-05-PTZ - FDA 327','FELIZ DE AMESTI 327',5,1,0],
[-33.416395,-70.581042,'FDA-06 - FDA 327','FELIX DE AMESTI 327',5,3,0],
[-33.416395,-70.581042,'FDA-07 - FDA 327','FELIX DE AMESTI 327',5,3,0],
[-33.417041,-70.580692,'FDA-08 - FDA 403','FELIX DE AMESTI 403',5,3,0],
[-33.417111,-70.580654,'FDA-09 - FDA 432','FELIX DE AMESTI 432',5,3,0],
[-33.417382,-70.580504,'FDA-10 - FDA 451','FELIX DE AMESTI 451',5,3,0],
[-33.417615,-70.580364,'FDA-11 - FDA 477','FELIX DE AMESTI 477',5,3,0],
[-33.417616,-70.580352,'FDA-12 - FDA 462','FELIX DE AMESTI 462',5,3,0],
[-33.409896,-70.565237,'LM-01 - LM 6255','LOS MILAGROS 6255',4,3,0],
[-33.409962,-70.565387,'LM-02 - LM 6255','LOS MILAGROS 6255',4,3,0],
[-33.410076,-70.565845,'LM-03 - LM 6231','LOS MILAGROS 6231',4,3,0],
[-33.410076,-70.565845,'LM-04 - LM 6231','LOS MILAGROS 6231',4,3,0],
[-33.4102,-70.566337,'LM-05 - LM 6206','LOS MILAGROS 6206',4,3,0],
[-33.421424,-70.548203,'GS-01 - G 1251','GUADARRAMA 1251',3,3,0],
[-33.421717,-70.547915,'GS-02 - G 1264','GUADARRAMA 1264',3,3,0],
[-33.42183,-70.547832,'GS-03 - G EP','GUADARRAMA & EL PASTOR',3,3,0],
[-33.421905,-70.547765,'GS-04 - G 1272','GUADARRAMA 1272',3,3,0],
[-33.422228,-70.547562,'GS-05-PTZ - G 1287','GUADARRAMA 1287',3,1,0],
[-33.422246,-70.547469,'GS-06 - G EO','GUADARRAMA & EL OVEJERO',3,3,0],
[-33.422449,-70.547259,'GS-07 - G 1295','GUADARRAMA 1295',3,3,0],
[-33.422532,-70.547242,'GS-08 - G 1299','GUADARRAMA 1299',3,3,0],
[-33.422535,-70.547161,'GS-09 - G 1304','GUADARRAMA 1304',3,3,0],
[-33.422742,-70.54704,'GS-10 - G 1315','GUADARRAMA 1315',3,3,0],
[-33.422762,-70.54694,'GS-11 - G 1316','GUADARRAMA 1316',3,3,0],
[-33.422907,-70.546451,'GS-12 - G 1324','GUADARRAMA 1324',3,3,0],
[-33.421641,-70.546345,'GS-13 - EP FO','EL PASTOR & FUENTE OVEJUNA',3,3,0],
[-33.422191,-70.547492,'GS-14 - G EO','GUADARRAMA & EL OVEJERO',3,3,0],
[-33.42212,-70.546345,'GS-15 - EO 8036','EL OVEJERO 8036',3,3,0],
[-33.422095,-70.546685,'GS-16 - EO FO','EL OVEJERO & FUENTE OVEJUNA',3,3,0],
[-33.398593,-70.545355,'E-01 - ME 553','MARÍA ESTUARDO 553',4,3,0],
[-33.399136,-70.545348,'E-02 - E 572','ESCOCIA 572',4,3,0],
[-33.399484,-70.545352,'E-03 - E 598','ESCOCIA 598',4,3,0],
[-33.399484,-70.545352,'E-04 - E 598','ESCOCIA 598',4,3,0],
[-33.399878,-70.545343,'E-05 - E 614','ESCOCIA 614',4,3,0],
[-33.399878,-70.545343,'E-06-PTZ - E 614','ESCOCIA 614',4,1,0],
[-33.400353,-70.545332,'E-07 - E 635','ESCOCIA 635',4,3,0],
[-33.400353,-70.545332,'E-08 - E 635','ESCOCIA 635',4,3,0],
[-33.401025,-70.545323,'E-09 - E 659','ESCOCIA 659',4,3,0],
[-33.427434,-70.544007,'ET-01 - MCV ET','MANUEL CLARO VIAL & EL TATIO',3,3,0],
[-33.427372,-70.541448,'ET-02 - ET 1843','EL TATIO 1843',3,3,0],
[-33.426963,-70.541483,'ET-03 - ET 1842','El TATIO 1842',3,3,0],
[-33.426963,-70.541483,'ET-04 - ET 1842','El TATIO 1842',3,3,0],
[-33.426751,-70.541535,'ET-05 - ET 1818','EL TATIO 1818',3,3,0],
[-33.426751,-70.541535,'ET-06 - ET 1818','EL TATIO 1818',3,3,0],
[-33.426597,-70.541557,'ET-07 - ET 1791','EL TATIO 1791',3,3,0],
[-33.426439,-70.541557,'ET-08 - ET 1786','El TATIO 1786',3,3,0],
[-33.426439,-70.541557,'ET-09 - ET 1786','El TATIO 1786',3,3,0],
[-33.42611,-70.541636,'ET-10-PTZ - ET 1781','EL TATIO 1781',3,1,0],
[-33.425989,-70.541651,'ET-11 - R 8769','RUPANCO 8769',3,3,0],
[-33.425989,-70.541651,'ET-12 - R 8769','RUPANCO 8769',3,3,0],
[-33.425969,-70.541051,'ET-13 - R A','RUPANCO & AYQUINA',3,3,0],
[-33.425969,-70.541051,'ET-14 - R 8828','RUPANCO 8828',3,3,0],
[-33.425569,-70.541705,'ET-15 - ET 1735','El TATIO 1735',3,3,0],
[-33.367825,-70.498687,'AMF-01 - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272',0,3,0],
[-33.367825,-70.498687,'AMF-02-PTZ - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272',0,1,0],
[-33.367625,-70.497944,'AMF-03 - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377',0,3,0],
[-33.367625,-70.497944,'AMF-04 - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377',0,3,0],
[-33.366998,-70.497437,'AMF-05 - CAF 14420','CAMINO A FARELLONES 14420',0,3,0],
[-33.37923,-70.50768,'FM-01-PTZ - CH 12920','CHARLES HAMILTON 12920',0,1,0],
[-33.379097,-70.507814,'FM-02 - FM 1088','FERNANDEZ MIRA 1088',0,3,0],
[-33.378865,-70.507925,'FM-03 - FM 1061','FERNANDEZ MIRA 1061',0,3,0],
[-33.378385,-70.508212,'FM-04 - FM 1005','FERNANDEZ MIRA 1005',0,3,0],
[-33.378385,-70.508212,'FM-05 - FM 1005','FERNANDEZ MIRA 1005',0,3,0],
[-33.377824,-70.50855,'FM-06 - FM 958','FERNANDEZ MIRA 958',0,3,0],
[-33.377824,-70.50855,'FM-07 - FM 958','FERNANDEZ MIRA 958',0,3,0],
[-33.377289,-70.508838,'FM-08 - FM 865','FERNANDEZ MIRA 865',0,3,0],
[-33.377289,-70.508838,'FM-09 - FM 865','FERNANDEZ MIRA 865',0,3,0],
[-33.404413,-70.525435,'CMQH-01 - CM 2099','CAMINO MIRASOL 2099',0,3,0],
[-33.404413,-70.525435,'CMQH-02 - CM 2099','CAMINO MIRASOL 2099',0,3,0],
[-33.405802,-70.524458,'CMQH-03 - CM 2315','CAMINO MIRASOL 2315',0,3,0],
[-33.405802,-70.524458,'CMQH-04 - CM 2315','CAMINO MIRASOL 2315',0,3,0],
[-33.408363,-70.522687,'CMQH-05 - QH 9990','QUEBRADA HONDA 9990',0,3,0],
[-33.408363,-70.522687,'CMQH-06 - QH 9990','QUEBRADA HONDA 9990',0,3,0],
[-33.407512,-70.523279,'CMQH-07 - CM 2511','CAMINO MIRASOL 2511',0,3,0],
[-33.407512,-70.523279,'CMQH-08 - CM 2511','CAMINO MIRASOL 2511',0,3,0],
[-33.403389,-70.522694,'CLFQH-01-PTZ - GB CLF','GENERAL BLANCHE - CAMINO LA FUENTE',0,1,0],
[-33.404189,-70.522627,'CLFQH-02 - CLF 1917','CAMINO LA FUENTE 1917',0,3,0],
[-33.404189,-70.522627,'CLFQH-03 - CLF 1917','CAMINO LA FUENTE 1917',0,3,0],
[-33.405284,-70.521906,'CLFQH-04 - CLF 2041','CAMINO LA FUENTE 2041',0,3,0],
[-33.405284,-70.521906,'CLFQH-05 - CLF 2041','CAMINO LA FUENTE 2041',0,3,0],
[-33.405793,-70.521543,'CLFQH-06-PTZ - CLF 2117','CAMINO LA FUENTE 2117',0,1,0],
[-33.406887,-70.520762,'CLFQH-07 - CLF 2237','CAMINO LA FUENTE 2237',0,3,0],
[-33.406887,-70.520762,'CLFQH-08 - CLF 2237','CAMINO LA FUENTE 2237',0,3,0],
[-33.407099,-70.520627,'CLFQH-09-PTZ - CLF 2259','CAMINO LA FUENTE 2259',0,1,0],
[-33.385556,-70.503398,'ECM-01 - EC 629','EL CONVENTO 629',0,3,0],
[-33.385556,-70.503398,'ECM-02 - EC 629','EL CONVENTO 629',0,3,0],
[-33.385297,-70.503686,'ECM-03 - EC 619','EL CONVENTO 619',0,3,0],
[-33.386495,-70.504913,'ECM-04 - EC 619','EL CONVENTO 619',0,3,0],
[-33.386413,-70.50434,'ECM-05 - EC 715','EL CONVENTO 715',0,3,0],
[-33.386413,-70.50434,'ECM-06 - EC 715','EL CONVENTO 715',0,3,0],
[-33.38685,-70.504815,'ECM-07 - EC 759','EL CONVENTO 759',0,3,0],
[-33.385706,-70.503446,'ECM-08 - AQ 1603','AGUA QUIETA 1603',0,3,0],
[-33.394162,-70.514541,'LF-01 - LF CLS','LOS FALDEOS & CERRO CATEDRAL SUR',0,3,0],
[-33.393664,-70.514366,'LF-02 - LF 1149','LOS FALDEOS 1149',0,3,0],
[-33.393024,-70.514119,'LF-03 - LF 1149','LOS FALDEOS 1149',0,3,0],
[-33.392032,-70.513706,'LF-04 - LF 1169','LOS FALDEOS 1169',0,3,0],
[-33.392032,-70.513706,'LF-05 - LF 1215','LOS FALDEOS 1215',0,3,0],
[-33.393024,-70.514119,'LF-06 - LF 1227','LOS FALDEOS 1227',0,3,0],
[-33.393024,-70.514119,'LF-07 - LF 1227','LOS FALDEOS 1227',0,3,0],
[-33.393024,-70.514119,'LF-08-PTZ - LF 1227','LOS FALDEOS 1227',0,1,0],
[-33.393398,-70.51426,'LF-09 - LF 1241','LOS FALDEOS 1241',0,3,0],
[-33.393663,-70.514372,'LF-10 - LF 1253','LOS FALDEOS 1253',0,3,0],
[-33.393707,-70.514361,'LF-11 - LF 1262','LOS FALDEOS 1262',0,3,0],
[-33.393981,-70.514491,'LF-12 - LF 1277','LOS FALDEOS 1277',0,3,0],
[-33.394162,-70.514541,'LF-13 - LF 1286','LOS FALDEOS 1286',0,3,0],
[-33.394162,-70.514541,'LF-14 - LF 1286','LOS FALDEOS 1286',0,3,0],
[-33.41692,-70.5792,'A-01 - DI 4622','DEL INCA 4622',5,3,0],
[-33.417254,-70.579042,'A-02 - A 506','ALGECIRAS 506',5,3,0],
[-33.417743,-70.578725,'A-03 - A 567','ALGECIRAS 567',5,3,0],
[-33.417743,-70.578725,'A-04 - A 567','ALGECIRAS 567',5,3,0],
[-33.418109,-70.578462,'A-05-PTZ - A 684','ALGECIRAS 684',5,1,0],
[-33.41845,-70.578236,'A-06 - A 778','ALGECIRAS 778',5,3,0],
[-33.41845,-70.578236,'A-07 - A 778','ALGECIRAS 778',5,3,0],
[-33.4188,-70.577956,'A-08 - A 829','ALGECIRAS 829',5,3,0],
[-33.4188,-70.577956,'A-09 - A 829','ALGECIRAS 829',5,3,0],
[-33.402306,-70.527848,'LMM-01 - CM 1744','CAMINO MIRASOL 1744',0,3,0],
[-33.402033,-70.528432,'LMM-02 - CM 1701','CAMINO MIRASOL 1701',0,3,0],
[-33.402275,-70.52853,'LMM-03 - LML 10185','LUIS MATTE LARRAIN 10185',0,3,0],
[-33.402496,-70.529201,'LMM-04 - LML 10162','LUIS MATTE LARRAIN 10162',0,3,0],
[-33.402504,-70.529225,'LMM-05 - LML 10135','LUIS MATTE LARRAIN 10135',0,3,0],
[-33.402575,-70.529572,'LMM-06-PTZ - LML 10091','LUIS MATTE LARRAIN 10091',0,1,0],
[-33.402651,-70.530001,'LMM-07 - LML 10066','LUIS MATTE LARRAIN 10066',0,3,0],
[-33.402758,-70.530482,'LMM-08 - LML 10011','LUIS MATTE LARRAIN 10011',0,3,0],
[-33.402757,-70.530788,'LMM-09 - LML 9972','LUIS MATTE LARRAIN 9972',0,3,0],
[-33.402753,-70.530761,'LMM-10 - LML 9996','LUIS MATTE LARRAIN 9966',0,3,0],
[-33.402958,-70.531473,'LMM-11 - LML 9924','Luis Matte Larrain 9924',0,3,0],
[-33.402923,-70.531371,'LMM-12 - LML 9924','Luis Matte Larrain 9923',0,3,0],
[-33.403003,-70.531571,'LMM-13 - LML 9898','Luis Matte Larrain 9898',0,3,0],
[-33.393802,-70.51121,'AC-01 - CF 1211','CERRO FRANCISCANO 1211',0,3,0],
[-33.3936,-70.51112,'AC-02 - CF 1171','CERRO FRANCISCANO 1171',0,3,0],
[-33.393891,-70.510644,'AC-03-PTZ - ALC 12098','ANILLO LA CUMBRE 12098',0,1,0],
[-33.393891,-70.510644,'AC-04 - ALC 12098','ANILLO LA CUMBRE 12098',0,3,0],
[-33.394596,-70.51077,'AC-05 - ALC 1259','ANILLO LA CUMBRE 1259',0,3,0],
[-33.394681,-70.510178,'AC-06 - ALC 1241','ANILLO LA CUMBRE 1241',0,3,0],
[-33.394102,-70.509934,'AC-07 - ALC 1211','ANILLO LA CUMBRE 1211',0,3,0],
[-33.393418,-70.509704,'AC-08 - ALC 1187','ANILLO LA CUMBRE 1187',0,3,0],
[-33.393181,-70.510201,'AC-09 - ALC 1153','ANILLO LA CUMBRE 1153',0,3,0],
[-33.38678,-70.5037,'PSC-01 - PSC 741','PASAJE SANTA CLARA 741',0,3,0],
[-33.38671,-70.503451,'PSC-02 - PSC 711','PASAJE SANTA CLARA 711',0,3,0],
[-33.38671,-70.503451,'PSC-03 - PSC 667','PASAJE SANTA CLARA 667',0,3,0],
[-33.38653,-70.503546,'PSC-04 - PSC 686','PASAJE SANTA CLARA 686',0,3,0],
[-33.38653,-70.503546,'PSC-05 - PSC 711','PASAJE SANTA CLARA 711',0,3,0],
[-33.412034,-70.517389,'LT2-01-PTZ - LT CPO','LAS TORTOLAS / CARLOS PEÑA OTAEGUI',0,1,0],
[-33.411634,-70.517225,'LT2-02 - LT 2958','LAS TORTOLAS 2958',0,3,0],
[-33.411559,-70.517193,'LT2-03 - LT 2929','LAS TORTOLAS 2929',0,3,0],
[-33.410919,-70.516988,'LT2-04 - LT 2796','LAS TORTOLAS 2796',0,3,0],
[-33.410684,-70.516991,'LT2-05 - LT 2778','LAS TORTOLAS 2778',0,3,0],
[-33.410149,-70.517121,'LT2-06 - LT 2712','LAS TORTOLAS 2712',0,3,0],
[-33.409521,-70.517527,'LT2-07 - LT 2658','LAS TORTOLAS 2658',0,3,0],
[-33.408842,-70.51798,'LT2-08 - LT 2550','LAS TORTOLAS 2550',0,3,0],
[-33.407444,-70.518859,'LT2-09 - LT 2358','LAS TORTOLAS 2358',0,3,0],
[-33.407444,-70.518859,'LT2-10 - LT 2358','LAS TORTOLAS 2358',0,3,0],
[-33.407097,-70.519095,'LT2-11-PTZ - LT QH','LAS TORTOLAS / QUEBRADA HONDA',0,1,0],
[-33.403512,-70.520937,'LT-01 - LT 1807','LAS TORTOLAS 1807',0,3,0],
[-33.404367,-70.520919,'LT-02 - LT 1901','LAS TORTOLAS 1901',0,3,0],
[-33.404367,-70.520919,'LT-03 - LT 1901','LAS TORTOLAS 1901',0,3,0],
[-33.404986,-70.520538,'LT-04 - LT 2008','LAS TORTOLAS 2008',0,3,0],
[-33.404986,-70.520538,'LT-05 - LT 2008','LAS TORTOLAS 2008',0,3,0],
[-33.405727,-70.520026,'LT-06 - LT 2084','LAS TORTOLAS 2084',0,3,0],
[-33.405727,-70.520026,'LT-07 - LT 2084','LAS TORTOLAS 2084',0,3,0],
[-33.407117,-70.519045,'LT-08 - LT 2346','LAS TORTOLAS 2346',0,3,0],
[-33.403159,-70.524231,'LC1-01 - LC 1950','LAS CONDESAS 1950',0,3,0],
[-33.403822,-70.524307,'LC1-02 - LC 2032','LAS CONDESAS 2032',0,3,0],
[-33.405043,-70.523563,'LC1-03 - LC 2248','LAS CONDESAS 2248',0,3,0],
[-33.405043,-70.523563,'LC1-04 - LC 2248','LAS CONDESAS 2248',0,3,0],
[-33.405043,-70.523563,'LC1-05-PTZ - LC 2248','LAS CONDESAS 2248',0,1,0],
[-33.407805,-70.521644,'LC2-01 - LC 2334','LAS CONDESAS 2334',0,3,0],
[-33.407805,-70.521644,'LC2-02 - LC 2422','LAS CONDESAS 2422',0,3,0],
[-33.406015,-70.522879,'LC2-03 - LC 2536','LAS CONDESAS 2536',0,3,0],
[-33.406015,-70.522879,'LC2-04 - LC 2598','LAS CONDESAS 2398',0,3,0],
[-33.412885,-70.534276,'CA-01 - CA 825 (N)','Cerro Alegre 825',0,3,0],
[-33.413135,-70.534131,'CA-02 - CA 830 (S)','Cerro Alegre 830',0,3,0],
[-33.413299,-70.534026,'CA-03 - CA 841 (N)','Cerro Alegre 841',0,3,0],
[-33.413299,-70.534026,'CA-04 - CA 841 (S)','Cerro Alegre 841',0,3,0],
[-33.413675,-70.533705,'CA-05 - CA 860 (N)','Cerro Alegre 860',0,3,0],
[-33.413675,-70.533705,'CA-06 - CA 860 (S)','Cerro Alegre 860',0,3,0],
[-33.413752,-70.533617,'CA-07 - CA 879 (N)','Cerro Alegre 879',0,3,0],
[-33.413889,-70.533507,'CA-08 - CA 887 (S)','Cerro Alegre 887',0,3,0],
[-33.414203,-70.53329,'CA-09-PTZ - CA 900','Cerro Alegre 900',0,1,0],
[-33.414291,-70.533287,'CA-10 -- CA 918 (N)','Cerro Alegre 918',0,3,0],
[-33.414291,-70.533287,'CA-11 - CA 918 (S)','Cerro Alegre 918',0,3,0],
[-33.41466,-70.533329,'CA-12 - CA 921 (N)','Cerro Alegre 921',0,3,0],
[-33.41466,-70.533329,'CA-13 - CA 921 (S)','Cerro Alegre 921',0,3,0],
[-33.415228,-70.533339,'CA-14-PTZ - CA 964','Cerro Alegre 964',0,1,0],
[-33.415228,-70.533339,'CA-15 - CA 964 (N)','Cerro Alegre 964',0,3,0],
[-33.415228,-70.533339,'CA-16 - CA 964 (O)','Cerro Alegre 964',0,3,0],
[-33.421468,-70.592275,'G-01 - G 547','GALICIA 547',5,3,0],
[-33.421468,-70.592275,'G-02 - G 547','GALICIA 547',5,3,0],
[-33.42194,-70.59171,'G-03 - G 628','GALICIA 628',5,3,0],
[-33.42202,-70.591599,'G-04 - G 662','GALICIA 662',5,3,0],
[-33.422338,-70.591205,'G-05 - G 727','GALICIA 727',5,3,0],
[-33.422338,-70.591205,'G-06 - G 727','GALICIA 727',5,3,0],
[-33.422564,-70.590919,'G-07 - G 788','GALICIA 788',5,3,0],
[-33.422441,-70.592213,'G-08 - B 3326','BAZTAN 3326',5,3,0],
[-33.422463,-70.59231,'G-09 - SC 644','SAN CRESCENTE 644',5,3,0],
[-33.393882,-70.548298,'CCQ-01 - B 8745','Bombay 8745',4,3,0],
[-33.393644,-70.548431,'CCQ-02 - CDM 223','Costa de Marfil 223',4,3,0],
[-33.393532,-70.548487,'CCQ-03 - CDM 238','Costa de Marfil 238',4,3,0],
[-33.393381,-70.548592,'CCQ-04 - CDM 250','Costa de Marfil 250',4,3,0],
[-33.393381,-70.548592,'CCQ-05 - CDM 250','Costa de Marfil 250',4,3,0],
[-33.393137,-70.548871,'CCQ-06 - CDM D','Costa de Marfil & Dakar',4,3,0],
[-33.393137,-70.548871,'CCQ-07-PTZ - CDM D','Costa de Marfil & Dakar',4,1,0],
[-33.392935,-70.548834,'CCQ-08 - CDM 282','Costa de Marfil 282',4,3,0],
[-33.392628,-70.549014,'CCQ-09 - M 8680','Mardoñal 8680',4,3,0],
[-33.392846,-70.548143,'CCQ-10 - D 8826','Dakar 8826',4,3,0],
[-33.392846,-70.548143,'CCQ-11 - D 8826','Dakar 8826',4,3,0],
[-33.392734,-70.547812,'CCQ-12 - D 8876','Dakar 8876',4,3,0],
[-33.392646,-70.54769,'CCQ-13 - T D','Trinidad & Dakar',4,3,0],
[-33.393091,-70.547343,'CCQ-14 - T 239','Trinidad 239',4,3,0],
[-33.38799,-70.50597,'PLM-01 - EC 824','EL CONVENTO 824',0,3,0],
[-33.388508,-70.506658,'PLM-02 - EC 863','EL CONVENTO 863',0,3,0],
[-33.388734,-70.506918,'PLM-03 - EC 955','EL CONVENTO 955',0,3,0],
[-33.389499,-70.507144,'PLM-04 - LM 12124','LOS MONJES 12124',0,3,0],
[-33.38975,-70.507209,'PLM-05 - LM 12144','LOS MONJES 12144',0,3,0],
[-33.39021,-70.50745,'PLM-06 - LM 12124','LOS MONJES 12124',0,3,0],
[-33.390265,-70.507434,'PLM-07 - LM 12171','LOS MONJES 12171',0,3,0],
[-33.390608,-70.507002,'PLM-08 - EM 973','EL MONASTERIO 973',0,3,0],
[-33.39003,-70.50843,'PLM-09 - EC 969','EL CONVENTO 969',0,3,0],
[-33.38996,-70.508154,'PLM-10 - LM 12109','LOS MONJES 12109',0,3,0],
[-33.390428,-70.506872,'PLM-11 - EM 948','EL MONASTERIO 948',0,3,0],
[-33.389196,-70.507852,'PLM-12 - EC 901','EL CONVENTO 901',0,3,0],
[-33.389191,-70.507628,'PLM-13 - LM 12092','LOS MONJES 12092',0,3,0],
[-33.412081,-70.547172,'V-01 - V 480','VALDEPEÑAS 480',4,3,0],
[-33.411334,-70.548182,'V-02 - V 382','VALDEPEÑAS 382',4,3,0],
[-33.411334,-70.548182,'V-03 - V 382','VALDEPEÑAS 382',4,3,0],
[-33.410668,-70.548822,'V-04 - V 275','VALDEPEÑAS 275',4,3,0],
[-33.399376,-70.564303,'NSRI-01 - NSDRI 623','NUESTRA SEÑORA DEL ROSARIO INT 623',5,3,0],
[-33.399271,-70.564186,'NSRI-02-PTZ - NSDRI 567','NUESTRA SEÑORA DEL ROSARIO INT 567',5,1,0],
[-33.399043,-70.563276,'NSRI-03 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583',5,3,0],
[-33.399043,-70.563276,'NSRI-04 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583',5,3,0],
[-33.419617,-70.546271,'Z-01 - FO 1172','FUENTE OVEJUNA 1172',3,3,0],
[-33.419614,-70.547442,'Z-02 - Z 8018','ZARAGOZA 8018',3,3,0],
[-33.419614,-70.547442,'Z-03 - Z 8018','ZARAGOZA 8018',3,3,0],
[-33.419668,-70.548032,'Z-04 - G 1126','GUIPUZCOA 1126',3,3,0],
[-33.41976,-70.54831,'Z-06 - V 1127','VIZCAYA 1127',3,3,0],
[-33.419784,-70.548475,'Z-07 - Z 7899','ZARAGOZA 7899',3,3,0],
[-33.41976,-70.54831,'Z-08 - V 1127','VIZCAYA 1127',3,3,0],
[-33.419917,-70.549571,'Z-09 - Z 7782','ZARAGOZA 7782',3,3,0],
[-33.419917,-70.549571,'Z-10 - Z 7782','ZARAGOZA 7782',3,3,0],
[-33.420053,-70.549696,'Z-11 - G 1153','GUADARRAMA 1153',3,3,0],
[-33.419835,-70.549929,'Z-12 - G 1135','GUADARRAMA 1135',3,3,0],
[-33.419415,-70.549475,'Z-13 - L 7798','LERIDA 7798',3,3,0],
[-33.419415,-70.549475,'Z-14 - L 7798','LERIDA 7798',3,3,0],
[-33.419315,-70.548636,'Z-15 - L 7851','LERIDA 7851',3,3,0],
[-33.419224,-70.548025,'Z-16 - L 7996','LERIDA 7996',3,3,0],
[-33.419784,-70.548475,'Z-05-PTZ - Z 7899','ZARAGOZA 7899',3,1,0],
[-33.42521,-70.561071,'ELT-01 - ET 1635','EL TOQUI 1635',4,3,0],
[-33.42521,-70.561071,'ELT-02 - ET 1635','EL TOQUI 1635',4,3,0],
[-33.42585,-70.561234,'ELT-03 - ET 1663','EL TOQUI 1663',4,3,0],
[-33.42585,-70.561234,'ELT-04 - ET 1663','EL TOQUI 1663',4,3,0],
[-33.426559,-70.561415,'ELT-05 - ET 1711','EL TOQUI 1711',4,3,0],
[-33.426559,-70.561415,'ELT-06 - ET 1711','EL TOQUI 1711',4,3,0],
[-33.42585,-70.561234,'ELT-07 - ET 1677','EL TOQUI 1677',4,3,0],
[-33.42585,-70.561234,'ELT-08 - ET 1677','EL TOQUI 1677',4,3,0],
[-33.427539,-70.561536,'ELT-09 - ET 1770','EL TOQUI 1770',4,3,0],
[-33.427744,-70.561674,'ELT-10 - ET 1793','El Toqui 1793',4,3,0],
[-33.427744,-70.561674,'ELT-11 - ET 1793','El Toqui 1793',4,3,0],
[-33.428098,-70.561736,'ELT-12 - ET 1837','El Toqui 1837',4,3,0],
[-33.428512,-70.561833,'ELT-13 - ET 1853','EL TOQUI 1853',4,3,0],
[-33.428512,-70.561833,'ELT-14 - ET 1853','EL TOQUI 1853',4,3,0],
[-33.39237,-70.506289,'SV-01 - SV 1018','SANTA VERONICA 1018',0,3,0],
[-33.39237,-70.506289,'SV-02 - SV 1018','SANTA VERONICA 1018',0,3,0],
[-33.392535,-70.505889,'SV-03 - SV 1044','SANTA VERONICA 1044',0,3,0],
[-33.412575,-70.563352,'LA-01 - M 6541','MONROE 6541',4,3,0],
[-33.412417,-70.563949,'LA-02 - LA 561','LOS ALMENDROS 561',4,3,0],
[-33.412164,-70.564432,'LA-03 - LA 485','LOS ALMENDROS 485',4,3,0],
[-33.412036,-70.564333,'LA-04 - LA 483','LOS ALMENDROS 483',4,3,0],
[-33.412036,-70.564333,'LA-05 - LA 483','LOS ALMENDROS 483',4,3,0],
[-33.411877,-70.563765,'LA-06 - LA 498','LOS ALMENDROS 498',4,3,0],
[-33.412402,-70.5639,'LA-07 - LA 537','Los Almendros 537',4,3,0],
[-33.413633,-70.530727,'VLML-01 - LML 917','LUIS MATTE LARRAIN 917',0,3,0],
[-33.413633,-70.530727,'VLML-02 - LML 917','LUIS MATTE LARRAIN 917',0,3,0],
[-33.412964,-70.530904,'VLML-04 - LML 907','LUIS MATTE LARRAIN 907',0,3,0],
[-33.412964,-70.530904,'VLML-05 - LML 907','LUIS MATTE LARRAIN 907',0,3,0],
[-33.412305,-70.531279,'VLML-06 - LML 899','LUIS MATTE LARRAIN 899',0,3,0],
[-33.412305,-70.531279,'VLML-07 - LML 899','LUIS MATTE LARRAIN 899',0,3,0],
[-33.411845,-70.531668,'VLML-09 - LML 885','LUIS MATTE LARRAIN 885',0,3,0],
[-33.411845,-70.531668,'VLML-10 - LML 885','LUIS MATTE LARRAIN 885',0,3,0],
[-33.413277,-70.530801,'VLML-03-PTZ - LML 913','LUIS MATTE LARRAIN 913',0,1,0],
[-33.412247,-70.531333,'VLML-08-PTZ - LML 893','LUIS MATTE LARRAIN 893',0,1,0],
[-33.393805,-70.507521,'SCLF-01 - CCS 12317','CERRO CATEDRAL SUR 12317',0,3,0],
[-33.393805,-70.507521,'SCLF-02 - CCS 12317','CERRO CATEDRAL SUR 12317',0,3,0],
[-33.393546,-70.508052,'SCLF-03 - SCDA 1126','SAN CARLOS DE APOQUINDO 1126',0,3,0],
[-33.393822,-70.508241,'SCLF-04 - SCDA 1128','SAN CARLOS DE APOQUINDO 1128',0,3,0],
[-33.394062,-70.508408,'SCLF-05 - SCDA 1154','SAN CARLOS DE APOQUINDO 1154',0,3,0],
[-33.394385,-70.508635,'SCLF-06 - SCDA 1218','SAN CARLOS DE APOQUINDO 1218',0,3,0],
[-33.394385,-70.508635,'SCLF-07 - SCDA 1218','SAN CARLOS DE APOQUINDO 1218',0,3,0],
[-33.394711,-70.508866,'SCLF-08 - SCDA 1248','SAN CARLOS DE APOQUINDO 1248',0,3,0],
[-33.394711,-70.508866,'SCLF-09 - SCDA 1248','SAN CARLOS DE APOQUINDO 1248',0,3,0],
[-33.394988,-70.509059,'SCLF-10 - SCDA 1290','SAN CARLSO DE APOQUINDO 1290',0,3,0],
[-33.395517,-70.509128,'SCLF-11 - CLF 12300','CAMINO LAS FLORES 12300',0,3,0],
[-33.395624,-70.50851,'SCLF-12 - CLF 12368','CAMINO LAS FLORES 12368',0,3,0],
[-33.395726,-70.507952,'SCLF-13 - CLF 12414','CAMINO LAS FLORES 12414',0,3,0],
[-33.395811,-70.507499,'SCLF-14 - CLF 12488','CAMINO LAS FLORES 12488',0,3,0],
[-33.395683,-70.507144,'SCLF-15 - STJDI 1094','SANTA TERESA JORNET DE IBARS 1094',0,3,0],
[-33.390734,-70.530912,'LCS2-01 - C 700','CAMPANARIO 700',4,3,0],
[-33.390892,-70.530518,'LCS2-02 - LC 10020','LOS CARPINTEROS 10020',4,3,0],
[-33.390892,-70.530518,'LCS2-03 - LC 10020','LOS CARPINTEROS 10020',4,3,0],
[-33.390439,-70.529965,'LCS2-04 - LC 10096','LOS CARPINTEROS 10096',4,3,0],
[-33.390439,-70.529965,'LCS2-05 - LC 10096','LOS CARPINTEROS 10096',4,3,0],
[-33.390008,-70.529454,'LCS2-06 - LC 10184','LOS CARPINTEROS 10184',4,3,0],
[-33.389867,-70.529284,'LCS2-07 - LC 10195','LOS CARPINTEROS 10195',4,3,0],
[-33.389665,-70.529036,'LCS2-08 - LC 10231','LOS CARPINTEROS 10231',4,3,0],
[-33.388948,-70.528163,'LCS2-09 - LC 10277','LOS CARPINTEROS 10277',4,3,0],
[-33.403637,-70.512185,'AFSR-01 - LO 12179','LOS OLIVOS 12179',0,3,0],
[-33.403615,-70.512141,'AFSR-02 - LO 12179','LOS OLIVOS 12179',0,3,0],
[-33.403606,-70.512277,'AFSR-03 - LO 12179','LOS OLIVOS 12179',0,3,0],
[-33.402829,-70.510934,'AFSA-01 - LO 12289','LOS OLIVOS 12289',0,3,0],
[-33.402894,-70.510828,'AFSA-02 - LO 12289','LOS OLIVOS 12289',0,3,0],
[-33.402894,-70.510828,'AFSA-03 - LO 12289','LOS OLIVOS 12289',0,3,0],
[-33.404837,-70.525111,'CMGB-01 - CM 2148','CAMINO MIRASOL 2148',0,3,0],
[-33.404403,-70.525418,'CMGB-02 - CM 2099','CAMINO MIRASOL 2099',0,3,0],
[-33.404098,-70.525628,'CMGB-03 - CM 2080','CAMINO MIRASOL 2080',0,3,0],
[-33.403554,-70.526064,'CMGB-04 - CM 1982','CAMINO MIRASOL 1982',0,3,0],
[-33.403442,-70.52617,'CMGB-05 - CM 1943','CAMINO MIRASOL 1943',0,3,0],
[-33.403442,-70.52617,'CMGB-06 - CM 1943','CAMINO MIRASOL 1943',0,3,0],
[-33.403042,-70.526647,'CMGB-07 - CM 1888','CAMINO MIRASOL 1888',0,3,0],
[-33.402991,-70.525724,'CMGB-09 - GB 10364','GENERAL BLANCHE 10364',0,3,0],
[-33.402991,-70.525724,'CMGB-10 - GB 10364','GENERAL BLANCHE 10364',0,3,0],
[-33.402991,-70.525724,'CMGB-11 - GB 10364','GENERAL BLANCHE 10364',0,3,0],
[-33.403075,-70.524947,'CMGB-12 - GB 10472','GENERAL BLANCHE 10472',0,3,0],
[-33.402873,-70.527047,'CMGB-08-PTZ - GB 10260','GENERAL BLANCHE 10260',0,1,0],
[-33.400768,-70.513707,'LBEA-01 - CEA 12048','CAMINO EL ALBA 12048',0,3,0],
[-33.400414,-70.512759,'LBEA-02 - CEA 12061','CAMINO EL ALBA 12061',0,3,0],
[-33.400333,-70.512461,'LBEA-03 - CEA 12069','CAMINO EL ALBA 12069',0,3,0],
[-33.400333,-70.512461,'LBEA-04 - CEA 12069','CAMINO EL ALBA 12069',0,3,0],
[-33.400641,-70.512165,'LBEA-05 - CEA 12079','CAMINO EL ALBA 12079',0,3,0],
[-33.40047,-70.511556,'LBEA-06 - CEA 12141','CAMINO EL ALBA 12141',0,3,0],
[-33.40058,-70.511561,'LBEA-07 - CEA 12133','CAMINO EL ALBA 12133',0,3,0],
[-33.400087,-70.511596,'LBEA-08 - CEA 12145','CAMINO EL ALBA 12145',0,3,0],
[-33.399929,-70.511014,'LBEA-09 - CEA 12163','CAMINO EL ALBA 12163',0,3,0],
[-33.400331,-70.510952,'LBEA-10 - CEA 12169','CAMINO EL ALBA 12169',0,3,0],
[-33.3998,-70.510499,'LBEA-11 - CEA 12295','CAMINO EL ALBA 12295',0,3,0],
[-33.39985,-70.510219,'LBEA-12 - SCDA 1625','SAN CARLOS DE APOQUINDO 1625',0,3,0],
[-33.400505,-70.510228,'LBEA-13 - SCDA 1643','SAN CARLOS DE APOQUINDO 1643',0,3,0],
[-33.400804,-70.510228,'LBEA-14 - SCDA 1653','SAN CARLOS DE APOQUINDO 1653',0,3,0],
[-33.42402,-70.555304,'MAY-01-PTZ - ILC 7400','ISABEL LA CATOLICA 7400',3,1,0],
[-33.423587,-70.555372,'MAY-02 - M 1554','MAYECURA 1554',3,3,0],
[-33.423587,-70.555372,'MAY-03 - M 1554','MAYECURA 1554',3,3,0],
[-33.423382,-70.555452,'MAY-04 - M 1482','MAYECURA 1482',3,3,0],
[-33.422962,-70.555444,'MAY-05 - M 1400','MAYECURA 1400',3,3,0],
[-33.422962,-70.555444,'MAY-06 - M 1400','MAYECURA 1400',3,3,0],
[-33.422524,-70.555386,'MAY-07-PTZ - M 1331','MAYECURA 1331',3,1,0],
[-33.422474,-70.555351,'MAY-08 - M 1336','MAYECURA 1336',3,3,0],
[-33.422474,-70.555351,'MAY-09 - M 1336','MAYECURA 1336',3,3,0],
[-33.421132,-70.560378,'MA-01 - ADC 6497 (N)','ALONSO DE CAMARGO 6497',4,3,0],
[-33.42102,-70.560593,'MA-02 - ADC 6466 (S)','ALONSO DE CAMARGO 6466',4,3,0],
[-33.420558,-70.56021,'MA-03 - MA 6520 (P)','MANUEL ALDUNATE 6520',4,3,0],
[-33.420434,-70.56034,'MA-04 - MA 6486 (O)','MANUEL ALDUNATE 6486',4,3,0],
[-33.420465,-70.560444,'MA-05 - MA 6491 (P)','MANUEL ALDUNATE 6491',4,3,0],
[-33.420358,-70.560822,'MA-06 - MA 6446 (O)','MANUEL ALDUNATE 6446',4,3,0],
[-33.420358,-70.560822,'MA-07 - MA 6446 (P)','MANUEL ALDUNATE 6446',4,3,0],
[-33.420273,-70.561344,'MA-08 - MA 6392 (O)','Manuel Aldunate 6392',4,3,0],
[-33.420273,-70.561344,'MA-09 - MA 6392 (P)','Manuel Aldunate 6392',4,3,0],
[-33.42016,-70.561983,'MA-10 - HDM 1227 (O)','Hernando De Magallanes 1227',4,3,0],
[-33.420475,-70.562058,'MA-11 - HDM 1238 (N)','Hernando De Magallanes 1238',4,3,0],
[-33.415878,-70.57635,'PEV-01 - D1 4852','DEL INCA 4852',5,3,0],
[-33.416293,-70.576115,'PEV-02 - PEV 555','PABLO EL VERONES 555',5,3,0],
[-33.416657,-70.57587,'PEV-03 - PEV 647','PABLO EL VERONES 647',5,3,0],
[-33.416937,-70.57567,'PEV-04 - PEV 696','PABLO EL VERONES 696',5,3,0],
[-33.416937,-70.57567,'PEV-05 - PEV 696','PABLO EL VERONES 696',5,3,0],
[-33.417163,-70.575493,'PEV-06-PTZ - PEV 773','PABLO EL VERONES 773',5,1,0],
[-33.417163,-70.575493,'PEV-07 - PEV 773','PABLO EL VERONES 773',5,3,0],
[-33.417248,-70.575426,'PEV-08 - PEV 782','PABLO EL VERONES 782',5,3,0],
[-33.417124,-70.575544,'PEV-09 - PEV 773','Pablo El Veronés 773',5,3,0],
[-33.417276,-70.575425,'PEV-10 - PEV 782','Pablo El Veronés 782',5,3,0],
[-33.417716,-70.575033,'PEV-11 - PEV MZ','Pablo El Veronés & Martín de Zamora',5,3,0],
[-33.371878,-70.503344,'STA-01 - SJDLS 201','SAN JOSE DE LA SIERRA 201',0,3,0],
[-33.371878,-70.503344,'STA-02 - SJDLS 201','SAN JOSE DE LA SIERRA 201',0,3,0],
[-33.371894,-70.503421,'STA-03 - STDA 13685','SANTA TERESA DE AVILA 13685',0,3,0],
[-33.372123,-70.504209,'STA-04 - STDA 13610','SANTA TERESA DE AVILA 13610',0,3,0],
[-33.372123,-70.504209,'STA-05 - STDA 13610','SANTA TERESA DE AVILA 13610',0,3,0],
[-33.372295,-70.504906,'STA-06 - STDA 13516','SANTA TERESA DE AVILA 13516',0,3,0],
[-33.372295,-70.504906,'STA-07 - STDA 13516','SANTA TERESA DE AVILA 13516',0,3,0],
[-33.372295,-70.504906,'STA-08 - STDA 13516','SANTA TERESA DE AVILA 13516',0,3,0],
[-33.372274,-70.504706,'STA-09 - STDA 13575','SANTA TERESA DE AVILA 13575',0,3,0],
[-33.372274,-70.504706,'STA-10-PTZ - STDA 13575','SANTA TERESA DE AVILA 13575',0,1,0],
[-33.397034,-70.509857,'LPS-01 - LP 12276','LOS PUMAS 12276',0,3,0],
[-33.397034,-70.509857,'LPS-02 - LP 12276','LOS PUMAS 12276',0,3,0],
[-33.39691,-70.510596,'LPS-03 - LP 12194','LOS PUMAS 12194',0,3,0],
[-33.39691,-70.510596,'LPS-04 - LP 12194','LOS PUMAS 12194',0,3,0],
[-33.396767,-70.511445,'LPS-05 - LP 12140','LOS PUMAS 12140',0,3,0],
[-33.396767,-70.511445,'LPS-06 - LP 12140','LOS PUMAS 12140',0,3,0],
[-33.41166,-70.514918,'LV-01 - CO 2837','CAMINO OTOÑAL 2837',0,3,0],
[-33.411365,-70.515678,'LV-02 - CO 2785','CAMINO OTOÑAL 2785',0,3,0],
[-33.410678,-70.515687,'LV-03 - CO 2708','CAMINO OTOÑAL 2708',0,3,0],
[-33.410141,-70.51584,'LV-04-PTZ - CO 2678','CAMINO OTOÑAL 2678',0,1,0],
[-33.409775,-70.51455,'LV-05 - LV 11717','LA VIGUELA 11717',0,3,0],
[-33.409775,-70.51455,'LV-06 - LV 11717','LA VIGUELA 11717',0,3,0],
[-33.409037,-70.515251,'LV-07 - LR 11771','LA RAMADA 11771',0,3,0],
[-33.409037,-70.515251,'LV-08 - LR 11771','LA RAMADA 11771',0,3,0],
[-33.409175,-70.516279,'LV-09 - CO 2536','CAMINO OTOÑAL 2536',0,3,0],
[-33.379915,-70.51289,'CLV1-01 - CV 12314','CAMINO LA VIÑA 12314',0,3,0],
[-33.379897,-70.512829,'CLV1-02 - CV 12314','CAMINO LA VIÑA 12314',0,3,0],
[-33.379706,-70.512402,'CLV1-03 - CV 12368','CAMINO LA VIÑA 12368',0,3,0],
[-33.379577,-70.511975,'CLV1-04 - CV 12439','CAMINO LA VIÑA 12439',0,3,0],
[-33.379409,-70.511669,'CLV1-05 - CV 12442','CAMINO LA VIÑA 12442',0,3,0],
[-33.379124,-70.511007,'CLV1-06 - CV 12479','CAMINO LA VIÑA 12479',0,3,0],
[-33.379124,-70.511007,'CLV1-07 - CV 12479','CAMINO LA VIÑA 12479',0,3,0],
[-33.379124,-70.511007,'CLV1-08 - CV 12479','CAMINO LA VIÑA 12479',0,3,0],
[-33.378331,-70.511474,'CLV2-01 - CV 12486','CAMINO LA VIÑA 12486',0,3,0],
[-33.378331,-70.511474,'CLV2-02 - CV-12486','CAMINO LA VIÑA 12486',0,3,0],
[-33.378222,-70.511626,'CLV2-04 - CV 12478','CAMINO LA VIÑA 12478',0,3,0],
[-33.378222,-70.511626,'CLV2-05 - CV 12478','CAMINO LA VIÑA 12472',0,3,0],
[-33.378379,-70.511937,'CLV2-06 - CV 12444','CAMINO LA VIÑA 12444',0,3,0],
[-33.378808,-70.512934,'CLV2-07 - CV 12354','CAMINO LA VIÑA 12354',0,3,0],
[-33.378808,-70.512934,'CLV2-08 - CV 12354','CAMINO LA VIÑA 12354',0,3,0],
[-33.378724,-70.512799,'CLV2-09 - CV 12313','CAMINO LA VIÑA 12313',0,3,0],
[-33.378212,-70.511548,'CLV2-03-PTZ - CV 12482','CAMINO LA VIÑA 12482',0,1,0],
[-33.403136,-70.531858,'LML2-01 - LML 9880','LUIS MATTE LARRAIN 9880',0,3,0],
[-33.403136,-70.531858,'LML2-02 - LML 9880','LUIS MATTE LARRAIN 9880',0,3,0],
[-33.403317,-70.532175,'LML2-03 - LML 9862','LUIS MATTE LARRAIN 9862',0,3,0],
[-33.403604,-70.532677,'LML2-04 - LML 9818','LUIS MATTE LARRAIN 9818',0,3,0],
[-33.403604,-70.532677,'LML2-05 - LML 9818','LUIS MATTE LARRAIN 9818',0,3,0],
[-33.404053,-70.533219,'LML2-06 - LML 9744','LUIS MATTE LARRAIN 9774',0,3,0],
[-33.404053,-70.533219,'LML2-08 - LML 9744','LUIS MATTE LARRAIN 9744',0,3,0],
[-33.404236,-70.533001,'LML2-09 - LML 9743','LUIS MATTE LARRAIN 9743',0,3,0],
[-33.404439,-70.533657,'LML2-10 - LML 9705','LUIS MATTE LARRAIN 9705',0,3,0],
[-33.404439,-70.533657,'LML2-11 - LML 9705','LUIS MATTE LARRAIN 9705',0,3,0],
[-33.404453,-70.533644,'LML2-12 - LML 9699','LUIS MATTE LARRAIN 9699',0,3,0],
[-33.404759,-70.534013,'LML2-13 - LML 9647','LUIS MATTE LARRAIN 9647',0,3,0],
[-33.405062,-70.534364,'LML2-14 - LML 9600','LUIS MATTE LARRAIN 9600',0,3,0],
[-33.404053,-70.533219,'LML2-07-PTZ - LML 9744','LUIS MATTE LARRAIN 9744',0,1,0],
[-33.415607,-70.530465,'LML5-01 - LML 940','Luis Matte Larraín 940',0,3,0],
[-33.415175,-70.530424,'LML5-02 - LML 936','Luis Matte Larraín 936',0,3,0],
[-33.415175,-70.530424,'LML5-03 - LML 936','Luis Matte Larraín 936',0,3,0],
[-33.414695,-70.530401,'LML5-04 - LML 930','Luis Matte Larraín 930',0,3,0],
[-33.414509,-70.530492,'LML5-05 - LML 927','Luis Matte Larraín 927',0,3,0],
[-33.414509,-70.530492,'LML5-06 - LML 927','Luis Matte Larraín 927',0,3,0],
[-33.414197,-70.530568,'LML5-07 - LML 924','Luis Matte Larraín 924',0,3,0],
[-33.414197,-70.530568,'LML5-08 - LML 924','Luis Matte Larraín 924',0,3,0],
[-33.413714,-70.530547,'LML5-09 - CPO 9574','Carlos Peña Otaegui 9574',0,3,0],
[-33.392397,-70.51816,'CO-01 - CO 1189','Camino Otoñal 1189',0,3,0],
[-33.392397,-70.51816,'CO-02 - CO 1189','Camino Otoñal 1189',0,3,0],
[-33.392927,-70.516133,'CO-03 - CO 1189','Camino Otoñal 1189',0,3,0],
[-33.392927,-70.516133,'CO-04 - CO 1189','Camino Otoñal 1189',0,3,0],
[-33.418875,-70.52017,'AER-01 - ER 9417','El Remanso 9417',0,3,0],
[-33.41939,-70.52028,'AER-02 - ER 11828','El Remanso 11828',0,3,0],
[-33.41939,-70.52028,'AER-03 - ER 11828','El Remanso 11828',0,3,0],
[-33.419721,-70.520521,'AER-04 - ER 11832','Caseta Norte',0,3,0],
[-33.419721,-70.520521,'AER-05 - ER 11832','Caseta Sur',0,3,0],
[-33.420116,-70.520713,'AER-06 - ER 11842','El Remanso 11842',0,3,0],
[-33.420116,-70.520713,'AER-07 - ER 11842','El Remanso 11842',0,3,0],
[-33.420584,-70.520658,'AER-08 - ER 11851','El Remanso 11851',0,3,0],
[-33.420584,-70.520658,'AER-09 - ER 11851','El Remanso 11851',0,3,0],
[-33.416712,-70.572796,'SE-01 - SE 849 (N)','849 Sebastián Elcano',5,3,0],
[-33.416291,-70.572964,'SE-02 - SE 756 (N)','756 Sebastián Elcano',5,3,0],
[-33.416291,-70.572964,'SE-03 - SE 700 (S)','700 Sebastián Elcano',5,3,0],
[-33.415799,-70.57316,'SE-04 - SE 628 (O)','628 Sebastián Elcano',5,3,0],
[-33.415712,-70.573201,'SE-05 - SE 609 (S)','609 Sebastián Elcano',5,3,0],
[-33.415509,-70.573276,'SE-06 - SE 538 (P)','538 Sebastián Elcano',5,3,0],
[-33.415332,-70.573349,'SE-07 - SE 487 (S)','487 Sebastián Elcano',5,3,0],
[-33.415332,-70.573349,'SE-08 - SE 487 (N)','487 Sebastián Elcano',5,3,0],
[-33.415146,-70.573425,'SE-09 - SE 482 (O)','482 Sebastián Elcano',5,3,0],
[-33.423508,-70.573045,'JDM-01 - JDM 4894','José de Moraleda 4894',5,3,0],
[-33.423508,-70.573045,'JDM-02 - JDM 4894','José de Moraleda 4894',5,3,0],
[-33.392616,-70.493305,'SFDA-01 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,3,0],
[-33.392677,-70.49388,'SFDA-02 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,3,0],
[-33.392677,-70.493881,'SFDA-03 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398',0,3,0],
[-33.3884,-70.503295,'SC2-01 - SC 12276','Sta Clara 12276',0,3,0],
[-33.3884,-70.503295,'SC2-02 - SC 12276','Sta Clara 12276',0,3,0],
[-33.387997,-70.503569,'SC2-03 - SC 12238','Sta Clara 12238',0,3,0],
[-33.387997,-70.503569,'SC2-04 - SC 12238','Sta Clara 12238',0,3,0],
[-33.387225,-70.50412,'SC2-05 - SC 12161','Sta Clara 12161',0,3,0],
[-33.387225,-70.50412,'SC2-06 - SC 12161','Sta Clara 12161',0,3,0],
[-33.387295,-70.504029,'SC2-07 - SC 12161','Sta Clara 12161',0,3,0],
[-33.387087,-70.504307,'SC2-08 - SC 12135','Sta Clara 12135',0,3,0],
[-33.387087,-70.504307,'SC2-09 - SC 12135','Sta Clara 12135',0,3,0],
[-33.386811,-70.504611,'SC2-10 - SC 12150','Sta Clara 12150',0,3,0],
[-33.411904,-70.535469,'RG-01 - RG PH (N)','RIO GUADIANA & PAUL HARRIS',0,3,0],
[-33.412145,-70.53479,'RG-02 - RG 9242 (N)','RIO GUADIANA 9242',0,3,0],
[-33.412231,-70.534562,'RG-03 - RG 9260 (O)','RIO GUADIANA 9260',0,3,0],
[-33.41206,-70.534002,'RG-04 - LL 878 (S)','LAS LOMAS 878',0,3,0],
[-33.412217,-70.534004,'RG-05-PTZ - RG 9284','RIO GUADIANA 9284',0,1,0],
[-33.412492,-70.534018,'RG-06 - RG 9309 (P)','RIO GUADIANA 9309',0,3,0],
[-33.412492,-70.534018,'RG-07 - RG 9309 (O)','RIO GUADIANA 9309',0,3,0],
[-33.412726,-70.533608,'RG-08 - RG 9326 (P)','RIO GUADIANA 9326',0,3,0],
[-33.413059,-70.533445,'RG-09 - RG 9387 (N)','RIO GUADIANA 9387',0,3,0],
[-33.413362,-70.533126,'RG-10 - RG 9433 (P)','RIO GUADIANA 9433',0,3,0],
[-33.413326,-70.533058,'RG-11-PTZ - RG 9434','RIO GUADIANA 9434',0,1,0],
[-33.413477,-70.532909,'RG-12 - RG 9461 (S)','RIO GUADIANA 9461',0,3,0],
[-33.412489,-70.518606,'A1-01 - A 11217','ATALAYA 11217',0,3,0],
[-33.412489,-70.518606,'A1-02 - A 11217','ATALAYA 11217',0,3,0],
[-33.412392,-70.519826,'A1-03 - A 11136','ATALAYA 11136',0,3,0],
[-33.412392,-70.519826,'A1-04 - A 11136','ATALAYA 11136',0,3,0],
[-33.412032,-70.521197,'A1-05 - A 10948','Frente a Atalaya 10948',0,3,0],
[-33.412032,-70.521197,'A1-06 - A 10948','Frente a Atalaya 10948',0,3,0],
[-33.41198,-70.522258,'A2-01 - A 10866','ATALAYA 10866',0,3,0],
[-33.41198,-70.522258,'A2-02 - A 10866','ATALAYA 10866',0,3,0],
[-33.412673,-70.52307,'A2-03 - A 10911','ATALAYA 10911',0,3,0],
[-33.412673,-70.52307,'A2-04 - A 10911','ATALAYA 10911',0,3,0],
[-33.412866,-70.52376,'A2-05 - A 10893','ATALAYA 10893',0,3,0],
[-33.412665,-70.523961,'A2-06 - A 10847','ATALAYA 10847',0,3,0],
[-33.412665,-70.523961,'A2-07 - A 10847','ATALAYA 10847',0,3,0],
[-33.411785,-70.522907,'A3-01 - A 10731','ATALAYA 10731',0,3,0],
[-33.411785,-70.522907,'A3-02 - A 10731','ATALAYA 10731',0,3,0],
[-33.41153,-70.522893,'A3-03 - A 10731','ATALAYA 10731',0,3,0],
[-33.411438,-70.522221,'A3-04 - CP WS','CARLOS PEÑA EXTERIOR WENLOCK SCHOOL',0,3,0],
[-33.411532,-70.521481,'A3-05 - CP WS','CARLOS PEÑA EXTERIOR WENLOCK SCHOOL',0,3,0],
[-33.411532,-70.521481,'A3-06 - CP WS','CARLOS PEÑA EXTERIOR WENLOCK SCHOOL',0,3,0],
[-33.411945,-70.518312,'A3-07 - CPO 11241','CARLOS PEÑA OTAEGUI 11241',0,3,0],
[-33.411945,-70.518312,'A3-08 - CPO 11241','CARLOS PEÑA OTAEGUI 11241',0,3,0],
[-33.41186,-70.518951,'A3-09 - CPO 11264','CARLOS PEÑA OTAEGUI 11170',0,3,0],
[-33.41186,-70.518951,'A3-10 - CPO 11264','CARLOS PEÑA OTAEGUI 11170',0,3,0],
[-33.411715,-70.520066,'A3-11 - CPO 11052','CARLOS PEÑA OTAEGUI 11052',0,3,0],
[-33.411715,-70.520066,'A3-12 - CPO 11052','CARLOS PEÑA OTAEGUI 11052',0,3,0],
[-33.403469,-70.529465,'CMR1-01 - CVH 1874','COLINA VISTA HERMOSA 1874',0,3,0],
[-33.403469,-70.529465,'CMR1-02 - CVH 1874','COLINA VISTA HERMOSA 1874',0,3,0],
[-33.403478,-70.528569,'CMR1-03 - CVH 1874','COLINA VISTA HERMOSA 1874',0,3,0],
[-33.403548,-70.528236,'CMR1-04 - CVH 1897','COLINA VISTA HERMOSA 1897',0,3,0],
[-33.403548,-70.528236,'CMR1-05 - CVH 1897','COLINA VISTA HERMOSA 1897',0,3,0],
[-33.403764,-70.527539,'CMR1-06 - CVH 1920','COLINA VISTA HERMOSA 1920',0,3,0],
[-33.404256,-70.526747,'CMR1-07 - CVH 2008','COLINA VISTA HERMOSA 2008',0,3,0],
[-33.404256,-70.526747,'CMR1-08 - CVH 2008','COLINA VISTA HERMOSA 2008',0,3,0],
[-33.405152,-70.526043,'CMR1-09 - CVH 2156','COLINA VISTA HERMOSA 2156',0,3,0],
[-33.405152,-70.526043,'CMR1-10 - CVH 2156','COLINA VISTA HERMOSA 2156',0,3,0],
[-33.405635,-70.525953,'CMR1-11 - AML 10188','ARTURO MATTE LARRAIN 10188',0,3,0],
[-33.405635,-70.525953,'CMR1-12 - AML 10188','ARTURO MATTE LARRAIN 10188',0,3,0],
[-33.405745,-70.525624,'CMR1-13 - CVH 2244','COLINA VISTA HERMOSA 2244',0,3,0],
[-33.405745,-70.525624,'CMR1-14 - CVH 2244','COLINA VISTA HERMOSA 2244',0,3,0],
[-33.406385,-70.52517,'CMR1-15 - CVH 2356','COLINA VISTA HERMOSA 2356',0,3,0],
[-33.406385,-70.52517,'CMR1-16 - CVH 2356','COLINA VISTA HERMOSA 2356',0,3,0],
[-33.406149,-70.526608,'CMR2-01 - AML 10101','ARTURO MATTE LARRAIN 10101',0,3,0],
[-33.406149,-70.526608,'CMR2-02 - AML 10101','ARTURO MATTE LARRAIN 10101',0,3,0],
[-33.406276,-70.52652,'CMR2-03 - CG 2257','COLINA LA GLORIA 2257',0,3,0],
[-33.406276,-70.52652,'CMR2-04 - CG 2257','COLINA LA GLORIA 2257',0,3,0],
[-33.406911,-70.526042,'CMR2-05 - CG 2296','COLINA LA GLORIA 2296',0,3,0],
[-33.406911,-70.526042,'CMR2-06 - CG 2296','COLINA LA GLORIA 2296',0,3,0],
[-33.407732,-70.525758,'CMR2-07 - CG 2386','COLINA LA GLORIA 2386',0,3,0],
[-33.407732,-70.525758,'CMR2-08 - CG 2386','COLINA LA GLORIA 2386',0,3,0],
[-33.408666,-70.526045,'CMR2-09 - CG 2460','COLINA LA GLORIA 2460',0,3,0],
[-33.408666,-70.526045,'CMR2-10 - CG 2460','COLINA LA GLORIA 2460',0,3,0],
[-33.409419,-70.526634,'CMR2-11 - CG 2573','COLINA LA GLORIA 2573',0,3,0],
[-33.409419,-70.526634,'CMR2-12 - CG 2573','COLINA LA GLORIA 2573',0,3,0],
[-33.407984,-70.526967,'CMR2-13 - CM 2426','COLINA DEL MIRADOR 2426',0,3,0],
[-33.407984,-70.526967,'CMR2-14 - CM 2426','COLINA DEL MIRADOR 2426',0,3,0],
[-33.406731,-70.527413,'CMR2-15 - CM 2242','COLINA DEL MIRADOR 2242',0,3,0],
[-33.406731,-70.527413,'CMR2-16 - CM 2242','COLINA DEL MIRADOR 2242',0,3,0],
[-33.405358,-70.528993,'CMR3-01 - CM 1854','COLINA EL MIRADOR 1854',0,3,0],
[-33.405358,-70.528993,'CMR3-02 - CM 1854','COLINA EL MIRADOR 1854',0,3,0],
[-33.404457,-70.528919,'CMR3-03 - CG 1860','COLINA LA GLORIA 1860',0,3,0],
[-33.40472,-70.527712,'CMR3-04 - CG 1990','COLINA LA GLORIA 1990',0,3,0],
[-33.40472,-70.527712,'CMR3-05 - CG 1990','COLINA LA GLORIA 1990',0,3,0],
[-33.405252,-70.527194,'CMR3-06 - CG 2098','COLINA LA GLORIA 2098',0,3,0],
[-33.405252,-70.527194,'CMR3-07 - CG 2098','COLINA LA GLORIA 2098',0,3,0],
[-33.406333,-70.527694,'CMR3-08 - AML 10020','ARTURO MATTE LARRAIN 10020',0,3,0],
[-33.407083,-70.528197,'CMR3-09 - AML 2246','ARTURO MATTE LARRAIN 2246',0,3,0],
[-33.407083,-70.528197,'CMR3-10 - AML 2246','ARTURO MATTE LARRAIN 2246',0,3,0],
[-33.40774,-70.528383,'CMR3-11 - LC 1888','LA CUMBRE 1888',0,3,0],
[-33.408382,-70.528418,'CMR3-12 - AML 2468','ARTURO MATTE LARRAIN 2468',0,3,0],
[-33.408382,-70.528418,'CMR3-13 - AML 2468','ARTURO MATTE LARRAIN 2468',0,3,0],
[-33.409164,-70.527479,'CMR3-14 - CM 2580','COLINA EL MIRADOR 2580',0,3,0],
[-33.409164,-70.527479,'CMR3-15 - CM 2580','COLINA EL MIRADOR 2580',0,3,0],
[-33.407888,-70.525863,'CMR3-16 - CG 2393','COLINA LA GLORIA 2393',0,3,0],
[-33.40823,-70.523888,'CMR4-01 - CVH 2552','COLINA VISTA HERMOSA 2552',0,3,0],
[-33.40823,-70.523888,'CMR4-02 - CVH 2552','COLINA VISTA HERMOSA 2552',0,3,0],
[-33.40727,-70.524558,'CMR4-03 - CVH 2450','COLINA VISTA HERMOSA 2450',0,3,0],
[-33.40727,-70.524558,'CMR4-04 - CVH 2450','COLINA VISTA HERMOSA 2450',0,3,0],
[-33.40727,-70.524558,'CMR4-05 - CVH 2450','COLINA VISTA HERMOSA 2450',0,3,0],
[-33.407917,-70.524805,'CMR4-06 - SVF 2465','SAN VICENTE FERRER 2465',0,3,0],
[-33.407917,-70.524805,'CMR4-07 - SVF 2465','SAN VICENTE FERRER 2465',0,3,0],
[-33.409376,-70.525205,'CMR4-08 - SVF 2520','SAN VICENTE FERRER 2520',0,3,0],
[-33.409376,-70.525205,'CMR4-09 - SVF 2520','SAN VICENTE FERRER 2520',0,3,0],
[-33.410191,-70.525997,'CMR4-10 - SVF 2580','SAN VICENTE FERRER 2580',0,3,0],
[-33.410191,-70.525997,'CMR4-11 - SVF 2580','SAN VICENTE FERRER 2580',0,3,0],
[-33.410411,-70.52643,'CMR4-12 - SVF 2599','SAN VICENTE FERRER 2599',0,3,0],
[-33.410411,-70.52643,'CMR4-13 - SVF 2599','SAN VICENTE FERRER 2599',0,3,0],
[-33.410634,-70.527239,'CMR4-14 - SVF 2569','SAN VICENTE FERRER 2569',0,3,0],
[-33.409538,-70.528051,'CMR4-15 - AML 2559','ARTURO MATTE LARRAIN 2559',0,3,0],
[-33.409538,-70.528051,'CMR4-16 - AML 2559','ARTURO MATTE LARRAIN 2559',0,3,0],
[-33.41062,-70.527247,'CMR5-01 - SVF 2569','SAN VICENTE FERRER 2569',0,3,0],
[-33.410608,-70.528008,'CMR5-02 - SVF 2537','SAN VICENTE FERRER 2537',0,3,0],
[-33.410608,-70.528008,'CMR5-03 - SVF 2537','SAN VICENTE FERRER 2537',0,3,0],
[-33.410096,-70.528847,'CMR5-04 - SVF 2494','SAN VICENTE FERRER 2494',0,3,0],
[-33.410096,-70.528847,'CMR5-05 - SVF 2494','SAN VICENTE FERRER 2494',0,3,0],
[-33.40909,-70.529476,'CMR5-06 - SVF 2408','SAN VICENTE FERRER 2408',0,3,0],
[-33.40909,-70.529476,'CMR5-07 - SVF 2408','SAN VICENTE FERRER 2408',0,3,0],
[-33.408108,-70.529658,'CMR5-08 - SVF 2338','SAN VICENTE FERRER 2338',0,3,0],
[-33.408108,-70.529658,'CMR5-09 - SVF 2338','SAN VICENTE FERRER 2338',0,3,0],
[-33.407206,-70.529563,'CMR5-10 - SVF 2326','SAN VICENTE FERRER 2326',0,3,0],
[-33.407206,-70.529563,'CMR5-11 - SVF 2326','SAN VICENTE FERRER 2326',0,3,0],
[-33.407206,-70.529563,'CMR5-12 - SVF 2326','SAN VICENTE FERRER 2326',0,3,0],
[-33.406616,-70.529346,'CMR5-13 - SVF 2270','SAN VICENTE FERRER 2270',0,3,0],
[-33.405439,-70.528836,'CMR5-14 - CM 1891','COLINA DEL MIRADOR 1891',0,3,0],
[-33.405439,-70.528836,'CMR5-15 - CM 1891','COLINA DEL MIRADOR 1891',0,3,0],
[-33.405864,-70.527999,'CMR5-16 - CM 2080','COLINA DEL MIRADOR 2080',0,3,0],
[-33.403283,-70.518626,'LH-01 - GB 11724','GENERAL BLANCHE 11724',0,3,0],
[-33.403906,-70.51822,'LH-02 - LH 1850','LOS HUASOS 1850',0,3,0],
[-33.403906,-70.51822,'LH-03 - LH 1850','LOS HUASOS 1850',0,3,0],
[-33.404758,-70.517852,'LH-04 - LH 1948','LOS HUASOS 1948',0,3,0],
[-33.404758,-70.517852,'LH-05 - LH 1948','LOS HUASOS 1948',0,3,0],
[-33.40558,-70.517456,'LH-06 - LH 2044','LOS HUASOS 2044',0,3,0],
[-33.40558,-70.517456,'LH-07 - LH 2044','LOS HUASOS 2044',0,3,0],
[-33.405973,-70.517266,'LH-08 - LH 2090','LOS HUASOS 2090',0,3,0],
[-33.405973,-70.517266,'LH-09 - LH 2090','LOS HUASOS 2090',0,3,0],
[-33.40616,-70.517251,'LH-10 - QH 11725','QUEBRADA HONDA 11725',0,3,0],
[-33.40616,-70.517251,'LH-11 - QH 11725','QUEBRADA HONDA 11725',0,3,0],
[-33.385971,-70.53291,'RC-01 - RM 335','RIO MAULE 335',4,3,0],
[-33.386203,-70.533182,'RC-02 - RC 10146','RIO CLARO 10146',4,3,0],
[-33.386362,-70.533324,'RC-03 - RC 10132','RIO CLARO 10132',4,3,0],
[-33.386405,-70.533363,'RC-04 - RC 10129','RIO CLARO 10129',4,3,0],
[-33.386503,-70.533444,'RC-05 - RC 10117','RIO CLARO 10117',4,3,0],
[-33.386644,-70.533573,'RC-06 - RC 10103','RIO CLARO 10103',4,3,0],
[-33.387036,-70.534081,'RC-07 - RC 10045','RIO CLARO 10045',4,3,0],
[-33.387036,-70.534081,'RC-08 - RC 10045','RIO CLARO 10045',4,3,0],
[-33.38731,-70.534413,'RC-09 - C 299','CAMPANARIO 299',4,3,0],
[-33.38731,-70.534413,'RC-10 - C 299','CAMPANARIO 299',4,3,0],
[-33.411216,-70.599177,'EQ1-01 - CDA 2998','CRISTAL DE ABELI 2998',5,3,0],
[-33.411239,-70.599437,'EQ1-02 - CDA 2988','CRISTAL DE ABELI 2988',5,3,0],
[-33.411587,-70.599303,'EQ1-03 - EQ 3001','EL QUISCO 3001',5,3,0],
[-33.411587,-70.599303,'EQ1-04 - EQ 3001','EL QUISCO 3001',5,3,0],
[-33.41193,-70.598733,'EQ1-05 - EQ 3046','EL QUISCO 3046',5,3,0],
[-33.412039,-70.598549,'EQ1-06 - EQ 3052','EL QUISCO 3052',5,3,0],
[-33.412037,-70.598487,'EQ1-07 - EQ 3152','EL QUISCO 3152',5,3,0],
[-33.412154,-70.597813,'EQ1-08 - EQ 3140','EL QUISCO 3140',5,3,0],
[-33.412177,-70.597619,'EQ1-09 - EQ 3140','EL QUISCO 3140',5,3,0],
[-33.411559,-70.595758,'EQ2-01 - EQ 3311','EL QUISCO 3311',5,3,0],
[-33.411751,-70.595214,'EQ2-02 - EQ 3397','EL QUISCO 3397',5,3,0],
[-33.412009,-70.594902,'EQ2-03 - EQ 3438','EL QUISCO 3438',5,3,0],
[-33.412067,-70.595588,'EQ2-04 - EQ 3408','EL QUISCO 3408',5,3,0],
[-33.412067,-70.595588,'EQ2-05 - EQ 3408','EL QUISCO 3408',5,3,0],
[-33.412051,-70.59619,'EQ2-06 - EQ 3298','EL QUISCO 3298',5,3,0],
[-33.412139,-70.596997,'EQ2-07 - EQ 3180','EL QUISCO 3180',5,3,0],
[-33.412139,-70.596997,'EQ2-08 - EQ 3180','EL QUISCO 3180',5,3,0],
[-33.412139,-70.596997,'EQ2-09 - EQ 3180','EL QUISCO 3180',5,3,0],
[-33.394756,-70.525288,'PR1-01 - CPR 1322','CAMINO PIEDRA ROJA 1322',0,3,0],
[-33.394908,-70.52539,'PR1-02 - CPR 1320','CAMINO PIEDRA ROJA 1320',0,3,0],
[-33.395254,-70.525337,'PR1-03 - CPR 1323','CAMINO PIEDRA ROJA 1323',0,3,0],
[-33.395254,-70.525337,'PR1-04 - CPR 1323','CAMINO PIEDRA ROJA 1323',0,3,0],
[-33.395608,-70.525468,'PR1-05 - CPR 1335','CAMINO PIEDRA ROJA 1335',0,3,0],
[-33.395608,-70.525468,'PR1-06 - CPR 1335','CAMINO PIEDRA ROJA 1335',0,3,0],
[-33.396145,-70.525432,'PR1-07 - CPR 1357','CAMINO PIEDRA ROJA 1357',0,3,0],
[-33.396145,-70.525432,'PR1-08 - CPR 1357','CAMINO PIEDRA ROJA 1357',0,3,0],
[-33.39626,-70.525525,'PR1-09 - CPR 1357','CAMINO PIEDRA ROJA 1357',0,3,0],
[-33.396625,-70.525488,'PR1-10 - CPR 1391','CAMINO PIEDRA ROJA 1391',0,3,0],
[-33.396625,-70.525488,'PR1-11 - CPR 1391','CAMINO PIEDRA ROJA 1391',0,3,0],
[-33.397076,-70.525551,'PR1-12 - CPR 1411','CAMINO PIEDRA ROJA 1411',0,3,0],
[-33.397076,-70.525551,'PR1-13 - CPR 1411','CAMINO PIEDRA ROJA 1411',0,3,0],
[-33.397471,-70.525581,'PR1-14 - CPR 1426','CAMINO PIEDRA ROJA 1426',0,3,0],
[-33.397471,-70.525581,'PR1-15 - CPR 1426','CAMINO PIEDRA ROJA 1426',0,3,0],
[-33.397614,-70.526072,'PR1-16 - CPR 1429','CAMINO PIEDRA ROJA 1429',0,3,0],
[-33.398056,-70.525118,'PR2-01 - CPR 1434','CAMINO PIEDRA ROJA 1434',0,3,0],
[-33.398018,-70.525651,'PR2-02 - CPR 1439','CAMINO PIEDRA ROJA 1439',0,3,0],
[-33.398018,-70.525651,'PR2-03 - CPR 1439','CAMINO PIEDRA ROJA 1439',0,3,0],
[-33.398223,-70.525718,'PR2-04 - CPR 1442','CAMINO PIEDRA ROJA 1442',0,3,0],
[-33.398803,-70.525721,'PR2-05 - CPR 1452','CAMINO PIEDRA ROJA 1452',0,3,0],
[-33.398426,-70.525728,'PR2-06 - CPR 1442','CAMINO PIEDRA ROJA 1442',0,3,0],
[-33.398639,-70.525756,'PR2-07 - CPR 1464','CAMINO PIEDRA ROJA 1464',0,3,0],
[-33.398716,-70.525769,'PR2-08 - CPR 1464','CAMINO PIEDRA ROJA 1464',0,3,0],
[-33.399313,-70.525823,'PR2-09 - CPR 1468','CAMINO PIEDRA ROJA 1468',0,3,0],
[-33.399414,-70.525831,'PR2-10 - CPR 1468','CAMINO PIEDRA ROJA 1468',0,3,0],
[-33.400022,-70.525894,'PR2-11 - CPR 1534','CAMINO PIEDRA ROJA 1534',0,3,0],
[-33.400022,-70.525894,'PR2-12 - CPR 1534','CAMINO PIEDRA ROJA 1534',0,3,0],
[-33.400298,-70.525935,'PR2-13 - CPR 1561','CAMINO PIEDRA ROJA 1561',0,3,0],
[-33.400675,-70.525982,'PR2-14 - CPR 1569','CAMINO PIEDRA ROJA 1569',0,3,0],
[-33.400675,-70.525982,'PR2-15 - CPR 1569','CAMINO PIEDRA ROJA 1569',0,3,0],
[-33.401206,-70.526036,'PR2-16 - CEA 10439','CAMINO EL ALBA 10439',0,3,0],
[-33.387128,-70.518857,'LL-01 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,3,0],
[-33.387543,-70.519151,'LL-02 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,3,0],
[-33.387543,-70.519151,'LL-03 - CF 990','FRENTE A CAMINO LA FUENTE N°990',0,3,0],
[-33.387795,-70.519145,'LL-04 - CF 1011','FRENTE A CAMINO LA FUENTE N°1011',0,3,0],
[-33.387795,-70.519889,'LL-05 - CF 1005','FRENTE A CAMINO LA FUENTE N°1005',0,3,0],
[-33.388305,-70.51939,'LL-06 - CF 1017','FRENTE A CAMINO LA FUENTE N°1017',0,3,0],
[-33.38763,-70.519562,'LL-07 - LL 11300','FRENTE A LAS LAVANDULAS N°11300',0,3,0],
[-33.387533,-70.519539,'LL-08 - LL 11300','FRENTE A LAS LAVANDULAS N°11300',0,3,0],
[-33.387887,-70.518327,'LL-09 - CO 1025','FRENTE A CAMINO OTOÑAL N°1025',0,3,0],
[-33.399139,-70.546483,'I-01 - I 607','IRLANDA 607',4,3,0],
[-33.399051,-70.546438,'I-02 - I 610','IRLANDA 610',4,3,0],
[-33.399363,-70.546172,'I-03 - I 580','IRLANDA 580',4,3,0],
[-33.399363,-70.546172,'I-04 - I 580','IRLANDA 580',4,3,0],
[-33.399919,-70.546174,'I-05 - I 654','IRLANDA 654',4,3,0],
[-33.400482,-70.546178,'I-06 - I 676','IRLANDA 676',4,3,0],
[-33.400482,-70.546178,'I-07 - I 676','IRLANDA 676',4,3,0],
[-33.400962,-70.54618,'I-08 - I 729','IRLANDA 729',4,3,0],
[-33.401556,-70.546177,'I-09 - I 735','IRLANDA 735',4,3,0],
[-33.401556,-70.546177,'I-10 - I 735','IRLANDA 735',4,3,0],
[-33.402086,-70.54618,'I-11 - I 986','IRLANDA 986',4,3,0],
[-33.402086,-70.54618,'I-12 - I 986','IRLANDA 986',4,3,0],
[-33.389143,-70.534698,'PT-01 - P 365','PETEN 365',4,3,0],
[-33.389143,-70.534698,'PT-02 - P 365','PETEN 365',4,3,0],
[-33.38888,-70.535033,'PT-03 - P 348','PETEN 348',4,3,0],
[-33.38858,-70.535454,'PT-04 - P 330','PETEN 330',4,3,0],
[-33.38858,-70.535454,'PT-05 - P 330','PETEN 330',4,3,0],
[-33.388478,-70.536275,'PT-06 - P 256','PETEN 256',4,3,0],
[-33.388478,-70.536275,'PT-07 - P 265','PETEN 256',4,3,0],
[-33.388143,-70.535947,'PT-08 - P 290','PETEN 290',4,3,0],
[-33.388668,-70.536532,'PT-09 - P 217','PETEN 217',4,3,0],
[-33.388668,-70.536532,'PT-10 - P 217','PETEN 217',4,3,0],
[-33.389062,-70.537469,'PT-11 - T 161','TIKAL 161',4,3,0],
[-33.389062,-70.537469,'PT-12 - T 161','TIKAL 161',4,3,0],
[-33.389288,-70.536427,'PT-13 - T 213','TIKAL 213',4,3,0],
[-33.389288,-70.536427,'PT-14 - T 213','TIKAL 213',4,3,0],
[-33.388784,-70.536009,'PT-15 - T 256','TIKAL 256',4,3,0],
[-33.388784,-70.536009,'PT-16 - T 256','TIKAL 256',4,3,0],
[-33.386229,-70.516878,'MC-01 - M 940','MONTECASSINO 940',0,3,0],
[-33.385969,-70.517623,'MC-02 - M 934','MONTECASSINO 934',0,3,0],
[-33.385969,-70.517623,'MC-03 - M 934','MONTECASSINO 934',0,3,0],
[-33.386,-70.517763,'MC-04 - M 930','MONTECASSINO 930',0,3,0],
[-33.386,-70.517763,'MC-05 - M 930','MONTECASSINO 930',0,3,0],
[-33.386208,-70.518864,'MC-06 - M 912','MONTECASSINO 912',0,3,0],
[-33.386208,-70.518864,'MC-07 - M 912','MONTECASSINO 912',0,3,0],
[-33.384598,-70.517826,'MC-08 - CH 11655','CHARLES HAMILTON 11655',0,3,0],
[-33.385612,-70.519539,'MC-09 - CH 11509','CHARLES HAMILTON 11509',0,3,0],
[-33.385612,-70.519539,'MC-10 - CH 11509','CHARLES HAMILTON 11509',0,3,0],
[-33.418754,-70.520083,'GV-01 - ER 11111','EL REMANSO 11111',0,3,0],
[-33.418754,-70.520083,'GV-02 - ER 11111','EL REMANSO 11111',0,3,0],
[-33.418413,-70.519669,'GV-03 - ER N 77','EL REMANSO NORTE 77',0,3,0],
[-33.418248,-70.519467,'GV-04 - ER N 73','EL REMANSO NORTE 73',0,3,0],
[-33.417781,-70.518911,'GV-05 - ER N 65','EL REMANSO NORTE 65',0,3,0],
[-33.417467,-70.518596,'GV-06 - ER N 61','EL REMANSO NORTE 61',0,3,0],
[-33.417346,-70.518464,'GV-07 - ER N 57','EL REMANSO NORTE 57',0,3,0],
[-33.417346,-70.518464,'GV-08 - ER N 57','EL REMANSO NORTE 57',0,3,0],
[-33.417179,-70.517966,'GV-09 - ER N 53','EL REMANSO NORTE 53',0,3,0],
[-33.417179,-70.517966,'GV-10 - ER N 53','EL REMANSO NORTE 53',0,3,0],
[-33.417216,-70.517527,'GV-11 - ER N 49','EL REMANSO NORTE 49',0,3,0],
[-33.417216,-70.517527,'GV-12 - ER N 49','EL REMANSO NORTE 49',0,3,0],
[-33.417022,-70.517132,'GV-13 - ER GV','EL REMANSO GRAN VISTA',0,3,0],
[-33.417022,-70.517132,'GV-14-PTZ - ER GV','EL REMANSO GRAN VISTA',0,1,0],
[-33.415592,-70.517658,'GV-15-PTZ - CGV1','CAMINO GRAN VISTA 1',0,1,0],
[-33.415549,-70.518638,'GV-16-PTZ - CGV2','CAMINO GRAN VISTA 2',0,1,0],
[-33.416438,-70.519928,'GV-17-PTZ - CGV3','CAMINO GRAN VISTA 3',0,1,0],
[-33.416099,-70.521228,'GV-18-PTZ - CGV4','CAMINO GRAN VISTA 4',0,1,0],
[-33.373209,-70.510393,'CSAN1-01 - CSA 391','CAMINO SAN ANTONIO 391',0,3,0],
[-33.37282,-70.510456,'CSAN1-02 - CSA 294','CAMINO SAN ANTONIO 294',0,3,0],
[-33.37282,-70.510456,'CSAN1-03 - CSA 294','CAMINO SAN ANTONIO 294',0,3,0],
[-33.372422,-70.510645,'CSAN1-04 - CSA 279','CAMINO SAN ANTONIO 279',0,3,0],
[-33.372422,-70.510645,'CSAN1-05 - CSA 255','CAMINO SAN ANTONIO 255',0,3,0],
[-33.372164,-70.510959,'CSAN1-06 - CSA 110','CAMINO SAN ANTONIO 110',0,3,0],
[-33.371898,-70.511101,'CSAN1-07 - CSA 99','CAMINO SAN ANTONIO 99',0,3,0],
[-33.371737,-70.511149,'CSAN1-08 - CSA 99','CAMINO SAN ANTONIO 99',0,3,0],
[-33.371642,-70.511071,'CSAN1-09 - CSA 133','CAMINO SAN ANTONIO 133',0,3,0],
[-33.371642,-70.511071,'CSAN1-10-PTZ - CSA 133','CAMINO SAN ANTONIO 133',0,3,0],
[-33.371359,-70.511286,'CSAN1-11 - CSA 18','CAMINO SAN ANTONIO 18',0,3,0],
[-33.371353,-70.511362,'CSAN1-12 - CSA 89','CAMINO SAN ANTONIO 89',0,3,0],
[-33.370888,-70.511645,'CSAN1-13 - CSA 29','CAMINO SAN ANTONIO 29',0,3,0],
[-33.370849,-70.511361,'CSAN1-14 - CSA 51','CAMINO SAN ANTONIO 51',0,3,0],
[-33.375325,-70.509062,'CSAN2-01 - CSA 650','CAMINO SAN ANTONIO 650',0,3,0],
[-33.373871,-70.509866,'CSAN2-02 - CSA 405','CAMINO SAN ANTONIO 405',0,3,0],
[-33.373738,-70.509932,'CSAN2-03 - CSA 397','CAMINO SAN ANTONIO 397',0,3,0],
[-33.374966,-70.50925,'CSAN2-04 - CSA 641','CAMINO SAN ANTONIO 641',0,3,0],
[-33.373483,-70.510084,'CSAN2-05 - CSA 398','CAMINO SAN ANTONIO 398',0,3,0],
[-33.374128,-70.509759,'CSAN2-06 - CSA 480','CAMINO SAN ANTONIO 480',0,3,0],
[-33.375033,-70.509371,'CSAN2-07 - CSA 602','CAMINO SAN ANTONIO 602',0,3,0],
[-33.374089,-70.509869,'CSAN2-08 - CSA 410','CAMINO SAN ANTONIO 89',0,3,0],
[-33.374447,-70.509472,'CSAN2-09 - CSA 525','CAMINO SAN ANTONIO 525',0,3,0],
[-33.430769,-70.562437,'ELT2-01 - ET 2001','EL TOQUI 2001',4,3,0],
[-33.430769,-70.562437,'ELT2-02 - ET 2001','EL TOQUI 2001',4,3,0],
[-33.430497,-70.562345,'ELT2-03 - ET 1997','EL TOQUI 1977',4,3,0],
[-33.430403,-70.562314,'ELT2-04 - ET 1977','EL TOQUI 1977',4,3,0],
[-33.429992,-70.562182,'ELT2-05 - ET 1956','EL TOQUI 1956',4,3,0],
[-33.429642,-70.562134,'ELT2-06 - ET 1948','EL TOQUI 1948',4,3,0],
[-33.429188,-70.561954,'ELT2-07 - ET 1887','EL TOQUI 1887',4,3,0],
[-33.429612,-70.562655,'ELT2-08 - P 6420','PROGRESO 6420',4,3,0],
[-33.40684,-70.51101,'LB-01 - LB 2440','LOS BELLOTOS 2440',0,3,0],
[-33.40684,-70.51101,'LB-02-PTZ - LB 2440','LOS BELLOTOS 2440',0,1,0],
[-33.40586,-70.508984,'LB-03 - SA 2470','SANTOS APOSTOLES 2470',0,3,0],
[-33.424219,-70.556504,'JP-01 - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,3,0],
[-33.424208,-70.556447,'JP-02-PTZ - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,1,0],
[-33.424208,-70.556447,'JP-03 - JP ILC','JUAN PALAU & ISABEL LA CATOLICA',3,3,0],
[-33.423868,-70.556554,'JP-04 - JP 1570','JUAN PALAU 1570',3,3,0],
[-33.423868,-70.556554,'JP-05 - JP 1570','JUAN PALAU 1570',3,3,0],
[-33.423483,-70.556606,'JP-06 - JP 1512','JUAN PALAU 1512',3,3,0],
[-33.423483,-70.556606,'JP-07 - JP 1512','JUAN PALAU 1512',3,3,0],
[-33.422775,-70.556803,'JP-08 - JP 1403','JUAN PALAU 1403',3,3,0],
[-33.422775,-70.556803,'JP-09 - JP 1403','JUAN PALAU 1403',3,3,0],
[-33.422589,-70.556889,'JP-10 - JP 1366','JUAN PALAU 1366',3,3,0],
[-33.422568,-70.556833,'JP-11 - JP 1371','JUAN PALAU 1371',3,3,0],
[-33.422568,-70.556833,'JP-12 - JP 1371','JUAN PALAU 1371',3,3,0],
[-33.422168,-70.556821,'JP-13 - JP 1302','JUAN PALAU 1302',3,3,0],
[-33.422168,-70.556821,'JP-14 - JP 1302','JUAN PALAU 1302',3,3,0],
[-33.421707,-70.556715,'JP-15 - JP ADC','JUAN PALAU & ALONSO DE CAMARGO',3,3,0],
[-33.421714,-70.556754,'JP-16 - JP ADC','JUAN PALAU & ALONSO DE CAMARGO',3,3,0],
[-33.387393,-70.512808,'LHS-01 - LH FBC','F. Bulnes Correa Esquina Los Hermanos',0,3,0],
[-33.387393,-70.512808,'LHS-02 - LH FBC','F. Bulnes Correa Esquina Los Hermanos',0,3,0],
[-33.387393,-70.512808,'LHS-03-PTZ - LH FBC','F. Bulnes Correa Esquina Los Hermanos',0,1,0],
[-33.387671,-70.512206,'LHS-04 - LH 11844','Los Hermanos 11844',0,3,0],
[-33.387671,-70.512206,'LHS-05 - LH 11844','Los Hermanos 11844',0,3,0],
[-33.387757,-70.512045,'LHS-06 - LH SIS','Sta. Inez Sur Esquina Los Hermanos',0,3,0],
[-33.387795,-70.511903,'LHS-07 - LH 11868','Los Hermanos 11868',0,3,0],
[-33.387955,-70.511569,'LHS-08 - LH 11880','Los Hermanos 11880',0,3,0],
[-33.387955,-70.511569,'LHS-09 - LH 11880','Los Hermanos 11880',0,3,0],
[-33.387736,-70.511315,'LHS-10 - SIN 903','Sta. Inez Norte 903',0,3,0],
[-33.388363,-70.510682,'LHS-11 - LH 11946','Los Hermanos Esquina Los Maitenes',0,3,0],
[-33.388363,-70.510682,'LHS-12 - LM 942','Los Maitenes 938',0,3,0],
[-33.388363,-70.510682,'LHS-13 - LM 938','Los Maitenes 938',0,3,0],
[-33.388363,-70.510682,'LHS-14 - LM 938','Los Maitenes 942',0,3,0],
[-33.428783,-70.57466,'MBP-01-PTZ - MB 4441','MANUEL BARRIOS 4441',5,1,0],
[-33.428783,-70.57466,'MBP-02 - MB 4441 (O)','MANUEL BARRIOS 4441',5,3,0],
[-33.428802,-70.573837,'MBP-03 - MB 4513 (P)','MANUEL BARRIOS 4513',5,3,0],
[-33.428802,-70.573837,'MBP-04 - MB 4513 (O)','MANUEL BARRIOS 4513',5,3,0],
[-33.428781,-70.573626,'MBP-05 - MB 4569 (N)','MANUEL BARRIOS 4569',5,3,0],
[-33.428759,-70.573301,'MBP-06 - MB 4607 (N)','MANUEL BARRIOS 4607',5,3,0],
[-33.428749,-70.572998,'MBP-07 - MB 4674 (N)','MANUEL BARRIOS 4674',5,3,0],
[-33.428685,-70.572896,'MBP-08 - MB 4678 (P)','MANUEL BARRIOS 4678',5,3,0],
[-33.428685,-70.572896,'MBP-09- MB 4678 (O)','MANUEL BARRIOS 4678',5,3,0],
[-33.428663,-70.571873,'MBP-10 - MB 4841 (P)','MANUEL BARRIOS 4841',5,3,0],
[-33.428663,-70.571873,'MBP-11 - MB 4841 (O)','MANUEL BARRIOS 4841',5,3,0],
[-33.42861,-70.571703,'MBP-12 - MB 4855 (O)','MANUEL BARRIOS 4855',5,3,0],
[-33.428632,-70.571391,'MBP-13 - MB 4916 (P)','MANUEL BARRIOS 4916',5,3,0],
[-33.428562,-70.57109,'MBP-14 - MB 4993 (P)','MANUEL BARRIOS 4993',5,3,0],
[-33.428562,-70.57109,'MBP-15 - MB 4993 (SO)','MANUEL BARRIOS 4993',5,3,0],
[-33.428432,-70.570523,'MBP-16 - MB 5069 (SP)','MANUEL BARRIOS 5069',5,3,0],
[-33.417506,-70.542716,'PC-01 - P 1031','PICA 1031',3,3,0],
[-33.417506,-70.542716,'PC-02 - P 1031','PICA 1031',3,3,0],
[-33.417577,-70.542777,'PC-03 - P 1037','PICA 1037',3,3,0],
[-33.417753,-70.542711,'PC-04 - P 1041','PICA 1041',3,3,0],
[-33.417847,-70.54271,'PC-05 - P 1051','PICA 1051',3,3,0],
[-33.417847,-70.54271,'PC-06-PTZ - P 1051','PICA 1051',3,1,0],
[-33.41812,-70.542711,'PC-07 - P 1067','PICA 1067',3,3,0],
[-33.41812,-70.542711,'PC-08 - P 1067','PICA 1067',3,3,0],
[-33.418248,-70.542679,'PC-09 - P 1078','PICA 1078',3,3,0],
[-33.418389,-70.542704,'PC-10 - P 1082','PICA 1082',3,3,0],
[-33.418901,-70.592052,'H-01 - RS 3570','Renato Sanchez 3570',5,3,0],
[-33.419417,-70.591886,'H-02 - H 367','Hendaya 367',5,3,0],
[-33.419414,-70.591885,'H-03 - H 380','Hendaya 380',5,3,0],
[-33.419609,-70.591818,'H-04 - H 392','Hendaya 392',5,3,0],
[-33.419686,-70.591801,'H-05-PTZ - 395','Hendaya 395',5,1,0],
[-33.419766,-70.591777,'H-06 - H 402','Hendaya 402',5,3,0],
[-33.419842,-70.591753,'H-07 - H 413','Hendaya 413',5,3,0],
[-33.420143,-70.591661,'H-08 - H 438','Hendaya 438',5,3,0],
[-33.420468,-70.591549,'H-09 - H 488','Hendaya 488',5,3,0],
[-33.419842,-70.591753,'H-10 - H PH','Hendaya 413',5,3,0],
[-33.429609,-70.574433,'CAP-01-PTZ - CA 4475','Carlos Alvarado 4475',5,1,0],
[-33.429584,-70.573748,'CAP-02 - CA 4536','Carlos Alvarado 4536',5,3,0],
[-33.429584,-70.573748,'CAP-03 - CA 4536','Carlos Alvarado 4536',5,3,0],
[-33.429546,-70.573499,'CAP-04 - CA 4576','Carlos Alvarado 4576',5,3,0],
[-33.429483,-70.572598,'CAP-05 - CA 4740','Carlos Alvarado 4740',5,3,0],
[-33.429483,-70.572598,'CAP-06 - CA 4740','Carlos Alvarado 4740',5,3,0],
[-33.429438,-70.571643,'CAP-07 - CA 4888','Carlos Alvarado 4888',5,3,0],
[-33.429438,-70.571643,'CAP-08 - CA 4888','Carlos Alvarado 4888',5,3,0],
[-33.429408,-70.571227,'CAP-09 - CA 4944','Carlos Alvarado 4944',5,3,0],
[-33.429408,-70.571227,'CAP-10 - CA 4944','Carlos Alvarado 4944',5,3,0],
[-33.429384,-70.570712,'CAP-11 - CA 5024','Carlos Alvarado 5024',5,3,0],
[-33.429384,-70.570712,'CAP-12 - CA 5024','Carlos Alvarado 5024',5,3,0],
[-33.429367,-70.570442,'CAP-13 - CA 5080','Carlos Alvarado 5080',5,3,0],
[-33.429403,-70.570182,'CAP-14-PTZ - CA SE','Carlos Alvarado esquina Sebastian Elcano',5,1,0],
[-33.413791,-70.529836,'VACP-01 - VA CP','Vital Apoquindo esquina Carlos Peña Otaegui',0,3,0],
[-33.413791,-70.529836,'VACP-02-PTZ - VA CP','Vital Apoquindo esquina Carlos Peña Otaegui',0,1,0],
[-33.414035,-70.529686,'VACP-03 - VA 926','Vital Apoquindo 926',0,3,0],
[-33.414497,-70.529629,'VACP-04 - VA 929','Vital Apoquindo 929',0,3,0],
[-33.414596,-70.529576,'VACP-05 - VA 938','Vital Apoquindo 938',0,3,0],
[-33.414825,-70.529605,'VACP-06 - VA 933','Vital Apoquindo 933',0,3,0],
[-33.414964,-70.529568,'VACP-07 - VA 946','Vital Apoquindo 946',0,3,0],
[-33.415205,-70.529587,'VACP-08 - VA 937','Vital Apoquindo 937',0,3,0],
[-33.415205,-70.529587,'VACP-09 - VA 937','Vital Apoquindo 937',0,3,0],
[-33.420225,-70.565114,'CMU-01 - AVI 6012','Alberto Vial Infate 6000',5,3,0],
[-33.420225,-70.565114,'CMU-02 - AVI 6012','Alberto Vial Infate 6000',5,3,0],
[-33.420217,-70.565924,'CMU-03 - AVI 5922','Alberto Vial Infate 5922',5,3,0],
[-33.420809,-70.565071,'CMU-05 - ADC 6079','Alonso de Camargo 6079',5,3,0],
[-33.420785,-70.565498,'CMU-06 - ADC 6020','Alonso de Camargo 6020',5,3,0],
[-33.420785,-70.565498,'CMU-07 - ADC 6020','Alonso de Camargo 6020',5,3,0],
[-33.420547,-70.565969,'CMU-04 - AVI 5880','Alberto Vial Infate 5880',5,3,0],
[-33.420792,-70.566192,'CMU-08 - ADC 5845','Alonso de Camargo 5845',5,3,0],
[-33.420792,-70.566192,'CMU-09 - ADC 5845','Alonso de Camargo 5845',5,3,0],
[-33.420778,-70.566827,'CMU-10 - ADC M','Alonso de Camargo 5776',5,3,0],
[-33.420778,-70.566827,'CMU-11-PTZ - ADC M','Alonso de Camargo 5776',5,1,0],
[-33.420094,-70.566641,'CMU-12 - M 1231','Medinacelli 1231',5,3,0],
[-33.420094,-70.566641,'MI-01 - M 1231','Medinacelli 1231',5,3,0],
[-33.420366,-70.566726,'MI-02 - M 1237','Medinacelli 1237',5,3,0],
[-33.420765,-70.566791,'MI-03 - ADC M','Medinacelli Esquina Alonso de Camargo',5,3,0],
[-33.420755,-70.566401,'MI-04 - ADC 5870','Alonso de Camargo 5870',5,3,0],
[-33.421015,-70.566793,'MI-05 - M 1260','Medinacelli 1260',5,3,0],
[-33.421328,-70.566987,'MI-06 - M 1283','Medinacelli 1283',5,3,0],
[-33.421328,-70.566987,'MI-07 - M 1283','Medinacelli 1283',5,3,0],
[-33.421902,-70.567245,'MI-08 - DED 5455','Dra. Eloisa Díaz 5455',5,3,0],
[-33.421971,-70.567426,'MI-09 - M 1327','Medinacelli 1327',5,3,0],
[-33.422134,-70.567492,'MI-10-PTZ - M 1330','Medinacelli 1330',5,1,0],
[-33.422524,-70.567794,'MI-11 - M 1358','Medinacelli 1358',5,3,0],
[-33.421527,-70.568069,'MI-12 - DB 1311','Domingo Bondi 1311',5,3,0],
[-33.421761,-70.552705,'PP-01-PTZ - P 1241','Palenque 1219',3,1,0],
[-33.421761,-70.552705,'PP-02 - P 1219','Palenque 1219',3,3,0],
[-33.421851,-70.552688,'PP-03 - P 1192','Palenque 1192',3,3,0],
[-33.420881,-70.552467,'PP-04 - N 7562','Nicosia 7562',3,3,0],
[-33.421796,-70.552268,'PP-05 - P 7563','Pretoria 7563',3,3,0],
[-33.421796,-70.552268,'PP-06 - P 7563','Pretoria 7563',3,3,0],
[-33.421743,-70.551706,'PP-07 - P 7585','Pretoria 7585',3,3,0],
[-33.421689,-70.551097,'PP-08 - P H','Pretoria esquina Huampani',3,3,0],
[-33.421689,-70.551097,'PP-09 - P H','Pretoria esquina Huampani',3,3,0],
[-33.421335,-70.552439,'PP-10 - M 7563','Manitoba 7563',3,3,0],
[-33.421286,-70.551939,'PP-11 - M 7580','Manitoba 7580',3,3,0],
[-33.393324,-70.521922,'VLF-01 - CLF 1236','Camino La Fuente 1236',0,3,0],
[-33.393324,-70.521922,'VLF-02 - CLF 1236','Camino La Fuente 1236',0,3,0],
[-33.393144,-70.521858,'VLF-03 - CLF 1222','Camino La Fuente 1222',0,3,0],
[-33.393144,-70.521858,'VLF-04 - CLF 1222','Camino La Fuente 1222',0,3,0],
[-33.393144,-70.521858,'VLF-05 - PTZ - CLF 1222','Camino La Fuente 1222',0,1,0],
[-33.414106,-70.574713,'AMC-01 - AMC ROH','ANA MARIA CARRERA & ROSA OHIGGINS',5,3,0],
[-33.413964,-70.574253,'AMC-02 - AMC 5090','ANA MARIA CARRERA 5090',5,3,0],
[-33.413896,-70.574033,'AMC-03 - AMC 5140','ANA MARIA CARRERA 5140',5,3,0],
[-33.413896,-70.574033,'AMC-04-PTZ - AMC 5140','ANA MARIA CARRERA 5140',5,1,0],
[-33.413896,-70.574033,'AMC-05 - AMC 5140','ANA MARIA CARRERA 5140',5,3,0],
[-33.413823,-70.573806,'AMC-06 - AMC 5155','ANA MARIA CARRERA 5155',5,3,0],
[-33.4137,-70.573424,'AMC-07 - AMC 5226','ANA MARIA CARRERA 5226',5,3,0],
[-33.4137,-70.573424,'AMC-08 - AMC 5226','ANA MARIA CARRERA 5226',5,3,0],
[-33.421499,-70.540105,'CTADC-01 - V 1381 (N)','Visviri 1371',3,3,0],
[-33.421706,-70.540552,'CTADC-02 - C 8891 (O)','Chapiquiña 8891',3,3,0],
[-33.421706,-70.540552,'CTADC-03 - C 8891 (P)','Chapiquiña 8891',3,3,0],
[-33.421739,-70.540766,'CTADC-04 - C 8875 (N)','Chapiquiña 8875',3,3,0],
[-33.421196,-70.540781,'CTADC-05 - T 1350 (N)','Toconce 1350',3,3,0],
[-33.421196,-70.540781,'CTADC-06 - T 1350 (S)','Toconce 1350',3,3,0],
[-33.421791,-70.541051,'CTADC-07 - C 8851 (O)','Chapiquiña 8851',3,3,0],
[-33.421791,-70.541051,'CTADC-08 - C 8851 (N)','Chapiquiña 8851',3,3,0],
[-33.421791,-70.541051,'CTADC-09 - C 8851 (P)','Chapiquiña 8851',3,3,0],
[-33.421696,-70.541369,'CTADC-10-PTZ - A 1391','Ayquina 1391',3,1,0],
[-33.422294,-70.541391,'CTADC-11 - A RG (N)','Ayquina & Roberto Guzman',3,3,0],
[-33.421346,-70.541369,'CTADC-12 - A 1350 (S)','Ayquina 1350',3,3,0],
[-33.421346,-70.541369,'CTADC-13- A 1350 (N)','Ayquina 1350',3,3,0],
[-33.397688,-70.522583,'LFM-02-PTZ - CLF 1406','Camino La Fuente 1406',0,1,0],
[-33.397688,-70.522583,'LFM-01 - CLF 1406','Camino La Fuente 1406',0,3,0],
[-33.397009,-70.522487,'LFM-03 - CLF 1398','Camino La Fuente 1392',0,3,0],
[-33.413844,-70.563332,'R-01 - R 6367','Roncesvalles 6367',4,3,0],
[-33.413897,-70.563039,'R-02 - R 6391','Roncesvalles 6391',4,3,0],
[-33.413897,-70.563039,'R-03 - R 6391','Roncesvalles 6391',4,3,0],
[-33.413899,-70.563015,'R-04 - R 6415','Roncesvalles 6415',4,3,0],
[-33.414066,-70.562322,'R-05 - R 6467','Roncesvalles 6467',4,3,0],
[-33.414066,-70.562322,'R-06 - R 6467','Roncesvalles 6467',4,3,0],
[-33.414095,-70.562163,'R-07-PTZ - R 6491','Roncesvalles 6535',4,1,0],
[-33.414142,-70.561917,'R-08 - R 6529','Roncesvalles Esquina Bello Horizonte',4,3,0],
[-33.414308,-70.561536,'R-09 - R BH','Roncesvalles 6491',4,3,0],
[-33.419017,-70.581153,'AYCDS-01 - S 626','Soria 626',5,3,0],
[-33.419017,-70.581153,'AYCDS-02 - S 626','Soria 626',5,3,0],
[-33.418601,-70.580616,'AYCDS-03 - A CDS','Albacete Esquina Cruz del Sur',5,3,0],
[-33.419007,-70.580339,'AYCDS-04 - CDS 706','Cruz del Sur 706',5,3,0],
[-33.419007,-70.580339,'AYCDS-05 - CDS 706','Cruz del Sur 706',5,3,0],
[-33.419269,-70.580133,'AYCDS-06-PTZ - CDS 740','Cruz del Sur 740',5,1,0],
[-33.419498,-70.579961,'AYCDS-07 - CDS 788','Cruz del Sur 788',5,3,0],
[-33.419682,-70.579837,'AYCDS-08 - C 4515','Cuenca 4515',5,3,0],
[-33.424134,-70.541343,'AP-01 - A AF','Ayquina Esquina Alexander Fleming',3,3,0],
[-33.424408,-70.541286,'AP-02 - A 1658','Ayquina 1658',3,3,0],
[-33.424763,-70.541234,'AP-03 - LG 8809','La Guaica 8809',3,3,0],
[-33.424904,-70.541215,'AP-04 - A 1709','Ayquina 1709',3,3,0],
[-33.424966,-70.541199,'AP-05 - A 1712','Ayquina 1712',3,3,0],
[-33.424966,-70.541199,'AP-06-PTZ - A 1712','Ayquina 1712',3,1,0],
[-33.425023,-70.541309,'AP-07 - P 8790','Pachica 8790',3,3,0],
[-33.425104,-70.541891,'AP-08 - P 8763','Pachica 8763',3,3,0],
[-33.425104,-70.541891,'AP-09 - P 8763','Pachica 8763',3,3,0],
[-33.425148,-70.542364,'AP-10 - P 8732','Pachica 8732',3,3,0],
[-33.425148,-70.542364,'AP-11 - P 8732','Pachica 8732',3,3,0],
[-33.425203,-70.542865,'AP-12 - P A','Pachica Esquina Alhue',3,3,0],
[-33.403064,-70.567532,'VSL-01 - CP 6560','Cerro el Plomo 6560',5,3,0],
[-33.403064,-70.567532,'VSL-02 - CP 6560','Cerro el Plomo 6560',5,3,0],
[-33.402696,-70.566684,'VSL-03 - CP 6578','Cerro el Plomo 6578',5,3,0],
[-33.403044,-70.567491,'VSL-04 - CP 6596','Cerro el Plomo 6596',5,3,0],
[-33.402555,-70.566316,'VSL-05-PTZ - CP E','Cerro el Plomo Esquina Estocolmo',5,1,0],
[-33.401637,-70.566829,'VSL-06 - E 659','Estocolmo 659',5,3,0],
[-33.401681,-70.567978,'VSL-07 - PR 6583','Presidente Riesco 6583',5,3,0],
[-33.414504,-70.532499,'ME-01-PTZ - PLA LDC','Loma del Canelo Esquina La Escuela',0,1,0],
[-33.414577,-70.532196,'ME-02 - LDC 9503','Loma del Canelo 9503',0,3,0],
[-33.414514,-70.532485,'ME-03 - LDC 9504','Loma del Canelo 9504',0,3,0],
[-33.414713,-70.531784,'ME-04 - LDC 9510','Loma del Canelo 9510',0,3,0],
[-33.415047,-70.531478,'ME-05 - LDC 9514','Loma del Canelo 9514',0,3,0],
[-33.415047,-70.531478,'ME-06 - LDC 9514','Loma del Canelo 9514',0,3,0],
[-33.415175,-70.531335,'ME-07 - LDC 9517','Loma del Canelo 9517',0,3,0],
[-33.415557,-70.53084,'ME-08 - LDC 9524','Loma del Canelo 9524',0,3,0],
[-33.414861,-70.531211,'ME-09 - LV 952','Loma Verde 952',0,3,0],
[-33.414759,-70.531135,'ME-10 - LV 948','Loma Verde 948',0,3,0],
[-33.414027,-70.531344,'ME-11 - LV 933','Loma Verde 933',0,3,0],
[-33.411935,-70.563665,'GDLR-01 - LA 533','LOS ALMENDROS 533',4,3,0],
[-33.411935,-70.563665,'GDLR-02-PTZ - LA 533','LOS ALMENDROS 533',4,1,0],
[-33.411892,-70.563613,'GDLR-03 - GDLR LA','GONZALO DE LOS RIOS & LOS ALMENDROS',4,3,0],
[-33.4118,-70.563545,'GDLR-04 - GDLR 5627','GONZALO DE LOS RIOS 5627',4,3,0],
[-33.411619,-70.563396,'GDLR-05 - GDLR 6524','GONZALO DE LOS RIOS 6524',4,3,0],
[-33.41154,-70.563333,'GDLR-06 - GDLR 6523','GONZALO DE LOS RIOS 6523',4,3,0],
[-33.41154,-70.563333,'GDLR-07 - GDLR 6523','GONZALO DE LOS RIOS 6523',4,3,0],
[-33.411459,-70.563272,'GDLR-08 - GDLR 6511','GONZALO DE LOS RIOS 6511',4,3,0],
[-33.411212,-70.563113,'GDLR-09 - GDLR 6515','GONZALO DE LOS RIOS 6515',4,3,0],
[-33.410897,-70.562866,'GDLR-10 - GDLR IV C','GONZALO DE LOS RIOS & IV CENTENARIO',4,3,0],
[-33.399185,-70.573449,'CCYK1-01-PTZ - PK 5853','PDTE. KENNEDY 5853',5,1,0],
[-33.399185,-70.573449,'CCYK1-02 - PK 5853','PDTE. KENNEDY 5853',5,3,0],
[-33.398998,-70.573077,'CCYK1-03 - PK 5933','PDTE. KENNEDY 5933',5,3,0],
[-33.398998,-70.573077,'CCYK1-04 - PK 5933','PDTE. KENNEDY 5933',5,3,0],
[-33.398904,-70.572826,'CCYK1-05 - PK 5947','PDTE. KENNEDY 5947',5,3,0],
[-33.398904,-70.572826,'CCYK1-06 - PK 5947','PDTE. KENNEDY 5947',5,3,0],
[-33.398784,-70.572162,'CCYK1-07 - MN 952','MANQUEHUE NORTE 952',5,3,0],
[-33.398784,-70.572162,'CCYK1-08 - MN 952','MANQUEHUE NORTE 952',5,3,0],
[-33.39914,-70.571055,'CCYK1-09 - MN 952','MANQUEHUE NORTE 952',5,3,0],
[-33.39914,-70.571055,'CCYK1-10 - MN 952','MANQUEHUE NORTE 952',5,3,0],
[-33.400659,-70.570294,'CCYK2-01-PTZ - MN CC','MANQUEHUE NORTE & CERRO COLORADO',5,1,0],
[-33.400717,-70.571273,'CCYK2-02 - CC 6036','CERRO COLORADO 6036',5,3,0],
[-33.400717,-70.571273,'CCYK2-03 - CC 6036','CERRO COLORADO 6036',5,3,0],
[-33.400855,-70.571924,'CCYK2-04 - CC 6028','CERRO COLORADO 6028',5,3,0],
[-33.400855,-70.571924,'CCYK2-05 - CC 6028','CERRO COLORADO 6028',5,3,0],
[-33.400931,-70.572243,'CCYK2-06 - CC 6010','CERRO COLORADO 6010',5,3,0],
[-33.425693,-70.556796,'FJPL-01 - JP 1666','Juan Palau 1643',3,3,0],
[-33.425889,-70.556826,'FJPL-02 PTZ - JP 1669','Juan Palau 1669',3,1,0],
[-33.425885,-70.556684,'FJPL-03 - JP JP','Juan Palau Int 7210',3,3,0],
[-33.426281,-70.556906,'FJPL-04 - JP 1685','Juan Palau 1685',3,3,0],
[-33.426281,-70.556906,'FJPL-05 - JP 1685','Juan Palau 1685',3,3,0],
[-33.426572,-70.556957,'FJPL-06 - JP 1696','Juan Palau 1696',3,3,0],
[-33.426768,-70.556987,'FJPL-07 - JP 1713','Juan Palau 1713',3,3,0],
[-33.426768,-70.556987,'FJPL-08 - JP 1713','Juan Palau 1713',3,3,0],
[-33.426682,-70.556778,'FJPL-09 - PJP 1718','Pje Juan Palau 1718',3,3,0],
[-33.426644,-70.556642,'FJPL-10 - PJP 1706','Pje Juan Palau 1706',3,3,0],
[-33.426644,-70.556642,'FJPL-11 - PJP 1706','Pje Juan Palau 1706',3,3,0],
[-33.426227,-70.556531,'FJPL-12 - PA 7220','Pje Albania 7220',3,3,0],
[-33.426227,-70.556531,'FJPL-13 - PA 7220','Pje Albania 7220',3,3,0],
[-33.425931,-70.556054,'FJPL-14 - PA 7253','Pje Albania 7253',3,3,0],
[-33.425931,-70.556054,'FJPL-15 - PA 7253','Pje Albania 7253',3,3,0],
[-33.425885,-70.556684,'FJPL-16 - JP JP','Juan Palau Int 7210',3,3,0],
[-33.389056,-70.527626,'E820-01 - E 820','Estoril 855',4,3,0],
[-33.388717,-70.52804,'E820-02 - E 820','Estoril 785',4,3,0],
[-33.388855,-70.527873,'E820-03-PTZ - E 820','Estoril 820',4,1,0],
[-33.409151,-70.535583,'LLS-01 - LL AS','Las Lomas & Almirante Soublette',0,3,0],
[-33.409471,-70.535485,'LLS-02 - LL 547','Las Lomas 547',0,3,0],
[-33.409962,-70.535298,'LLS-03 - LL 585','Las Lomas 585',0,3,0],
[-33.410339,-70.535147,'LLS-04 - LL 628','Las Lomas 628',0,3,0],
[-33.410339,-70.535147,'LLS-05 - LL 628','Las Lomas 628',0,3,0],
[-33.41077,-70.534989,'LLS-06 - LL 684','Las Lomas 684',0,3,0],
[-33.41077,-70.534989,'LLS-07 - LL 684','Las Lomas 684',0,3,0],
[-33.410932,-70.534919,'LLS-08-PTZ - LL 701','Las Lomas 701',0,1,0],
[-33.411216,-70.534776,'LLS-09 - LL 739','Las Lomas 739',0,3,0],
[-33.411216,-70.534776,'LLS-10 - LL 739','Las Lomas 739',0,3,0],
[-33.41177,-70.534273,'LLS-11 - LL 824','Las Lomas 824',0,3,0],
[-33.41177,-70.534273,'LLS-12 - LL 824','Las Lomas 824',0,3,0],
[-33.41203,-70.533882,'LLS-13 - LL 892','Las Lomas 892',0,3,0],
[-33.424267,-70.547802,'PGC-01 - PJGC 8098','Pintor José Gil de Castro 8098',3,3,0],
[-33.424281,-70.548063,'PGC-02 - PJGC 8119','Pintor José Gil de Castro 8119',3,3,0],
[-33.424352,-70.548447,'PGC-03 - PJGC 8059','Pintor José Gil de Castro 8059',3,3,0],
[-33.424352,-70.548447,'PGC-04 - PJGC 8059','Pintor José Gil de Castro 8059',3,3,0],
[-33.424429,-70.549283,'PGC-05 - PJGC 7984','Pintor José Gil de Castro 7984',3,3,0],
[-33.424429,-70.549283,'PGC-06 - PSGC 7984','Pintor José Gil de Castro 7984',3,3,0],
[-33.424492,-70.549806,'PGC-07-PTZ - PJS 1337','Pintor José Gil de Castro 7911',3,1,0],
[-33.424515,-70.55005,'PGC-08 - PSGC 7899','Pintor José Gil de Castro 7899',3,3,0],
[-33.424515,-70.55005,'PGC-09 - PJGC 7899','Pintor José Gil de Castro 7899',3,3,0],
[-33.424595,-70.550672,'PGC-10 - PJGC 7838','Pintor José Gil de Castro 7838',3,3,0],
[-33.424595,-70.550672,'PGC-11 - PJGC 7838','Pintor José Gil de Castro 7838',3,3,0],
[-33.424686,-70.551535,'PGC-12 - PJGC 7760','Pintor José Gil de Castro 7760',3,3,0],
[-33.424686,-70.551535,'PGC-13 - PJGC 7759','Pintor José Gil de Castro 7759',3,3,0],
[-33.416755,-70.578772,'SP-01 - SP DI','San Pascual & Del Inca',5,3,0],
[-33.417106,-70.578452,'SP-02 - SP 540','San Pascual 540',5,3,0],
[-33.41741,-70.578241,'SP-03 - SP 601','San Pascual 601',5,3,0],
[-33.417672,-70.578058,'SP-04 - SP 648','San Pascual 660',5,3,0],
[-33.417757,-70.577997,'SP-05 - SP 687','San Pascual 687',5,3,0],
[-33.417928,-70.577875,'SP-06 - SP 736','San Pascual 725',5,3,0],
[-33.418017,-70.577812,'SP-07 - SP 750','San Pascual 750',5,3,0],
[-33.41821,-70.577674,'SP-08 - SP 796','San Pascual 796',5,3,0],
[-33.418309,-70.577602,'SP-09 - SP 851','San Pascual 851',5,3,0],
[-33.418581,-70.577376,'SP-10 - SP 860','San Pascual 877',5,3,0],
[-33.418672,-70.577197,'SP-11-PTZ - SP MDZ','San Pascual & Martín de Zamora',5,1,0],
[-33.417106,-70.578452,'SP-12 - SP 541','San Pascual 540',5,3,0],
[-33.418035,-70.580161,'FDA2-01 - FDA 539','FELIX DE AMESTI 539',5,3,0],
[-33.418387,-70.579943,'FDA2-02 - FDA 594','FELIX DE AMESTI 594',5,3,0],
[-33.418387,-70.579943,'FDA2-03 - FDA 594','FELIX DE AMESTI 594',5,3,0],
[-33.418734,-70.579718,'FDA2-04 - FDA 700','FELIX DE AMESTI 700',5,3,0],
[-33.419205,-70.579385,'FDA2-05 - FDA 722','FELIX DE AMESTI 722',5,3,0],
[-33.419205,-70.579385,'FDA2-06 - FDA 722','FELIX DE AMESTI 722',5,3,0],
[-33.419328,-70.579458,'FDA2-07 - C 4542','CUENCA 4542',5,3,0],
[-33.419299,-70.579312,'FDA2-08-PTZ - FDA C','FELIX DE AMESTI & CUENCA',5,1,0],
[-33.419567,-70.579096,'FDA2-09 - FDA 776','FELIX DE AMESTI 776',5,3,0],
[-33.419567,-70.579096,'FDA2-10 - FDA 776','FELIX DE AMESTI 776',5,3,0],
[-33.419903,-70.578822,'FDA2-11 - FDA 828','FELIX DE AMESTI 828',5,3,0],
[-33.419903,-70.578822,'FDA2-12 - FDA 828','FELIX DE AMESTI 828',5,3,0],
[-33.420249,-70.578511,'FDA2-13 - FDA MDZ','FELIX DE AMESTI & MARTIN DE ZAMORA',5,3,0],
[-33.424502,-70.539469,'PLP-01 - PLP 1633','Padre Le Paige 1633',3,3,0],
[-33.424502,-70.539469,'PLP-02 - PLP 1633','Padre Le Paige 1633',3,3,0],
[-33.424502,-70.539469,'PLP-03-PTZ - PLP 1633','Padre Le Paige 1633',3,1,0],
[-33.425041,-70.539384,'PLP-04 - PLP 1683','Padre Le Paige 1683',3,3,0],
[-33.425124,-70.539281,'PLP-05 - PLP 1699','Padre Le Paige 1699',3,3,0],
[-33.424695,-70.53894,'PLP-06 - PLP 1750','Padre Le Paige 1750',3,3,0],
[-33.424695,-70.53894,'PLP-07 - PLP 1750','Padre Le Paige 1750',3,3,0],
[-33.42429,-70.538881,'PLP-08 - PLP 1776','Padre Le Paige 1776',3,3,0],
[-33.42429,-70.538881,'PLP-09 - PLP 1776','Padre Le Paige 1776',3,3,0],
[-33.423826,-70.538827,'PLP-10 - PLP F','Padre Le Paige & Alejandro Fleming',3,3,0],
[-33.423826,-70.538827,'PLP-11 - PLP F','Padre Le Paige & Alejandro Fleming',3,3,0],
[-33.423859,-70.539444,'PLP-12 - PLP F','Alejandro Fleming 8904',3,3,0],
[-33.423859,-70.539444,'PLP-13 - PLP F','Alejandro Fleming 8904',3,3,0],
[-33.407608,-70.557514,'RDA-01 - A 6934','Apoquindo 6960',4,3,0],
[-33.407594,-70.55762,'RDA-02 - A 6934','Apoquindo 6954',4,3,0],
[-33.407566,-70.55784,'RDA-03-PTZ - A 6934','Apoquindo 6934',4,1,0],
[-33.412357,-70.548911,'Y-01 - Y DEP','YAGUERO & DOCTORA ERNESTINA PEREZ',4,3,0],
[-33.412397,-70.549015,'Y-02 - Y 7783','YAGUERO 7783',4,3,0],
[-33.412644,-70.549278,'Y-03 - Y 77769','YAGUERO 7769',4,3,0],
[-33.412644,-70.549278,'Y-04 - Y 7769','YAGUERO 7769',4,3,0],
[-33.412947,-70.549589,'Y-05 - Y 7750','YAGUERO 7750',4,3,0],
[-33.412947,-70.549589,'Y-06-PTZ - Y 7750','YAGUERO 7750',4,1,0],
[-33.412947,-70.549589,'Y-07 - Y 7751','YAGUERO 7751',4,3,0],
[-33.412947,-70.549589,'Y-08 - Y 7751','YAGUERO 7751',4,3,0],
[-33.41328,-70.549951,'Y-09 - Y 7735','YAGUERO 7735',4,3,0],
[-33.413464,-70.550177,'Y-10 - Y 595','YELCHO 595',4,3,0],
[-33.41345,-70.550121,'Y-11 - Y 611','YELCHO 611',4,3,0],
[-33.41345,-70.550121,'Y-12 - Y 611','YELCHO 611',4,3,0],
[-33.41328,-70.549951,'Y-13 - Y 7734','YAGUERO 7734',4,3,0],
[-33.400637,-70.547046,'BO-01 - BO 532','Bocaccio 532',4,3,0],
[-33.400732,-70.546819,'BO-02 - BO 560','Bocaccio 560',4,3,0],
[-33.400732,-70.546819,'BO-03-PTZ - BO 560','Bocaccio 560',4,1,0],
[-33.400878,-70.546388,'BO-04 - BO 588','Bocaccio 588',4,3,0],
[-33.400878,-70.546388,'BO-05 - BO 588','Bocaccio 588',4,3,0],
[-33.400977,-70.546173,'BO-06 - BO I','Bocaccio & Irlanda',4,3,0],
[-33.400899,-70.545605,'BO-07 - BO 648','Bocaccio 648',4,3,0],
[-33.400884,-70.54529,'BO-08 - BO 654','Bocaccio 654',4,3,0],
[-33.400871,-70.545165,'BO-09 - BO 675','Bocaccio 675',4,3,0],
[-33.400861,-70.54479,'BO-10 - BO 709','Bocaccio 709',4,3,0],
[-33.412721,-70.515347,'AT2-01 - A 11431','Atalaya 11431',0,3,0],
[-33.413177,-70.515341,'AT2-02 - A 11521','Atalaya 11521',0,3,0],
[-33.413177,-70.515341,'AT2-03 - A 11521','Atalaya 11521',0,1,0],
[-33.413373,-70.515406,'AT2-04 - A 11515','Atalaya 11515',0,3,0],
[-33.413052,-70.516314,'AT2-05 - A 11457','Atalaya 11457',0,3,0],
[-33.412994,-70.516333,'AT2-06 - A 11460','Atalaya 11460',0,3,0],
[-33.413013,-70.516356,'AT2-07 - A 11427','Atalaya 11427',0,3,0],
[-33.412824,-70.516842,'AT2-08 - A 11337','Atalaya 11373',0,3,0],
[-33.412688,-70.517205,'AT2-09 - A 11328','Atalaya 11328',0,3,0],
[-33.427903,-70.545132,'LSI-01 - MCV 8471','Manuel Claro vial 8471',3,3,0],
[-33.427953,-70.545613,'LSI-02 - MCV 8443','Manuel Claro vial 8443',3,3,0],
[-33.429102,-70.545193,'LSI-08 - LS 1989','Luis Strozzi 1989',3,3,0],
[-33.428433,-70.545373,'LSI-03 - LS 1922','Luis Strozzi 1920',3,3,0],
[-33.428405,-70.547422,'LSI-04 - LS 1922','Luis Strozzi 1922',3,3,0],
[-33.428691,-70.545252,'LSI-05 - LS 1954','Luis Strozzi 1954',3,3,0],
[-33.428691,-70.545252,'LSI-07-PTZ - LS 1954','Luis Strozzi 1954',3,1,0],
[-33.428691,-70.545252,'LSI-06 - LS 1954','Luis Strozzi 1954',3,3,0],
[-33.429263,-70.545183,'LSI-09 - LS FB','Luis Strozzi & Av. Francisco Bilbao',3,3,0],
[-33.429263,-70.545183,'LSI-10 - LS FB','Luis Strozzi & Av. Francisco Bilbao',3,3,0],
[-33.415975,-70.558658,'DH-01 - LP 6828','Los Pozos 6828',4,3,0],
[-33.416015,-70.558393,'DH-02 - LP 6828','Los Pozos 6828',4,3,0],
[-33.416015,-70.558393,'DH-03 - LP 6828','Los Pozos 6828',4,1,0],
[-33.416152,-70.570194,'PMZR-01 - MDZ LR','Martin de Zamora & La Reconquista',5,3,0],
[-33.416515,-70.57005,'PMZR-02 - MDZ 5485','Pasaje Martin de Zamora 5485',5,3,0],
[-33.416515,-70.57005,'PMZR-03 - MDZ 5485','Pasaje Martin de Zamora 5485',5,3,0],
[-33.416581,-70.569964,'PMZR-04-PTZ - MDZ 5511','Pasaje Martin de Zamora 5511',5,1,0],
[-33.416703,-70.569923,'PMZR-05 - MDZ 5509','Pasaje Martin de Zamora 5509',5,3,0],
[-33.416893,-70.56985,'PMZR-06 - MDZ 5505','Pasaje Martin de Zamora 5505',5,3,0],
[-33.429549,-70.554328,'N-01 - N TM','Ñandu & Tomas Moro',3,3,0],
[-33.429657,-70.553729,'N-02 - N 7547','Ñandu 7547',3,3,0],
[-33.429657,-70.553729,'N-03 - N 7547','Ñandu 7547',3,3,0],
[-33.429629,-70.553598,'N-04-PTZ - N 7567','Ñandu 7567',3,1,0],
[-33.429573,-70.553317,'N-06 - N 7628','Ñandu 7628',3,3,0],
[-33.429596,-70.553202,'N-05 - N 7611','Ñandu 7611',3,3,0],
[-33.429505,-70.552822,'N-07 - P 1962','Polcura 1962',3,3,0],
[-33.429505,-70.552822,'N-08 - N P','Ñandu & Polcura',3,3,0],
[-33.402193,-70.552517,'PE-01 - PE LDM','Padre Errazuriz & Lorenzo de Medicis',4,3,0],
[-33.402738,-70.552703,'PE-02 - PE 7583','Padre Errazuriz 7583',4,3,0],
[-33.403136,-70.552915,'PE-05 - PE 7541','Padre Errazuriz 7541',4,3,0],
[-33.403003,-70.552938,'PE-04-PTZ - PE 7514','Padre Errazuriz 7514',4,1,0],
[-33.402653,-70.552759,'PE-03 - PE 7550','Padre Errazuriz 7550',4,3,0],
[-33.403179,-70.553032,'PE-06 - PE 7478','Padre Errazuriz 7478',4,3,0],
[-33.403222,-70.552949,'PE-07 - PE 7483','Padre Errazuriz 7483',4,3,0],
[-33.403423,-70.553049,'PE-08 - PE 7451','Padre Errazuriz 7451',4,3,0],
[-33.403505,-70.553102,'PE-09 - PE 7442','Padre Errazuriz 7442',4,3,0],
[-33.403583,-70.553141,'PE-10 - PE 7433','Padre Errazuriz 7433',4,3,0],
[-33.403714,-70.553231,'PE-11 - PE 7412','Padre Errazuriz 7412',4,3,0],
[-33.425374,-70.540229,'LGN-01 - LG 8888 (N)','Luisa Guzman 8888',3,3,0],
[-33.425393,-70.54047,'LGN-02 - LG 8867 (N)','Luisa Guzman 8867',3,3,0],
[-33.425427,-70.540631,'LGN-03 - LG 8846 (S)','Luisa Guzman 8846',3,3,0],
[-33.425463,-70.540859,'LGN-04 - LG 8832 (O)','Luisa Guzman 8832',3,3,0],
[-33.425473,-70.54099,'LGN-05 - LG 8810 (O)','Luisa Guzman 8810',3,3,0],
[-33.425473,-70.54099,'LGN-06 - LG 8810 (P)','Luisa Guzman 8810',3,3,0],
[-33.425654,-70.541109,'LGN-07 - A 1723 (P)','Luisa Guzman 1723',3,3,0],
[-33.425479,-70.541165,'LGN-08 - LG A (N)','Ayquina 1723',3,3,0],
[-33.425524,-70.541392,'LGN-09 - LG 8792 (P)','Luisa Guzman 8792',3,3,0],
[-33.42561,-70.54175,'LGN-10 - ET 1737 (P)','Luisa Guzman 1737',3,3,0],
[-33.425551,-70.541841,'LGN-11-PTZ - LG 8770','Luisa Guzman 8770',3,1,0],
[-33.425598,-70.542219,'LGN-12 - LG 8742 (S)','Luisa Guzman 8742',3,3,0],
[-33.425613,-70.542342,'LGN-13 - LG 8755 (P)','Luisa Guzman 8755',3,3,0],
[-33.425551,-70.541841,'LGN-14 - LG 8770 (P)','Luisa Guzman 8770',3,3,0],
[-33.425613,-70.542342,'LGN-15 - LG 8723 (P)','Luisa Guzman 8723',3,3,0],
[-33.425656,-70.542701,'LGN-16 - LG 8710 (O)','Luisa Guzman 8710',3,3,0],
[-33.392355,-70.547845,'ER-08-PTZ - T 264','Trinidad 264',4,1,0],
[-33.393158,-70.54651,'ER-01 - PHN 182','Padre Hurtado Norte 182',4,3,0],
[-33.3924,-70.547082,'ER-06 - PHN 276','Padre Hurtado Norte 276',4,3,0],
[-33.393158,-70.546507,'ER-02 - PHN 182','Padre Hurtado Norte 182',4,3,0],
[-33.392962,-70.547482,'ER-11 - T 250','Trinidad 250',4,3,0],
[-33.3924,-70.547082,'ER-05 - PHN 276','Padre Hurtado Norte 276',4,3,0],
[-33.39282,-70.546814,'ER-04 - PHN 228','Padre Hurtado Norte 228',4,3,0],
[-33.392816,-70.546814,'ER-03 - PHN 228','Padre Hurtado Norte 228',4,3,0],
[-33.392595,-70.547671,'ER-10 - T 269','Trinidad 269',4,3,0],
[-33.39265,-70.547689,'ER-09 - T 269','Trinidad 269',4,3,0],
[-33.392193,-70.547825,'ER-07 - M 8828','Mardoñal 8828',4,3,0],
[-33.393126,-70.547366,'ER-12 - T 230','Trinidad 230',4,3,0],
[-33.422926,-70.560823,'LBR-01 - L RP','Longopilla & Roberto peragallo',4,3,0],
[-33.4234,-70.560635,'LBR-02 - L 1491','Longopilla 1491',4,3,0],
[-33.423643,-70.560555,'LBR-03 - L 1527','Longopilla 1527',4,3,0],
[-33.423822,-70.56051,'LBR-04 - L 1550','Longopilla 1550',4,3,0],
[-33.423822,-70.56051,'LBR-05 - L 1550','Longopilla 1550',4,3,0],
[-33.423822,-70.56051,'LBR-06-PTZ - L 1550','Longopilla 1550',4,1,0],
[-33.424014,-70.560393,'LBR-07 - L 1536','Longopilla 1536',4,3,0],
[-33.424014,-70.560393,'LBR-08 - L 1536','Longopilla 1536',4,3,0],
[-33.424344,-70.560416,'LBR-09 - L 1579','Longopilla 1579',4,3,0],
[-33.4239,-70.56076,'LBR-10 - IPB 6588','Ingeniero Pedro Blanquier 6588',4,3,0],
[-33.42397,-70.56095,'LBR-11 - IPB 6565','Ingeniero Pedro Blanquier 6565',4,3,0],
[-33.423942,-70.561112,'LBR-12 - IPB 6504','Ingeniero Pedro Blanquier 6504',4,3,0],
[-33.424008,-70.561469,'LBR-13 - IPB 6437','Ingeniero Pedro Blanquier 6437',4,3,0],
[-33.42399,-70.561876,'LBR-14 - IPB 6340','Ingeniero Pedro Blanquier 6340',4,3,0],
[-33.424016,-70.562146,'LBR-15 - IPB HDM','Ingeniero Pedro Blanquier & Hernando de Magallanes',4,3,0],
[-33.424041,-70.562316,'LBR-16 - IPB 6280','Ingeniero Pedro Blanquier 6280',4,3,0],
[-33.407154,-70.546487,'P-01 - P L','Parana & Lareda Oriente',4,3,0],
[-33.406808,-70.546428,'P-02 - P 8375','Parana 8375',4,3,0],
[-33.406702,-70.54643,'P-03 - P 8378','Parana 8378',4,3,0],
[-33.406488,-70.54638,'P-04 - P 8394','Parana 8394',4,3,0],
[-33.405945,-70.546057,'P-05 - P 8431','Parana 8431',4,3,0],
[-33.405945,-70.546057,'P-06 - P 8430','Parana 8430',4,3,0],
[-33.405824,-70.546007,'P-07 - P 8455','Parana 8455',4,3,0],
[-33.405692,-70.545943,'P-08 - P 8460','Parana 8460',4,3,0],
[-33.405433,-70.545637,'P-09 - P 8479','Parana 8479',4,3,0],
[-33.405221,-70.545502,'P-10 - P 8580','Parana 8580',4,3,0],
[-33.405221,-70.545502,'P-11-PTZ - P 8580','Parana 8580',4,1,0],
[-33.405242,-70.545427,'P-12 - P L','Parana & Laredo Norte',4,3,0],
[-33.404894,-70.544906,'P-13 - P 8730','Parana 8730',4,3,0],
[-33.40485,-70.544795,'P-14 - P 8760','Parana 8760',4,3,0],
[-33.404816,-70.544723,'P-15 - P AG','Parana & Augusta Gerona',4,3,0],
[-33.4005,-70.513528,'SRO1-01-PTZ - SR 1555','Cerro San Ramon 1555',0,1,0],
[-33.4005,-70.513528,'SRO1-02 - SR 1555','Cerro San Ramon 1555',0,3,0],
[-33.400224,-70.513763,'SRO1-03 - CLH 12049','Camino de las hojas 12049',0,3,0],
[-33.400224,-70.513763,'SRO1-04 - CLH 12049','Camino de las hojas 12049',0,3,0],
[-33.400184,-70.513561,'SRO1-05 - SR CLH','Cerro San Ramon & Camino de las hojas',0,3,0],
[-33.399527,-70.51344,'SRO1-07 - SR 1483','Cerro San Ramon 1483',0,3,0],
[-33.399527,-70.51344,'SRO1-06 - SR 1483','Cerro San Ramon 1483',0,3,0],
[-33.399527,-70.51344,'SRO1-08 - SR 1483','Cerro San Ramon 1483',0,3,0],
[-33.398795,-70.513359,'SRO1-10 - SR 1475','Cerro San Ramon 1475',0,3,0],
[-33.398795,-70.513359,'SRO1-09 - SR 1476','Cerro San Ramon 1476',0,3,0],
[-33.398795,-70.513359,'SRO1-11 - SR 1469','Cerro San Ramon 1469',0,3,0],
[-33.398795,-70.513359,'SRO1-12 - SR 1469','Cerro San Ramon 1469',0,3,0],
[-33.39846,-70.51334,'SRO1-13 - SR 1465','Cerro San Ramon 1465',0,3,0],
[-33.39846,-70.51334,'SRO1-14 - SR 1465','Cerro San Ramon 1465',0,3,0],
[-33.398112,-70.513246,'SRO1-15 - SR 1461','Cerro San Ramon 1461',0,3,0],
[-33.398104,-70.513051,'SRO1-16 - CA 12052','Camino del alba 12052',0,3,0],
[-33.397795,-70.513279,'SRO2-01 - SR 1457','Cerro San Ramon 1457',0,3,0],
[-33.397795,-70.513279,'SRO2-02 - SR 1457','Cerro San Ramon 1457',0,3,0],
[-33.398145,-70.512729,'SRO2-03 - CA 12074','Cerro Abanico 12074',0,3,0],
[-33.398208,-70.512702,'SRO2-04 - CA 12073','Cerro Abanico 12073',0,3,0],
[-33.398295,-70.512064,'SRO2-05 - CP 1463','Cerro Pintor 1463',0,3,0],
[-33.39831,-70.511918,'SRO2-06 - CA 12121','Cerro Abanico 12121',0,3,0],
[-33.397445,-70.513223,'SRO2-07 - SR 1449','Cerro San Ramon 1449',0,3,0],
[-33.397445,-70.513223,'SRO2-08 - SR 1449','Cerro San Ramon 1449',0,3,0],
[-33.397098,-70.513158,'SRO2-09 - SR 1429','Cerro San Ramon 1429',0,3,0],
[-33.39646,-70.513267,'SRO2-10 - CLP 12018','Cerro los pumas 12018',0,3,0],
[-33.396349,-70.51309,'SRO2-11 - SR 1357','Cerro San Ramon 1357',0,3,0],
[-33.396061,-70.513042,'SRO2-12 - SR 1345','Cerro San Ramon 1345',0,3,0],
[-33.396061,-70.513042,'SRO2-13 - SR 1345','Cerro San Ramon 1345',0,3,0],
[-33.39644,-70.513131,'SRO2-14 - SR 1335','Cerro San Ramon 1335',0,3,0],
[-33.39644,-70.513131,'SRO2-15 - SR 1335','Cerro San Ramon 1335',0,3,0],
[-33.39644,-70.513131,'SRO2-16-PTZ - SR 1335','Cerro San Ramon 1335',0,1,0],
[-33.427924,-70.545673,'CMCV-01 - MCV 8443','Manuel Claro Vial 8443',3,3,0],
[-33.427904,-70.545976,'CMCV-02 - MCV 8394','Manuel Claro Vial 8394',3,3,0],
[-33.427975,-70.546218,'CMCV-03 - MCV 8350','Manuel Claro Vial 8350',3,3,0],
[-33.427949,-70.546317,'CMCV-04-PTZ - MCV C','Manuel Claro Vial & Calatambo',3,1,0],
[-33.428022,-70.546723,'CMCV-05 - MCV 8234','Manuel Claro Vial 8234',3,3,0],
[-33.427744,-70.546429,'CMCV-06 - C 1870','Calatambo 1870',3,3,0],
[-33.427466,-70.546472,'CMCV-07 - C 1854','Calatambo 1854',3,3,0],
[-33.427089,-70.546531,'CMCV-08 - C 1814','Calatambo 1814',3,3,0],
[-33.427089,-70.546531,'CMCV-09 - C 1797','Calatambo 1797',3,3,0],
[-33.427089,-70.546531,'CMCV-10 - C 1797','Calatambo 1797',3,3,0],
[-33.426884,-70.546564,'CMCV-11 - C 1797','Calatambo 1797',3,3,0],
[-33.408798,-70.533387,'VS-01 - AS 9581','Almirante Soublette 9581',0,3,0],
[-33.409011,-70.533011,'VS-02 - VA 579','Vital Apoquindo 579',0,3,0],
[-33.40933,-70.532736,'VS-03 - VA 587','Vital Apoquindo 587',0,3,0],
[-33.40933,-70.532736,'VS-04 - VA 587','Vital Apoquindo 587',0,3,0],
[-33.409525,-70.53265,'VS-05 - VA 613','Vital Apoquindo 613',0,3,0],
[-33.409615,-70.53261,'VS-06 - VA 621','Vital Apoquindo 621',0,3,0],
[-33.409902,-70.532477,'VS-07 - VA 667','Vital Apoquindo 667',0,3,0],
[-33.410089,-70.532381,'VS-08 - VA 695','Vital Apoquindo 695',0,3,0],
[-33.410176,-70.532329,'VS-09-PTZ - VA 749','Vital Apoquindo 749',0,1,0],
[-33.410417,-70.532148,'VS-10 - VA 831','Vital Apoquindo 831',0,3,0],
[-33.410417,-70.532148,'VS-11 - VA 831','Vital Apoquindo 831',0,3,0],
[-33.410492,-70.532078,'VS-12 - VA 855','Vital Apoquindo 855',0,3,0],
[-33.410567,-70.532,'VS-13 - VA 867','Vital Apoquindo 867',0,3,0],
[-33.410641,-70.531918,'VS-14 - VA 881','Vital Apoquindo 881',0,3,0],
[-33.410931,-70.531554,'VS-15 - VA 883','Vital Apoquindo 883',0,3,0],
[-33.41107,-70.531363,'VS-16 - VA 887','Vital Apoquindo 887',0,3,0],
[-33.38054,-70.521107,'FJ1-01 - PH 11649','Paul Harris 11649',0,3,0],
[-33.380105,-70.520432,'FJ1-02 - PH 11675','Paul Harris 11675',0,3,0],
[-33.380332,-70.520023,'FJ1-03 - PH 11729','Paul Harris 11729',0,3,0],
[-33.380569,-70.519828,'FJ1-04 - PH 11711','Paul Harris 11711',0,3,0],
[-33.38001,-70.520254,'FJ1-05 - PH 11710','Paul Harris 11710',0,3,0],
[-33.379694,-70.519803,'FJ1-06 - PH 11758','Paul Harris 11758',0,3,0],
[-33.379694,-70.519803,'FJ1-07 - PH 11758','Paul Harris 11758',0,3,0],
[-33.379537,-70.519553,'FJ1-08 - PH 11765','Paul Harris 11765',0,3,0],
[-33.379537,-70.519553,'FJ1-09 - PH 11758','Paul Harris 11778',0,3,0],
[-33.379506,-70.519318,'FJ1-10 - FJ 508','Fray Jorge 508',0,3,0],
[-33.379506,-70.519318,'FJ1-11-PTZ - FJ 508','Fray Jorge 508',0,1,0],
[-33.379724,-70.519157,'FJ1-12 - FJ 585','Fray Jorge 585',0,3,0],
[-33.379326,-70.519447,'FJ1-13 - FJ 502','Fray Jorge 502',0,3,0],
[-33.379326,-70.519447,'FJ1-14 - FJ 502','Fray Jorge 502',0,3,0],
[-33.379089,-70.519627,'FJ1-16 - FJ 467','Fray Jorge 467',0,3,0],
[-33.379089,-70.519627,'FJ1-15 - FJ 462','Fray Jorge 462',0,3,0],
[-33.378858,-70.519785,'FJ2-01 - FJ 476','Fray Jorge 476',0,3,0],
[-33.378858,-70.519785,'FJ2-02-PTZ - FJ 476','Fray Jorge 476',0,1,0],
[-33.378797,-70.519861,'FJ2-03 - FJ 423','Fray Jorge 423',0,3,0],
[-33.378631,-70.519983,'FJ2-04 - FJ 417','Fray Jorge 417',0,3,0],
[-33.378649,-70.519424,'FJ2-05 - FB 11835','Fray Bernardo 11835',0,3,0],
[-33.379852,-70.520049,'FJ2-06 - PH 11756','Paul Harris 11756',0,3,0],
[-33.37683,-70.51583,'FJ2-07 - FB 585','Fray Bernardo 585',0,3,0],
[-33.407765,-70.537374,'VE-01 - GB 9185','GENERAL BLANCHE 9185',4,3,0],
[-33.407848,-70.537728,'VE-02 - GB 9175','GENERAL BLANCHE 9175',4,3,0],
[-33.408069,-70.537778,'VE-03 - VE 344','VIEJOS ESTANDARTES 344',4,3,0],
[-33.408457,-70.537634,'VE-04 - VE 366','VIEJOS ESTANDARTES 366',4,3,0],
[-33.408457,-70.537634,'VE-05 - VE 366','VIEJOS ESTANDARTES 366',4,3,0],
[-33.408741,-70.5375,'VE-06 - VE 394','VIEJOS ESTANDARTES 394',4,3,0],
[-33.408741,-70.5375,'VE-07-PTZ - VE 394','VIEJOS ESTANDARTES 394',4,1,0],
[-33.408741,-70.5375,'VE-08 - VE 394','VIEJOS ESTANDARTES 394',4,3,0],
[-33.408925,-70.538044,'VE-09 - PA 391','PUERTO ARTURO 391',4,3,0],
[-33.408896,-70.537788,'VE-10 - AF PA','PASAJE AGUSTIN FONTAINE & VIEJOS ESTANDARTES',4,3,0],
[-33.408754,-70.53725,'VE-11 - AF PA','PASAJE AGUSTIN FONTAINE & VIEJOS ESTANDARTES',4,3,0],
[-33.408642,-70.536856,'VE-12 - AF PH','AGUSTIN FONTAINE & PAUL HARRIS',4,3,0],
[-33.407897,-70.537141,'VE-13 - PH 343','PAUL HARRIS 343',4,3,0],
[-33.409694,-70.537069,'VE-14 - AS 9153','ALMIRANTE SOUBLETTE 9153',4,3,0],
[-33.426207,-70.574524,'CR-01 - IC 4580','Isabel la Catolica 4580',5,3,0],
[-33.425953,-70.574951,'CR-02 - IC JM','Isabel la Catolica & Jose de Moraleda',5,3,0],
[-33.426,-70.575384,'CR-03 - IC 4472','Isabel la Catolica 4472',5,3,0],
[-33.425887,-70.576081,'CR-04 - IC 4460','Isabel la Catolica 4460',5,3,0],
[-33.425887,-70.576081,'CR-05-PTZ - IC 4460','Isabel la Catolica 4460',5,1,0],
[-33.426582,-70.575899,'CR-06 - AVS 1520','Americo Vespucio Sur 1520',5,3,0],
[-33.426825,-70.575668,'CR-07 - AVS 1622','Americo Vespucio Sur 1622',5,3,0],
[-33.427255,-70.574944,'CR-08 - JEM 4456','Juan Esteban Montero 4456',5,3,0],
[-33.427212,-70.574348,'CR-09 - JEM 4560','Juan Esteban Montero 4560',5,3,0],
[-33.424032,-70.575568,'FR1-01-PTZ - FR 1206','Fitz Roy 1206',5,1,0],
[-33.424032,-70.575568,'FR1-02 - FR 1206','Fitz Roy 1206',5,3,0],
[-33.42429,-70.575133,'FR1-03 - FR 1231','Fitz Roy 1231',5,3,0],
[-33.424347,-70.575038,'FR1-04 - FR 1240','Fitz Roy 1240',5,3,0],
[-33.424464,-70.574843,'FR1-05 - FR 1259','Fitz Roy 1259',5,3,0],
[-33.424464,-70.574843,'FR1-06 - FR 1260','Fitz Roy 1260',5,3,0],
[-33.424527,-70.574734,'FR1-07 - FR 1266','Fitz Roy 1266',5,3,0],
[-33.424653,-70.574514,'FR1-08 - FR 1272','Fitz Roy 1272',5,3,0],
[-33.424653,-70.574514,'FR1-09 - FR 1272','Fitz Roy 1272',5,3,0],
[-33.42472,-70.574396,'FR1-10 - FR 1280','Fitz Roy 1280',5,3,0],
[-33.424685,-70.573937,'FR1-11 - JDM 4751','Jose de Moraleda 4751',5,3,0],
[-33.425107,-70.574248,'FR1-12 - JDM 4725','Jose de Moraleda 4725',5,3,0],
[-33.425107,-70.574248,'FR1-13 - JDM 4716','Jose de Moraleda 4716',5,3,0],
[-33.424935,-70.574106,'FR1-14 - FR JDM','Fitz Roy & Jose de Moraleda',5,3,0],
[-33.425052,-70.573848,'FR1-15 - FR 1413','Fitz Roy 1413',5,3,0],
[-33.42511,-70.573749,'FR1-16 - FR 1418','Fitz Roy 1418',5,3,0],
[-33.424154,-70.575362,'FR2-01 - FR 1216','FITZ ROY 1216',5,3,0],
[-33.42511,-70.573749,'FR2-02 - FR 1418','Fitz Roy 1418',5,3,0],
[-33.425283,-70.573449,'FR2-03 - FR 1424','Fitz Roy 1424',5,3,0],
[-33.425453,-70.57316,'FR2-04 - FR 1432','Fitz Roy 1432',5,3,0],
[-33.425155,-70.575139,'FR2-05 - FR 1436','Fitz Roy 1436',5,3,0],
[-33.425155,-70.575139,'FR2-06 - FR 1436','Fitz Roy 1436',5,3,0],
[-33.425453,-70.57316,'FR2-07 - FR 1440','Fitz Roy 1440',5,3,0],
[-33.424976,-70.572591,'FR2-08 - FR 1440','Fitz Roy 1440',5,3,0],
[-33.425566,-70.572969,'FR2-09 - FR 1455','Fitz Roy 1445',5,3,0],
[-33.425566,-70.572969,'FR2-10 - FR 1452','Fitz Roy 1452',5,3,0],
[-33.425742,-70.572662,'FR2-11-PTZ - FR PDP','Fitz Roy & Puerto de Palos',5,3,0],
[-33.425742,-70.572662,'FR2-12 - FR PDP','Fitz Roy & Puerto de Palos',5,1,0],
[-33.425642,-70.572276,'FR2-13 - PDP 4916','Puerto de Palos 4916',5,3,0],
[-33.372119,-70.509263,'FMU-01 - FM 204','Fray Montalva 204',0,3,0],
[-33.37187,-70.509404,'FMU-02 - FM 150','Fray Montalva 150',0,3,0],
[-33.37187,-70.509404,'FMU-03 - FM 150','Fray Montalva 150',0,3,0],
[-33.371625,-70.509548,'FMU-04 - FM 111','Fray Montalva 111',0,3,0],
[-33.371453,-70.509641,'FMU-05 - FM 102','FRAY MONTALVA 102',0,3,0],
[-33.371453,-70.509641,'FMU-06-PTZ - FM 102','FRAY MONTALVA 102',0,1,0],
[-33.371357,-70.509689,'FMU-07 - FM 102','FRAY MONTALVA 102',0,3,0],
[-33.371115,-70.509815,'FMU-08 - FM 102','FRAY MONTALVA 102',0,3,0],
[-33.426942,-70.558627,'VO-01 - L 6943','LATADIA 6943',3,3,0],
[-33.427057,-70.557989,'VO-02 - L V','LATADIA & VICHATO',3,3,0],
[-33.426896,-70.558052,'VO-03 - V L','VICHATO & LATADIA',3,3,0],
[-33.426709,-70.558029,'VO-04 - VO 1727','VICHATO 1727',3,3,0],
[-33.426233,-70.557942,'VO-05 - VO 1693','VICHATO 1693',3,3,0],
[-33.426331,-70.557962,'VO-06 - VO 1698','VICHATO 1698',3,3,0],
[-33.426028,-70.557907,'VO-07 - VO 1685','VICHATO 1685',3,3,0],
[-33.426028,-70.557907,'VO-08-PTZ - VO 1685','VICHATO 1685',3,1,0],
[-33.426028,-70.557907,'VO-09 - VO 1685','VICHATO 1685',3,3,0],
[-33.425787,-70.557863,'VO-10 - VO 1677','VICHATO 1677',3,3,0],
[-33.425558,-70.557818,'VO-11 - VO 1640','VICHATO 1640',3,3,0],
[-33.425558,-70.557818,'VO-12 - VO 1640','VICHATO 1640',3,3,0],
[-33.425302,-70.557634,'VO-13 - V AF','VICHATO & ALEJANDRO FLEMING',3,3,0],
[-33.425258,-70.557994,'VO-14 - VO 6889','ALEJANDRO FLEMING 6889',3,3,0],
[-33.426331,-70.557962,'VO-15 - VO 1700','VICHATO 1700',3,3,0],
[-33.410701,-70.514959,'ADR1-01 - LQ 11680','LA QUINCHA 11680',0,3,0],
[-33.41073,-70.514953,'ADR1-02 - LQ 11720','LA QUINCHA 11720',0,3,0],
[-33.41073,-70.514953,'ADR1-03 - LQ 11720','LA QUINCHA 11720',0,3,0],
[-33.410734,-70.514607,'ADR1-04 - LQ 11761','LA QUINCHA 11761',0,3,0],
[-33.410709,-70.514611,'ADR1-05 - LQ 11754','LA QUINCHA 11754',0,3,0],
[-33.409484,-70.51419,'ADR1-06 - FBC 2699','FRANCISCO BULNES CORREA 2699',0,3,0],
[-33.410114,-70.514087,'ADR1-07 - FBC 2739','FRANCISCO BULNES CORREA 2739',0,3,0],
[-33.410814,-70.514035,'ADR1-08 - FBC 2803','FRANCISCO BULNES CORREA 2803',0,3,0],
[-33.411578,-70.513869,'ADR1-09-PTZ - FBC CO','FRANCISCO BULNES CORREA & CAMINO OTOÑAL',0,1,0],
[-33.411578,-70.513869,'ADR1-10 - FBC CO','FRANCISCO BULNES CORREA & CAMINO OTOÑAL',0,3,0],
[-33.412177,-70.513484,'ADR2-01 - FBC 2931','FRANCISCO BULNES CORREA 2931',0,3,0],
[-33.411682,-70.513817,'ADR2-02 - CO FBC','CAMINO OTOÑAL & FRANCISCO BULNES CORREA',0,3,0],
[-33.411691,-70.514023,'ADR2-03 - CO 2897','CAMINO OTOÑAL 2897',0,3,0],
[-33.411671,-70.514571,'ADR2-04 - CO 2878','CAMINO OTOÑAL 2878',0,3,0],
[-33.41169,-70.515102,'ADR2-05 - CO 2837','CAMINO OTOÑAL 2837',0,3,0],
[-33.411642,-70.515361,'ADR2-06 - CO 2812','CAMINO OTOÑAL 2812',0,3,0],
[-33.411642,-70.515361,'ADR2-07 - CO 2812','CAMINO OTOÑAL 2812',0,3,0],
[-33.41148,-70.515684,'ADR2-08 - CO 2793','CAMINO OTOÑAL 2793',0,3,0],
[-33.411324,-70.515723,'ADR2-09 - CO 2785','CAMINO OTOÑAL 2785',0,3,0],
[-33.411666,-70.515033,'ADR2-10 - CO 2799','CAMINO OTOÑAL 2799',0,3,0],
[-33.410897,-70.515672,'ADR2-11-PTZ - CO 2756','CAMINO OTOÑAL 2756',0,1,0],
[-33.386961,-70.530096,'LGE-01 - E 660','ESTORIL 660',4,3,0],
[-33.387239,-70.529738,'LGE-02 - E 680','ESTORIL 680',4,3,0],
[-33.387239,-70.529738,'LGE-03 - E 680','ESTORIL 680',4,3,0],
[-33.387971,-70.529218,'LGE-04 - E 707','ESTORIL 707',4,3,0],
[-33.387341,-70.529932,'LGE-05 - LG 10298','LOS GLADIOLOS 10298',4,3,0],
[-33.387638,-70.530205,'LGE-06 - LG 10292','LOS GLADIOLOS 10292',4,3,0],
[-33.387638,-70.530205,'LGE-07-PTZ','LOS GLADIOLOS 10292',4,1,0],
[-33.387893,-70.530415,'LGE-08 - LG 10262','LOS GLADIOLOS 10262',4,3,0],
[-33.387893,-70.530415,'LGE-09 - LG 10262','LOS GLADIOLOS 10262',4,3,0],
[-33.388045,-70.530538,'LGE-10 - LG 10254','LOS GLADIOLOS 10254',4,3,0],
[-33.388173,-70.530671,'LGE-11 - LG 10210','LOS GLADIOLOS 10210',4,3,0],
[-33.388605,-70.531035,'LGE-12 - LG 10116','LOS GLADIOLOS 10116',4,3,0],
[-33.388605,-70.531035,'LGE-13 - LG 10116','LOS GLADIOLOS 10116',4,3,0],
[-33.388605,-70.531035,'LGE-14 - LG 10116','LOS GLADIOLOS 10116',4,3,0],
[-33.388605,-70.531035,'LGE-15 - LG 10116','LOS GLADIOLOS 10116',4,3,0],
[-33.389112,-70.530487,'LGE-16 - LG 10109','LOS GLADIOLOS 10109',4,3,0],
[-33.424806,-70.568463,'RP-01 - PDP 5362','PUERTO DE PALOS 5362',5,3,0],
[-33.424821,-70.5685,'RP-02 - PDP 5349','PUERTO DE PALOS 5349',5,3,0],
[-33.424868,-70.569084,'RP-03 - PDP 5325','PUERTO DE PALOS 5325',5,3,0],
[-33.424555,-70.568375,'RP-04 - RP 5373','ROBERTO PERAGALLO 5373',5,3,0],
[-33.424555,-70.568375,'RP-05 - RP 5373','ROBERTO PERAGALLO 5373',5,3,0],
[-33.424345,-70.568294,'RP-06 - RP 5390','ROBERTO PERAGALLO 5390',5,3,0],
[-33.424148,-70.568157,'RP-07 - RP 5477','ROBERTO PERAGALLO 5477',5,3,0],
[-33.424148,-70.568157,'RP-08-PTZ','ROBERTO PERAGALLO 5477',5,1,0],
[-33.424148,-70.568157,'RP-09 - RP 5477','ROBERTO PERAGALLO 5477',5,3,0],
[-33.423761,-70.567954,'RP-10 - RP 5483','ROBERTO PERAGALLO 5483',5,3,0],
[-33.42356,-70.567881,'RP-11 - RP 5482','ROBERTO PERAGALLO 5482',5,3,0],
[-33.414109,-70.552641,'MM-01 - MM TM','MERCEDES MARÍN & TOMÁS MORO',4,3,0],
[-33.414109,-70.552641,'MM-02 - MM TM','MERCEDES MARÍN & TOMÁS MORO',4,3,0],
[-33.413996,-70.553358,'MM-03 - MM 7321','MERCEDES MARÍN 7321',4,3,0],
[-33.413996,-70.553358,'MM-04 - MM 7321','MERCEDES MARÍN 7321',4,3,0],
[-33.413948,-70.55366,'MM-05 - MM 7249','MERCEDES MARÍN 7249',4,3,0],
[-33.413877,-70.553882,'MM-06-PTZ - MM 7186','MERCEDES MARÍN 7186',4,1,0],
[-33.413673,-70.554227,'MM-07 - MM 7075','MERCEDES MARÍN 7075',4,3,0],
[-33.413673,-70.554227,'MM-08 - MM 7075','MERCEDES MARÍN 7075',4,3,0],
[-33.413627,-70.554535,'MM-09 - MM 7031','MERCEDES MARÍN 7031',4,3,0],
[-33.413582,-70.554833,'MM-10 - MN MM','MERCEDES MARÍN & MANUEL NOVOA',4,3,0],
[-33.413679,-70.554853,'MM-11 - MN 620','MANUEL NOVOA 620',4,3,0],
[-33.418189,-70.529965,'AA1-01 - VA 1285','VITAL APOQUINDO INTERIOR 1285',3,3,0],
[-33.418189,-70.529965,'AA1-02 - VA 1285','VITAL APOQUINDO INTERIOR 1285',3,3,0],
[-33.417542,-70.529833,'AA1-03 - Y VA','YOLANDA & VITAL APOQUINDO INTERIOR',3,3,0],
[-33.417542,-70.529833,'AA1-04-PTZ - Y VA','YOLANDA & VITAL APOQUINDO INTERIOR',3,1,0],
[-33.41757,-70.530152,'AA1-05 - Y 9645','YOLANDA 9645',3,3,0],
[-33.418302,-70.576704,'NC-01 - MDZ & NC','MARTIN DE ZAMORA & NIBALDO CORREA',5,3,0],
[-33.417868,-70.577002,'NC-02 - NC 808','NIBALDO CORREA 808',5,3,0],
[-33.417868,-70.577002,'NC-03 - NC 808','NIBALDO CORREA 808',5,3,0],
[-33.417786,-70.577082,'NC-04 - NC 763','NIBALDO CORREA 763',5,3,0],
[-33.417466,-70.577282,'NC-05 - NC 710','NIBALDO CORREA 710',5,3,0],
[-33.417466,-70.577282,'NC-06 - NC 710','NIBALDO CORREA 710',5,3,0],
[-33.417213,-70.577454,'NC-07-PTZ - NC 640','NIBALDO CORREA 640',5,1,0],
[-33.417213,-70.577454,'NC-08 - NC 640','NIBALDO CORREA 640',5,3,0],
[-33.416894,-70.577699,'NC-09 - NC 547','NIBALDO CORREA 547',5,3,0],
[-33.416894,-70.577699,'NC-10 - NC 547','NIBALDO CORREA 547',5,3,0],
[-33.41642,-70.578002,'NC-11 - NC & DI','DEL INCA & NIBALDO CORREA',5,3,0],
[-33.429413,-70.547439,'D1-01 - D 1988','DUQUECO 1988',3,3,0],
[-33.429014,-70.547479,'D1-02 - D 1942','DUQUECO 1942',3,3,0],
[-33.428818,-70.547509,'D1-03 - D 1918','DUQUECO 1918',3,3,0],
[-33.428605,-70.547557,'D1-04 - D 1906','DUQUECO 1906',3,3,0],
[-33.428408,-70.54758,'D1-05 - D 1894','DUQUECO 1894',3,3,0],
[-33.428129,-70.547636,'D1-06 - D MCV','DUQUECO & MANUEL CLARO VIAL',3,3,0],
[-33.428129,-70.547636,'D1-07-PTZ - D 1875','DUQUECO 1875',3,1,0],
[-33.428129,-70.547636,'D1-08 - D 1875','DUQUECO 1875',3,3,0],
[-33.427823,-70.547767,'D1-09 - D 1869','DUQUECO 1869',3,3,0],
[-33.427501,-70.547826,'D1-10 - D 1845','DUQUECO 1845',3,3,0],
[-33.42719,-70.54787,'D1-11 - D 1813','DUQUECO 1813',3,3,0],
[-33.42719,-70.54787,'D1-12 - D 1813','DUQUECO 1813',3,3,0],
[-33.426722,-70.547939,'D1-12 - D L','DUQUECO & LAMPA',3,3,0],
[-33.426564,-70.547859,'D2-01 - D 1774','DUQUECO 1774',3,3,0],
[-33.426381,-70.547875,'D2-02 - D 1750','DUQUECO 1750',3,3,0],
[-33.426381,-70.547875,'D2-03 - D 1750','DUQUECO 1750',3,3,0],
[-33.426381,-70.547875,'D2-04-PTZ - D 1750','DUQUECO 1750',3,1,0],
[-33.425699,-70.548108,'D2-05 - D 1707','DUQUECO 1707',3,3,0],
[-33.425551,-70.548121,'D2-06 - D 1691','DUQUECO 1691',3,3,0],
[-33.425694,-70.548109,'D2-07 - D 1699','DUQUECO 1699',3,3,0],
[-33.425309,-70.548046,'D2-08 - D LG','DUQUECO & LA GUAICA',3,3,0],
[-33.425042,-70.548108,'D2-09 - D 1666','DUQUECO 1666',3,3,0],
[-33.424813,-70.548188,'D2-10 - D AF','DUQUECO & ALEJANDRO FLEMING',3,3,0],
[-33.398385,-70.528851,'CM-01 - CM 1471','CAMINO MIRASOL 1471',0,3,0],
[-33.397957,-70.528802,'CM-02 - CM 1459','CAMINO MIRASOL 1459',0,3,0],
[-33.397957,-70.528802,'CM-03 - CM 1459','CAMINO MIRASOL 1459',0,3,0],
[-33.397304,-70.528726,'CM-04 - CM 1433','CAMINO MIRASOL 1433',0,3,0],
[-33.397179,-70.528708,'CM-05-PTZ - CM 1431','CAMINO MIRASOL 1431',0,1,0],
[-33.429405,-70.54686,'CMP-01 - MP 1986','Marcela Paz 1986',3,3,0],
[-33.428956,-70.54693,'CMP-02 - MP 1948','Marcela Paz 1948',3,3,0],
[-33.428956,-70.54693,'CMP-03 - MP 1948','Marcela Paz 1948',3,3,0],
[-33.428668,-70.54698,'CMP-04 - MP 1918','Marcela Paz 1918',3,3,0],
[-33.428668,-70.54698,'CMP-05 - MP 1918','Marcela Paz 1918',3,3,0],
[-33.428239,-70.547057,'CMP-06 - MP 1880','Marcela Paz 1880',3,3,0],
[-33.428239,-70.547057,'CMP-07 - MP 1880','Marcela Paz1880',3,3,0],
[-33.428088,-70.547125,'CMP-08-PTZ - MCV MP','Manuel Claro Vial & Marcela Paz',3,1,0],
[-33.42384,-70.536593,'CVUS1-01 – LTM AF','LAS TRES MARIAS & ALEJANDRO FLEMING',3,3,0],
[-33.423963,-70.536587,'CVUS1-02-PTZ – LTM 1614','LAS TRES MARIAS 1614',3,1,0],
[-33.424431,-70.536608,'CVUS1-03 – LTM 1650','LAS TRES MARIAS 1650',3,3,0],
[-33.424438,-70.537488,'CVUS1-04 – AC 8920','ALFA CENTAURO 8920',3,3,0],
[-33.424488,-70.535928,'CVUS1-05 – AC 1679','ALFA CENTAURO 1679',3,3,0],
[-33.424623,-70.536605,'CVUS1-06 – LTM 1682','LAS TRES MARIAS 1682',3,3,0],
[-33.424907,-70.536747,'CVUS1-07 – LTM A','LAS TRES MARIAS & ARTURO',3,3,0],
[-33.424899,-70.537493,'CVUS1-08 – A 8924','ARTURO 8924',3,3,0],
[-33.424924,-70.536017,'CVUS1-09 – A 1713','ARTURO 1713',3,3,0],
[-33.42504,-70.536628,'CVUS2-01 – LTM 1734','LAS TRES MARIAS 1734',3,3,0],
[-33.425361,-70.536646,'CVUS2-02 – LTM 1758','LAS TRES MARIAS 1758',3,3,0],
[-33.425577,-70.536604,'CVUS2-03 – LTM VL','LAS TRES MARIAS & VIA LACTEA',3,3,0],
[-33.425577,-70.536604,'CVUS2-04 – LTM VL','LAS TRES MARIAS & VIA LACTEA',3,3,0],
[-33.425592,-70.536224,'CVUS2-05 – VL 8990','VIA LACTEA 8990',3,3,0],
[-33.425563,-70.537425,'CVUS2-06 – VL 8934','VIA LACTEA 8934',3,3,0],
[-33.425563,-70.537425,'CVUS2-07 – VL 8934','VIA LACTEA 8934',3,3,0],
[-33.425795,-70.537117,'CVUS2-08 – VL 8943','VIA LACTEA 8943',3,3,0],
[-33.425787,-70.53666,'CVUS2-09-PTZ – VL 8989','VIA LACTEA 8989',3,1,0],
[-33.42579,-70.536517,'CVUS2-10 – VL 8993','VIA LACTEA 8993',3,3,0],
[-33.420159,-70.589434,'PA-01 – P PE','POLONIA & PRESIDENTE ERRAZURIZ',5,3,0],
[-33.419544,-70.589646,'PA-02 – P 433','POLONIA 433',5,3,0],
[-33.419544,-70.589646,'PA-03 – P 433','POLONIA 433',5,3,0],
[-33.419208,-70.589738,'PA-04 – P 395','POLONIA 395',5,3,0],
[-33.419208,-70.589738,'PA-05 – P 395','POLONIA 395',5,3,0],
[-33.419208,-70.589738,'PA-06-PTZ – P 395','POLONIA 395',5,1,0],
[-33.418849,-70.58985,'PA-07 – P 357','POLONIA 357',5,3,0],
[-33.418833,-70.589806,'PA-08 – P 326','POLONIA 326',5,3,0],
[-33.4125,-70.554584,'VSA-01 –VS 7311','VICTOR SOTTA 7311',4,3,0],
[-33.4125,-70.554584,'VSA-02 –VS 7311','VICTOR SOTTA 7311',4,3,0],
[-33.412337,-70.555408,'VSA-03 –VS 7230','VICTOR SOTTA 7230',4,3,0],
[-33.412337,-70.555408,'VSA-04 –VS 7230','VICTOR SOTTA 7230',4,3,0],
[-33.412337,-70.555408,'VSA-05 –VS 7230','VICTOR SOTTA 7230',4,3,0],
[-33.412288,-70.555902,'VSA-06 –VS 7165','VICTOR SOTTA 7165',4,3,0],
[-33.412288,-70.555902,'VSA-07 –VS 7165','VICTOR SOTTA 7165',4,3,0],
[-33.41222,-70.556169,'VSA-08–PTZ - VS 7131','VICTOR SOTTA 7131',4,1,0],
[-33.412169,-70.556682,'VSA-09 –VS 7097','VICTOR SOTTA 7097',4,3,0],
[-33.412169,-70.556682,'VSA-10 –VS 7097','VICTOR SOTTA 7097',4,3,0],
[-33.412087,-70.557034,'VSA-11 –VS 7068','VICTOR SOTTA 7068',4,3,0],
[-33.412077,-70.557104,'VSA-12 –VS 7060','VICTOR SOTTA 7060',4,3,0],
[-33.411959,-70.557864,'VSA-13 –VS HDM','VICTOR SOTTA & HERNANDO DE MAGALLANES',4,3,0],
[-33.411959,-70.557864,'VSA-14 – VS HDM','VICTOR SOTTA & HERNANDO DE MAGALLANES',4,3,0],
[-33.387598,-70.532517,'CFB-01 – PH 10105','PAUL HARRIS 10105',4,3,0],
[-33.387598,-70.532517,'CFB-02 – PH 10105','PAUL HARRIS 10105',4,3,0],
[-33.387547,-70.532479,'CFB-03-PTZ – PH 10109','PAUL HARRIS 10109',4,1,0],
[-33.397885,-70.510753,'CECCP-01 - CEP 12221','CERRO EL CEPO 12221',0,3,0],
[-33.397807,-70.511295,'CECCP-02 - CEP 12169','CERRO EL CEPO 12169',0,3,0],
[-33.39772,-70.511719,'CECCP-03 - CEP 12106','CERRO EL CEPO 12106',0,3,0],
[-33.397709,-70.511903,'CECCP-04 - CEP CP','CERRO EL CEPO & CERRO PINTOR',0,3,0],
[-33.39811,-70.511981,'CECCP-05 - CP 1460','CERRO PINTOR 1460',0,3,0],
[-33.39811,-70.511981,'CECCP-06 - CP 1460','CERRO PINTOR 1460',0,3,0],
[-33.397822,-70.511952,'CECCP-07-PTZ - CP 1451','CERRO PINTOR 1451',0,1,0],
[-33.397709,-70.511903,'CECCP-08 - CEC 12082','CERRO PINTOR & CERRO EL CEPO',0,3,0],
[-33.39762,-70.512357,'CECCP-09 - CEC 12076','CERRO EL CEPO 12076',0,3,0],
[-33.39734,-70.511847,'CECCP-10 - CP 1441','CERRO PINTOR 1441',0,3,0],
[-33.39734,-70.511847,'CECCP-11 - CP 1441','CERRO PINTOR 1441',0,3,0],
[-33.397044,-70.511773,'CECCP-12 - CP 1419','CERRO PINTOR 1419',0,3,0],
[-33.397044,-70.511773,'CECCP-13 - CP 1419','CERRO PINTOR 1419',0,3,0],
[-33.396554,-70.511618,'CECCP-14 - CP 1370','CERRO PINTOR 1370',0,3,0],
[-33.396317,-70.511569,'CECCP-15 - CP 1344','CERRO PINTOR 1344',0,3,0],
[-33.395286,-70.511251,'CECCP-16 - CP 1312','CERRO PINTOR 1312',0,3,0],
[-33.429927,-70.577601,'CVL-01 - L 4196','LATADIA 4196',5,3,0],
[-33.430183,-70.57718,'CVL-02 - L 4233','LATADIA 4233',5,3,0],
[-33.430183,-70.57718,'CVL-03 - L 4227','LATADIA 4233',5,3,0],
[-33.430401,-70.576775,'CVL-04 - L 4223','LATADIA INTERIOR 4223',5,3,0],
[-33.430574,-70.577065,'CVL-05 - L 4211','LATADIA INTERIOR 4211',5,3,0],
[-33.430574,-70.577065,'CVL-06 - L 4211','LATADIA INTERIOR 4211',5,3,0],
[-33.430539,-70.577373,'CVL-07 - L 4203','LATADIA INTERIOR 4203',5,3,0],
[-33.430418,-70.578003,'CVL-08 - L 4209','LATADIA INTERIOR',5,3,0],
[-33.430357,-70.577953,'CVL-09 - PIL L','LATADIA 4243',5,3,0],
[-33.430357,-70.577953,'CVL-10 - PIL L','LATADIA 4243',5,3,0],
[-33.430037,-70.577717,'CVL-10-PTZ - L 4251','LATADIA 4251',5,1,0],
[-33.408689,-70.549156,'CV-01 - V 85','VALDEPEÑAS 85',4,3,0],
[-33.409133,-70.549083,'CV-02 - V 116','VALDEPEÑAS 116',4,3,0],
[-33.409506,-70.54905,'CV-03 - V 176','VALDEPEÑAS 176',4,3,0],
[-33.409339,-70.549065,'CV-04 - V 150','VALDEPEÑAS 150',4,3,0],
[-33.409339,-70.549065,'CV-05 - V 150','VALDEPEÑAS 150',4,3,0],
[-33.409646,-70.549042,'CV-06 - V 192','VALDEPEÑAS 192',4,3,0],
[-33.409787,-70.54903,'CV-07 - V 214','VALDEPEÑAS 214',4,3,0],
[-33.409825,-70.54903,'CV-08 - V 220','VALDEPEÑAS 220',4,3,0],
[-33.410211,-70.549024,'CV-09 - V 259','VALDEPEÑAS 259',4,3,0],
[-33.410211,-70.549024,'CV-10 - V 259','VALDEPEÑAS 259',4,3,0],
[-33.410363,-70.549003,'CV-11 - V 275','VALDEPEÑAS 275',4,3,0],
[-33.410363,-70.549003,'CV-12 - V 275','VALDEPEÑAS 275',4,3,0],
[-33.410727,-70.548834,'CV-13-PTZ - V RT','VALDEPEÑAS & RIO TAJO',4,1,0],
[-33.413182,-70.587526,'CETG-01 – G 4233','LA GIOCONDA 4233',5,3,0],
[-33.413182,-70.587526,'CETG-02 – G 4233','LA GIOCONDA 4233',5,3,0],
[-33.413228,-70.587656,'CETG-03-PTZ – GM G','LA GIOCONDA & GOLDA MEIR',5,1,0],
[-33.413642,-70.587494,'CETG-04 – GM 122','GOLDA MEIR 122',5,3,0],
[-33.413694,-70.58719,'CETG-05 – T 4222','EL TROVADOR 4222',5,3,0],
[-33.413694,-70.58719,'CETG-06 – T 4222','EL TROVADOR 4222',5,3,0],
[-33.413668,-70.58703,'CETG-07 – T 4253','EL TROVADOR 4253',5,3,0],
[-33.425957,-70.541073,'CAGMB-01 - A R','AYQUINA & RUPANCO',3,3,0],
[-33.426134,-70.541052,'CAGMB-02 - A 1780','AYQUINA 1780',3,3,0],
[-33.426712,-70.540991,'CAGMB-03 - A 1825','AYQUINA 1825',3,3,0],
[-33.426918,-70.540954,'CAGMB-04 - A G','AYQUINA & GUALLATIRE',3,3,0],
[-33.426918,-70.540954,'CAGMB-05 - A G','AYQUINA & GUALLATIRE',3,3,0],
[-33.426918,-70.540954,'CAGMB-06-PTZ - A 1837','AYQUINA 1837',3,1,0],
[-33.427101,-70.540895,'CAGMB-07 - A 1861','AYQUINA 1861',3,3,0],
[-33.426918,-70.540954,'CAGMB-08 - A G','AYQUINA & GUALLATIRE',3,3,0],
[-33.426886,-70.540283,'CAGMB-09 - G 8833','GUALLATIRE 8833',3,3,0],
[-33.426833,-70.54013,'CAGMB-10 - G 8833','GUALLATIRE 8833',3,3,0],
[-33.426809,-70.539654,'CAGMB-11 - V G','VISVIRI & GUALLATIRE',3,3,0],
[-33.426879,-70.539634,'CAGMB-12 - V 1839','VISVIRI 1839',3,3,0],
[-33.427262,-70.539602,'CAGMB-13 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,3,0],
[-33.42724,-70.539613,'CAGMB-14 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,3,0],
[-33.427297,-70.540154,'CAGMB-15 - MCV 8844','MANUEL CLARO VIAL 8844',3,3,0],
[-33.427389,-70.540902,'CAGMB-16 - MCV 8784','MANUEL CLARO VIAL 8784',3,3,0],
[-33.426021,-70.550566,'CSSCN-01 - N 7865','NAICURA 7865',3,3,0],
[-33.426007,-70.550481,'CSSCN-02 - N 7881','NAICURA 7881',3,3,0],
[-33.425969,-70.550106,'CSSCN-03 - N 7921','NAICURA 7921',3,3,0],
[-33.425955,-70.549965,'CSSCN-04 - N 7929','NAICURA 7929',3,3,0],
[-33.425474,-70.549818,'CSSCN-05 - C 1672','CECILIA 1672',3,3,0],
[-33.425474,-70.549818,'CSSCN-06 - C 1672','CECILIA 1672',3,3,0],
[-33.425917,-70.549545,'CSSCN-07 - N 7963','NAICURA 7963',3,3,0],
[-33.425883,-70.54926,'CSSCN-08 - N 7979','NAICURA 7979',3,3,0],
[-33.424968,-70.549481,'CSSCN-09 - AF 7989','ALEJANDRO FLEMING 7989',3,3,0],
[-33.425075,-70.549299,'CSSCN-10 - R 1661','RUCALHUE 1661',3,3,0],
[-33.425677,-70.549164,'CSSCN-11 – R 1690','RUCALHUE 1690',3,3,0],
[-33.425972,-70.549114,'CSSCN-12 - R 1706','RUCALHUE 1706',3,3,0],
[-33.425972,-70.549114,'CSSCN-13 - R 1706','RUCALHUE 1706',3,3,0],
[-33.426203,-70.549756,'CSSCN-14 - R 1729','RUCALHUE 1729',3,3,0],
[-33.426309,-70.548975,'CSSCN-15 - L 8020','LOLCO 8020',3,3,0],
[-33.425444,-70.549232,'CSSCN-16-PTZ - R 1679','RUCALHUE 1679',3,1,0],
[-33.412643,-70.547424,'SMS-01 - LD SMS','LOS DOMINICOS & SANTA MAGDALENA SOFIA',4,3,0],
[-33.412705,-70.547356,'SMS-02 - LD SMS','LOS DOMINICOS & SANTA MAGDALENA SOFIA',4,3,0],
[-33.413046,-70.546902,'SMS-03 - SMS 542','SANTA MAGDALENA SOFIA 542',4,3,0],
[-33.413345,-70.546513,'SMS-04 - SMS 613','SANTA MAGDALENA SOFIA 613',4,3,0],
[-33.413345,-70.546513,'SMS-05 - SMS 613','SANTA MAGDALENA SOFIA 613',4,3,0],
[-33.413345,-70.546513,'SMS-06-PTZ - SMS 613','SANTA MAGDALENA SOFIA 613',4,1,0],
[-33.413628,-70.546133,'SMS-07 - SMS 648','SANTA MAGDALENA SOFIA 648',4,3,0],
[-33.413628,-70.546133,'SMS-08 - SMS 648','SANTA MAGDALENA SOFIA 648',4,3,0],
[-33.413948,-70.545697,'SMS-09 - SMS M','SANTA MAGDALENA SOFIA & MONROE',4,3,0],
[-33.42882,-70.587286,'TA-01 - MSF T','MARIANO SANCHEZ FONTECILLA & TARRAGONA?',5,3,0],
[-33.42877,-70.586988,'TA-02 - T 3622','TARRAGONA? 3622?',5,3,0],
[-33.42869,-70.586633,'TA-03 - T 3646','TARRAGONA? 3646?',5,3,0],
[-33.428637,-70.586409,'TA-04 -T 3656','TARRAGONA? 3656',5,3,0],
[-33.428637,-70.586409,'TA-05 - T 3656','TARRAGONA? 3656',5,3,0],
[-33.428581,-70.586184,'TA-06 - PTZ - T 3682','TARRAGONA? 3682?',5,1,0],
[-33.428493,-70.585837,'TA-07 - T 3703','TARRAGONA? 3703?',5,3,0],
[-33.428493,-70.585837,'TA-08 - T 3703','TARRAGONA? 3703?',5,3,0],
[-33.428368,-70.585471,'TA-09 - T 3741','TARRAGONA? 3741',5,3,0],
[-33.42814,-70.585228,'TA-10 - T CD','TARRAGONA &? CANCILLER DOLLFUSS?',5,3,0],
[-33.427899,-70.5849,'TA-11 - T A','TARRAGONA & ALCANTARA?',5,3,0],
[-33.427899,-70.5849,'TA-12 - T A','TARRAGONA & ALCANTARA?',5,3,0],
[-33.427942,-70.585478,'TA-13 - CD 1351','CANCILLER DOLLFUSS? 1351',5,3,0],
[-33.427886,-70.585389,'TA-14 - T 3850','TARRAGONA 3850',5,3,0],
[-33.428214,-70.585287,'TA-15 - CD 1445 (S)','CANCILLER DOLLFUSS 1445',5,3,0],
[-33.42848,-70.584976,'TA-16 - CD 1457 (S)','CANCILLER DOLLFUSS 1457',5,3,0],
[-33.400742,-70.529055,'CMEA-01 - PTZ - CM 1583','CAMINO MIRASOL 1583',0,1,0],
[-33.400477,-70.529011,'CMEA-02 - CM 1571','CAMINO MIRASOL 1571',0,3,0],
[-33.400477,-70.529011,'CMEA-03 - CM 1571','CAMINO MIRASOL 1571',0,3,0],
[-33.400122,-70.528985,'CMEA-04 - CM 1557','CAMINO MIRASOL 1557',0,3,0],
[-33.39994,-70.528964,'CMEA-05 - CM 1556','CAMINO MIRASOL 1556',0,3,0],
[-33.399575,-70.528922,'CMEA-06 - CM 1541','CAMINO MIRASOL 1541',0,3,0],
[-33.399386,-70.528903,'CMEA-07 - CM 1527','CAMINO MIRASOL 1527',0,3,0],
[-33.405203,-70.568725,'CMN-01 - MN LM','MANQUEHUE NORTE & LOS MILITARES',5,3,0],
[-33.404576,-70.56896,'CMN-02 - MN 444','MANQUEHUE NORTE 444',5,3,0],
[-33.404491,-70.568992,'CMN-03-PTZ - MN 444','MANQUEHUE NORTE 444',5,1,0],
[-33.403711,-70.569235,'CMN-04 - MN CEP','MANQUEHUE NORTE & CERRO EL PLOMO',5,3,0],
[-33.404165,-70.57019,'CMN-05 - CEP 6000','CERRO EL PLOMO 6000',5,3,0],
[-33.397479,-70.567522,'CEA-01 - B 800','BRASILIA 800',5,3,0],
[-33.397811,-70.566874,'CEA-02 - PTZ - B 800','BRASILIA 800',5,1,0],
[-33.397811,-70.566874,'CEA-03 - B 800','BRASILIA 800',5,3,0],
[-33.398331,-70.567289,'CEA-04 - CC NSR','NUESTRA SRA. DEL ROSARIO & CERRO COLORADO.',5,3,0],
[-33.398047,-70.56787,'CEA-05 - NSR 848','NUESTRA SRA. DEL ROSARIO 848',5,3,0],
[-33.398047,-70.56787,'CEA-06 - NSR 848','NUESTRA SRA. DEL ROSARIO 848',5,3,0],
[-33.422117,-70.550281,'PM-01 - ADC PAM','ALONSO DE CAMARGO & PINTORA AURORA MIRA',3,3,0],
[-33.422364,-70.550231,'PM-02 - PAM 1241','PINTORA AURORA MIRA? 1241?',3,3,0],
[-33.422777,-70.549808,'PM-03 - PAM 1264','PINTORA AURORA MIRA? 1264',3,3,0],
[-33.422777,-70.549808,'PM-04 - PAM 1264','PINTORA AURORA MIRA? 1264',3,3,0],
[-33.422986,-70.5496,'PM-05 - PAM 1276','PINTORA AURORA MIRA? 1276?',3,3,0],
[-33.422986,-70.5496,'PM-06 - PAM 1276','PINTORA AURORA MIRA? 1276?',3,3,0],
[-33.422986,-70.5496,'PM-07 - PAM 1276','PINTORA AURORA MIRA? 1276?',3,3,0],
[-33.423369,-70.54917,'PM-08 - PAM PRM','PINTORA AURORA MIRA & PINTOR RAIMUNDO MONVOISIN',3,3,0],
[-33.423072,-70.55002,'PM-09 - PMM 7923','PINTORA MAGDALENA MIRA? 7923?',3,3,0],
[-33.423072,-70.55002,'PM-10 - PMM 7923','PINTORA MAGDALENA MIRA? 7923?',3,3,0],
[-33.42317,-70.550878,'PM-11 - PMM 7839','PINTORA MAGDALENA MIRA? 7839',3,3,0],
[-33.42317,-70.550878,'PM-12 - PMM 7839','PINTORA MAGDALENA MIRA? 7839',3,3,0],
[-33.423258,-70.551682,'PM-13 - PMM 7785','PINTORA MAGDALENA MIRA? 7785',3,3,0],
[-33.423258,-70.551682,'PM-14 - PMM 7785','PINTORA MAGDALENA MIRA? 7785',3,3,0],
[-33.423266,-70.55184,'PM-15-PTZ - PMM 7777','PINTORA MAGDALENA MIRA? 7777',3,1,0],
[-33.423341,-70.552288,'PM-16 - C PMM','CANUMANQUI & PINTORA? MAGDALENA MIRA',3,3,0],
[-33.420167,-70.547278,'CH-01 - S H','HUESCA & SOMORROSTRO',3,3,0],
[-33.420167,-70.547278,'CH-02 - S H','HUESCA & SOMORROSTRO',3,3,0],
[-33.42016,-70.547518,'CH-03 - H 7995','HUESCA 7995',3,3,0],
[-33.420206,-70.547845,'CH-04 - H 7946','HUESCA ?7946?',3,3,0],
[-33.420206,-70.547845,'CH-05 - H 7946','?HUESCA 7946?',3,3,0],
[-33.420253,-70.548289,'CH-06-PTZ - H 7914','?HUESCA 7914?',3,1,0],
[-33.420253,-70.548289,'CH-07 - H 7914','?HUESCA 7914?',3,3,0],
[-33.420253,-70.548289,'CH-08 - H 7914','?HUESCA 7914?',3,3,0],
[-33.420291,-70.548641,'CH-09 - H 7874','?HUESCA 7874?',3,3,0],
[-33.420291,-70.548641,'CH-10 - H 7874','?HUESCA 7874?',3,3,0],
[-33.420335,-70.548974,'CH-11 - H 7846','?HUESCA 7846?',3,3,0],
[-33.420335,-70.548974,'CH-12 - H 7846','?HUESCA 7846',3,3,0],
[-33.420414,-70.549393,'CH-13 - H G','HUESCA & GUADARRAMA',3,3,0],
[-33.405781,-70.533264,'CGB-01 - GB VA','GENERAL BLANCHE & VITAL APOQUINDO',0,3,0],
[-33.406046,-70.533505,'CGB-02 - GB 9576','GENERAL BLANCHE 9576',0,3,0],
[-33.406375,-70.533872,'CGB-03 - GB 9538','GENERAL BLANCHE 9538',0,3,0],
[-33.406375,-70.533872,'CGB-04-PTZ - GB 9540','GENERAL BLANCHE 9540',0,1,0],
[-33.406614,-70.534217,'CGB-05 - GB 9524','GENERAL BLANCHE 9524',0,3,0],
[-33.406767,-70.534488,'CGB-06 - GB 9535','GENERAL BLANCHE 9535',0,3,0],
[-33.403151,-70.543226,'COE-01 - O E','OXFORD & EDIMBURGO',4,3,0],
[-33.402739,-70.543285,'COE-02 - O 1060','OXFORD 1060',4,3,0],
[-33.402552,-70.543297,'COE-03 - O 1020','OXFORD 1020',4,3,0],
[-33.402149,-70.543302,'COE-04 - O 940','OXFORD 940',4,3,0],
[-33.402149,-70.543302,'COE-05 - O 940','OXFORD 940',4,3,0],
[-33.40196,-70.543303,'COE-06 - O 913','OXFORD 913',4,3,0],
[-33.40196,-70.543303,'COE-07 - O 913','OXFORD 913',4,3,0],
[-33.401763,-70.543297,'COE-08-PTZ - O 890','OXFORD 890',4,1,0],
[-33.401384,-70.543313,'COE-09 - O 769','OXFORD 769',4,3,0],
[-33.401384,-70.543313,'COE-10 - O 768','OXFORD 768',4,3,0],
[-33.401384,-70.543313,'COE-11 - O 768','OXFORD 768',4,3,0],
[-33.401204,-70.543313,'COE-12 - O 754','OXFORD 754',4,3,0],
[-33.400842,-70.543298,'COE-13 - O B','OXFORD & BOCACCIO',4,3,0],
[-33.411175,-70.543544,'CVA-01 - V A','VILANOVA & ANTEQUERA',4,3,0],
[-33.41132,-70.543454,'CVA-02 - V 411','VILANOVA 411',4,3,0],
[-33.411582,-70.543335,'CVA-03 - V 438','VILANOVA 438',4,3,0],
[-33.411753,-70.543189,'CVA-04 - V M','VILANOVA & MONROE',4,3,0],
[-33.411753,-70.543189,'CVA-05 - V M','VILANOVA & MONROE',4,3,0],
[-33.411724,-70.543034,'CVA-06 - M 8508','MONROE 8508',4,3,0],
[-33.412026,-70.543135,'CVA-07 - V 476','VILANOVA 476',4,3,0],
[-33.412302,-70.543026,'CVA-08 - V 510','VILANOVA 510',4,3,0],
[-33.412655,-70.542888,'CVA-09-PTZ - V 553','VILANOVA 553',4,1,0],
[-33.412655,-70.542888,'CVA-10 - V 553','VILANOVA 553',4,3,0],
[-33.412655,-70.542888,'CVA-11 - V 553','VILANOVA 553',4,3,0],
[-33.413102,-70.542722,'CVA-12 - V 665','VILANOVA 665',4,3,0],
[-33.413355,-70.54261,'CVA-13 - V 677','VILANOVA 677',4,3,0],
[-33.413638,-70.542545,'CVA-14 - V 727','VILANOVA 727',4,3,0],
[-33.41388,-70.542498,'CVA-15 - RG 8673','RIO GUADIANA 8673',4,3,0],
[-33.413798,-70.54215,'CVA-16 - RG 8693','RIO GUADIANA 8693',4,3,0],
[-33.423585,-70.588355,'CMZ-01 - MZ 3768','MARTIN DE ZAMORA 3768',5,3,0],
[-33.423585,-70.588355,'CMZ-02 - MZ 3768','MARTIN DE ZAMORA 3768',5,3,0],
[-33.423625,-70.588573,'CMZ-03-PTZ - MZ 3752','MARTIN DE ZAMORA 3752',5,1,0],
[-33.411063,-70.55973,'CVMM-01 - CV VF','CONSTANCIO VIGIL & VIRGILIO FIGUEROA',4,3,0],
[-33.410445,-70.559242,'CVMM-02 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,3,0],
[-33.410445,-70.559242,'CVMM-03 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,3,0],
[-33.410445,-70.559242,'CVMM-04 - CV MM','CONSTANCIO VIGIL & MADRE MAZARELLO',4,3,0],
[-33.410334,-70.559745,'CVMM-05 - MM 6827','MADRE MAZARELLO 6827',4,3,0],
[-33.410181,-70.560558,'CVMM-06 - MM 6663','MADRE MAZARELLO 6663',4,3,0],
[-33.410133,-70.560612,'CVMM-07 - MM 6666','MADRE MAZARELLO 6666',4,3,0],
[-33.409971,-70.558991,'CVMM-08 - CV 313','CONSTANCIO VIGIL 313',4,3,0],
[-33.409828,-70.558923,'CVMM-09 - CV EO','CONSTANCIO VIGIL & ESTEBAN DELL ORTO',4,3,0],
[-33.409828,-70.558923,'CVMM-10-PTZ - CV EO','CONSTANCIO VIGIL & ESTEBAN DELL ORTO',4,1,0],
[-33.403097,-70.544207,'CE-01 - E PHC','EDIMBURGO & PADRE HURTADO CENTRAL',4,3,0],
[-33.403014,-70.54371,'CE-02 - E 8958','EDIMBURGO 8958',4,3,0],
[-33.403014,-70.54371,'CE-03 - E 8958','EDIMBURGO 8958',4,3,0],
[-33.402993,-70.543567,'CE-04 - E 8972','EDIMBURGO 8972',4,3,0],
[-33.402968,-70.542933,'CE-05 - E 9010','EDIMBURGO 9010',4,3,0],
[-33.402986,-70.543269,'CE-06-PTZ - E O','EDIMBURGO & OXFORD',4,1,0],
[-33.415313,-70.602256,'CEBRO-01 - E 2799','EBRO 2799',5,3,0],
[-33.415313,-70.602256,'CEBRO-02 - E 2799','EBRO 2799',5,3,0],
[-33.415313,-70.602256,'CEBRO-03-PTZ - E 2799','EBRO 2799',5,1,0],
[-33.422252,-70.572913,'CMO-01 - MO 1267','MARIA OLIVARES 1267',5,3,0],
[-33.422252,-70.572913,'CMO-02-PTZ - MO 1267','MARIA OLIVARES 1267',5,1,0],
[-33.422341,-70.573084,'CMO-03 - MO 1256','MARIA OLIVARES 1256',5,3,0],
[-33.421917,-70.572437,'CMO-04 - VNB 1286','VASCO NUÑEZ DE BALBOA 1286',5,3,0],
[-33.405322,-70.541814,'CW1-01 - CW 1571','WATERLOO 1571',4,3,0],
[-33.404913,-70.541938,'CW1-02 - CW I','WATERLOO & ISLANDIA',4,3,0],
[-33.404913,-70.541938,'CW1-03-PTZ - CW I','WATERLOO & ISLANDIA',4,1,0],
[-33.404617,-70.542022,'CW1-04 - CW 1450','WATERLOO 1450',4,3,0],
[-33.404617,-70.541974,'CW1-05 - CW 1449','WATERLOO 1449',4,3,0],
[-33.404387,-70.542043,'CW1-06 - CW 1404','WATERLOO 1404',4,3,0],
[-33.404322,-70.542132,'CW1-07 - CW 1409','WATERLOO 1409',4,3,0],
[-33.404071,-70.542195,'CW1-08 - CW 1347','WATERLOO 1347',4,3,0],
[-33.404002,-70.54215,'CW1-09 - CW 1340','WATERLOO 1340',4,3,0],
[-33.40381,-70.542272,'CW1-10 - CW 1309','WATERLOO 1309',4,3,0],
[-33.403659,-70.542314,'CW1-11 - CW 1237','WATERLOO 1237',4,3,0],
[-33.403579,-70.542283,'CW1-12 - CW 1212','WATERLOO 1212',4,3,0],
[-33.403579,-70.542283,'CW1-13 - CW 1212','WATERLOO 1212',4,3,0],
[-33.403271,-70.542417,'CW1-14 - CW 1149','WATERLOO 1149',4,3,0],
[-33.403163,-70.54241,'CW1-15 - CW 1120','WATERLOO 1120',4,3,0],
[-33.402935,-70.542519,'CW1-16 - CW E','WATERLOO & EDIMBURGO',4,3,0],
[-33.402935,-70.542519,'CW2-01-PTZ - CW E','WATERLOO & EDIMBURGO',4,1,0],
[-33.402642,-70.542516,'CW2-02 - CW 1066','WATERLOO 1066',4,3,0],
[-33.402686,-70.542558,'CW2-03 - CW 1065','WATERLOO 1065',4,3,0],
[-33.402371,-70.54253,'CW2-04 - CW 1010','WATERLOO 1010',4,3,0],
[-33.402039,-70.542574,'CW2-05 - CW 931','WATERLOO 931',4,3,0],
[-33.401895,-70.542603,'CW2-06 - CW 913','WATERLOO 913',4,3,0],
[-33.401549,-70.542585,'CW2-07 - CW 836','WATERLOO 836',4,3,0],
[-33.401634,-70.542575,'CW2-08 - CW 848','WATERLOO 848',4,3,0],
[-33.40135,-70.542636,'CW2-09 - CW 789','WATERLOO 789',4,3,0],
[-33.401318,-70.542577,'CW2-10 - CW 788','WATERLOO 788',4,3,0],
[-33.401318,-70.542577,'CW2-11 - CW 788','WATERLOO 788',4,3,0],
[-33.401202,-70.542662,'CW2-12 - CW 765','WATERLOO 765',4,3,0],
[-33.400826,-70.542656,'CW2-13 - CW B','WATERLOO & BOCACCIO',4,3,0],
[-33.400826,-70.542656,'CW2-14 - CW B','WATERLOO & BOCACCIO',4,3,0],
[-33.400826,-70.542656,'CW2-15 - CW B','WATERLOO & BOCACCIO',4,3,0],
[-33.413908,-70.589927,'CPLA-01 - A 99','ALSACIA 99',5,3,0],
[-33.414361,-70.590112,'CPLA-02 - A 100','ALSACIA 100',5,3,0],
[-33.414476,-70.590097,'CPLA-03 - A 57','ALSACIA 57',5,3,0],
[-33.414684,-70.590221,'CPLA-04 - A B','ALSACIA & BERNARDITA',5,3,0],
[-33.414426,-70.590924,'CPLA-05 - NSDLA B','NUESTRA SRA DE LOS ANGELES & BERNARDITA',5,3,0],
[-33.414426,-70.590924,'CPLA-06-PTZ - NSDLA B','NUESTRA SRA DE LOS ANGELES & BERNARDITA',5,1,0],
[-33.41395,-70.59076,'CPLA-07 - NSDLA 133','NUSTRA SRA DE LOS ANGELES 133',5,3,0],
[-33.41395,-70.59076,'CPLA-08 - NSDLA 133','NUSTRA SRA DE LOS ANGELES 133',5,3,0],
[-33.424615,-70.541372,'CG-01 - LG A','LA GUAICA & AYQUINA',3,3,0],
[-33.42455,-70.540627,'CG-02 - LG 8864','LA GUAICA 8864',3,3,0],
[-33.42455,-70.540627,'CG-03 - LG 8864','LA GUAICA 8864',3,3,0],
[-33.42455,-70.540627,'CG-04 - LG 8864','LA GUAICA 8864',3,3,0],
[-33.42455,-70.540627,'CG-05-PTZ - LG 8864','LA GUAICA 8864',3,1,0],
[-33.424991,-70.540571,'CG-06 - T 1715','TOCONCE 1715',3,3,0],
[-33.424991,-70.540571,'CG-07 - T 1715','TOCONCE 1715',3,3,0],
[-33.425442,-70.540475,'CG-08 - LG 8869','LUISA GUZMAN 8869',3,3,0],
[-33.425458,-70.539848,'CG-09 - V 1730','VISVIRI 1730',3,3,0],
[-33.424846,-70.539946,'CG-10 - V 1711','VISVIRI 1711',3,3,0],
[-33.424479,-70.540023,'CG-11 - V LG','VISVIRI & LA GUAICA',3,3,0],
[-33.424479,-70.540023,'CG-12 - V LG','VISVIRI & LA GUAICA',3,3,0],
[-33.423812,-70.540111,'CG-13 - V AF','VISVIRI & ALEJANDRO FLEMING',3,3,0],
[-33.424479,-70.540023,'CG-14 - V LG','VISVIRI & LA GUAICA',3,3,0],
[-33.391204,-70.517623,'CCO-01 - CO 1130','CAMINO OTOÑAL 1130',0,3,0],
[-33.391204,-70.517623,'CCO-02-PTZ - CO 1130','CAMINO OTOÑAL 1130',0,1,0],
[-33.391204,-70.517623,'CCO-03 - CO 1130','CAMINO OTOÑAL 1130',0,3,0],
[-33.391204,-70.517623,'CCO-04 - CO 1130','CAMINO OTOÑAL 1130',0,3,0],
[-33.396009,-70.507311,'STJ-01 - STJDI 1303','Santa Teresa Jornet de Ibars 1303',0,3,0],
[-33.396839,-70.507535,'STJ-02-PTZ - STJDI 1357','Santa Teresa Jornet de Ibars 1357',0,1,0],
[-33.396903,-70.50755,'STJ-03 - STJDI 1357','Santa Teresa Jornet de Ibars 1357',0,3,0],
[-33.397629,-70.507597,'STJ-04 - STJDI 1410','Santa Teresa Jornet de Ibars 1410',0,3,0],
[-33.397629,-70.507597,'STJ-05 - STJDI 1410','Santa Teresa Jornet de Ibars 1410',0,3,0],
[-33.398569,-70.507919,'STJ-06 - STJDI 1451','Santa Teresa Jornet de Ibars 1451',0,3,0],
[-33.398969,-70.508005,'STJ-07 - STJDI 1478','Santa Teresa Jornet de Ibars 1478',0,3,0],
[-33.417424,-70.551962,'RL-01 - RL CH','RIO LOA & CHOAPA',4,3,0],
[-33.417424,-70.551962,'RL-02-PTZ - RL CH','RIO LOA & CHOAPA',4,1,0],
[-33.417316,-70.551751,'RL-03 - RL 7616','RIO LOA 7616',4,3,0],
[-33.417342,-70.551378,'RL-04 - RL 7635','RIO LOA 7635',4,3,0],
[-33.417284,-70.551415,'RL-05 - RL 7640','RIO LOA 7640',4,3,0],
[-33.417282,-70.55094,'RL-06 - RL M','RIO LOA & MATAQUITO',4,3,0],
[-33.417212,-70.550956,'RL-07 - RL 7655','RIO LOA 7955',4,3,0],
[-33.417195,-70.550775,'RL-08 - RL 7664','RIO LOA 7664',4,3,0],
[-33.417167,-70.550563,'RL-09 - RL 7667','RIO LOA 7667',4,3,0],
[-33.417188,-70.550431,'RL-10 - RL 7680','RIO LOA 7680',4,3,0],
[-33.417139,-70.550299,'RL-11 - RL 7695','RIO LOA 7695',4,3,0],
[-33.420719,-70.590267,'CSG-01 - PE GE','Presidente Errázuriz & Gertrudis Echenique',5,3,0],
[-33.421241,-70.590261,'CSG-02 - GE 685','GERTRUDIZ ECHEÑIQUE 685',5,3,0],
[-33.421155,-70.590229,'CSG-03 - GE 564','GERTRUDIZ ECHEÑIQUE 564',5,3,0],
[-33.42151,-70.590185,'CSG-04 - GE 609','GERTRUDIZ ECHEÑIQUE 609',5,3,0],
[-33.421518,-70.590107,'CSG-05 - GE 598','GERTRUDIZ ECHEÑIQUE 598',5,3,0],
[-33.421715,-70.590079,'CSG-06-PTZ - GE 640','GERTRUDIZ ECHEÑIQUE 640',5,1,0],
[-33.421807,-70.590159,'CSG-07 - GE N','GERTRUDIZ ECHEÑIQUE & NAVARRA',5,3,0],
[-33.421925,-70.590198,'CSG-08 - SG 3693','SAN GABRIEL 3693',5,3,0],
[-33.42211,-70.590339,'CSG-09 - SG H','SAN GABRIEL & HENDAYA',5,3,0],
[-33.422205,-70.590432,'CSG-10 - SG 3534','SAN GABRIEL 3534',5,3,0],
[-33.422205,-70.590432,'CSG-11 - SG 3534','SAN GABRIEL 3534',5,3,0],
[-33.422054,-70.590426,'CSG-12 - H 663','HENDAYA 663',5,3,0],
[-33.421967,-70.590538,'CSG-13 - H 672','HENDAYA 672',5,3,0],
[-33.421595,-70.590929,'CSG-14 - H 624','HENDAYA 624',5,3,0],
[-33.421153,-70.591417,'CSG-15 - H 535','HENDAYA 535',5,3,0],
[-33.420912,-70.591328,'CSG-16 - PE 3575','PADRE ERRAZURIZ & HENDAYA',5,3,0],
[-33.420713,-70.582578,'AE-01 - P A','PORTOFINO & ALICANTE',5,3,0],
[-33.421239,-70.582289,'AE-02 - A 836','ALICANTE 836',5,3,0],
[-33.421364,-70.582341,'AE-03 - A 839','ALICANTE 839',5,3,0],
[-33.421534,-70.582265,'AE-04 - A 861','ALICANTE 861',5,3,0],
[-33.421572,-70.582161,'AE-05 - A 858','ALICANTE 858',5,3,0],
[-33.421841,-70.582052,'AE-06 - A 894','ALICANTE 894',5,3,0],
[-33.422067,-70.582049,'AE-07-PTZ - A 894','ALICANTE 894',5,1,0],
[-33.407502,-70.536328,'CL-01 - LL GB','LAS LOMAS & GENERAL BLANCHE',0,3,0],
[-33.407638,-70.536165,'CL-02 - LL 353','LAS LOMAS 353',0,3,0],
[-33.408069,-70.536088,'CL-03 - LL 389','LAS LOMAS 389',0,3,0],
[-33.408054,-70.535989,'CL-04 - LL 390','LAS LOMAS 390',0,3,0],
[-33.408199,-70.536025,'CL-05-PTZ - LL 409','LAS LOMAS 409',0,1,0],
[-33.408406,-70.535849,'CL-06 - LL 436','LAS LOMAS 436',0,3,0],
[-33.408718,-70.535829,'CL-07 - LL 437','LAS LOMAS 437',0,3,0],
[-33.408803,-70.535705,'CL-08 - LL 437','LAS LOMAS 437',0,3,0],
[-33.409022,-70.535624,'CL-09 - LL 485','LAS LOMAS 485',0,3,0],
[-33.409165,-70.535644,'CL-10 - LL 485','LAS LOMAS 485',0,3,0],
[-33.424784,-70.543155,'CGA-01 - A 1661','ALHUE 1661',3,3,0],
[-33.424784,-70.543155,'CGA-02 - A 1661','ALHUE 1661',3,3,0],
[-33.424714,-70.54273,'CGA-03 - G 8781','LA GUAICA 8781',3,3,0],
[-33.424714,-70.54273,'CGA-04 - G 8718','LA GUAICA 8718',3,3,0],
[-33.424689,-70.542482,'CGA-05-PTZ - G 8750','LA GUAICA 8750',3,1,0],
[-33.424635,-70.5419,'CGA-06 - G 8772','LA GUAICA 8772',3,3,0],
[-33.424635,-70.5419,'CGA-07 - G 8772','LA GUAICA 8772',3,3,0],
[-33.424583,-70.541464,'CGA-08 - G A','LA GUAICA & ALHUE',3,3,0],
[-33.418096,-70.598649,'CV90-01 - V 90','VECINAL 90',5,3,0],
[-33.418096,-70.598649,'CV90-02 - V 90','VECINAL 90',5,3,0],
[-33.418389,-70.598537,'CV90-03 - V 90','VECINAL 90',5,3,0],
[-33.418324,-70.598252,'CV90-04 - N 2985','NAPOLEON 2985',5,3,0],
[-33.418517,-70.598613,'CV90-05-PTZ - V N','NAPOLEON & VECINAL',5,1,0],
[-33.419065,-70.560817,'MAP-01 - MAP 6500','MARTIN ALONSO DE PINZON 6500',4,3,0],
[-33.419497,-70.560951,'MAP-02 - MAP 6501','MARTIN ALONSO DE PINZON 6501',4,3,0],
[-33.419497,-70.560951,'MAP-03 - MAP 6501','MARTIN ALONSO DE PINZON 6501',4,3,0],
[-33.419497,-70.560951,'MAP-04 - MAP 6501','MARTIN ALONSO DE PINZON 6501',4,3,0],
[-33.419687,-70.561055,'MAP-05-PTZ - MAP 6507','MARTIN ALONSO DE PINZON 6507',4,1,0],
[-33.419839,-70.561147,'MAP-06 - MAP 6521','MARTIN ALONSO DE PINZON 6521',4,3,0],
[-33.419969,-70.560436,'MAP-07 - MAP 6573','MARTIN ALONSO DE PINZON 6573',4,3,0],
[-33.419969,-70.560436,'MAP-08 - MAP 6573','MARTIN ALONSO DE PINZON 6573',4,3,0],
[-33.419785,-70.55994,'MAP-09 - MAP 6641','MARTIN ALONSO DE PINZON 6641',4,3,0],
[-33.4197,-70.559999,'MAP-10 - MAP 6641','MARTIN ALONSO DE PINZON 6641',4,3,0],
[-33.419577,-70.560696,'MAP-11 - MAP 6645','MARTIN ALONSO DE PINZON 6645',4,3,0],
[-33.419638,-70.559867,'MAP-12 - MAP 6642','MARTIN ALONSO DE PINZON 6642',4,3,0],
[-33.419232,-70.559832,'MAP-13 - MAP 6599','MARTIN ALONSO DE PINZON 6599',4,3,0],
[-33.419109,-70.560554,'MAP-14 - MAP 6569','MARTIN ALONSO DE PINZON 6569',4,3,0],
[-33.419082,-70.560683,'MAP-15 - MAP 6569','MARTIN ALONSO DE PINZON 6569',4,3,0],
[-33.424421,-70.592845,'CSGP-01 - MSF SG','MARIANO SANCHEZ FONTECILLA & SAN GABRIEL',5,3,0],
[-33.424177,-70.592524,'CSGP-02 - SG 2922','SAN GABRIEL 2922',5,3,0],
[-33.423852,-70.592299,'CSGP-03 - SG 3011','SAN GABRIEL 3011',5,3,0],
[-33.423865,-70.592187,'CSGP-04 - SG 3087','SAN GABRIEL 3087',5,3,0],
[-33.423764,-70.592074,'CSGP-05 - SG 3011','SAN GABRIEL 3011',5,3,0],
[-33.423703,-70.592148,'CSGP-06 - U SG','UNAMUNO & SAN GABRIEL',5,3,0],
[-33.423589,-70.591996,'CSGP-07 - SG 3135','SAN GABRIEL 3135',5,3,0],
[-33.423576,-70.591861,'CSGP-08 - SG 3177','SAN GABRIEL 3177',5,3,0],
[-33.423498,-70.591909,'CSGP-09-PTZ - SG 3094','SAN GABRIEL 3094',5,1,0],
[-33.423244,-70.591596,'CSGP-10 - SG 3225','SAN GABRIEL 3225',5,3,0],
[-33.423186,-70.591426,'CSGP-11 - SG L','SAN GABRIEL & LEON',5,3,0],
[-33.423186,-70.591426,'CSGP-12 - SG L','SAN GABRIEL & LEON',5,3,0],
[-33.423094,-70.591463,'CSGP-13 - SC 800','SAN CRESCENTE 800',5,3,0],
[-33.423094,-70.591463,'CSGP-14 - SC 800','SAN CRESCENTE 800',5,3,0],
[-33.42272,-70.591023,'CSGP-15 - SG 3427','SAN GABRIEL 3427',5,3,0],
[-33.422715,-70.590898,'CSGP-16 - SG 3364','SAN GABRIEL 3364',5,3,0],
[-33.423222,-70.544396,'CU1-01 - O 8638','OLLAGUE 8638',3,3,0],
[-33.42336,-70.54428,'CU1-02-PTZ - P 1541','PARINACOTA 1541',3,1,0],
[-33.423266,-70.544271,'CU1-03 - O 8650','OLALGUE 8650',3,3,0],
[-33.423167,-70.543865,'CU1-04 - O 8684','OLLAGUE 8684',3,3,0],
[-33.423167,-70.543865,'CU1-05 - O 8684','OLLAGUE 8684',3,3,0],
[-33.423065,-70.543193,'CU1-06 - O A','OLLAGUE & ALHUE',3,3,0],
[-33.423552,-70.543176,'CU1-07 - A 1560','ALHUE 1560',3,3,0],
[-33.424189,-70.543163,'CU1-08 - A AF','ALHUE & AV ALEJANDRO FLEMING',3,3,0],
[-33.424331,-70.543152,'CU1-09 - AF A','ALEJANDO FLEMING & ALHUE',3,3,0],
[-33.424331,-70.543152,'CU1-10 - AF A','ALEJANDO FLEMING & ALHUE',3,3,0],
[-33.423775,-70.543868,'CU2-01 - P 1579','Puren 1579',3,3,0],
[-33.423775,-70.543868,'CU2-02 - P 1579','Puren 1579',3,3,0],
[-33.424411,-70.543762,'CU2-03 - P AF','Puren & Alejandro Fleming',3,3,0],
[-33.42439,-70.543557,'CU2-04-PTZ - AF 8673','Puren & Alejandro Fleming',3,1,0],
[-33.424491,-70.544365,'CU2-05 - PA AF','Parinacota & Alejando fleming',3,3,0],
[-33.424333,-70.544359,'CU2-06 - PA AF','Parinacota & Alejando fleming',3,3,0],
[-33.423757,-70.544425,'CU2-07 - PA 1579','Parinacota 1579',3,3,0],
[-33.423757,-70.544425,'CU2-08 - PA 1579','Parinacota 1579',3,3,0],
[-33.405103,-70.542751,'COX-01 - I 9003','Islandia 9003',4,3,0],
[-33.405045,-70.542746,'COX-02 - I O','Islandia esquina Oxford',4,3,0],
[-33.404657,-70.542843,'COX-03 - O 1422','Oxford 1422',4,3,0],
[-33.404564,-70.542866,'COX-04 - O 1422','Oxford 1422',4,3,0],
[-33.404472,-70.54289,'COX-05 - O 1402','Oxford 1402',4,3,0],
[-33.404382,-70.542912,'COX-06 - O 1391','Oxford 1391',4,3,0],
[-33.403934,-70.543023,'COX-07 - O 1291','Oxford 1291',4,3,0],
[-33.403934,-70.543023,'COX-08 - O 1291','Oxford 1291',4,3,0],
[-33.403934,-70.543023,'COX-09 - O 1291','Oxford 1291',4,3,0],
[-33.403934,-70.543023,'COX-10 - O 1291','Oxford 1291',4,3,0],
[-33.403657,-70.543099,'COX-11 - O 1205','Oxford 1205',4,3,0],
[-33.40361,-70.54311,'COX-12 - O 1150 (SP)','Oxford 1150',4,3,0],
[-33.40361,-70.54311,'COX-13 - O 1150','Oxford 1150',4,3,0],
[-33.403439,-70.543154,'COX-14 - O 1195','Oxford 1195',4,3,0],
[-33.403161,-70.54321,'COX-15 - O 1119','Oxford 1119',4,3,0],
[-33.403075,-70.543229,'COX-16-PTZ - O E','Oxford esquina Edimburgo',4,1,0],
[-33.426205,-70.529808,'CLP-01 - VA 1884','Vital Apoquindo 1884',3,3,0],
[-33.426186,-70.530292,'CLP-02 - LP 9439','Las Pleyades 9439',3,3,0],
[-33.426483,-70.530301,'CLP-03 - LP 9445','Las Pleyades 9445',3,3,0],
[-33.426211,-70.530619,'CLP-04 - LP 9385','Las Pleyades 9385',3,3,0],
[-33.426211,-70.530619,'CLP-05 - LP 9390','Las Pleyades 9390',3,3,0],
[-33.426211,-70.530619,'CLP-06 - LP 9390','Las Pleyades 9390',3,3,0],
[-33.426559,-70.531143,'CLP-07 - LP 9329','Las Pleyades 9329',3,3,0],
[-33.426528,-70.531486,'CLP-08 - LP 9307','Las Pleyades 9307',3,3,0],
[-33.426476,-70.531129,'CLP-09 - LP 9337','Las Pleyades 9337',3,3,0],
[-33.426211,-70.531441,'CLP-10-PTZ - LP 9318','Las Pleyades 9318',3,1,0],
[-33.426231,-70.532098,'CLP-11 - LP 9290','Las Pleyades 9290',3,3,0],
[-33.407084,-70.534612,'CLU-01 - LML 337','Luis Matte Larrain 337',0,3,0],
[-33.407994,-70.534243,'CLU-02-PTZ - LML 426','Luis Matte Larrain 426',0,1,0],
[-33.407994,-70.534243,'CLU-03 - LML 426','Luis Matte Larrain 426',0,3,0],
[-33.408699,-70.534016,'CLU-04 - LML AS','Luis Matte Larrain & Almirante Soublette',0,3,0],
[-33.429024,-70.581758,'DLV-01 - DLV 1754A','Daniel de la Vega 1754 A',5,3,0],
[-33.428855,-70.581942,'DLV-02 - DLV 1754C','Daniel de la Vega 1754 C',5,3,0],
[-33.428782,-70.582028,'DLV-03 - DLV 1726','Daniel de la Vega 1726',5,3,0],
[-33.428481,-70.582388,'DLV-04 - DLV 1698','Daniel de la Vega 1698',5,3,0],
[-33.428542,-70.582566,'DLV-05 - DLV MRC','Mariscal Ramon Castilla & Daniel de la Vega',5,3,0],
[-33.428542,-70.582566,'DLV-06-PTZ - DLV MRC','Mariscal Ramon Castilla & Daniel de la Vega',5,1,0],
[-33.428288,-70.5826,'DLV-07 - DLV 1688','Daniel de la Vega 1688',5,3,0],
[-33.393585,-70.55028,'D-01 - D RR','Dakar & Rosario Rosales',4,3,0],
[-33.393471,-70.549907,'D-02 - D 8632','Dakar 8632',4,3,0],
[-33.393438,-70.549705,'D-03 - 8644','Dakar 8644',4,3,0],
[-33.393438,-70.549705,'D-04 - 8645','Dakar 8645',4,3,0],
[-33.393598,-70.549636,'D-05 - D 8631','Dakar 8631',4,3,0],
[-33.393438,-70.549705,'D-06 - D 8635','Dakar 8635',4,3,0],
[-33.393438,-70.549705,'D-07-PTZ - D 8644','Dakar 8644',4,1,0],
[-33.393243,-70.549316,'D-08 - D 8677','Dakar 8677',4,3,0],
[-33.393282,-70.549297,'D-09 - D 8683','Dakar 8683',4,3,0],
[-33.393116,-70.548865,'D-10 - D 8875','Dakar & Costa de Marfil',4,3,0],
[-33.401185,-70.515821,'CCLV1-01 - CEA CDLV','Camino el alba & Camino las vertientes',0,3,0],
[-33.400645,-70.5158,'CCLV1-02 - CDLV 1585','Las Vertientes 1585',0,3,0],
[-33.399898,-70.515744,'CCLV1-03 - CDLV CLH','Las Vertientes & Camino Las Hojas',0,3,0],
[-33.399213,-70.515691,'CCLV1-04-PTZ - CDLV CLH','Las Vertientes & Camino Las Hojas',0,1,0],
[-33.399213,-70.515691,'CCLV1-05 - CDLV 1499','Las Vertientes 1499',0,3,0],
[-33.399024,-70.515677,'CCLV1-06 - CDLV 1472','Las Vertientes 1472',0,3,0],
[-33.398459,-70.515633,'CCLV1-07 - CDLV 1465','Las Vertientes 1465',0,3,0],
[-33.398088,-70.515607,'CCLV2-08 - CDLV CDLA','Las Vertientes & Camino Los Arrieros',0,3,0],
[-33.397521,-70.515566,'CCLV2-09 - CDLV 1417','Las Vertientes 1417',0,3,0],
[-33.397521,-70.515566,'CCLV2-10 - CDLV 1409','Las Vertientes 1409',0,3,0],
[-33.396882,-70.515517,'CCLV2-11 - CDLV 1371','Las Vertientes 1371',0,3,0],
[-33.396882,-70.515517,'CCLV2-12 - CDLV 1371','Las Vertientes 1371',0,3,0],
[-33.396528,-70.515404,'CCLV2-13-PTZ - CDLV 1353','Las Vertientes 1353',0,1,0],
[-33.396167,-70.515072,'CCLV2-14 - CDLV CEM','Las Vertientes & Camino El Manzanar',0,3,0],
[-33.395641,-70.514415,'CCLV2-15 - CDLV LP','Las Vertientes & Los Pumas',0,3,0],
[-33.396167,-70.515072,'CCLV2-16 - CDLV CEM','Las Vertientes & Camino El Manzanar',0,3,0],
[-33.426731,-70.580667,'FDAN-01 - FDA F (P)','Fernando De Aragon & Flandes',5,3,0],
[-33.427006,-70.581281,'FDAN-02 - FDA 4190 (O)','Fernando De Aragon 4190',5,3,0],
[-33.427046,-70.581384,'FDAN-03 - FDA 4181 (O)','Fernando De Aragon 4181',5,3,0],
[-33.427074,-70.581606,'FDAN-04 - FDA 4171 (P)','Fernando De Aragon 4171',5,3,0],
[-33.427055,-70.581706,'FDAN-05 - FDA 4172 (O)','Fernando De Aragon 4172',5,3,0],
[-33.427124,-70.582025,'FDAN-06 - FDA 4163 (P)','Fernando De Aragon 4163',5,3,0],
[-33.427124,-70.582025,'FDAN-07 - FDA 4163 (O)','Fernando De Aragon 4163',5,3,0],
[-33.427124,-70.582025,'FDAN-08 - FDA 4163 (P)','Fernando De Aragon 4163',5,3,0],
[-33.427255,-70.582419,'FDAN-09-PTZ - FDA 4148','Fernando De Aragon 4148',5,1,0],
[-33.427395,-70.582475,'FDAN-10 - JDA 1449 (O)','Juan De Austria 1449',5,3,0],
[-33.427409,-70.582413,'FDAN-11 - FDA 4155 (N)','Fernando De Aragon 4155',5,3,0],
[-33.427409,-70.582413,'FDAN-12 - FDA 4155 (P)','Fernando De Aragon 4155',5,3,0],
[-33.427409,-70.582413,'FDAN-13 - FDA 4155 (O)','Fernando De Aragon 4155',5,3,0],
[-33.427912,-70.581933,'FDAN-14 - JDA 1539 (N)','Juan De Austria 1539',5,3,0],
[-33.427912,-70.581933,'FDAN-15 - JDA 1539 (N)','JUAN DE AUSTRIA 1539',5,3,0],
[-33.40441,-70.532148,'CGB9000-01 - GB 9792 (P)','General Blanche 9792',0,3,0],
[-33.40441,-70.532148,'CGB9000-02 - GB 9792 (O)','General Blanche 9792',0,3,0],
[-33.40441,-70.532148,'CGB9000-03 - GB 9792 (P)','General Blanche 9792',0,3,0],
[-33.40441,-70.532148,'CGB9000-04 - GB 9792 (O)','General Blanche 9792',0,3,0],
[-33.404204,-70.53191,'CGB9000-05 - GB 9826 (P)','General Blanche 9826',0,3,0],
[-33.404204,-70.53191,'CGB9000-06 - GB 9826 (O)','General Blanche 9826',0,3,0],
[-33.404204,-70.53191,'CGB9000-07-PTZ - GB 9826','General Blanche 9826',0,1,0],
[-33.404074,-70.531753,'CGB9000-08 - GB 9848 (O)','General Blanche 9848',0,3,0],
[-33.403995,-70.531503,'CGB9000-09 - GB 9876 (O)','General Blanche 9876',0,3,0],
[-33.403995,-70.531503,'CGB9000-10 - GB 9876 (P)','General Blanche 9876',0,3,0],
[-33.403995,-70.531503,'CGB9000-11 - GB 9876 (O)','General Blanche 9876',0,3,0],
[-33.403815,-70.531225,'CGB9000-12 - GB 9910 (P)','General Blanche 9910',0,3,0],
[-33.403815,-70.531225,'CGB9000-13 - GB 9910 (O)','General Blanche 9910',0,3,0],
[-33.403815,-70.531225,'CGB9000-14 - GB 9910 (P)','General Blanche 9910',0,3,0],
[-33.403647,-70.530923,'CGB9000-15 - GB 9922 (P)','General Blanche 9922',0,3,0],
[-33.403647,-70.530923,'CGB9000-16 - GB 9922 (O)','General Blanche 9922',0,3,0],
[-33.416603,-70.571312,'LZ-01 - MZ LZ (N)','Martín de Zamora & Luis Zegers',5,3,0],
[-33.416071,-70.57153,'LZ-02 - LZ 806 (N)','Luis Zeggers 806',5,3,0],
[-33.415986,-70.571556,'LZ-03 - LZ 784 (O)','Luis Zeggers 784',5,3,0],
[-33.415702,-70.571647,'LZ-04 - LZ 690 (N)','Luis Zeggers 690',5,3,0],
[-33.415702,-70.571647,'LZ-05 - LZ 690 (S)','Luis Zeggers 690',5,3,0],
[-33.415605,-70.571714,'LZ-06-PTZ - LZ 655','Luis Zeggers 655',5,1,0],
[-33.415285,-70.571814,'LZ-07 - LZ 619 (O)','Luis Zeggers 619',5,3,0],
[-33.415285,-70.571814,'LZ-08 - LZ 619 (N)','Luis Zeggers 619',5,3,0],
[-33.415285,-70.571814,'LZ-09 - LZ 619 (S)','Luis Zeggers 619',5,3,0],
[-33.414742,-70.571909,'LZ-10 - LZ 495 (S)','Luis Zeggers 495',5,3,0],
[-33.414494,-70.572009,'LZ-11 - LZ DI (S)','Luis Zeggers & Del Inca',5,3,0],
[-33.394384,-70.55326,'CPB1-01 - P 639 (P)','Pinares 636',4,3,0],
[-33.394384,-70.55326,'CPB1-02 - P 639 (O)','Pinares 636',4,3,0],
[-33.394616,-70.552925,'CPB1-03 - P 500 (P)','Pinares 540',4,3,0],
[-33.394616,-70.552925,'CPB1-04 - P 500 (O)','Pinares 540',4,3,0],
[-33.394865,-70.55187,'CPB1-05 - P 358 (P)','Pinares 365',4,3,0],
[-33.394968,-70.552154,'CPB1-06 - P 365 (P)','Pinares 358',4,3,0],
[-33.395275,-70.551363,'CPB1-07 - P 235 (P)','Pinares 200',4,3,0],
[-33.395275,-70.551363,'CPB1-08 - P 235 (0)','Pinares 200',4,3,0],
[-33.39535,-70.550932,'CPB1-09 - P B (P)','Pinares 150',4,3,0],
[-33.39546,-70.550915,'CPB1-10 - P B (O)','Pinares 138',4,3,0],
[-33.395628,-70.55031,'CPB1-11-PTZ - P 138','Pinares & Las Verbenas',4,1,0],
[-33.39537,-70.550676,'CPB1-12 - P 110 (P)','Pinares & Bombay',4,3,0],
[-33.394789,-70.551528,'CPB2-01 - B 8554','Bombay 8562',4,3,0],
[-33.394789,-70.551528,'CPB2-02 - B 8554','Bombay 8562',4,3,0],
[-33.394522,-70.550645,'CPB2-03 - B 8586','Bombay 8586',4,3,0],
[-33.394497,-70.549574,'CPB2-04-PTZ - B RR','Bombay & Rosario Rosales',4,1,0],
[-33.394497,-70.549574,'CPB2-05 - B RR','Bombay & Rosario Rosales',4,3,0],
[-33.394333,-70.54956,'CPB2-06 - B 8547','Bombay 8647',4,3,0],
[-33.394333,-70.54956,'CPB2-07 - B 8547','Bombay 8647',4,3,0],
[-33.394183,-70.548881,'CPB2-08 - B 8674','Bombay 8671',4,3,0],
[-33.393945,-70.548368,'CPB2-09 - B 8731','Bombay 8731',4,3,0],
[-33.393945,-70.548368,'CPB2-10 - B 8731','Bombay 8731',4,3,0],
[-33.393717,-70.547587,'CPB2-11 - B 8825','Bombay 8825',4,3,0],
[-33.393717,-70.547587,'CPB2-12 - B 8825','Bombay 8825',4,3,0],
[-33.411414,-70.56452,'PLA-01 - LA 440 (S)','Los Almendros 440',4,3,0],
[-33.411592,-70.56424,'PLA-02 - LA 478 (S)','Los Almendros 478',4,3,0],
[-33.411584,-70.564457,'PLA-03 - PLA 469 (N)','Pasaje Los Almendros 469',4,3,0],
[-33.411742,-70.564602,'PLA-04-PTZ - PLA 465','Pasaje Los Almendros 465',4,1,0],
[-33.411873,-70.564707,'PLA-05 - PLA 459 (N)','Pasaje Los Almendros 459',4,3,0],
[-33.411873,-70.564707,'PLA-06 - PLA 459 (S)','Pasaje Los Almendros 459',4,3,0],
[-33.411968,-70.564913,'PLA-07 - PLA 451 (O)','Pasaje Los Almendros 451',4,3,0],
[-33.415286,-70.570395,'MDZLR-01 - LR 762','La Reconquista 762',5,3,0],
[-33.415587,-70.57032,'MDZLR-02 - LR 816','La Reconquista 816',5,3,0],
[-33.415579,-70.570454,'MDZLR-03 - LR 723','La Reconquista 723',5,3,0],
[-33.415579,-70.570454,'MDZLR-04 - LR 723','La Reconquista 723',5,3,0],
[-33.415858,-70.570256,'MDZLR-05 - LR 838','La Reconquista 838',5,3,0],
[-33.415858,-70.570256,'MDZLR-06 - LR 838','La Reconquista 838',5,3,0],
[-33.41619,-70.570231,'MDZLR-07 - MDZ 5471','Martín De Zamora 5471',5,3,0],
[-33.416244,-70.570188,'MDZLR-08-PTZ - MDZ 5471','Martín De Zamora 5471',5,1,0],
[-33.416366,-70.570608,'MDZLR-09 - MDZ 5415','Martín De Zamora 5415',5,3,0],
[-33.417584,-70.53034,'VLE-01 - Y 9439','Yolanda 9439',3,3,0],
[-33.417638,-70.530539,'VLE-02 - Y 9437','Yolanda 9437',3,3,0],
[-33.417624,-70.530849,'VLE-03 - Y LP','Yolanda & La Paz',3,3,0],
[-33.417747,-70.531321,'VLE-04 - Y 9431','Yolanda 9431',3,3,0],
[-33.417687,-70.531311,'VLE-05 - Y 9432','Yolanda 9431',3,3,0],
[-33.417816,-70.531633,'VLE-06 - Y 9430','Yolanda 9430',3,3,0],
[-33.417747,-70.531591,'VLE-07 - Y 9424','Yolanda 9424',3,3,0],
[-33.417747,-70.531591,'VLE-08 - Y PSY','Yolanda 9424',3,3,0],
[-33.417781,-70.531934,'VLE-09 - Y 9410','Yolanda 9410',3,3,0],
[-33.41787,-70.532529,'VLE-10-PTZ - Y E','Yolanda & La Escuela',3,1,0],
[-33.42815,-70.546477,'CDL-01 - DL 1892 (N)','Delia Matte 1892',3,3,0],
[-33.42815,-70.546477,'CDL-02 - DL 1892 (S)','Delia Matte 1892',3,3,0],
[-33.428585,-70.546416,'CDL-03 - DL 1929 (N)','Delia Matte 1929',3,3,0],
[-33.428585,-70.546416,'CDL-04 - DL 1929 (S)','Delia Matte 1929',3,3,0],
[-33.428958,-70.546347,'CDL-05-PTZ - DL 1950','Delia Matte 1950',3,1,0],
[-33.429173,-70.546375,'CDL-06 - DL 1975 (S)','Delia Matte 1975',3,3,0],
[-33.429216,-70.546319,'CDL-07 - DL 1976 (N)','Delia Matte 1975',3,3,0],
[-33.398626,-70.509676,'CCA-01 - CCA 12339 (O)','Cerro Abanico 12339',0,3,0],
[-33.398642,-70.509575,'CCA-02 - CA 12393 (P)','Cerro Abanico 12393',0,3,0],
[-33.398745,-70.508993,'CCA-03 - CCA 12393 (O)','Cerro Abanico 12393',0,3,0],
[-33.398745,-70.508993,'CCA-04 - CCA 12393 (O)','Cerro Abanico 12393',0,3,0],
[-33.398762,-70.508887,'CCA-05-PTZ - CCA 12390','Cerro Abanico 12390',0,1,0],
[-33.398819,-70.508549,'CCA-06 - CA 12466 (O)','Cerro Abanico 12466',0,3,0],
[-33.398897,-70.507948,'CCA-07 - STDJI 1478 (P)','Santa Teresa de Jornet de Ibars 1478',0,3,0],
[-33.411209,-70.518663,'CLF-01 - CLF 2860 (N)','Cam. La Fuente 2860',0,3,0],
[-33.411093,-70.518452,'CLF-02 - LF 11221 (O)','La Fontana 11221',0,3,0],
[-33.411019,-70.518259,'CLF-03 - LF 11005 (O)','La Fontana 11005',0,3,0],
[-33.410869,-70.51868,'CLF-04 - CLF 2796 (N)','Cam. La Fuente 2796',0,3,0],
[-33.410453,-70.518707,'CLF-05 - CLF 2762 (NO)','Cam. La Fuente 2762',0,3,0],
[-33.410605,-70.519075,'CLF-06 - CLF 2793 (P)','Cam. La Fuente 2793',0,3,0],
[-33.410417,-70.518835,'CLF-07 - CLF 2715 (P)','Cam. La Fuente 2715',0,3,0],
[-33.410086,-70.518798,'CLF-08 - CLF 2724 (S)','Cam. La Fuente 2724',0,3,0],
[-33.410086,-70.518798,'CLF-09 - CLF 2724 (N)','Cam. La Fuente 2724',0,3,0],
[-33.409671,-70.519098,'CLF-10 - CLF 2649 (N)','Cam. La Fuente 2649',0,3,0],
[-33.409671,-70.519098,'CLF-11 - CLF 2649 (S)','Cam. La Fuente 2649',0,3,0],
[-33.409388,-70.51915,'CLF-12 - CLF 2595 (S)','Cam. La Fuente 2595',0,3,0],
[-33.409197,-70.519248,'CLF-13 - CLF 2565','Cam. La Fuente 2565',0,1,0],
[-33.408432,-70.519764,'CLF-14 - CLF 2477 (S)','Cam. La Fuente 2477',0,3,0],
[-33.408432,-70.519764,'CLF-15 - CLF 2477 (N)','Cam. La Fuente 2477',0,3,0],
[-33.40837,-70.519713,'CLF-16 - CLF 2434 (P)','Cam. La Fuente 2434',0,3,0],
[-33.40837,-70.519713,'CLF-17 - CLF 2434 (O)','Cam. La Fuente 2434',0,3,0],
[-33.407526,-70.520376,'CLF-18 - QH 11191 (N)','QUEBRADA HONDA 11191',0,3,0],
[-33.40738,-70.520368,'CLF-19 - QH 11206 (N)','QUEBRADA HONDA 11206',0,3,0],
[-33.430189,-70.557551,'RVC14S-JPCA-01 - JP 1960 (NO)','Juan Palau 1952',3,3,0],
[-33.430035,-70.557577,'RVC14S-JPCA-02 - JP 1952 (S)','Juan Palau 1952',3,3,0],
[-33.429494,-70.557422,'RVC14S-JPCA-03 - JP 1898 (P)','Juan Palau 1898',3,3,0],
[-33.428997,-70.557423,'RVC14S-JPCA-04-PTZ - JP CA','Juan Palau & Carlos Alvarado',3,1,0],
[-33.429162,-70.556672,'RVC14S-JPCA-05 - CA 7283 (P)','Carlos Alvarado 7283',3,3,0],
[-33.429005,-70.557292,'RVC14S-JPCA-06 - CA JP (S)','Carlos Alvarado & Juan Palau?',3,3,0],
[-33.428976,-70.557415,'RVC14S-JPCA-07 - CA JP (SO)','Carlos Alvarado & Juan Palau?',3,3,0],
[-33.429078,-70.55745,'RVC14S-JPCA-08 - CA JP (N)','Carlos Alvarado & Juan Palau?',3,3,0],
[-33.429009,-70.557874,'RVC14S-JPCA-09 - CA 7105 (N)','Carlos Alvarado 7105',3,3,0],
[-33.428915,-70.557952,'RVC14S-JPCA-10 - CA 7128 (S)','Carlos Alvarado 7128',3,3,0],
[-33.428862,-70.558268,'RVC14S-JPCA-11 - CA 7080 (SP)','Carlos Alvarado 7080',3,3,0],
[-33.428932,-70.558437,'RVC14S-JPCA-12 - CA V (NO)','Carlos Alvarado & Vichato',3,3,0],
[-33.430162,-70.55866,'RVC14S-V-01 - V 1959','Vichato 1959',3,3,0],
[-33.429687,-70.558583,'RVC14S-V-02 - V 1925','Vichato 1925',3,3,0],
[-33.429385,-70.55839,'RVC14S-V-03 - V 1890','Vichato 1890',3,3,0],
[-33.428811,-70.558415,'RVC14S-V-04-PTZ - V 1867','Vichato 1867',3,1,0],
[-33.428697,-70.558284,'RVC14S-V-05 - V 1864','Vichato 1864',3,3,0],
[-33.428697,-70.558284,'RVC14S-V-06 - V 1864','Vichato 1864',3,3,0],
[-33.428001,-70.558168,'RVC14S-V-07 - V 1792','Vichato 1792',3,3,0],
[-33.428001,-70.558168,'RVC14S-V-08 - V 1795','Vichato 1795',3,3,0],
[-33.427512,-70.558139,'RVC14S-V-09 - V 1770','Vichato 1770',3,3,0],
[-33.427512,-70.558139,'RVC14S-V-10 - V 1769','Vichato 1769',3,3,0],
[-33.428963,-70.558757,'RVC14S-V-11 - CA 6963','Carlos Alvarado 6963?',3,3,0],
[-33.428869,-70.559119,'RVC14S-V-12 - CA 6884','Carlos Alvarado 6883',3,3,0],
[-33.428869,-70.559119,'RVC14S-V-13 - CA 6884','Carlos Alvarado 6884',3,3,0],
[-33.428634,-70.559638,'RVC14S-V-14 - CA 6800','Carlos Alvarado 6800',3,3,0],
[-33.428814,-70.559812,'RVC14S-V-15 - HH & CA','Huara huara & Carlos Alvarado.',3,3,0],
[-33.428634,-70.559638,'RVC14S-V-16 - HH 1852','Huara Huara 1852',3,3,0],
[-33.430445,-70.56002,'RVC14S-HH-01 - HH 1991','HUARA HUARA 1991',3,3,0],
[-33.430345,-70.56,'RVC14S-HH-02 - HH 1987','HUARA HUARA 1987',3,3,0],
[-33.430154,-70.559962,'RVC14S-HH-03 - HH 1970','HUARA HUARA? 1970?',3,3,0],
[-33.429972,-70.559926,'RVC14S-HH-04 - HH 1964','HUARA HUARA? 1964?',3,3,0],
[-33.429433,-70.559823,'RVC14S-HH-05 - HH 1925','HUARA HUARA? 1925?',3,3,0],
[-33.429256,-70.55979,'RVC14S-HH-06 - HH 1894','HUARA HUARA? 1894?',3,3,0],
[-33.429136,-70.559771,'RVC14S-HH-07 - HH 1880','HUARA HUARA? 1880',3,3,0],
[-33.428791,-70.55973,'RVC14S-HH-08 - HH CA','HUARA HUARA? & Carlos Alvarado',3,3,0],
[-33.428791,-70.55973,'RVC14S-HH-09-PTZ - HH CA','HUARA HUARA? & Carlos Alvarado',3,1,0],
[-33.428838,-70.560779,'RVC14S-HH-10 - CA EP','CARLOS ALVARADO & EL PILLAN',3,3,0],
[-33.428801,-70.560223,'RVC14S-HH-11 - CA 6715','CARLOS ALVARADO 6715',3,3,0],
[-33.428099,-70.559576,'RVC14S-HH-12 - HH 1821','HUARA HUARA? 1821',3,3,0],
[-33.427821,-70.559525,'RVC14S-HH-13 - HH 1803','HUARA HUARA? 1803?',3,3,0],
[-33.427369,-70.55944,'RVC14S-HH-14 - HH 1768','HUARA HUARA? 1768',3,3,0],
[-33.427369,-70.55944,'RVC14S-HH-15 - HH 1768','HUARA HUARA? 1768',3,3,0],
[-33.42684,-70.559377,'RVC14S-HH-16 - HH L','HUARA HUARA & LATADIA',3,3,0],
[-33.429921,-70.583189,'CC17-01 - CD ILC (N)','Canciller Dollfuss & Isabel la Catolica',5,3,0],
[-33.429701,-70.583348,'CC17-02 - CD 1790 (N)','Canciller Dollfuss 1790',5,3,0],
[-33.429247,-70.583931,'CC17-03 - CD 1680 (S)','Canciller Dollfuss 1680',5,3,0],
[-33.42912,-70.58409,'CC17-04 - CD 1650 (S)','Canciller Dollfuss 1650',5,3,0],
[-33.428933,-70.584328,'CC17-05 - CD 1575 (S)','Canciller Dollfuss 1575',5,3,0],
[-33.428812,-70.584485,'CC17-06 CD 1530 (S)','Canciller Dollfuss 1530',5,3,0],
[-33.428696,-70.58464,'CC17-07 - CD A (S)','Canciller Dollfuss & Acapulco',5,3,0],
[-33.428696,-70.58464,'CC17-08 - CD A (N)','Canciller Dollfuss & Acapulco',5,3,0],
[-33.428696,-70.58464,'CC17-09-PTZ - CD A','Canciller Dollfuss & Acapulco',5,1,0],
[-33.428696,-70.58464,'CC17-10 - CD 1500 (N)','Canciller Dollfuss 1500',5,3,0],
[-33.428799,-70.584935,'CC17-11 - A 3772 (P)','Acapulco 3772',5,3,0],
[-33.428941,-70.585347,'CC17-12 - A 3729 (O)','Acapulco 3729',5,3,0],
[-33.429,-70.585557,'CC17-13 - A 3711 (P)','Acapulco 3711',5,3,0],
[-33.429062,-70.585768,'CC17-14 - A 3696 (O)','Acapulco 3696',5,3,0],
[-33.429156,-70.58613,'CC17-15 - A 3665 (SP)','Acapulco 3665',5,3,0],
[-33.429156,-70.58613,'CC17-16 - A 3665 (O)','Acapulco 3665',5,3,0],
[-33.423113,-70.570804,'CVNB-01 - VNB SB (N)','Vasco Nuñez de Balboa & Sebastian Elcano',5,3,0],
[-33.423113,-70.570804,'CVNB-02 - VNB SB (S)','Vasco Nuñez de Balboa & Sebastian Elcano',5,3,0],
[-33.423124,-70.57113,'CVNB-03 - VNB 1361','Vasco Nuñez de Balboa 1361',5,3,0],
[-33.422987,-70.571278,'CVNB-04 - VNB 1354','Vasco Nuñez de Balboa 1354',5,3,0],
[-33.422836,-70.571408,'CVNB-05 - VNB 1351 (S)','Vasco Nuñez de Balboa 1351',5,3,0],
[-33.422836,-70.571408,'CVNB-06 - VNB 1351 (N)','Vasco Nuñez de Balboa 1351',5,3,0],
[-33.422836,-70.571408,'CVNB-07 - VNB 1352 (P)','Vasco Nuñez de Balboa 1352',5,3,0],
[-33.422836,-70.571408,'CVNB-08-PTZ - VNB 1352','Vasco Nuñez de Balboa 1352',5,1,0],
[-33.423054,-70.571735,'CVNB-09 - VNB 1321 (P)','Pje Vasco Nuñez de Balboa 1321',5,3,0],
[-33.422465,-70.571842,'CVNB-10 - VNB JDM (S)','Vasco Nuñez de Balboa & Jose de Moraleda',5,3,0],
[-33.422465,-70.571842,'CVNB-11 - VNB JDM (O)','Vasco Nuñez de Balboa & Jose de Moraleda',5,3,0],
[-33.42369,-70.552131,'PRM-01 - C 1305 (O)','CANUMANQUI 1305',3,3,0],
[-33.42369,-70.552131,'PRM-02 - C 1305 (O)','CANUMANQUI 1305',3,3,0],
[-33.423713,-70.551561,'PRM-03 - PRM 7786 (P)','PINTOR RAIMUNDO MONVOISIN 7786',3,3,0],
[-33.423713,-70.551561,'PRM-04 - PRM 7786 (O)','PINTOR RAIMUNDO MONVOISIN 7786',3,3,0],
[-33.423678,-70.551226,'PRM-05 - PRM 7806 (SP)','Pintor Raimundo Monvoisin 7806',3,3,0],
[-33.424079,-70.551263,'PRM-06 - PAH 1313 (N)','Pintor Alfredo Helsby 1313',3,3,0],
[-33.424079,-70.551263,'PRM-07 - PAH 1313 (S)','Pintor Alfredo Helsby 1313',3,3,0],
[-33.424216,-70.551238,'PRM-08 - PAH 1324 (S)','Pintor Alfredo Helsby 1324',3,3,0],
[-33.424605,-70.551162,'PRM-09 - PJGDC 7795 (N)','Pintor José Gil de Castro 7795',3,3,0],
[-33.423628,-70.550688,'PRM-10 - PRM 7850 (P)','Pintor Raimundo Monvoisin 7850',3,3,0],
[-33.423628,-70.550688,'PRM-11 - PRM 7850 (O)','Pintor Raimundo Monvoisin 7850',3,3,0],
[-33.423628,-70.550688,'PRM-12-PTZ - PRM 7850','Pintor Raimundo Monvoisin 7850',3,1,0],
[-33.423605,-70.550341,'PRM-13 - PRM 7886 (P)','Pintor Raimundo Monvoisin 7886',3,3,0],
[-33.423548,-70.549838,'PRM-14 - PRM 7934 (P)','Pintor Raimundo Monvoisin 7934',3,3,0],
[-33.423508,-70.549621,'PRM-15 - PRM 7946 (P)','Pintor Raimundo Monvoisin 7946',3,3,0],
[-33.422963,-70.548833,'PRM-16 - T 1294 (P)','Tezcuco 1294',3,3,0],
[-33.423096,-70.566738,'CCPM-01 - RB 5732 (S)','ROBERTO PERAGALLO 5732',5,3,0],
[-33.423096,-70.566738,'CCPM-02 -PTZ - RB 5732','ROBERTO PERAGALLO 5732',5,1,0],
[-33.423083,-70.566202,'CCPM-03 - RB 5806 (NP)','ROBERTO PERAGALLO 5806',5,3,0],
[-33.41471,-70.580529,'SPYEB-01 - N 4631','NEVERIA 4631',5,3,0],
[-33.414528,-70.580169,'SPYEB-02-PTZ - SP N','SAN PASCUAL & NEVERIA',5,1,0],
[-33.414528,-70.580169,'SPYEB-03 - SP N','SAN PASCUAL & NEVERIA',5,3,0],
[-33.414836,-70.580048,'SPYEB-04 - SN 215','San Pascual 215',5,3,0],
[-33.414911,-70.58,'SPYEB-05 - SN 228','San Pascual 228',5,3,0],
[-33.414987,-70.579949,'SPYEB-06 - SN 248','San Pascual 248',5,3,0],
[-33.415217,-70.579789,'SPYEB-07 - SN 275','San Pascual 275',5,3,0],
[-33.415571,-70.579536,'SPYEB-08 - SN 330','San Pascual 330',5,3,0],
[-33.416346,-70.578998,'SPYEB-09 - SN 410','San Pascual 410',5,3,0],
[-33.415082,-70.57917,'SPYEB-10 - EB 4693','Enrique Barrenechea 4693',5,3,0],
[-33.415082,-70.57917,'SPYEB-11 - EB 4693','Enrique Barrenechea 4693',5,3,0],
[-33.416033,-70.579205,'SPYEB-12- SB 375 (O)','SAN PASCUAL 375',5,3,0],
[-33.416062,-70.579145,'SPYEB-13 - PTZ - SP 397','SAN PASCUAL 397',5,3,0],
[-33.415746,-70.578679,'SPYEB-14 - T 4686 (SO)','TURENA 4686',5,3,0],
[-33.415812,-70.578618,'SPYEB-15 - T 4693 (NO)','TURENA 4693',5,3,0],
[-33.402875,-70.536809,'CCEO1-01 - CEO 1888','Camino del Observatorio 1888',4,3,0],
[-33.402875,-70.536809,'CCEO1-02-PTZ - CEO 1888','Camino del Observatorio 1888',4,1,0],
[-33.402875,-70.536809,'CCEO1-03 - CEO 1888','Camino del Observatorio 1888',4,3,0],
[-33.402712,-70.536708,'CCEO1-04 - CEO 1888','Camino del Observatorio 1888',4,3,0],
[-33.399937,-70.535119,'CCEO2-01 - CEO 1646','Camino del Observatorio 1646',4,3,0],
[-33.399388,-70.534999,'CCEO2-02 - CEO 1624','Camino del Observatorio 1624',4,3,0],
[-33.399388,-70.534999,'CCEO2-03 - CEO 1624','Camino del Observatorio 1624',4,3,0],
[-33.399046,-70.534986,'CCEO2-04 - CEO 1616','Camino del Observatorio 1616',4,3,0],
[-33.399046,-70.534986,'CCEO2-05 - CEO 1616','Camino del Observatorio 1616',4,3,0],
[-33.398851,-70.534949,'CCEO2-06 - CEO 1602','Camino del Observatorio 1602',4,3,0],
[-33.398851,-70.534949,'CCEO2-07 - CEO 1602','Camino del Observatorio 1602',4,3,0],
[-33.398659,-70.534933,'CCEO2-08 - CEO 1598','Camino del Observatorio 1598',4,3,0],
[-33.398659,-70.534933,'CCEO2-09 - CEO 1598','Camino del Observatorio 1598',4,3,0],
[-33.398379,-70.534911,'CCEO2-10 - CEO 1590','Camino del Observatorio 1590',4,3,0],
[-33.398192,-70.534893,'CCEO2-11 - CEO 1580','Camino del Observatorio 1580',4,3,0],
[-33.398192,-70.534893,'CCEO2-12 - CEO 1580','Camino del Observatorio 1580',4,3,0],
[-33.398099,-70.534883,'CCEO3-01 - CEO 1562','Camino del Observatorio 1562',4,3,0],
[-33.398008,-70.534874,'CCEO3-02 - CEO 1562','Camino del Observatorio 1562',4,3,0],
[-33.397824,-70.534846,'CCEO3-03 - CEO 1546','Camino del Observatorio 1546',4,3,0],
[-33.397553,-70.534775,'CCEO3-04 - CEO 1530','Camino del Observatorio 1530',4,3,0],
[-33.397553,-70.534775,'CCEO3-05-PTZ - CEO 1530','Camino del Observatorio 1530',4,1,0],
[-33.397553,-70.534775,'CCEO3-06 - CEO 1530','Camino del Observatorio 1530',4,3,0],
[-33.397112,-70.534586,'CCEO3-07 - CEO 1510','Camino del Observatorio 1510',4,3,0],
[-33.396764,-70.534409,'CCEO3-08 - CEO 1502','Camino del Observatorio 1502',4,3,0],
[-33.396764,-70.534409,'CCEO3-09 - CEO 1502','Camino del Observatorio 1502',4,3,0],
[-33.396419,-70.534234,'CCEO3-10 - CEO 1492','Camino del Observatorio 1492',4,3,0],
[-33.396229,-70.534138,'CCEO3-11 - CEO 1486','Camino del Observatorio 1486',4,3,0],
[-33.396229,-70.534138,'CCEO3-12 - CEO 1486','Camino del Observatorio 1486',4,3,0],
[-33.395866,-70.533955,'CCEO3-13 - CEO 1464','Camino del Observatorio 1464',4,3,0],
[-33.395691,-70.533868,'CCEO3-14 - CEO 1464','Camino del Observatorio 1464',4,3,0],
[-33.393931,-70.533079,'CCEO4-01-PTZ - CEO CO','Cam. El Olivar & Cam. El Observatorio',4,1,0],
[-33.393506,-70.533022,'CCEO4-02 - CEO 1110','Camino del Observatorio 1110',4,3,0],
[-33.393506,-70.533022,'CCEO4-03 - CEO 1110','Camino del Observatorio 1110',4,3,0],
[-33.393233,-70.533089,'CCEO4-04 - CEO 998','Camino del Observatorio 998',4,3,0],
[-33.393233,-70.533089,'CCEO4-05 - CEO 998','Camino del Observatorio 998',4,3,0],
[-33.392839,-70.5334,'CCEO4-06 - CEO CH','Cam. El Observatorio & Charles Hamilton',4,3,0],
[-33.425536,-70.537998,'CPHS-01-PTZ - VL PH','VIA LACTEA ESQUINA PADRE HURTADO',3,1,0],
[-33.425373,-70.538096,'CPHPS-02 - VL PH','PADRE HURTADO ESQUINA VIA LACTEA',3,3,0],
[-33.42519,-70.538069,'CPHS-03 - PH 1769','PADRE HURTADO 1769',3,3,0],
[-33.42519,-70.538069,'CPHS-04 - PH 1769','PADRE HURTADO 1769',3,3,0],
[-33.425098,-70.538055,'CPHS-05 - PH 1769','PADRE HURTADO 1769',3,3,0],
[-33.424917,-70.538026,'CPHS-06 - PH 1721 (O)','PADRE HURTADO 1721',3,3,0],
[-33.424735,-70.537997,'CPHS-07 - PH 1687','PADRE HURTADO 1687',3,3,0],
[-33.424644,-70.537982,'CPHS-08 - PH 1687','PADRE HURTADO 1687',3,3,0],
[-33.424462,-70.537954,'CPHS-09 - PH 1651','PADRE HURTADO 1651',3,3,0],
[-33.424193,-70.537906,'CPHS-10 - PH 1627 (S)','PADRE HURTADO 1627',3,3,0],
[-33.413949,-70.564015,'CGAV-01 - LG 6273','Las Gaviotas 6273',4,3,0],
[-33.413949,-70.564015,'CGAV-02 - LG 6273','Las Gaviotas 6273',4,3,0],
[-33.414013,-70.564093,'CGAV-03 - LG 6253','Las Gaviotas 6253',4,3,0],
[-33.413992,-70.564377,'CGAV-04 - LG 6232','Las Gaviotas 6232',4,3,0],
[-33.41379,-70.564817,'CGAV-05 - LG 6199','Las Gaviotas 6199',4,3,0],
[-33.41379,-70.564817,'CGAV-06-PTZ - LG 6199','Las Gaviotas 6199',4,1,0],
[-33.41379,-70.564817,'CGAV-07 - LG 6199','Las Gaviotas 6199',4,3,0],
[-33.413556,-70.564938,'CGAV-08 - LG 6173','Las Gaviotas 6172',4,3,0],
[-33.416171,-70.550187,'CMM-01 - M M (O)','Mataquito & Monroe',4,3,0],
[-33.415958,-70.549963,'CMM-02 - M 7728 (P)','Mataquito 7728',4,3,0],
[-33.415958,-70.549963,'CMM-03-PTZ - M 7728','Mataquito 7728',4,1,0],
[-33.415747,-70.549747,'CMM-04 - M 7757 (O)','Mataquito 7757',4,3,0],
[-33.41553,-70.549522,'CMM-05 - M 7768 (O)','Mataquito 7768',4,3,0],
[-33.415637,-70.549236,'CMM-06 - M 418 (N)','Maullin 818',4,3,0],
[-33.415637,-70.549236,'CMM-07 - M 418 (S)','Maullin 818',4,3,0],
[-33.415872,-70.548932,'CMM-08 - M 858 (P)','Maullin 858',4,3,0],
[-33.415872,-70.548932,'CMM-09 - M 858 (P)','Maullin 858',4,3,0],
[-33.416054,-70.549703,'CMM-10 - M 7735 (N)','Mataquito 7735',4,3,0],
[-33.42647,-70.529655,'CNBVA-01 - VA 1921','Vital Apoquindo 1921',3,3,0],
[-33.42647,-70.529655,'CNBVA-02 - VA 1921','Vital Apoquindo 1921',3,3,0],
[-33.426759,-70.529654,'CNBVA-03 - VA 1968','Vital Apoquindo 1968',3,3,0],
[-33.427118,-70.529877,'CNBVA-04 - VA NB','Nueva Bilbao & Vital Apoquindo',3,3,0],
[-33.427129,-70.530335,'CNBVA-05 - NB 9440','Nueva Bilbao 9440',3,3,0],
[-33.427128,-70.530454,'CNBVA-06 - NB 9445','Nueva Bilbao 9495',3,3,0],
[-33.42712,-70.530789,'CNBVA-07 - NB 9376','Nueva Bilbao 9376',3,3,0],
[-33.42712,-70.530789,'CNBVA-08 - NB 9346','Nueva Bilbao 9376',3,3,0],
[-33.427114,-70.53129,'CNBVA-09 - NB 9322','Nueva Bilbao 9322',3,3,0],
[-33.427113,-70.531437,'CNBVA-10 - NB 9316','Nueva Bilbao 9316',3,3,0],
[-33.427112,-70.531863,'CNBVA-11 - NB 9290','Nueva Bilbao 9290',3,3,0],
[-33.427028,-70.532096,'CNBVA-12-PTZ - NB C','Nueva Bilbao & Cirio',3,1,0],
[-33.42711,-70.532386,'CNBVA-13 - NB 9280','Nueva Bilbao 9280',3,3,0],
[-33.39825,-70.557057,'CPSGP-01 - PSGP 7379','Pasaje García Pica 7379',4,3,0],
[-33.398522,-70.557099,'CPSGP-02-PTZ - PSGP 7369','Pasaje García Pica 7369',4,1,0],
[-33.398727,-70.557092,'CPSGP-03 - PSGP 7367','Pasaje García Pica 7367',4,3,0],
[-33.416299,-70.53638,'LV1000-01 - CC9053','Cristóbal Colón 9053',3,3,0],
[-33.416543,-70.53631,'LV1000-02 - LV CC','Los Vilos & Cristobal Colon',3,3,0],
[-33.416904,-70.536205,'LV1000-03-PTZ - LV 1083','Los Vilos 1083',3,1,0],
[-33.416992,-70.536178,'LV1000-04 - LV 1098','Los Vilos 1098',3,3,0],
[-33.417414,-70.536031,'LV1000-05 - LV PA','Los Vilos & Pozo Almonte',3,3,0],
[-33.41738,-70.536352,'LV1000-06 - LV PZ (P)','LOS VILOS 1074',3,3,0],
[-33.41738,-70.536352,'LV1000-07 - LV PZ (P)','POZO AL MONTE 9050',3,3,0],
[-33.427818,-70.544977,'DSC-01 - DSC MCV (S)','Manuel Claro Vial & Domingo Santa Cruz',3,3,0],
[-33.428297,-70.544853,'DSC-02 - DSC 1915 (N)','Domingo Santa Cruz 1926',3,3,0],
[-33.428689,-70.544775,'DSC-03 - DSC 1956 (N)','Domingo Santa Cruz 1956',3,3,0],
[-33.428689,-70.544775,'DSC-04-PTZ - DSC 1956','Domingo Santa Cruz 1956',3,1,0],
[-33.429033,-70.544724,'DSC-05 - DSC 1988 (N)','Domingo Santa Cruz 1988',3,3,0],
[-33.429033,-70.544724,'DSC-06 - DSC 1988 (S)','Domingo Santa Cruz 1988',3,3,0],
[-33.429258,-70.54469,'DSC-07 - DSC FB (N)','Domingo Santa Cruz & Francisco Bilbao',3,3,0],
[-33.428027,-70.55182,'NCA-01 - FB N (P)','Florencio Barrios & Ñanco',3,3,0],
[-33.4281,-70.552354,'NCA-02 - N 7680 (O)','Ñanco 7680',3,3,0],
[-33.4281,-70.552354,'NCA-03 - N 7680 (P)','Ñanco 7680',3,3,0],
[-33.428146,-70.552781,'NCA-04 - N 7661','Ñanco 7661',3,3,0],
[-33.428211,-70.55347,'NCA-05 - N C (O)','Ñanco & Caleu',3,3,0],
[-33.428211,-70.55347,'NCA-06 - N C (S)','Ñanco & Caleu',3,3,0],
[-33.428211,-70.55347,'NCA-07 - N C (N)','Ñanco & Caleu',3,3,0],
[-33.428719,-70.553506,'NCA-08 - C MCV (N)','Caleu & Manuel Claro Vial',3,3,0],
[-33.427759,-70.553448,'NCA-09-PTZ - C 1805','Caleu 1805',3,1,0],
[-33.427331,-70.553465,'NCA-10 - C CLC (S)','Caleu & Colico',3,3,0],
[-33.427331,-70.553465,'NCA-11 - C CLC (N)','Caleu & Colico',3,3,0],
[-33.427331,-70.553465,'NCA-12 - C 1790 (O)','Caleu & Colico',3,3,0],
[-33.400754,-70.541094,'COS-01 - B 9142','Cardenal Newman & Bocaccio',4,3,0],
[-33.400758,-70.541311,'COS-02 - CN B','Bocaccio 9142',4,3,0],
[-33.40108,-70.541064,'COS-03 - CN 766','Cardenal Newman 766',4,3,0],
[-33.40139,-70.541017,'COS-04 - CN 832','Cardenal Newman 832',4,3,0],
[-33.40139,-70.541017,'COS-05-PTZ - CN 832','Cardenal Newman 832',4,1,0],
[-33.40139,-70.541017,'COS-06 - CN 853','Cardenal Newman 832',4,3,0],
[-33.401786,-70.540962,'COS-07 - CN 880','Cardenal Newman 880',4,3,0],
[-33.401786,-70.540962,'COS-08 - CN 880','Cardenal Newman 880',4,3,0],
[-33.402164,-70.540884,'COS-09 - CN 944','Cardenal Newman 944',4,3,0],
[-33.402164,-70.540884,'COS-10 - CN 944','Cardenal Newman 944',4,3,0],
[-33.402442,-70.54084,'COS-11 - CN 973','Cardenal Newman 973',4,3,0],
[-33.402914,-70.54075,'COS-12 - CN 1075','Cardenal Newman 1075',4,3,0],
[-33.403157,-70.540663,'COS-13 - CN E','Cardenal Newman & Edimburgo',4,3,0],
[-33.403157,-70.540663,'COS-14 - CN E','Cardenal Newman & Edimburgo',4,3,0],
[-33.414942,-70.559394,'EG-01 - HM 871','Hernando de Magallanes 871',4,3,0],
[-33.415161,-70.559496,'EG-02 - HM 847','Hernando de Magallanes 847',4,3,0],
[-33.415132,-70.558735,'EG-03 - EG 6788','El Galeón 6788',4,3,0],
[-33.415132,-70.558735,'EG-04 - EG 6788','El Galeón 6788',4,3,0],
[-33.415132,-70.558735,'EG-05 - EG 6788','El Galeón 6788',4,3,0],
[-33.415214,-70.558123,'EG-06 - EG 6830','El Galeón 6830',4,3,0],
[-33.415214,-70.558123,'EG-07 - EG 6823','El Galeón 6823',4,3,0],
[-33.415156,-70.558043,'EG-08-PTZ - EG 6835','El Galeón 6835',4,1,0],
[-33.414878,-70.557968,'EG-09 - EG 6859','El Galeón 6859',4,3,0],
[-33.414515,-70.557841,'EG-10 - EG AVPSPE','El Galeón & Av. Pdte Sebastián Piñera Echeñique',4,3,0],
[-33.418543,-70.546373,'GR-01 - G FO','Gredos & Fuente Ovejuna',3,3,0],
[-33.418614,-70.547232,'GR-02 - G 8051','Gredos 8051',3,3,0],
[-33.418614,-70.547232,'GR-03 - G 8051','Gredos 8051',3,3,0],
[-33.418663,-70.547585,'GR-04 - G C','Gredos & Calahorra',3,3,0],
[-33.418718,-70.548027,'GR-05 - G G','Gredos & Guipuzcoa',3,3,0],
[-33.418903,-70.548701,'GR-06 - PTZ - G V','Gredos & Vizcaya',3,1,0],
[-33.418872,-70.549279,'GR-07 - G 7817','Gredos 7817',3,3,0],
[-33.418872,-70.549279,'GR-08 - G 7817','Gredos 7817',3,3,0],
[-33.418934,-70.549727,'GR-09 - 7793','Gredos 7793',3,3,0],
[-33.419026,-70.55026,'GR-10 - G 7757','Gredos 7757',3,3,0],
[-33.419145,-70.55081,'GR-11 - G G','Gredos & Guadarrama',3,3,0],
[-33.414328,-70.548999,'CAZP-01 - Y LD','Yelcho & Los Dominicos',4,3,0],
[-33.414669,-70.548568,'CAZP-02 - Y 807','Yelcho 807',4,3,0],
[-33.414948,-70.548216,'CAZP-03 - Y 842','Yelcho 842',4,3,0],
[-33.415013,-70.548131,'CAZP-04 - Y 842','Yelcho 842',4,3,0],
[-33.414607,-70.548396,'CAZP-05-PTZ - A 7730','Azapa 7730',4,1,0],
[-33.414383,-70.548151,'CAZP-06 - A 7741','Azapa 7741',4,3,0],
[-33.414383,-70.548151,'CAZP-07 - A 7741','Azapa 7741',4,3,0],
[-33.414162,-70.547921,'CAZP-08 - A 7745','Azapa 7745',4,3,0],
[-33.414162,-70.547921,'CAZP-09 - A 7745','Azapa 7745',4,1,0],
[-33.413944,-70.547676,'CAZP-10 - A 7772','Azapa 7772',4,3,0],
[-33.413944,-70.547676,'CAZP-11 - A 7772','AZAPA 7772',4,3,0],
[-33.413582,-70.54733,'CAZP-12-PTZ - DEP LD','DOCTORA ERNESTINA PEREZ & LOS DOMINICOS',4,1,0],
[-33.413564,-70.547256,'CAZP-13 - A DEP','AZAPA & DOCTORA ERNESTINA PEREZ',4,3,0],
[-33.413197,-70.547718,'CAZP-14 - DEP LD','DOCTORA ERNESTINA PEREZ & LOS DOMINICOS',4,3,0],
[-33.413695,-70.547093,'CAZP-15 - DEP 676','DOCTORA ERNESTINA PEREZ 676',4,3,0],
[-33.413695,-70.547093,'CAZP-16 - DEP 676','DOCTORA ERNESTINA PEREZ 676',4,3,0],
[-33.413598,-70.541771,'CHPH-01 PTZ - RG & L','Rio Guadiana & Lontananza',4,1,0],
[-33.413485,-70.541595,'CHPH-02 - RG 8857 (O)','Rio Guadiana 8857',4,3,0],
[-33.413485,-70.541595,'CHPH-03 - RG 8857 (S)','Rio Guadiana 8857',4,3,0],
[-33.413367,-70.541277,'CHPH-04 - RG 8666 (S)','Rio Guadiana 8666',4,3,0],
[-33.413574,-70.540382,'CHPH-05 - PHS 875 (P)','Padre Hurtado Sur 823',4,3,0],
[-33.426862,-70.559469,'CHHN-01 - L 6829','Latadia & Huara Huara',3,3,0],
[-33.426764,-70.559333,'CHHN-02 - L HH','Huara Huara 1739',3,3,0],
[-33.426565,-70.559298,'CHHN-03 - HH 1739','Huara Huara 1734',3,3,0],
[-33.426,-70.559196,'CHHN-04 - HH 1734','Huara Huara 1691',3,3,0],
[-33.426191,-70.559228,'CHHN-05 - HH 1669','Huara Huara 1708',3,3,0],
[-33.425638,-70.559128,'CHHN-06-PTZ - HH 1699','Huara Huara 1666',3,1,0],
[-33.425638,-70.559128,'CHHN-07 - HH 1699','Huara Huara 1666',3,3,0],
[-33.425638,-70.559128,'CHHN-08 - HH 1667','Huara Huara 1678',3,3,0],
[-33.425273,-70.55906,'CHHN-09 - HH 1678','Huara Huara & Alejandro Fleming',3,3,0],
[-33.426191,-70.559228,'CHHN-10 - HH 1678','Huara Huara 1708',3,3,0],
[-33.426871,-70.559189,'CHHN-11 - HH 1655','Latadia & Huara Huara',3,3,0],
[-33.390878,-70.503786,'SR-01 - SR 874','Santa Rita 874',0,3,0],
[-33.390878,-70.503786,'SR-02 - SR 874','Santa Rita 874',0,3,0],
[-33.390831,-70.503363,'SR-03 - SR 864','Santa Rita 864',0,3,0],
[-33.390831,-70.503363,'SR-04 - SR 864','Santa Rita 864',0,3,0],
[-33.390699,-70.503524,'SR-05 - SM 12499','San Miguel 12499',0,3,0],
[-33.390504,-70.50325,'SR-06 - SM 12492','San Miguel 12492',0,3,0],
[-33.390379,-70.502972,'SR-07 - SR 811','Santa Rita 811',0,3,0],
[-33.390379,-70.502972,'SR-08 - SR 811','Santa Rita 811',0,3,0],
[-33.390379,-70.502972,'SR-09 - SR 811','Santa Rita 811',0,3,0],
[-33.390379,-70.502972,'SR-10 - SR 811','Santa Rita 811',0,3,0],
[-33.390177,-70.502566,'SR-11 - SR 791','Santa Rita 791',0,3,0],
[-33.390177,-70.502566,'SR-12 - SR 791','Santa Rita 791',0,3,0],
[-33.390177,-70.502566,'SR-13 - SR 791','Santa Rita 791',0,3,0],
[-33.390074,-70.502223,'SR-14 - SR 751','Santa Rita 751',0,3,0],
[-33.389973,-70.501804,'SR-15 - SR 719','Santa Rita 719',0,3,0],
[-33.389973,-70.501804,'SR-16 - SR 719','Santa Rita 719',0,3,0],
[-33.389973,-70.501804,'SR-17 - SR 719','Santa Rita 719',0,3,0],
[-33.389973,-70.501804,'SR-18 - SR 719','Santa Rita 719',0,3,0],
[-33.389789,-70.501292,'SR-19 - SR 683','Santa Rita 683',0,3,0],
[-33.389789,-70.501292,'SR-20 - SR 683','Santa Rita 683',0,3,0],
[-33.389684,-70.500916,'SR-21 - SR 655','Santa Rita 655',0,3,0],
[-33.389684,-70.500916,'SR-22 - SR 655','Santa Rita 655',0,3,0],
[-33.389606,-70.500603,'SR-23 - SR 629','Santa Rita 629',0,3,0],
[-33.425153,-70.533345,'CICA-01 - SZ 9230','Santa Zita 9230',3,3,0],
[-33.425141,-70.533667,'CICA-02 - SZ 9208','Santa Zita 9208',3,3,0],
[-33.424946,-70.533665,'CICA-03 - SZ C','Santa Zita & Capella',3,3,0],
[-33.424597,-70.533652,'CICA-04 - C 1709','Capella 1709',3,3,0],
[-33.424597,-70.533652,'CICA-05-PTZ - C 1709','Capella 1709',3,1,0],
[-33.424597,-70.533652,'CICA-06 - C 1709','Capella 1709',3,3,0],
[-33.424493,-70.533899,'CICA-07 - C 1672','Capella 1672',3,3,0],
[-33.424384,-70.533625,'CICA-08 - C 1669','Capella 1669',3,3,0],
[-33.424384,-70.533625,'CICA-09 - C 1669','Capella 1669',3,3,0],
[-33.423884,-70.533568,'CICA-10 - AF C','Alejandro Fleming & Capella',3,3,0],
[-33.423999,-70.533627,'CICA-11 - AF C','CAPELLA ESQUINA ALEJANDRO FLEMING',3,3,0],
[-33.41674,-70.571859,'JVI-01 - MZ JVI','Martin de Zamora & Jorge VI',5,3,0],
[-33.416833,-70.572169,'JVI-02 - MZ JVI','Martin de Zamora & Jorge VI',5,3,0],
[-33.416668,-70.572072,'JVI-03-PTZ - MZ JVI','Jorge VI & Martin de Zamora',5,1,0],
[-33.416474,-70.572159,'JVI-04 - JVI 861','Jorge VI 861',5,3,0],
[-33.416256,-70.572244,'JVI-05 - JVI 801','Jorge VI 801',5,3,0],
[-33.416256,-70.572244,'JVI-06 - JVI 801','Jorge VI 801',5,3,0],
[-33.416172,-70.572268,'JVI-07 - JVI 848','Jorge VI 848',5,3,0],
[-33.41591,-70.572363,'JVI-08 - JVI 669','Jorge VI 669',5,3,0],
[-33.415546,-70.572495,'JVI-09 - JVI 611','Jorge VI 611',5,3,0],
[-33.415546,-70.572495,'JVI-10 - JVI 611','Jorge VI 611',5,3,0],
[-33.415171,-70.572634,'JVI-11 - JVI 536','Jorge VI 536',5,3,0],
[-33.41508,-70.572666,'JVI-12 - JVI 505','Jorge VI 505',5,3,0],
[-33.41475,-70.572627,'JVI-13 - JVI DI','Del Inca & Jorge VI',5,3,0],
[-33.414755,-70.572804,'JVI-14 - JVI DI','Del Inca & Jorge VI',5,3,0],
[-33.415559,-70.532629,'LAES-01 - LE 962','La Escuela 962',0,3,0],
[-33.41538,-70.532576,'LAES-02 - LE 958','La Escuela 958',0,3,0],
[-33.41538,-70.532576,'LAES-03 - LE 958','La Escuela 958',0,3,0],
[-33.415138,-70.532559,'LAES-04 - LE 940','La Escuela 940',0,3,0],
[-33.414942,-70.532539,'LAES-05 - LE 945','La Escuela 945',0,3,0],
[-33.414848,-70.532529,'LAES-06-PTZ - LE 936','La Escuela 936',0,1,0],
[-33.414435,-70.532488,'LAES-07 - LE LDC','La Escuela & Lomas del Canelo',0,3,0],
[-33.414255,-70.532464,'LAES-08 - LE 930','La Escuela 930',0,3,0],
[-33.414255,-70.532464,'LAES-09 - LE 933','La Escuela 933',0,3,0],
[-33.413848,-70.532183,'LAES-10 - CPO 9543','Carlos Peña Otaegui 9543',0,3,0],
[-33.413691,-70.532408,'LAES-11 - LE 926','La Escuela 926',0,3,0],
[-33.414848,-70.532529,'LAES-12 - LE 936','La Escuela 936',0,3,0],
[-33.42077,-70.568669,'CADC-01 - ADC 5341 (O)','Alonso de Camargo 5341',5,3,0],
[-33.420772,-70.568546,'CADC-02-PTZ - ADC 5595','Alonso de Camargo 5595',5,1,0],
[-33.420781,-70.567963,'CADC-03 - ADC 5630 (P)','Alonso de Camargo 5630',5,3,0],
[-33.427101,-70.534001,'CVPG-01 - NB V','Nueva Bilbao & Venus',3,3,0],
[-33.426504,-70.534044,'CVPG-02 - V 1938','Venus 1938',3,3,0],
[-33.426379,-70.53385,'CVPG-03-PTZ - V IP','Venus INTERIOR PLAZA',3,1,0],
[-33.426271,-70.534,'CVPG-04 - V 1871','Venus 1871',3,3,0],
[-33.425828,-70.534005,'CVPG-05 - V VL','Venus & Via Lactea',3,3,0],
[-33.425773,-70.534584,'CLE - 01 - PTZ LE VL','SANTA ZITA 9111',3,1,0],
[-33.42575,-70.534011,'CLE - 02 - VL V','VIA LACTEA 9130',3,3,0],
[-33.425856,-70.534606,'CLE - 03 - LE 1818 (N)','ESPIGAS 1818',3,3,0],
[-33.425856,-70.534606,'CLE - 04 - LE 1818 (S)','ESPIGAS 1818',3,3,0],
[-33.425978,-70.534619,'CLE - 05 - LE 1910 (N)','ESPIGAS 1848',3,3,0],
[-33.426265,-70.534665,'CLE - 06 - LE 1919 (N)','ESPIGAS 1910',3,3,0],
[-33.42671,-70.53462,'CLE - 07 - LE 1970 (N)','ESPIGAS 1970',3,3,0],
[-33.42671,-70.53462,'CLE - 08 - LE 1970 (S)','ESPIGAS 1970',3,3,0],
[-33.426956,-70.534636,'CLE - 09 - LE NB (O)','ESPIGAS 1980',3,3,0],
[-33.426961,-70.534515,'CLE - 10 - LE 9116 (P)','NUEVA BILBAO 9116',3,3,0],
[-33.411665,-70.564131,'CLAP - 01','LOS ALMENDROS 498',4,3,0],
[-33.411507,-70.564157,'CLAP - 02','LOS ALMENDROS 478',4,3,0],
[-33.411347,-70.564118,'CLAP - 03','PASAJE LOS ALMENDROS 482',4,3,0],
[-33.411439,-70.563866,'CLAP - 04','PASAJE LOS ALMENDROS 496',4,3,0],
[-33.418466,-70.53689,'CPC - 01','TONGOY 1231',3,3,0],
[-33.418421,-70.53655,'CPC - 02','TONGOY 1236',3,3,0],
[-33.418479,-70.536736,'CPC - 03','CUYA 8957',3,3,0],
[-33.418494,-70.537063,'CPC - 04','CUYA 8958',3,3,0],
[-33.418577,-70.537382,'CPC - 05','CUYA 8935',3,3,0],
[-33.407772,-70.539124,'EA-01','CARDENAL NEWMAN 264',4,3,0],
[-33.407157,-70.539389,'EA-02','CARDENAL NEWMAN 168',4,3,0],
[-33.406979,-70.539442,'EA-03','CARDENAL NEWMAN 192',4,3,0],
[-33.407209,-70.539565,'EA-04','EL APOSTOL 9065',4,3,0],
[-33.407349,-70.539972,'EA-05','EL APOSTOL 9036',4,1,0],
[-33.407442,-70.540404,'EA-06','EL APOSTOL 9025',4,3,0],
[-33.407609,-70.540461,'EA-07','EL MESIAS 225',4,3,0],
[-33.407663,-70.539848,'EA-08','EL APOSTOL 9055',4,3,0],
[-33.407663,-70.539848,'EA-09','EL APOSTOL 9055',4,3,0],
[-33.407751,-70.539813,'EA-10','EL APOSTOL 9055',4,3,0],
[-33.407855,-70.539819,'EA-11','EL APOSTOL 9047',4,3,0],
[-33.406864,-70.540215,'EA-12','EL APOSTOL 9046',4,3,0],
[-33.407034,-70.540126,'EA-13','EL APOSTOL 9046',4,3,0],
[-33.427397,-70.542112,'PPR-01','PICA 1865',3,3,0],
[-33.427496,-70.542065,'PPR-02','PICA 1848',3,3,0],
[-33.427397,-70.542112,'PPR-03','PICA 1858',3,3,0],
[-33.427202,-70.542134,'PPR-04','PICA 1858',3,3,0],
[-33.427109,-70.542148,'PPR-05','PICA 1840',3,1,0],
[-33.427017,-70.542162,'PPR-06','PICA 1832',3,3,0],
[-33.426832,-70.54219,'PPR-07','PICA 1832',3,3,0],
[-33.426832,-70.54219,'PPR-08','PICA 1809',3,3,0],
[-33.426652,-70.54222,'PPR-09','PICA 1809',3,3,0],
[-33.426565,-70.542234,'PPR-10','PICA 1788',3,3,0],
[-33.426485,-70.542248,'PPR-11','PICA 1788',3,3,0],
[-33.426388,-70.542261,'PPR-12','RUPANCO 8717',3,3,0],
[-33.426176,-70.542284,'PPR-13','RUPANCO 8731',3,3,0],
[-33.418636,-70.543165,'L-01-PTZ - L 8702','LERIDA 8702',3,1,0],
[-33.418636,-70.543165,'L-02 - L 8702','LERIDA 8702',3,3,0],
[-33.418724,-70.543856,'L-03 - L 8678','LERIDA 8678',3,3,0],
[-33.418724,-70.543856,'L-04 - L 8678','LERIDA 8678',3,3,0],
[-33.418783,-70.543939,'L-05 - L 8672','LERIDA 8672',3,3,0],
[-33.430638,-70.561315,'EP-01 - EP FB (N)','EL PILLAN ESQUINA FRANCISCO BILBAO',3,3,0],
[-33.430301,-70.561218,'EP-02 - EP 1963 (S)','EL PILLAN 1963',3,3,0],
[-33.42994,-70.561132,'EP-03 - EP 1941 (S)','EL PILLAN 1941',3,3,0],
[-33.429849,-70.561104,'EP-04 - EP 1941 (N)','EL PILLAN 1941',3,3,0],
[-33.429485,-70.561018,'EP-05 - EP 1921 (N)','EL PILLAN 1921',3,3,0],
[-33.429392,-70.560995,'EP-06 - EP 1921 (N)','EL PILLAN 1921',3,3,0],
[-33.429102,-70.560951,'EP-07 - EP 1881 (N)','EL PILLAN 1881',3,3,0],
[-33.428779,-70.560873,'EP-08-PTZ - EP CA','EL PILLAN CARLOS ALVARADO',3,1,0],
[-33.428336,-70.560742,'EP-09 - EP 1933 (S)','EL PILLAN 1933',3,3,0],
[-33.428247,-70.560717,'EP-10 - EP 1833 (N)','EL PILLAN 1833',3,3,0],
[-33.427887,-70.560631,'EP-11 - EP 1807 (S)','EL PILLAN 1807',3,3,0],
[-33.427797,-70.560608,'EP-12 - EP 1807 (N)','EL PILLAN 1807',3,3,0],
[-33.42752,-70.560537,'EP-13 - EP 1771 (N)','EL PILLAN 1771',3,3,0],
[-33.427707,-70.560583,'EP-14-PTZ - EP 1792','EL PILLAN 1792',3,1,0],
[-33.427331,-70.560494,'EP-15 - EP 1766 (S)','EL PILLAN 1766',3,3,0],
[-33.427235,-70.560478,'EP-16 - EP 1766 (N)','EL PILLAN 1766',3,3,0],
[-33.426876,-70.56041,'EP-17 - EP L (S)','EL PILLAN L',3,3,0],
[-33.408856,-70.548408,'TMU-01 - T 141 (SP)','TORREMOLINOS 141',4,3,0],
[-33.409135,-70.548378,'TMU-02 - T 176 (O)','TORREMOLINOS 176',4,3,0],
[-33.40931,-70.548365,'TMU-03 - T 194 (P)','TORREMOLINOS 194',4,3,0],
[-33.409393,-70.548356,'TMU-04 - T 213 (SO)','TORREMOLINOS 213',4,3,0],
[-33.409683,-70.548318,'TMU-05 - T 222 (NP)','TORREMOLINOS 222',4,3,0],
[-33.409683,-70.548318,'TMU-06 - T 222 (SP)','TORREMOLINOS 222',4,3,0],
[-33.409778,-70.548302,'TMU-07 - T 221 (NO)','TORREMOLINOS 221',4,3,0],
[-33.409778,-70.548302,'TMU-08-PTZ - T 233','TORREMOLINOS 233',4,1,0],
[-33.409958,-70.548258,'TMU-09 - T 240 (P)','TORREMOLINOS 240',4,3,0],
[-33.41004,-70.548236,'TMU-10 - T 241 (O)','TORREMOLINOS 241',4,3,0],
[-33.41004,-70.548236,'TMU-11 - T 271 (SP)','TORREMOLINOS 271',4,3,0],
[-33.410217,-70.548187,'TMU-12 - T 289 (O)','TORREMOLINOS 289',4,3,0],
[-33.408682,-70.547705,'CTU-01 - TDLR 78 (SO)','TALAVERA DE LA REINA 78',4,3,0],
[-33.408863,-70.547686,'CTU-02 - TDLR 78 (S)','TALAVERA DE LA REINA 78',4,3,0],
[-33.408863,-70.547686,'CTU-03 - TDLR 78 (SO)','TALAVERA DE LA REINA 78',4,3,0],
[-33.409136,-70.547697,'CTU-04 - TDLR 121 (SO)','TALAVERA DE LA REINA 121',4,3,0],
[-33.409038,-70.54767,'CTU-05 - TDLR 124 (SP)','TALAVERA DE LA REINA 124',4,3,0],
[-33.40952,-70.547655,'CTU-06 - TDLR L (NO)','TALAVERA DE LA REINA ESQUINA LUGO',4,3,0],
[-33.409615,-70.547642,'CTU - 07 - TDLR 219 (P)','TALAVERA DE LA REINA 219',4,3,0],
[-33.40952,-70.547655,'CTU-08-PTZ - TDLR L','TALAVERA DE LA REINA ESQUINA LUGO',4,1,0],
[-33.409706,-70.547625,'CTU-09 - TDLR 243 (P)','TALAVERA DE LA REINA 243',4,3,0],
[-33.409796,-70.547605,'CTU-10 - TDLR 247 (SO)','TALAVERA DE LA REINA 247',4,3,0],
[-33.409885,-70.547579,'CTU-11 - TDLR 250 (S)','TALAVERA DE LA REINA 250',4,3,0],
[-33.410058,-70.547507,'CTU-12 - TDLR RT','TALAVERA DE LA REINA ESQUINA RIO TAJO',4,3,0],
[-33.41181,-70.55458,'MN-01 - MN 468 (NP)','MANUEL NOVOA 468',4,3,0],
[-33.412004,-70.554641,'MN-02 - MN 471 (SO)','MANUEL NOVOA 471',4,3,0],
[-33.412183,-70.554682,'MN-03 - MN 494 (N)','MANUEL NOVOA 494',4,3,0],
[-33.412588,-70.554761,'MN-04 - MN 511 (SP)','MANUEL NOVOA 511',4,3,0],
[-33.41275,-70.554765,'MN-05 - MN 523 (NO)','MANUEL NOVOA 523',4,3,0],
[-33.413027,-70.554745,'MN-06 - MN MC','MANUEL NOVOA ESQUINA MANUELA CABEZON',4,3,0],
[-33.413079,-70.554659,'MN-07 - MC MN (O)','MANUELA CABEZON ESQUINA MANUEL NOVOA',4,3,0],
[-33.413164,-70.554771,'MN-08 - MN 560','MANUEL NOVOA 560',4,3,0],
[-33.413256,-70.554793,'MN-09 - MN 577 (NO)','MANUEL NOVOA 577 (NO)',4,3,0],
[-33.413351,-70.554807,'MN-10-PTZ - MN 582','MANUEL NOVOA 582',4,1,0],
[-33.413401,-70.555228,'MN-11 - MM 6982 (SP)','MERCEDES MARIN 6982',4,3,0],
[-33.41385,-70.554906,'MN-12 - MN 615 (O)','MANUEL NOVOA 615',4,3,0],
[-33.413761,-70.554885,'MN-13 - MN 620 (NP)','MANUEL NOVOA 620',4,3,0],
[-33.414052,-70.554958,'MN-14 - MN 658 (P)','MANUEL NOVOA 658',4,3,0],
[-33.414141,-70.55498,'MN-15 - MN 667 (SO)','MANUEL NOVOA 667',4,3,0],
[-33.414233,-70.555004,'MN-16 - MN 671 (SP)','MANUEL NOVOA 671',4,3,0],
[-33.390009,-70.510105,'EBA-01 - RH EB (O)','Republica de Honduras esquina El Bautisterio',0,3,0],
[-33.390009,-70.510105,'EBA-02 - RH EB (P)','Republica de Honduras esquina El Bautisterio',0,3,0],
[-33.389776,-70.509936,'EBA-03 - EB 994 (N)','El Bautisterio 994',0,3,0],
[-33.389548,-70.509777,'EBA-04 - EB 983 (S)','El Bautisterio 983',0,3,0],
[-33.389469,-70.509726,'EBA-05 - EB 983 (N)','El Bautisterio 983',0,3,0],
[-33.389236,-70.509565,'EBA-06 - EB 961 (N)','El Bautisterio 961',0,3,0],
[-33.389157,-70.509512,'EBA-07 - EB 961 (S)','El Bautisterio 961',0,3,0],
[-33.388998,-70.509405,'EBA-08 - EB 929 (N)','El Bautisterio 929',0,3,0],
[-33.388916,-70.509348,'EBA-09-PTZ - EB 929','El Bautisterio 929',0,1,0],
[-33.388431,-70.509155,'EBA-10 - LM 12026 (S)','Los Monjes 12026',0,3,0],
[-33.388503,-70.508997,'EBA-11 - LM 12026 (S)','Los Monjes 12026',0,3,0],
[-33.414402,-70.556418,'CB-01 - CB M (N)','Cristina Barros esquina Monroe',4,3,0],
[-33.41407,-70.55625,'CB-02 - CB 717 (S)','Cristina Barros 717',4,3,0],
[-33.41407,-70.55625,'CB-03 - CB 717 (N)','Cristina Barros 717',4,3,0],
[-33.413811,-70.55611,'CB-04 - CB 679 (O)','Cristina Barros 679',4,3,0],
[-33.413811,-70.55611,'CB-05 - CB 679 (P)','Cristina Barros 679',4,3,0],
[-33.413471,-70.555942,'CB-06 - CB 630 (S)','Cristina Barros 630',4,3,0],
[-33.413471,-70.555942,'CB-07 - CB 630 (N)','Cristina Barros 630',4,3,0],
[-33.413268,-70.555836,'CB-08 - CB 607 (S)','Cristina Barros 607',4,3,0],
[-33.413268,-70.555836,'CB-09 - CB 607 (N)','Cristina Barros 607',4,3,0],
[-33.413006,-70.555722,'CB-10 - CB 567 (S)','Cristina Barros 567',4,3,0],
[-33.413006,-70.555722,'CB-11 - CB 567 (N)','Cristina Barros 567',4,3,0],
[-33.412662,-70.555557,'CB-12 - CB 541 (S)','Cristina Barros 541',4,3,0],
[-33.412662,-70.555557,'CB-13 - CB 541 (N)','Cristina Barros 541',4,3,0],
[-33.412342,-70.555375,'CB-14 - CB VS (S)','Cristina Barros esquina Victor Sotta',4,3,0],
[-33.413471,-70.555942,'CB-15-PTZ - CB 643','Cristina Barros 643',4,1,0],
[-33.388109,-70.538316,'DLCM-13 - CAMM 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',0,0,0],
[-33.388069,-70.538402,'DLCM-14 - CAMM 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78',0,0,0],
[-33.367837,-70.498666,'AMF-02 - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272',0,0,0],
[-33.367654,-70.497961,'AMF-03-PTZ - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377',0,1,0],
[-33.375411,-70.50912,'CSAN1-01 - CSA 672','CAMINO SAN ANTONIO 672',0,0,0],
[-33.375144,-70.509266,'CSAN1-02 - CSA 602','CAMINO SAN ANTONIO 602',0,0,0],
[-33.375144,-70.509266,'CSAN1-03 - CSA 602','CAMINO SAN ANTONIO 602',0,0,0],
[-33.374513,-70.509647,'CSAN1-04 - CSA 525','CAMINO SAN ANTONIO 525',0,0,0],
[-33.374585,-70.509549,'CSAN1-05 - CSA 480','CAMINO SAN ANTONIO 480',0,0,0],
[-33.374062,-70.509877,'CSAN1-06 - CSA 405','CAMINO SAN ANTONIO 405',0,0,0],
[-33.374062,-70.509877,'CSAN1-07 - CSA 404','CAMINO SAN ANTONIO 404',0,0,0],
[-33.374062,-70.509877,'CSAN1-08 - CSA 404','CAMINO SAN ANTONIO 404',0,0,0],
[-33.37319,-70.510378,'CSAN1-09 - CSA 391','CAMINO SAN ANTONIO 391',0,0,0],
[-33.372891,-70.510464,'CSAN1-10 - CSA 294','CAMINO SAN ANTONIO 294',0,0,0],
[-33.372452,-70.510792,'CSAN1-11 - CSA 255','CAMINO SAN ANTONIO 255',0,0,0],
[-33.372452,-70.510792,'CSAN1-12 - CSA 255','CAMINO SAN ANTONIO 255',0,0,0],
[-33.372045,-70.510943,'CSAN1-13 - CSA 110','CAMINO SAN ANTONIO 110',0,0,0],
[-33.372045,-70.510943,'CSAN1-14 - CSA 110','CAMINO SAN ANTONIO 110',0,0,0],
[-33.371837,-70.511104,'CSAN1-15 - CSA 99','CAMINO SAN ANTONIO 99',0,0,0],
[-33.371706,-70.511183,'CSAN1-16-PTZ - CSA 89','CAMINO SAN ANTONIO 89',0,1,0],
[-33.374083,-70.509814,'CSAN2-01 - CSA 410','CAMINO SAN ANTONIO 410',0,0,0],
[-33.372883,-70.510482,'CSAN2-02 - CSA 294','CAMINO SAN ANTONIO 294',0,0,0],
[-33.371837,-70.511104,'CSAN2-03 - CSA 89','CAMINO SAN ANTONIO 99',0,0,0],
[-33.371706,-70.511183,'CSAN2-04 - CSA 89','CAMINO SAN ANTONIO 89',0,0,0],
[-33.371384,-70.511356,'CSAN2-05 - CSA 73','CAMINO SAN ANTONIO 73',0,0,0],
[-33.370935,-70.511566,'CSAN2-06 - CSA 29','CAMINO SAN ANTONIO 29',0,0,0],
[-33.370935,-70.511566,'CSAN2-07 - CSA 29','CAMINO SAN ANTONIO 29',0,0,0],
[-33.404382,-70.542912,'COX-04 - O 1391','Oxford 1391',0,0,0],
[-33.404024,-70.543001,'COX-05 - O 1291','Oxford 1291',0,0,0],
[-33.404024,-70.543001,'COX-06 - O 1291','Oxford 1291',0,0,0],
[-33.403648,-70.543092,'COX-08 - O 1205','Oxford 1205',0,0,0],
[-33.403151,-70.543226,'COX-09 - O 1119','Oxford 1119',0,0,0],
[-33.4029,-70.543248,'COX-10-PTZ - O E','Oxford & Edimburgo',0,1,0],
[-33.390969,-70.520792,'CLFLF-02 - CLF 1159','CAMINO LA FUENTE 1159',0,0,0],
[-33.428855,-70.574765,'MBP-01-PTZ - MB AVS','MANUEL BARRIOS & AMERICO VESPUCIO SUR',1,1,0],
[-33.428855,-70.574765,'MBP-02 - MB AVS','MANUEL BARRIOS & AMERICO VESPUCIO SUR',1,0,0],
[-33.428787,-70.573837,'MBP-03 - MB 4539','MANUEL BARRIOS 4593',1,0,0],
[-33.428787,-70.573837,'MBP-04 - MB 4593','MANUEL BARRIOS 4593',1,0,0],
[-33.428775,-70.573651,'MBP-05 - MB 4551','MANUEL BARRIOS 4551',1,0,0],
[-33.428741,-70.573237,'MBP-06 - MB 4627','MANUEL BARRIOS 4627',1,0,0],
[-33.428725,-70.572983,'MBP-07 - MB 4695','MANUEL BARRIOS 4695',1,0,0],
[-33.428716,-70.572834,'MBP-08 - MB 4701','MANUEL BARRIOS 4701',1,0,0],
[-33.428716,-70.572834,'MBP-09 - MB 4701','MANUEL BARRIOS 4701',1,0,0],
[-33.42864,-70.571878,'MBP-10 - MB 4841','MANUEL BARRIOS 4841',1,0,0],
[-33.42864,-70.571878,'MBP-11 - MB 4841','MANUEL BARRIOS 4841',1,0,0],
[-33.428587,-70.571065,'MBP-12 - MB 4993','MANUEL BARRIOS 4993',1,0,0],
[-33.428587,-70.571065,'MBP-13 - MB 4993','MANUEL BARRIOS 4993',1,0,0],
[-33.428441,-70.570664,'MBP-14 - SE 1783','MANUEL BARRIOS 4980',1,0,0],
[-33.428613,-70.571498,'MBP-15 - MB 4915','MANUEL BARRIOS 4915',1,0,0],
[-33.428608,-70.571733,'MBP-16 - MB 4884','MANUEL BARRIOS 4884',1,0,0],
[-33.42511,-70.573749,'FR2-01 - FR 1418','Fitz Roy 1418',1,0,0],
[-33.425283,-70.573449,'FR2-02 - FR 1424','Fitz Roy 1424',1,0,0],
[-33.425453,-70.57316,'FR2-03 - FR 1432','Fitz Roy 1432',1,0,0],
[-33.425155,-70.575139,'FR2-04 - FR 1436','Fitz Roy 1436',1,0,0],
[-33.425453,-70.57316,'FR2-06 - FR 1440','Fitz Roy 1440',1,0,0],
[-33.425566,-70.572969,'FR2-08 - FR 1455','Fitz Roy 1445',1,0,0],
[-33.425566,-70.572969,'FR2-09 - FR 1452','Fitz Roy 1452',1,0,0],
[-33.425742,-70.572662,'FR2-10 - FR PDP','Fitz Roy & Puerto de Palos',1,0,0],
[-33.425642,-70.572276,'FR2-12 - PDP 4916','Puerto de Palos 4916',1,0,0],
[-33.420159,-70.589434,'P-01 – P PE','POLONIA & PRESIDENTE ERRAZURIZ',1,0,0],
[-33.419544,-70.589646,'P-02 – P 433','POLONIA 433',1,0,0],
[-33.419544,-70.589646,'P-03 – P 433','POLONIA 433',1,0,0],
[-33.419208,-70.589738,'P-04 – P 395','POLONIA 395',1,0,0],
[-33.419208,-70.589738,'P-05 – P 395','POLONIA 395',1,0,0],
[-33.419208,-70.589738,'P-06-PTZ – P 395','POLONIA 395',1,1,0],
[-33.418849,-70.58985,'P-07 – P 357','POLONIA 357',1,0,0],
[-33.418833,-70.589806,'P-08 – P 326','POLONIA 326',1,0,0],
[-33.430357,-70.577953,'CVL-09 - L 4243','LATADIA 4243',1,0,0],
[-33.427046,-70.581384,'FDAN-04 - FDA 4181 (P)','Fernando De Aragon 4172',1,0,0],
[-33.427124,-70.582025,'FDAN-06 - FDA 4160 (P)','Fernando De Aragon 4160',1,0,0],
[-33.427207,-70.58209,'FDAN-07 - FDA 4160 (O)','Fernando De Aragon 4163',1,0,0],
[-33.427436,-70.582505,'FDAN-09-PTZ - FDA 4163','Fernando De Aragon 4146',1,1,0],
[-33.427201,-70.582455,'FDAN-10 - FDA 4146 (O)','Fernando De Aragon 4145',1,0,0],
[-33.427453,-70.582369,'FDAN-11 - FDA 4145 (N)','Fernando De Aragon 4145',1,0,0],
[-33.427453,-70.582369,'FDAN-12 - FDA 4145 (P)','Fernando De Aragon 4145',1,0,0],
[-33.388044,-70.504345,'SB-02 - SB 12238 (Sur Oriente)','SAN BENITO 12238',2,0,0],
[-33.394207,-70.514659,'LF-13 - LF 1277 (Sur)','LOS FALDEOS 1277',2,0,0],
[-33.403044,-70.53173,'LMM-13 - LML 9923','Luis Matte Larraín 9898',2,0,0],
[-33.411904,-70.535477,'RG-01 - RG PH (Oriente)','RIO GUADIANA & PAUL HARRIS',2,0,0],
[-33.412143,-70.534763,'RG-02 - RG 9242 (Norte)','RIO GUADIANA 9242',2,0,0],
[-33.412229,-70.534575,'RG-03 - RG 9260 (Oriente)','RIO GUADIANA 9260',2,0,0],
[-33.412076,-70.533656,'RG-04 - LL 878 (Sur)','LAS LOMAS 878',2,0,0],
[-33.412492,-70.534018,'RG-06 - RG 9309 (Poniente)','RIO GUADIANA 9309',2,0,0],
[-33.412535,-70.533933,'RG-07 - RG 9309 (Oriente)','RIO GUADIANA 9309',2,0,0],
[-33.4128,-70.533659,'RG-08 - RG 9326 (Poniente)','RIO GUADIANA 9326',2,0,0],
[-33.413059,-70.533445,'RG-09 - RG 9387 (Nor Poniente)','RIO GUADIANA 9387',2,0,0],
[-33.413439,-70.533076,'RG-10 - RG 9433 (Oriente)','RIO GUADIANA 9433',2,0,0],
[-33.413593,-70.532762,'RG-12 - RG 9461 (Sur Poniente)','RIO GUADIANA 9461',2,0,0],
[-33.412644,-70.522992,'A2-03 - A 10766 (Oriente)','ATALAYA 10911',2,0,0],
[-33.412691,-70.523067,'A2-04 - A 10766 (Poniente)','ATALAYA 10911',2,0,0],
[-33.411735,-70.520308,'A3-07 - CPO 11052 (Poniente)','CARLOS PEÑA OTAEGUI 11052',2,0,0],
[-33.411748,-70.520214,'A3-08 - CPO 11052 (Oriente)','CARLOS PEÑA OTAEGUI 11052',2,0,0],
[-33.411808,-70.5189,'A3-10 - CPO 11170 (Oriente)','CARLOS PEÑA OTAEGUI 11170',2,0,0],
[-33.413166,-70.515328,'AT2-03-PTZ - A 11521','Atalaya 11521',2,1,0],
[-33.401185,-70.515821,'CDLV1-01 - CEA CDLV','Las Vertientes 1585',2,0,0],
[-33.400645,-70.5158,'CDLV1-02 - CDLV 1585','Las Vertientes & Camino Las Hojas',2,0,0],
[-33.399898,-70.515744,'CDLV1-03 - CDLV CLH','Las Vertientes & Camino Las Hojas',2,0,0],
[-33.399212,-70.515691,'CDLV1-04 - CDLV CLH','Las Vertientes 1499',2,0,0],
[-33.399212,-70.515691,'CDLV1-05-PTZ - CDLV 1499','Las Vertientes 1472',2,1,0],
[-33.399024,-70.515677,'CDLV1-06 - CDLV 1472','Las Vertientes 1465',2,0,0],
[-33.398459,-70.515633,'CDLV1-07 - CDLV 1465','Las Vertientes 1449',2,0,0],
[-33.398088,-70.515607,'CDLV1-08 - CDLV 1449','Las Vertientes 1417',2,0,0],
[-33.397521,-70.515565,'CDLV1-09 - CDLV 1417','Las Vertientes 1409',2,0,0],
[-33.397521,-70.515565,'CDLV2-01 - CDLV 1409','Las Vertientes 1398',2,0,0],
[-33.397144,-70.515541,'CDLV2-02 - CDLV 1398','Las Vertientes 1349',2,0,0],
[-33.396528,-70.515404,'CDLV2-03-PTZ - CDLV 1349','Las Vertientes 1371',2,1,0],
[-33.396882,-70.515517,'CDLV2-04 - CDLV 1371','Las Vertientes & Camino El Manzanar',2,0,0],
[-33.396167,-70.515072,'CDLV2-05 - CDLV CEM','Las Vertientes & Camino El Manzanar',2,0,0],
[-33.396167,-70.515072,'CDLV2-06 - CDLV CEM','Las Vertientes 1465',2,0,0],
[-33.395641,-70.514415,'CDLV2-07 - CDLV 1465','Fernando De Aragon & Flandes',2,0,0],
[-33.40441,-70.532148,'GB-01 - GB 9792 (P)','General Blanche 9792',2,0,0],
[-33.40441,-70.532148,'GB-02 - GB 9792 (O)','General Blanche 9792',2,0,0],
[-33.40441,-70.532148,'GB-03 - GB 9792 (P)','General Blanche 9792',2,0,0],
[-33.40441,-70.532148,'GB-04 - GB 9792 (O)','General Blanche 9826',2,0,0],
[-33.404204,-70.53191,'GB-05 - GB 9826 (P)','General Blanche 9826',2,0,0],
[-33.404204,-70.53191,'GB-06 - GB 9826 (O)','General Blanche 9826',2,0,0],
[-33.404204,-70.53191,'GB-07-PTZ - GB 9826','General Blanche 9848',2,1,0],
[-33.404074,-70.531753,'GB-08 - GB 9848 (O)','General Blanche 9876',2,0,0],
[-33.403901,-70.531505,'GB-09 - GB 9876 (O)','General Blanche 9876',2,0,0],
[-33.403901,-70.531505,'GB-10 - GB 9876 (P)','General Blanche 9894',2,0,0],
[-33.403799,-70.531354,'GB-11 - GB 9894 (P)','General Blanche 9910',2,0,0],
[-33.403799,-70.531354,'GB-12 - GB 9910 (P)','General Blanche 9910',2,0,0],
[-33.403799,-70.531354,'GB-13 - GB 9910 (O)','General Blanche 9910',2,0,0],
[-33.403743,-70.531156,'GB-14 - GB 9910 (P)','General Blanche 9922',2,0,0],
[-33.403665,-70.531029,'GB-15 - GB 9922 (P)','General Blanche 9922',2,0,0],
[-33.403665,-70.531029,'GB-16 - GB 9922 (O)','Manuel Aldunate 6392',2,0,0],
[-33.398702,-70.509597,'CCA-01 - CA 12339 (O)','Cerro Abanico 12390',2,0,0],
[-33.398748,-70.508933,'CCA-02-PTZ - CA 12390','Santa Teresa De Jornet De Ibars 1478',2,1,0],
[-33.398939,-70.507909,'CCA-03 - STDJDI 1478 (P)','Camino La Fuente Esquina Pasaje La Fontana',2,0,0],
[-33.411239,-70.518643,'CLFPLF-01 - CLF PLF (N)','Entrada Pasaje La Fontana',2,0,0],
[-33.411206,-70.518526,'CLFPLF-02 - PLF CLF (O)','Pasaje La Fontana 11264',2,0,0],
[-33.410986,-70.518026,'CLFPLF-03 - PLF 11264 (P)','Camino La Fuente 2796',2,0,0],
[-33.410928,-70.518706,'CLFPLF-04 - CLF 2796 (N)','Camino La Fuente 2762',2,0,0],
[-33.410472,-70.518716,'CLFPLF-05 - CLF 2762 (NO)','Pasaje Camino La Fuente 2763',2,0,0],
[-33.41077,-70.519209,'CLFPLF-06 - PCLF 2763 (P)','Pasaje Camino La Fuente (Entrada Psje)',2,0,0],
[-33.410408,-70.518846,'CLFPLF-07 - PCLF 2763 (P)','Camino La Fuente 2724',2,0,0],
[-33.410048,-70.518796,'CLFPLF-08 - CLF 2724 (S)','Camino La Fuente 2724',2,0,0],
[-33.410048,-70.518796,'CLFPLF-09 - CLF 2724 (N)','Camino La Fuente 2654',2,0,0],
[-33.409653,-70.518965,'CLFPLF-10 - CLF 2654 (N)','Camino La Fuente 2654',2,0,0],
[-33.409653,-70.518965,'CLFPLF-11 - CLF 2654 (S)','Camino La Fuente 2630',2,0,0],
[-33.409444,-70.519132,'CLFPLF-12 - CLF 2630 (P)','Camino La Fuente 2665',2,0,0],
[-33.409716,-70.519084,'CLFPLF-13-PTZ - CLF 2665','Camino La Fuente 2434',2,1,0],
[-33.408388,-70.519667,'CLFPLF-14 - CLF 2434 (S)','Camino La Fuente 2434',2,0,0],
[-33.408388,-70.519667,'CLFPLF-15 - CLF 2434 (N)','Camino La Fuente 2434',2,0,0],
[-33.408425,-70.519771,'CLFPLF-16 - CLF 2434 (P)','Camino La Fuente 2434',2,0,0],
[-33.408425,-70.519771,'CLFPLF-17 - CLF 2434 (O)','Camino La Fuente Esquina Quebrada Honda N 2762',2,0,0],
[-33.407512,-70.520285,'CLFPLF-18 - CLF QH 2762 (N)','Camino La Fuente Esquina Quebrada Honda Frente Al Camino La Fuente N 2434',2,0,0],
[-33.407512,-70.520285,'CLFPLF-19 - CLF QH 2434 (N)','Camino La Fuente Esquina Quebrada Honda Frente Al Camino La Fuente N 2434',2,0,0],
[-33.411987,-70.535439,'Punto 787','',2,0,0],
[-33.404132,-70.511291,'AFSR-04 C14 (Sur Poniente)','Los Olivos Interior',2,0,0],
[-33.404113,-70.511848,'AFSR-05 - Plaza (Oriente)','Los Olivos Plaza',2,0,0],
[-33.404145,-70.511816,'AFSR-06 - Plaza (Oriente)','Los Olivos',2,0,0],
[-33.403755,-70.51077,'AFSA-04 (Oriente)','Los Olivos',2,0,0],
[-33.403516,-70.510947,'AFSA-05 (Sur)','Los Olivos',2,0,0],
[-33.40342,-70.510518,'AFSA-06 (Poniente)','Los Olivos',2,0,0],
[-33.427372,-70.541448,'ET-01 - ET 1843','EL TATIO 1843',3,0,0],
[-33.426597,-70.541557,'ET-04 - ET 1791','EL TATIO 1791',3,0,0],
[-33.426751,-70.541535,'ET-03 - ET 1818','EL TATIO 1818',3,0,0],
[-33.42611,-70.541636,'ET-07-PTZ - ET 1781','EL TATIO 1781',3,1,0],
[-33.425989,-70.541651,'ET-08 - R 8769','RUPANCO 8769',3,0,0],
[-33.425989,-70.541651,'ET-09 - R 8769','RUPANCO 8769',3,0,0],
[-33.425969,-70.541051,'ET-10 - R 8828','RUPANCO 8828',3,0,0],
[-33.425569,-70.541705,'ET-11 - ET 1735','El TATIO 1735',3,0,0],
[-33.426963,-70.541483,'ET-02 - ET 1842','El TATIO 1842',3,0,0],
[-33.426439,-70.541557,'ET-05 - ET 1786','El TATIO 1786',3,0,0],
[-33.426439,-70.541557,'ET-06 - ET 1786','El TATIO 1786',3,0,0],
[-33.413927,-70.533514,'CA-07 - CA 879','CERRO ALEGRE 879',3,0,0],
[-33.414845,-70.533341,'CA-12- CA 921','CERRO ALEGRE 944',3,0,0],
[-33.41289,-70.534334,'CA-01 - CA 825','CERRO ALEGRE 825',3,0,0],
[-33.413118,-70.534092,'CA-02 - CA 841','CERRO ALEGRE 841',3,0,0],
[-33.413331,-70.534047,'CA-03 - CA 841','CERRO ALEGRE 841',3,0,0],
[-33.413395,-70.533998,'CA-04 - CA 860','CERRO ALEGRE 860',3,0,0],
[-33.413591,-70.533659,'CA-05 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.413656,-70.533595,'CA-06 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.414088,-70.533388,'CA-08 - CA 887','CERRO ALEGRE 887',3,0,0],
[-33.414479,-70.533212,'CA-10 - CA 921','CERRO ALEGRE 921',3,0,0],
[-33.414591,-70.533218,'CA-11 - CA 921','CERRO ALEGRE 921',3,0,0],
[-33.414945,-70.53335,'CA-13 - CG 964','CERRO ALEGRE 944',3,0,0],
[-33.425438,-70.540447,'LGN-01 - LG 8867','Luisa Guzman 8867',3,0,0],
[-33.425386,-70.54056,'LGN-02 - LG 8846','Luisa Guzman 8846',3,0,0],
[-33.425421,-70.540939,'LGN-03 - LG 8832','Luisa Guzman 8832',3,0,0],
[-33.425493,-70.541026,'LGN-04 - LG 8810','Luisa Guzman 8810',3,0,0],
[-33.425493,-70.541026,'LGN-05 - LG 8810','Luisa Guzman 8810',3,0,0],
[-33.42551,-70.541166,'LGN-06 - LG A','Luisa Guzman & Ayquina',3,0,0],
[-33.425508,-70.541253,'LGN-07 - LG 8792','Luisa Guzman 8792',3,0,0],
[-33.425585,-70.54168,'LGN-08 - ET 1737','El Tatio 1737',3,0,0],
[-33.425519,-70.541735,'LGN-09-PTZ - LG 8770','Luisa Guzman 8770',3,1,0],
[-33.425519,-70.541735,'LGN-10 - LG 8770','Luisa Guzman 8770',3,0,0],
[-33.42561,-70.542118,'LGN-11 - LG 8755','Luisa Guzman 8755',3,0,0],
[-33.425573,-70.542213,'LGN-12 - LG 8742','Luisa Guzman 8742',3,0,0],
[-33.425647,-70.54235,'LGN-13 - LG 8723','Luisa Guzman 8723',3,0,0],
[-33.425649,-70.542806,'LGN-14 - LG 8710','Luisa Guzman 8710',3,0,0],
[-33.425957,-70.541073,'AGMB-01 - A R','AYQUINA & RUPANCO',3,0,0],
[-33.426134,-70.541052,'AGMB-02 - A 1780','AYQUINA 1780',3,0,0],
[-33.426712,-70.540991,'AGMB-03 - A 1825','AYQUINA 1825',3,0,0],
[-33.426918,-70.540954,'AGMB-04 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.426918,-70.540954,'AGMB-05 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.426918,-70.540954,'AGMB-06-PTZ - A 1837','AYQUINA 1837',3,1,0],
[-33.427101,-70.540895,'AGMB-07 - A 1861','AYQUINA 1861',3,0,0],
[-33.426918,-70.540954,'AGMB-08 - A G','AYQUINA & GUALLATIRE',3,0,0],
[-33.426886,-70.540283,'AGMB-09 - G 8833','GUALLATIRE 8833',3,0,0],
[-33.426886,-70.540283,'AGMB-10 - G 8833','GUALLATIRE 8833',3,0,0],
[-33.426423,-70.539738,'AGMB-11 - V G','VISVIRI & GUALLATIRE',3,0,0],
[-33.426879,-70.539634,'AGMB-12 - V 1839','VISVIRI 1839',3,0,0],
[-33.427251,-70.539725,'AGMB-13 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,0,0],
[-33.42724,-70.539613,'AGMB-14 - MCV V','MANUEL CLARO VIAL & VISVIRI',3,0,0],
[-33.427297,-70.540154,'AGMB-15 - MCV 8844','MANUEL CLARO VIAL 8844',3,0,0],
[-33.427389,-70.540902,'AGMB-16 - MCV 8784','MANUEL CLARO VIAL 8784',3,0,0],
[-33.426528,-70.531486,'CLP-09 - LP 9307','Las Pleyades 9307',3,0,0],
[-33.426237,-70.530615,'CLP-10-PTZ - LP 9390','Las Pleyades 9390',3,1,0],
[-33.427051,-70.546557,'MCV-11 - C 1814','Luis Zeggers 297',3,0,0],
[-33.417584,-70.53034,'VLE-01 - Y VA','Yolanda 9437',3,0,0],
[-33.417624,-70.530849,'VLE-03 - Y P','Yolanda 9431',3,0,0],
[-33.417747,-70.531591,'VLE-08 - Y 9425','Yolanda 9410',3,0,0],
[-33.429494,-70.557422,'RVC14S-JPCA-03 - JP 1940 (P)','Juan Palau & Carlos Alvarado',3,0,0],
[-33.429078,-70.55745,'RVC14S-JPCA-08 - CA 7177 (N)','Carlos Alvarado 7105​',3,0,0],
[-33.428634,-70.559638,'RVC14S-V-16 - CA 6800','Carlos Alvarado 6800',3,0,0],
[-33.4269,-70.559318,'RVC14S-HH-01 - HH L','HUARA HUARA​ & Latadia',3,0,0],
[-33.427369,-70.559359,'RVC14S-HH-02 - HH 1768','HUARA HUARA​ 1768​',3,0,0],
[-33.427369,-70.559359,'RVC14S-HH-03 - HH 1768','HUARA HUARA​ 1768​',3,0,0],
[-33.427734,-70.559567,'RVC14S-HH-04 - HH CA','HUARA HUARA​ 1803​',3,0,0],
[-33.427897,-70.559617,'RVC14S-HH-05 - HH 1803','HUARA HUARA​ 1821​',3,0,0],
[-33.428711,-70.559645,'RVC14S-HH-06 - HH 1821','HUARA HUARA​ CARLOS ALVARADO',3,0,0],
[-33.429083,-70.55973,'RVC14S-HH-07 - HH 1894','HUARA HUARA​ 1894​',3,0,0],
[-33.429152,-70.559736,'RVC14S-HH-08 - HH 1886','HUARA HUARA​ 1886​',3,0,0],
[-33.429275,-70.55984,'RVC14S-HH-09 - HH 1925','HUARA HUARA​ 1925​',3,0,0],
[-33.430323,-70.559921,'RVC14S-HH-10 - HH 1970','HUARA HUARA​ 1970​',3,0,0],
[-33.430525,-70.560059,'RVC14S-HH-11 - HH 1987','HUARA HUARA​ 1987​',3,0,0],
[-33.429933,-70.559869,'RVC14S-HH-12 - HH 1947','HUARA HUARA​ 1947​',3,0,0],
[-33.430568,-70.55999,'RVC14S-HH-13 - HH 1991','HUARA HUARA​ 1991​',3,0,0],
[-33.428811,-70.559829,'RVC14S-HH-14 - HH CA','HUARA HUARA​ & Carlos Alvarado',3,0,0],
[-33.428826,-70.56039,'RVC14S-HH-15 - CA 6715','CARLOS ALVARADO​ 6715​',3,0,0],
[-33.428858,-70.560827,'RVC14S-HH-16 - CA EP','CARLOS ALVARADO​ & El Pillan​',3,0,0],
[-33.415291,-70.533308,'CA-16 - CA 964','CERRO ALEGRE 964',0,0,0],
[-33.415243,-70.53336,'CA-15 - CA 964','CERRO ALEGRE 966',0,0,0],
[-33.418302,-70.576704,'NB-01 - MDZ & NC','MARTIN DE ZAMORA & NIBALDO CORREA',4,0,0],
[-33.417868,-70.577002,'NB-02 - NC 808','NIBALDO CORREA 808',4,0,0],
[-33.417213,-70.577454,'NC-07 - NC 640','NIBALDO CORREA 640',4,0,0],
[-33.41642,-70.578002,'NC-11-PTZ - DI & NC','DEL INCA & NIBALDO CORREA',4,1,0],
[-33.393116,-70.548865,'D-10 - D CDM','Camino El Alba & Camino De Las Vertientes',4,0,0],
[-33.416603,-70.571312,'LZ-01 - LZ 297 (N)','Luis Zeggers 806',4,0,0],
[-33.41563,-70.571636,'LZ-04 - LZ 707 (N)','Luis Zeggers 707',4,0,0],
[-33.41563,-70.571636,'LZ-05 - LZ 707 (S)','Luis Zeggers 655',4,0,0],
[-33.414519,-70.572063,'LZ-11 - LZ & DEL INCA (S)','Pinares 636',4,0,0],
[-33.394602,-70.553184,'BP1-01 - P 636 (P)','Pinares 636',4,0,0],
[-33.394602,-70.553184,'BP1-02 - P 636 (O)','Pinares 540',4,0,0],
[-33.394645,-70.552655,'BP1-03 - P 540 (P)','Pinares 540',4,0,0],
[-33.394645,-70.552655,'BP1-04 - P 540 (O)','Pinares 365',4,0,0],
[-33.394868,-70.551881,'BP1-05 - P 365 (P)','Pinares 358',4,0,0],
[-33.394878,-70.55197,'BP1-06 - P 358 (O)','Pinares 200',4,0,0],
[-33.395148,-70.551154,'BP1-07 - P 200 (P)','Pinares 200',4,0,0],
[-33.395148,-70.551154,'BP1-08 - P 200 (O)','Pinares 150',4,0,0],
[-33.395374,-70.550688,'BP1-09 - P 150 (P)','Pinares 138',4,0,0],
[-33.395446,-70.550651,'BP1-10-PTZ - P 138','Pinares & Las Verbenas',4,1,0],
[-33.395628,-70.55031,'BP1-11 - P & LV (P)','Pinares & Bombay',4,0,0],
[-33.39537,-70.550676,'BP2-01 - P B (N)','Bombay 8562',4,0,0],
[-33.39487,-70.550251,'BP2-02 - B 8562 (S)','Bombay 8562',4,0,0],
[-33.39487,-70.550251,'BP2-03 - B 8562 (N)','Bombay 8586',4,0,0],
[-33.39465,-70.549922,'BP2-04 - B 8586 (N)','Bombay & Rosario Rosales',4,0,0],
[-33.394497,-70.549574,'BP2-05 - B RR (S)','Bombay & Rosario Rosales',4,0,0],
[-33.394497,-70.549574,'BP2-06-PTZ - B RR','Bombay 8647',4,1,0],
[-33.394267,-70.549222,'BP2-07 - B 8647 (S)','Bombay 8647',4,0,0],
[-33.394267,-70.549222,'BP2-08 - B 8647 (N)','Bombay 8671',4,0,0],
[-33.394102,-70.548799,'BP2-09 - B 8671 (NP)','Bombay 8731',4,0,0],
[-33.393895,-70.548259,'BP2-10 - B 8731 (P)','Bombay 8731',4,0,0],
[-33.393906,-70.548258,'BP2-11 - B 8731 (S)','Bombay 8825',4,0,0],
[-33.393634,-70.547472,'BP2-12 - B 8825 (N)','Bombay 8825',4,0,0],
[-33.393634,-70.547472,'BP2-13 - B 8825 (S)','Los Almendros 440',4,0,0],
[-33.42401,-70.52958,'002 VITAL APOQUINDO - FLEMING / PARLANTE','Alejandro Fleming &amp; Vital Apoquindo',0,6,1],
[-33.40919,-70.56828,'005 APUMANQUE / PARLANTE','Apoquindo &amp; Manquehue Sur',0,6,1],
[-33.40833,-70.55187,'010 TOMAS MORO - APOQUINDO / PARLANTE','Tomás Moro &amp; Apoquindo',0,6,1],
[-33.41333,-70.53637,'022 LOMA LARGA - ALACALUFES / PARLANTE','Loma Larga &amp; Alacalufes',0,6,1],
[-33.41482,-70.53563,'023 PLAZA MAPUCHES / PARLANTE','Mapuches &amp; Islas Guaitecas',0,6,1],
[-33.41641,-70.59412,'RF 03 FOSTER B / PTZ','Enrique Foster &amp; Apoquindo Norte',0,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / PTZ','Apoquindo &amp; General Barceló',0,1,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / SOS','Apoquindo &amp; General Barceló',0,5,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR /FIJA 1','Apoquindo &amp; General Barceló',0,3,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR /FIJA 2','Apoquindo &amp; General Barceló',0,3,1],
[-33.41343,-70.58272,'027 APOQUINDO - ESCUELA MILITAR / PARLANTE','Apoquindo &amp; General Barceló',0,6,1],
[-33.41343,-70.58272,'RF 05 ESCUELA MILITAR A / PTZ','Apoquindo &amp; General Barceló',0,1,1],
[-33.4159,-70.59165,'028 APOQUINDO - GERTRUDIS ECHEÑIQUE / PARLANTE','Apoquindo &amp; Gertrudis Echeñique',0,6,1],
[-33.41755,-70.59989,'RF 01 EL BOSQUE A / PTZ','Apoquindo &amp; El Bosque Norte',0,1,1],
[-33.42749,-70.53844,'048 PADRE HURTADO - SKATEPARK / PARLANTE','Skate Padre Hurtado',0,6,1],
[-33.41557,-70.53859,'050 CERRO TOLOLO - CERRO NEGRO / PARLANTE','Cerro Tololo &amp; Cerro Negro',0,6,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / FIJA 4','Av Apoquindo &amp; Rosario Norte',0,3,1],
[-33.409589,-70.570624,'057 APOQUINDO - ROSARIO NORTE / PARLANTE','Av Apoquindo &amp; Rosario Norte',0,6,1],
[-33.396858,-70.566948,'059 KENNEDY - BRASILIA / PARLANTE','Av. Kennedy &amp; Brasilia',0,6,1],
[-33.401421,-70.555218,'062 LAS CONDES - LAS TRANQUERAS / PARLANTE','Av. Las Condes &amp; Las Tranqueras',0,6,1],
[-33.405052,-70.568479,'063 MANQUEHUE - LOS MILITARES / PARLANTE','Av. Manquehue &amp; Los Militares',0,6,1],
[-33.403844,-70.573456,'065 RIESCO - ROSARIO NORTE / PARLANTE','Av. Presidente Riesco &amp; Rosario Norte',0,6,1],
[-33.414449,-70.594566,'078 FOSTER - ISIDORA GOYENECHEA / PARLANTE','Isidora Goyenechea &amp; Enrique Foster',0,6,1],
[-33.414449,-70.594566,'RF 11 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea &amp; Enrique Foster',0,1,1],
[-33.413528,-70.558785,'079 IV CENTENARIO - HDO DE MAGALLANES / PARLANTE','IV Centenario &amp; Hernando de Magallanes',0,6,1],
[-33.427755,-70.570121,'083 ROTONDA LATADIA / PARLANTE','Latadía &amp; Sebastián Elcano',0,6,1],
[-33.413103,-70.537537,'086 NAME - SIERRA NEVADA / PARLANTE','Pje. Cerro Name &amp; Pje. Sierra Nevada',0,6,1],
[-33.414423,-70.537494,'087 DIAGUITAS - LEON BLANCO / SOS','Pje. Diaguitas &amp; Pje. León Blanco',0,5,1],
[-33.414423,-70.537494,'087 DIAGUITAS - LEON BLANCO / PARLANTE','Pje. Diaguitas &amp; Pje. León Blanco',0,6,1],
[-33.420242,-70.588399,'091 ERRAZURIZ - ALCANTARA / PARLANTE','Pdte. Errazuriz &amp; Alcantara',0,6,1],
[-33.423615,-70.527308,'093 PLAZA FLEMING / PARLANTE','Alejandro Fleming 9695',0,6,1],
[-33.413274,-70.570203,'094 ROTONDA LA CAPITANIA / PARLANTE','La Capitanía &amp; Del Inca',0,6,1],
[-33.415373,-70.551429,'095 MONROE - ANDALIEN / PARLANTE','Monroe &amp; Andalién',0,6,1],
[-33.430451,-70.585123,'097 I. La Católica & S.Fontecilla / LPR 1','Sánchez Fontecilla &amp; Isabel La Católica',0,2,1],
[-33.430451,-70.585123,'097 I. La Católica & S.Fontecilla / LPR 2','Sánchez Fontecilla &amp; Isabel La Católica',0,2,1],
[-33.413522,-70.539614,'098 LEON NEGRO - FUEGUINOS / PARLANTE','Sierra Nevada &amp; Leon Negro',0,6,1],
[-33.401927,-70.570086,'099 PARQUE ARAUCANO SKATEPARK / PARLANTE','Skatepark Parque Araucano',0,6,1],
[-33.416816,-70.604894,'100 TAJAMAR - VITACURA / PARLANTE','Tajamar &amp; Vitacura',0,6,1],
[-33.425341,-70.553952,'101 TOMAS MORO - FLEMING / PARLANTE','Tomás Moro &amp; Alejandro Fleming',0,6,1],
[-33.428146,-70.574807,'103 VESPUCIO - LATADIA / PARLANTE','A. Vespucio &amp; Latadía',0,6,1],
[-33.41639,-70.594105,'RF 03 FOSTER A / PTZ','Enrique Foster &amp; Apoquindo Sur',0,1,1],
[-33.39951,-70.5068,'153 DUOC CAMINO EL ALBA - LA PLAZA / PTZ','DUOC - Camino El Alba &amp; La PLaza',0,1,1],
[-33.399665,-70.574542,'177 MARRIOT / PARLANTE','Av. Kennedy 5741',0,6,1],
[-33.409457,-70.570242,'RF 07 ROSARIO NORTE / PTZ','Apoquindo &amp; Rosario Norte',0,1,1],
[-33.408777,-70.567855,'RF 08 MANQUEHUE / PTZ','Manquehue &amp; Apoquindo Norte',0,1,1],
[-33.409235,-70.568171,'RF 09 APUMANQUE / FIJA','Apumanque &amp; Apoquindo Sur',0,3,1],
[-33.413653,-70.58266,'RF 05 ESCUELA MILITAR B / PTZ','Apoquindo &amp; Felix de amesti',0,1,1],
[-33.420651,-70.533969,'235 ESTADIO PATRICIA / PARLANTE','PATRICIA &amp; PICHIDANGUI',0,6,1],
[-33.426284,-70.573986,'239 ISABEL LA CATATOLICA #4601 / PTZ','ISABEL LA CATÓLICA 4601',0,1,1],
[-33.426284,-70.573986,'239 ISABEL LA CATATOLICA #4601 / FIJA 1','ISABEL LA CATÓLICA 4601',0,3,1],
[-33.426284,-70.573986,'239 ISABEL LA CATATOLICA #4601 / FIJA 2','ISABEL LA CATÓLICA 4601',0,3,1],
[-33.426284,-70.573986,'239 ISABEL LA CATATOLICA #4601 / LPR 1','ISABEL LA CATÓLICA 4601',0,2,1],
[-33.426284,-70.573986,'239 ISABEL LA CATATOLICA #4601 / LPR 2','ISABEL LA CATÓLICA 4601',0,2,1],
[-33.385083,-70.532717,'249 Estoril & P.Harris / LPR 1','Estoril &amp; Av. Las Condes',0,2,1],
[-33.385083,-70.532717,'249 ESTORIL (PAUL HARRIS) PONIENTE LAS CONDES / FIJA','Estoril &amp; Av. Las Condes',0,3,1],
[-33.404426,-70.556827,'268 268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 1','Las Condes &amp; General Carol Urzúa',0,3,1],
[-33.404426,-70.556827,'268 268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 2','Las Condes &amp; General Carol Urzúa',0,3,1],
[-33.40701,-70.56122,'282 NUESTRA SEÑORA DEL ROSARIO & AV. LAAS CONDES / PTZ','Nuestra Sra del Rosario &amp; Av. Las Condes',0,1,1],
[-33.412815,-70.537536,'287 FUEGUINOS & CERRO NAME / PTZ','Fueguinos &amp; Cerro Name',0,1,1],
[-33.412815,-70.537536,'287 FUEGUINOS & CERRO NAME / FIJA 1','Fueguinos &amp; Cerro Name',0,3,1],
[-33.412815,-70.537536,'287 FUEGUINOS & CERRO NAME / FIJA 2','Fueguinos &amp; Cerro Name',0,3,1],
[-33.423132,-70.586652,'292 MARTIN DE ZAMORA & ALCANTARA PTZ','MARTIN DE ZAMORA &amp; ALCANTARA',0,1,1],
[-33.413816,-70.60661,'293 TITANIUM PTZ','PARQUE TITANIUM',0,1,1],
[-33.413037,-70.606329,'293 TITANIUM FIJA 01','PARQUE TITANIUM',0,3,1],
[-33.413807,-70.606227,'293 TITANIUM FIJA 02','PARQUE TITANIUM',0,3,1],
[-33.413897,-70.606439,'293 TITANIUM FIJA 03','PARQUE TITANIUM',0,3,1],
[-33.413897,-70.606439,'293 TITANIUM FIJA 04','PARQUE TITANIUM',0,3,1],
[-33.425147,-70.563476,'296 ISABEL LA CATOLICA - MANQUEHUE ORIENTE / PTZ','Isabel la Católica &amp; Manquehue Oriente',0,1,1],
[-33.430863,-70.574788,'297 VESPUCIO - BILBAO / LPR 1','Vespucio Poniente &amp; Bilbao',0,2,1],
[-33.430863,-70.574788,'297 VESPUCIO - BILBAO / FIJA 1','Vespucio Poniente &amp; Bilbao',0,3,1],
[-33.430863,-70.574788,'297 VESPUCIO - BILBAO / FIJA 2','Vespucio Poniente &amp; Bilbao',0,3,1],
[-33.410653,-70.579161,'298 LOS MILITARES - ORINOCO / LPR 1','Los Militares &amp; Orinoco',0,2,1],
[-33.410653,-70.579161,'298 LOS MILITARES - ORINOCO / LPR 2','Los Militares &amp; Orinoco',0,2,1],
[-33.410653,-70.579161,'298 LOS MILITARES - ORINOCO / FIJA 1','Los Militares &amp; Orinoco',0,3,1],
[-33.410653,-70.579161,'298 LOS MILITARES - ORINOCO / FIJA 2','Los Militares &amp; Orinoco',0,3,1],
[-33.405028,-70.557472,'PI 01 LAS CONDES - CAROL URZUA / PARLANTE','Av. Las condes &amp; Carol Urzua',0,6,2],
[-33.417472,-70.545972,'PI 02 COLON - FUENTEOVEJUNA / PARLANTE','C. Colon &amp; Fuenteovejuna',0,6,2],
[-33.414611,-70.537361,'PI 04 DIAGUITAS - ATACAMEÑOS / PARLANTE','Diaguitas &amp; Atacameños',0,6,2],
[-33.428333,-70.551056,'PI 05 F BARRIOS . M CLARO VIAL / PARLANTE','Florencio Barrios &amp; Miguel Claro Vial',0,6,2],
[-33.42425,-70.547,'PI 06 IV CENTENARIO - FLEMING / PARLANTE','IV Centenario &amp; Alejandro Fleming',0,6,2],
[-33.423639,-70.546528,'PI 07 IV CENTENARIO - FUENTEOVEJUNA / PARLANTE','IV Centenario &amp; Fuenteovejuna',0,6,2],
[-33.401056,-70.555167,'PI 08 LAS CONDES - LAS TRANQUERAS / PARLANTE','Las Tranqueras &amp; Av. Las condes',0,6,2],
[-33.412667,-70.536278,'PI 09 FUEGUINOS - PATAGONES / PARLANTE','Los Fueguinos &amp; Patagones',0,6,2],
[-33.414472,-70.535694,'PI 10 MAPUCHES - HUALTECAS / PARLANTE','Los mapuches &amp; Las Hualtecas',0,6,2],
[-33.421528,-70.535611,'PI 11 LOS VILOS - PEÑUELAS / PARLANTE','Los Vilos &amp; Peñuelas',0,6,2],
[-33.418111,-70.53575,'PI 12 LOS VILOS - SOCOMPA / PARLANTE','Los Vilos &amp; Socompa',0,6,2],
[-33.428861,-70.553722,'PI 13 M CLARO VIAL - CALEU / PARLANTE','Miguel Claro Vial &amp; Caleu',0,6,2],
[-33.420361,-70.530361,'PI 14 MARISOL - ROSITA / PARLANTE','Marisol &amp; Rosita',0,6,2],
[-33.403,-70.574028,'PI 15 PARQUE ARAUCANO CENTRAL / PARLANTE','Parque Araucano Central',0,6,2],
[-33.403,-70.572583,'PI 18 PARQUE ARAUCANO Z DEPORTIVA / PARLANTE','Parque Araucano Z. Deportiva',0,6,2],
[-33.404056,-70.576778,'PI 17 PARQUE ARAUCANO PONIENTE / PARLANTE','Parque Araucano Poniente',0,6,2],
[-33.401417,-70.570583,'PI 16 PARQUE ARAUCANO SKATEPARK /PARLANTE','Parque Araucano Oriente (skatepark)',0,6,2],
[-33.404889,-70.547639,'PI 19 PARQUE MONTEGRANDE NORTE / PARLANTE','Parque Montegrande Norte',0,6,2],
[-33.406361,-70.548333,'PI 20 PARQUE MONTEGRANDE / PARLANTE','Parque Montegrande II',0,6,2],
[-33.429861,-70.548472,'PI 21 BILBAO - DUQUECO / PARLANTE','Plaza Bilbao &amp; Duqueco',0,6,2],
[-33.42925,-70.542972,'PI 22 BILBAO - IV CENTENARIO / PARLANTE','Plaza Bilbao &amp; Enrique Bunster',0,6,2],
[-33.414056,-70.558722,'PI 23 IV CENTENARIO - H DE MAGALLANES / PARLANTE','Plaza IV Centenario &amp; H. Magallanes',0,6,2],
[-33.408194,-70.555972,'PI 24 METRO H DE MAGALLANES / PARLANTE','Apoquindo &amp; Hernando de magallanes',0,6,2],
[-33.420417,-70.535167,'PI 25 PATRICIA & LOS VILOS / PARLANTE','Plaza Patricia &amp; Los vilos',0,6,2],
[-33.42575,-70.532972,'PI 26 VIA LACTEA - CIRIO / PARLANTE','Via Lactea &amp; Cirio',0,6,2],
[-33.425667,-70.53775,'PI 27 VIA LACTEA - PADRE HURTADO / PARLANTE','Via Lactea &amp; Padre Hurtado',0,6,2],
[-33.417889,-70.552528,'PI 28 ROTONDA ATENAS - PETROBRAS / PARLANTE','Cristobal Colón &amp; Los Dominicos',0,6,2],
[-33.414844,-70.598468,'PI 32 CARMENCITA & DON CARLOS / PARLANTE','Carmencita &amp; Don carlos',0,6,2],
[-33.420261,-70.589371,'PI 37 PDTE ERRAZURIZ & POLONIA / PARLANTE','Presidente Errazuriz &amp; Polonia',0,6,2],
[-33.413338,-70.570481,'PI 38 LA CAPITANIA & DEL INCA / PARLANTE','Plaza La Capitania / Del Inca',0,6,2],
[-33.428061,-70.585188,'PI 39 TARRAGONA & ALCANTARA / PARLANTE','Tarragona &amp; Alcantara',0,6,2],
[-33.417046,-70.540436,'PI 40 COLÓN & VISVIRI / PARLANTE','Cristobal colón &amp; Visviri',0,6,2],
[-33.426883,-70.579043,'PI 41 FDO DE ARAGON & CARLOS V / PARLANTE','Fernando de Aragon &amp; Carlos V',0,6,2],
[-33.427893,-70.570032,'PI 42 MANUEL BARRIOS & LATADIA / PARLANTE','Manuel Barrios &amp; Latadia',0,6,2],
[-33.426241,-70.564279,'PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / PARLANTE','Juan Esteban Montero &amp; Manquehue',0,6,2],
[-33.420626,-70.57069,'PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / PARLANTE','Martin Alonso Pinzon &amp; Sebastian Elcano',0,6,2],
[-33.424257,-70.564144,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / PTZ','Ingeniero Pedro Blanquier &amp; Manquehue sur',0,1,2],
[-33.424257,-70.564144,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / SOS','Ingeniero Pedro Blanquier &amp; Manquehue sur',0,5,2],
[-33.424257,-70.564144,'PI 45 PEDRO BALNUQIER & MANQUEHUE SUR / PARLANTE','Ingeniero Pedro Blanquier &amp; Manquehue sur',0,6,2],
[-33.4198,-70.567566,'PI 45 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / SOS','Domingo Bondi &amp; Martín Alonso Pinzón',0,5,2],
[-33.4198,-70.567566,'PI 45 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / PARLANTE','Domingo Bondi &amp; Martín Alonso Pinzón',0,6,2],
[-33.414184,-70.583638,'PI 47 VESPUCIO & APOQUINDO / PARLANTE','Americo Vespucio Norte &amp; Apoquindo',0,6,2],
[-33.417836,-70.58143,'PI 48 CRUZ DEL SUR & DEL INCA / PARLANTE','Cruz del Sur &amp; del Inca',0,6,2],
[-33.411204,-70.575094,'PI 49 COIMBRA & ROSA O\'HIGGINS / PARLANTE','Coimbra &amp; Rosa O\'higgins',0,6,2],
[-33.409463,-70.569096,'PI 50 APOQUINDO & MAR DE LOS SARGAZOS / PARLANTE','Apoquindo &amp; Mar de los Sargazos',0,6,2],
[-33.424845,-70.559541,'PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / PARLANTE','Av Alejandro Fleming &amp; Isabel La Católica',0,6,2],
[-33.400311,-70.567711,'PI 52 RIESCO & MANQUEHUE / PARLANTE','Presidente Riesco &amp; Manquehue Norte',0,6,2],
[-33.397226,-70.566921,'PI 53 KENNEDY & BRASILIA / PARLANTE','Presidente Kennedy &amp; Brasilia',0,6,2],
[-33.397583,-70.558647,'PI 54 MAR DE CORAL & GARCIA PICA / PARLANTE','Mar de Coral &amp; Garcia Pica',0,6,2],
[-33.398631,-70.553527,'PI 56 SOR JOSEFA & LAS VERBENAS / PARLANTE','Sor Josefa &amp; Las Verbenas',0,6,2],
[-33.416535,-70.555004,'PI 58 LOS POZOS & IV CENTENARIO / PARLANTE','Los Pozos &amp; Cuarto Centenario',0,6,2],
[-33.422398,-70.553295,'PI 60 ALONSO DE CAMARGO & TOMAS MORO / PARLANTE','Alonso de Camargo &amp; Tomas Moro',0,6,2],
[-33.421377,-70.550633,'PI 61 TEZCUCO & PRETORIA / PARLANTE','Tezcuco &amp; Pretoria',0,6,2],
[-33.418114,-70.549016,'PI 62 COLON & VIZCAYA / PARLANTE','Cristobal Colón &amp; Vizcaya',0,6,2],
[-33.415783,-70.552042,'PI 63 TINGUIRIRICA & MONROE / PARLANTE','Tinguiririca &amp; Monroe',0,6,2],
[-33.415865,-70.542488,'PI 64 ISLOTE SNIPE & RIO TAMESIS / PARLANTE','Islote Snipe &amp; Rio Tamesis',0,6,2],
[-33.414765,-70.542148,'PI 65 TALAVERA DE LA REINA & RIO CONGO / PARLANTE','Talavera de la Teina &amp; Rio Congo',0,6,2],
[-33.394502,-70.541198,'PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / PARLANTE','Cardenal newman &amp; Punta del este',0,6,2],
[-33.408229,-70.537743,'PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / PARLANTE','Viejos Estandartes &amp; General Blanche',0,6,2],
[-33.37327,-70.518441,'PI 71 NUEVA LAS CONDES & LAS CONDES / PARLANTE','Nueva Las Condes &amp; Las Condes',0,6,2],
[-33.406856,-70.535362,'PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / PARLANTE','General Blanche &amp; Luis Matte Larrain',0,6,2],
[-33.41345,-70.541702,'PI 75 RIO GUADIANA & LONTANANZA / PARLANTE','Rio Guadiana &amp; Lontananza',0,6,2],
[-33.412755,-70.541369,'PI 76 LA RECOBA & EL TORRENTE / PARLANTE','La Recoba &amp; El Torrente',0,6,2],
[-33.416755,-70.529836,'PI 77 LA QUEBRADA & VITAL APOQUINDO / PARLANTE','La Quebrada &amp; Vital apoquindo',0,6,2],
[-33.420665,-70.53255,'PI 79 RIVADAVIA & INCAHUASI / PARLANTE','Rivadavia &amp; Incahuasi',0,6,2],
[-33.42285,-70.53767,'PI 80 PADRE HURTADO & INCA DE ORO / PARLANTE','Padre Hurtado Sur &amp; Inca de Oro',0,6,2],
[-33.426401,-70.537459,'PI 81 ALTAIR & PLAZA ALTAIR / PARLANTE','Altair &amp; Altair',0,6,2],
[-33.412117,-70.507735,'PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / PARLANTE','Quebrada Honda &amp; Carlos Peña otaegui',0,6,2],
[-33.402408,-70.510345,'PI 84 DEL PARQUE & SANTOS APOSTOLES / PARLANTE','Del Parque &amp; Santos Apostoles',0,6,2],
[-33.411443,-70.520512,'PI 85 CARLOS PEÑA & LAS CONDESAS / PARLANTE','Carlos Peña Otaegui &amp; Las Condesas',0,6,2],
[-33.389637,-70.50769,'PI 87 LOS MONJES EL CONVENTO / PARLANTE','Los Monjes &amp; El Convento',0,6,2],
[-33.39338,-70.507662,'PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / PARLANTE','Cerro Catedral Sur &amp; San Carlos de Apoquindo',0,6,2],
[-33.396678,-70.512747,'PI 90 CERRO PROVINCIA & LOS PUMAS / PARLANTE','Cerro Provincia &amp; Los Pumas',0,6,2],
[-33.398237,-70.515344,'PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / PARLANTE','Camino las Vertientes &amp; Camino de los Arrieros',0,6,2],
[-33.427425,-70.542827,'PI 93 IV CENTENARIO & MANUEL CLARO VIAL / PARLANTE','IV Centenario &amp; Manuel Claro Vial',0,6,2],
[-33.426526,-70.548812,'PI 94 LOLCO & RUCALHUE / PARLANTE','Lolco &amp; Rucalhue',0,6,2],
[-33.41905,-70.530946,'PI 95 PLAZA OLGA NORTEL / SOS','Pasaje Olga Norte',0,5,2],
[-33.41905,-70.530946,'PI 95 PLAZA OLGA NORTEL / PARLANTE','Pasaje Olga Norte',0,6,2],
[-33.417454,-70.529687,'PI 96 YOLANDA & VITAL APOQUINDO / PARLANTE','Yolanda &amp; Vital Apoquindo',0,6,2],
[-33.418403,-70.530209,'PI 97 YOLANDA INTERIOR / PARLANTE','Yolanda Interior',0,6,2],
[-33.397826,-70.511007,'PI 98 CERRO EL CEPO & CERRO EL CEPO / PARLANTE','Cerro el Cepo &amp; Cerro el Cepo',0,6,2],
[-33.39629,-70.510664,'PI 99 CERRO LITORIA & CERRO LITORIA / PARLANTE','Cerro litoria &amp; Cerro litoria',0,6,2],
[-33.423071,-70.542308,'PI 102 EL TATIO & PICA / PARLANTE','El tatio &amp; Pica',0,6,2],
[-33.423731,-70.535043,'PI 103 ALEXANDER FLEMING & TOTORALILLO / PARLANTE','Alexander Fleming &amp; Totoralillo',0,6,2],
[-33.425016,-70.533183,'PI 104 SANTA ZITA & SANTA ZITA / PARLANTE','Santa Zita &amp; Santa Zita',0,6,2],
[-33.423745,-70.533152,'PI 105 FLEMING & PUNITAQUI / PARLANTE','Alexander Fleming &amp; Punitaqui',0,6,2],
[-33.401294,-70.550247,'PI 106 PETRARCA & BENVENUTTO CELLINI / PARLANTE','Petrarca &amp; Benvenuto Cellini',0,6,2],
[-33.402913,-70.550754,'PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / PARLANTE','Lorenzo de Medicis &amp; Benvenuto Cellini',0,6,2],
[-33.404444,-70.553531,'PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / PARLANTE','Padre Errazuriz &amp; Miguel Angel Buonarotti',0,6,2],
[-33.420547,-70.537497,'PI 109 PADRE HURTADO & PATRICIA / PARLANTE','Padre Hurtado Sur &amp; Patricia',0,6,2],
[-33.42022,-70.545332,'PI 110 TOCONAO & CHIUCHIU / PARLANTE','Toconao &amp; Chiu chiu',0,6,2],
[-33.418758,-70.53352,'PI 111 PAUL HARRIS & SOCOMPA / PARLANTE','Paul harris sur &amp; Socompa',0,6,2],
[-33.412861,-70.523871,'PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / PARLANTE','atalaya &amp; carlos peña otaegui',0,6,2],
[-33.418849,-70.541374,'PI 113 ZARAGOZA & AYQUINA / PARLANTE','zaragoza &amp; ayquina',0,6,2],
[-33.418537,-70.545239,'PI 114 LERIDA & TOCONAO / PARLANTE','Lerida &amp; Toconao',0,6,2],
[-33.419553,-70.544831,'PI 115 ZARAGOZA & TOCONAO / PARLANTE','Zaragoza &amp; Toconao',0,6,2],
[-33.419785,-70.570616,'PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / PARLANTE','Martin Alonso Pinzon &amp; Sebsatian Elcano',0,6,2],
[-33.420014,-70.543798,'PI 117 ZARAGOZA & PUREN / PARLANTE','Puren. Entre Zaragoza &amp; Alonso de Camargo',0,6,2],
[-33.403675,-70.566929,'PI 118 VILLA SAN LUIS A / PARLANTE','Cerro el Plomo &amp; Estocolmo',0,6,2],
[-33.40249,-70.567499,'PI 119 VILLA SAN LUIS B / PARLANTE','Cerro el Plomo &amp; Estocolmo',0,6,2],
[-33.413497,-70.596308,'PI 120 GLAMIS & LA PASTORA / PARLANTE','Glamis &amp; La Pastora',0,6,2],
[-33.408344,-70.571159,'PI 121 ROSARIO NORTE & EDIPO REY / PARLANTE','Rosario Norte &amp; Edipo Rey',0,6,2],
[-33.417699,-70.602121,'PI 122 TAJAMAR & ENCOMENDEROS / PARLANTE','Tajamar &amp; Encomenderos',0,6,2],
[-33.423377,-70.54122,'PI 123 PLAZA AYQUINA ASCOTAN / PARLANTE','Ayquina &amp; Ascotan',0,6,2],
[-33.431162,-70.578661,'PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PARLANTE','Francisco Bilbao &amp; Juan de Austria',0,6,2],
[-33.416996,-70.540565,'PI 127 PARQUE SANTA ROSA / PARLANTE','Cristobal colón &amp; Visviri',0,6,2],
[-33.405275,-70.572463,'PI 128 ROSARIO NORTE - CERRO EL PLOMO / PARLANTE','Rosario Norte &amp; Cerro el Plomo',0,6,2],
[-33.413585,-70.583606,'PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PARLANTE','Apoquindo &amp; Gral Francisco Barceló',0,6,2],
[-33.406898,-70.561535,'PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / PARLANTE','Av. Las Condes &amp; Nuestra Sra. del Rosario',0,6,2],
[-33.391084,-70.513489,'PI 134 PLAZA CORAZÓN / PARLANTE','Republica de Honduras &amp; Catedral Sur',0,6,2],
[-33.421694,-70.545627,'PI 135 CHIU CHIU - CODPA / PARLANTE','Chiu Chiu &amp; Codpa',0,6,2],
[-33.42147,-70.544334,'PI 136 PARINACOTA - CODPA / PARLANTE','Codpa &amp; Parinacota',0,6,2],
[-33.423482,-70.549274,'PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / PARLANTE','Pintor R. Monvoisin &amp; Pintora Aurora Mira',0,6,2],
[-33.418847,-70.540482,'PI 138 VISVIRI - ZARAGOZA / PARLANTE','Visviri &amp; Zaragoza',0,6,2],
[-33.426615,-70.553101,'PI 141 TORRE FLEMING / PARLANTE','Lolco 7680',0,6,2],
[-33.396871,-70.552641,'Pi 143 PLAZA SOR LAURA ROSA / PARLANTE','Sor Laura Rosa 220',0,6,2],
[-33.421748,-70.541165,'Pi 144 TOCONCE & CHAPIQUIÑA / PARLANTE','Chapiquiña 8851',0,6,2],
[-33.414607,-70.534543,'PI 145 PAUL HARRIS & ATACAMEÑOS / PARLANTE','Paul Harris &amp; Atacameños',0,6,2],
[-33.425435,-70.591556,'PI 146 LA NIÑA - SANCHEZ FONTECILLA / PARLANTE','La niña &amp; Sanchez Fontecilla',0,6,2],
[-33.388356,-70.525315,'PI 147 CHARLES HAMILTON - LO FONTECILLA / PARLANTE','Charles Hamilton &amp; Lo Fontecilla',0,6,2],
[-33.407581,-70.544921,'PI 148 LOS DOMINICOS / PARLANTE','Los Dominicos (Pista Patinaje)',0,6,2],
[-33.415,-70.597893,'PI 149 DON CARLOS & AUGUSTO LEGUIA / PARLANTE','Don Carlos &amp; Augusto Leguia',0,6,2],
[-33.392293,-70.54002,'PI 152 PLAZA DANURRO - PDTE. SANFUENTES / PARLANTE','Pdte. San Fuentes - Euzkadi',0,6,2],
[-33.374123,-70.520551,'PI 153 COLEGIO LAS CONDES / PARLANTE','Av. Las condes 12125',0,6,2],
[-33.42062,-70.536441,'PI 157 COLEGIO JUAN PABLO II / PARLANTE','Patricia 9040',0,6,2],
[-33.425799,-70.532285,'PI 158 COLEGIO SANTA MARIA DE LAS CONDES / PARLANTE','VIA LACTEA &amp; CIRIO',0,6,2],
[-33.400343,-70.56491,'PI 159 COLEGIO LEONARDO DA VINCI / PARLANTE','Cerro Altar 6811',0,6,2],
[-33.403933,-70.536128,'PI 160 COLEGIO SAN FCO. DEL ALBA / PARLANTE','CAMINO EL ALBA &amp; VITAL APOQUINDO',0,6,2],
[-33.415965,-70.536116,'PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / PARLANTE','Av. Cristóbal Colón 9070',0,6,2],
[-33.416044,-70.534556,'PI 162 COLEGIO PAUL HARRIS / PARLANTE','CRISTOBAL COLON 9188',0,6,2],
[-33.425536,-70.554461,'PI 163 COLEGIO SIMON BOLIVAR / PARLANTE','TOMAS MORO 1651',0,6,2],
[-33.404941,-70.578501,'PI 164 DEPARTAMENTO DE TRANSITO / PARLANTE','PDTE RIESCO 5296',0,6,2],
[-33.398751,-70.561971,'PI 165 CIRCULO POLAR / PARLANTE','CÍRCULO POLAR 6652',0,6,2],
[-33.414261,-70.588148,'PI 166 JEAN MERMOZ / PARLANTE','JEAN MERMOZ 4115',0,6,2],
[-33.37008,-70.505555,'PI 167 COLEGIO SOUTHERN CROSS / PARLANTE','LAS CONDES 13525',0,6,2],
[-33.370302,-70.508184,'PI 168 COLEGIO PEDRO DE VALDIVIA / PARLANTE','AV. LAS CONDES 13349',0,6,2],
[-33.403125,-70.564497,'PI 169 COLEGIO SEK / PARLANTE','LOS MILITARES 6640',0,6,2],
[-33.400645,-70.566639,'PI 170 COLEGIO ARABE / PARLANTE','PDTE. RIESCO 6437',0,6,2],
[-33.420455,-70.589129,'PI 171 COLEGIO VILLA MARIA ACADEMY / PARLANTE','PDTE ERRÁZURIZ 3753',0,6,2],
[-33.410642,-70.549632,'PI 174 COLEGIO SAGRADO CORAZÓN / PARLANTE','STA. MAGDALENA SOFÍA 277',0,6,2],
[-33.405538,-70.540548,'PI 175 COLEGIO VIRGEN DE POMPEYA / PARLANTE','CAMINO EL ALBA N° 9145',0,6,2],
[-33.38845,-70.533326,'PI 176 COLEGIO SAN MIGUEL ARCANGEL / PARLANTE','CAMPANARIO 000',0,6,2],
[-33.425544,-70.555118,'PI 177 COLEGIO ALEXANDER FLEMING / PARLANTE','AV. ALEJANDRO FLEMING 7315',0,6,2],
[-33.421384,-70.558582,'PI 178 COLEGIO ACHIGA COMEDUC / PARLANTE','ALONSO DE CAMARGO 6615',0,6,2],
[-33.419263,-70.588568,'PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PARLANTE','ALCÁNTARA 445',0,6,2],
[-33.405655,-70.560724,'PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / PARLANTE','LA PIEDAD 35',0,6,2],
[-33.395207,-70.554028,'PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / PARLANTE','LAS TRANQUERAS 726',0,6,2],
[-33.411268,-70.552289,'PI 182 COLEGIO SAN JORGE / PARLANTE','AVENIDA TOMÁS MORO 272',0,6,2],
[-33.398973,-70.559905,'PI 183 COLEGIO EMAUS / PARLANTE','GERÓNIMO DE ALDERETE 481',0,6,2],
[-33.426145,-70.572864,'PI 184 COLEGIO QUIMAY / PARLANTE','ISABEL LA CATOLICA 4774',0,6,2],
[-33.41145,-70.522091,'PI 185 COLEGIO WENLOCK SCHOOL / PARLANTE','CALLE CARLOS PEÑA OTAEGUI 10880',0,6,2],
[-33.414752,-70.563079,'PI 186 COLEGIO SAN JUAN EVANGELISTA / PARLANTE','MARTÍN DE ZAMORA 6395',0,6,2],
[-33.419581,-70.542305,'PI 187 PLAZA EL TATIO / PARLANTE','CALLE PICA 1220',0,6,2],
[-33.40716,-70.554827,'PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / PARLANTE','PADRE ERRAZURIZ 7001',0,6,2],
[-33.420743,-70.546357,'PI 189 COLEGIO ALAMIRO / PARLANTE','FUENTE OVEJUNA 1235',0,6,2],
[-33.40704,-70.581401,'PI 190 COLEGIO ALCAZAR DE LAS CONDES / PARLANTE','PRESIDENTE RIESCO 4902',0,6,2],
[-33.398249,-70.567799,'PI 191 COLEGIO ALEMAN DE SANTIAGO / PARLANTE','NUESTRA SEÑORA DEL ROSARIO 850',0,6,2],
[-33.425653,-70.570196,'PI 192 COLEGIO ANDINO ANTILLANCA / PARLANTE','SEBASTIAN ELCANO 1590',0,6,2],
[-33.389257,-70.531581,'PI 193 COLEGIO BRITISH HIGH SCHOOL / PARLANTE','LOS GLADIOLOS 10031',0,6,2],
[-33.40915,-70.564771,'PI 194 COLEGIO LIFE SUPPORT / PARLANTE','IV CENTENARIO 68',0,6,2],
[-33.413211,-70.55941,'PI 195 COLEGIO CIUDADELA MONTESSORI / PARLANTE','IV CENTENARIO 605',0,6,2],
[-33.409437,-70.566742,'PI 196 COLEGIO COMPAÑÍA DE MARÍA / PARLANTE','AV. MANQUEHUE SUR 116',0,6,2],
[-33.396287,-70.513887,'PI 197 COLEGIO CORDILLERA DE LAS CONDES / PARLANTE','LOS PUMAS 12015',0,6,2],
[-33.429265,-70.586696,'PI 198 COLEGIO COYANCURA / PARLANTE','MARIANO SANCHEZ FONTECILLA 1552',0,6,2],
[-33.394369,-70.504856,'PI 199 COLEGIO CUMBRES / PARLANTE','AV. PLAZA 1150',0,6,2],
[-33.398647,-70.544789,'PI 200 COLEGIO DALCAHUE / PARLANTE','PADRE HURTADO CENTRAL 605',0,6,2],
[-33.374363,-70.520918,'PI 201 COLEGIO DUNALASTAIR / PARLANTE','AV. LAS CONDES 11931',0,6,2],
[-33.392114,-70.50925,'PI 202 COLEGIO SAN FRANCISCO DE ASIS / PARLANTE','CERRO CATEDRAL NORTE 12150',0,6,2],
[-33.424052,-70.555008,'PI 203 COLEGIO INSTITUCION TERESIANA / PARLANTE','ISABEL LA CATOLICA 7445',0,6,2],
[-33.413619,-70.512481,'PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / PARLANTE','FRANCISCO BULNES CORREA 3000',0,6,2],
[-33.43058,-70.563589,'PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PARLANTE','FRANCISCO BILBAO 6300',0,6,2],
[-33.420564,-70.568728,'PI 206 COLEGIO LA GIOURETTE / PARLANTE','MAR DEL SUR 1238',0,6,2],
[-33.379334,-70.508343,'PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / PARLANTE','AV. CHARLES HAMILTON 12880',0,6,2],
[-33.401524,-70.521361,'PI 208 COLEGIO REDLAND SCHOOL / PARLANTE','CAMINO EL ALBA 11357',0,6,2],
[-33.419439,-70.588478,'PI 209 COLEGIO SAIN PAUL MONTESSORI / PARLANTE','ALCÁNTARA 464',0,6,2],
[-33.429551,-70.583641,'PI 210 COLEGIO SAN JUAN DE LAS CONDES / PARLANTE','CANCILLER DOLLFUSS 1801',0,6,2],
[-33.430412,-70.574176,'PI 211 COLEGIO SAN LUIS DE LAS CONDES / PARLANTE','VICTOR RAE 4420',0,6,2],
[-33.39377,-70.505077,'PI 212 COLEGIO NICOLAS DE MYRA / PARLANTE','AV PLAZA 1157',0,6,2],
[-33.39965,-70.50582,'PI 213 COLEGIO SCUOLA ITALIANA / PARLANTE','CAMINO EL ALBA 12881',0,6,2],
[-33.39483,-70.521538,'PI 214 COLEGIO KILPATRICK / PARLANTE','CAMINO LAS FLORES 11280',0,6,2],
[-33.413781,-70.574749,'PI 215 COLEGIO MOUNIER / PARLANTE','ROSA O\'HIGGINS 298',0,6,2],
[-33.424902,-70.56184,'PI 216 COLEGIO GUNMAN / PARLANTE','ISABEL LA CATÓLICA 6366',0,6,2]
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

    /** Agrupa cámaras por coordenada exacta → 1 sitio = 1 marcador */
    function groupCamerasBySite(cams) {
        const map = new Map();
        for (const cam of cams) {
            const key = cam.lat + ',' + cam.lng;
            let site = map.get(key);
            if (!site) {
                site = { lat: cam.lat, lng: cam.lng, dir: cam.dir, cams: [], programa: cam.programa };
                map.set(key, site);
            }
            site.cams.push(cam);
        }
        return Array.from(map.values());
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
            .mi-card.ignored { opacity:0.3; }
            .mi-card.ignored:hover { opacity:0.5; }
            .mi-card.pinned { border-left-color:#fbbf24!important; box-shadow:inset 0 0 0 1px rgba(251,191,36,.15); }
            .mi-sec.pinned-sec { color:rgba(251,191,36,.6); background:rgba(251,191,36,.04); }
            .mi-sec.ignored-sec { color:rgba(255,255,255,.25); background:rgba(255,255,255,.02); }
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
                font:500 16px 'SF Mono',Consolas,monospace; color:rgba(255,255,255,.5);
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

            /* ═══ SWITCH TV/PC ═══ */
            #mi-view-switch {
                display:flex; justify-content:flex-end; gap:0; padding:4px 10px 2px;
                flex-shrink:0;
            }
            #mi-view-switch button {
                background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1);
                color:rgba(255,255,255,.35);
                font:600 10px -apple-system,sans-serif; padding:2px 10px; cursor:pointer;
                transition:all .12s; letter-spacing:.3px;
            }
            #mi-view-switch button:first-child { border-radius:3px 0 0 3px; border-right:none; }
            #mi-view-switch button:last-child { border-radius:0 3px 3px 0; }
            #mi-view-switch button:hover { color:rgba(255,255,255,.6); }
            #mi-view-switch button.active { background:rgba(59,130,246,.25); color:#60a5fa; }

            /* ── Modo compacto (PC) ── */
            #mi-panel.compact .mi-sec { padding:4px 14px; font-size:10px; }
            #mi-panel.compact .mi-card { padding:5px 12px; margin:0 4px 3px; border-radius:4px; border-left-width:3px; }
            #mi-panel.compact .mi-card-top { margin-bottom:1px; gap:4px; }
            #mi-panel.compact .mi-card-tipo { font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            #mi-panel.compact .mi-card-est { font-size:8px; padding:1px 5px; }
            #mi-panel.compact .mi-card-info { margin-bottom:1px; gap:4px; }
            #mi-panel.compact .mi-card-hora { font-size:11px; }
            #mi-panel.compact .mi-card-id { font-size:16px; }
            #mi-panel.compact .mi-card-dir { font-size:11px; margin-bottom:0; }
            #mi-panel.compact .mi-card-desc { display:none; }
            #mi-panel.compact .mi-card-btns { margin-top:3px; gap:2px; }
            #mi-panel.compact .mi-card-btns button { padding:2px 6px; font-size:10px; }

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
                background:rgba(0,0,0,.85) !important; backdrop-filter:blur(6px);
                border-radius:4px !important; padding:4px 8px !important;
                font:700 12px -apple-system,sans-serif; color:#fff !important;
                white-space:nowrap; pointer-events:none;
                border:1px solid rgba(255,255,255,.15) !important;
                box-shadow:0 2px 8px rgba(0,0,0,.5) !important;
                line-height:1.3; opacity:1 !important;
            }
            .mi-nearby-label::before { border:none !important; display:none !important; }
            .mi-nearby-label * { color:inherit; }
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
                <div id="mi-view-switch">
                    <button data-view="tv" class="active" title="TV: cards grandes">TV</button>
                    <button data-view="pc" title="PC: cards compactas">PC</button>
                </div>
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
        const isIgnored = S.procs.ignored.has(p.id);
        const hasCoords = !!resolveCoords(p.id, p.internalId);
        const dirIcon = hasCoords ? '📍' : '<span style="color:rgba(251,191,36,.6)">⚠</span>';
        const dirLine = p.dir
            ? `<div class="mi-card-dir">${dirIcon} <span data-action="copydir" data-copy="${esc(p.dir)}" style="cursor:pointer">${esc(p.dir)}</span></div>`
            : `<div class="mi-card-dir" style="color:rgba(251,191,36,.5)">⚠ Sin dirección</div>`;
        const descLine = p.desc ? `<div class="mi-card-desc" data-tooltip="${esc(p.desc)}">${esc(p.desc)}</div>` : '';
        const idDisplay = p.id.length > 4 ? p.id.slice(0, -4) + ' ' + p.id.slice(-4) : p.id;
        const detailUrl = p.internalId ? `/incidents/${p.internalId}` : '';
        const ignoreBtn = isIgnored
            ? `<button data-action="restore" data-id="${esc(p.id)}" style="color:#34d399">↩</button>`
            : `<button data-action="ignore" data-id="${esc(p.id)}">✕</button>`;
        return `
            <div class="mi-card${isPendiente ? '' : ' closed'}${isPinned ? ' pinned' : ''}${isIgnored ? ' ignored' : ''}" data-id="${esc(p.id)}" style="border-left-color:${isPendiente && !isIgnored ? p.cat.border : 'transparent'};background:${p.cat.color}">
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
                    ${ignoreBtn}
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
        if (ignorados.length > 0) {
            html += `<div class="mi-sec ignored-sec">✕ Ignorados (${ignorados.length})</div>`;
            html += ignorados.map(cardHTML).join('');
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

                if (action === 'restore') {
                    e.stopPropagation();
                    const id = actionEl.dataset.id;
                    S.procs.ignored.delete(id);
                    // Re-crear marcador si hay datos y coordenadas
                    const proc = S.procs.all.find(p => p.id === id);
                    if (proc) {
                        const coords = resolveCoords(proc.id, proc.internalId);
                        if (coords) agregarMarcadorProc(proc.id, coords, proc);
                    }
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
        if (!S.cameras.sites.length) return;

        const cercanos = S.cameras.sites
            .map(site => ({ ...site, dist: haversine(coords[0], coords[1], site.lat, site.lng) }))
            .filter(site => site.dist <= radioMetros)
            .sort((a, b) => a.dist - b.dist);

        if (!cercanos.length) return;

        L.circle(coords, {
            radius: radioMetros,
            color: 'rgba(255,255,255,.15)',
            fillColor: 'rgba(255,255,255,.03)',
            weight: 1,
            dashArray: '4,4',
        }).addTo(S.layers.nearby);

        const dirs = ['top', 'right', 'bottom', 'left'];
        cercanos.forEach((site, idx) => {
            const pg = site.programa || 'R';
            const color = PROG_COLOR[pg] || '#3b82f6';
            const dist = Math.round(site.dist);
            // Mostrar código corto de la primera cámara + cantidad si hay más
            const mainShort = codigoCorto(site.cams[0]);
            const label = site.cams.length > 1
                ? `${mainShort} <span style="font-size:8px;opacity:.5">+${site.cams.length - 1}</span>`
                : mainShort;

            const icon = L.divIcon({
                className: '',
                html: `<div style="width:10px;height:10px;background:${color};border:2px solid #fff;border-radius:1px;box-shadow:0 0 8px ${color};"></div>`,
                iconSize: [10, 10],
                iconAnchor: [5, 5],
            });
            const nearMarker = L.marker([site.lat, site.lng], { icon, interactive: true }).addTo(S.layers.nearby);

            const dir = dirs[idx % dirs.length];
            const off = dir === 'top' ? [0, -8] : dir === 'bottom' ? [0, 8] : dir === 'right' ? [8, 0] : [-8, 0];
            const content = `<span class="mi-nearby-square" style="background:${color}"></span><strong>${label}</strong> <span style="font-size:8px;color:rgba(255,255,255,.3)">${dist}m</span>`;

            nearMarker.bindTooltip(content, {
                permanent: true, direction: dir, offset: off,
                className: 'mi-nearby-label', interactive: true,
            });

            // Click copia todos los códigos del sitio
            nearMarker.on('click', () => {
                const allCodes = site.cams.map(c => codigoCorto(c)).join(', ');
                navigator.clipboard.writeText(allCodes).then(() => {
                    nearMarker.setTooltipContent(`<span style="color:#34d399">✓ ${esc(mainShort)}</span>`);
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
        S.map.getPane('camPopupPane').style.zIndex = 700;

        // Canvas renderer — cámaras sin DOM individual (~2573 markers canvas vs 3832 divIcons SVG)
        const camRenderer = L.canvas({ pane: 'camPane', padding: 0.3 });

        S.layers.proc = L.layerGroup().addTo(S.map);
        S.layers.cam = L.layerGroup().addTo(S.map);
        S.layers.nearby = L.layerGroup().addTo(S.map);
        S.layers.draw = L.layerGroup().addTo(S.map);

        // ── Cámaras (agrupadas por sitio) ──
        S.cameras.data = await fetchCamaras();
        S.cameras.sites = groupCamerasBySite(S.cameras.data);
        S.cameras.loaded = true;

        S.cameras.sites.forEach(site => {
            const pg = site.programa || 'R';
            const color = PROG_COLOR[pg] || '#3b82f6';

            const marker = L.circleMarker([site.lat, site.lng], {
                renderer: camRenderer,
                radius: 5,
                fillColor: color,
                fillOpacity: 0.7,
                color: '#fff',
                weight: 1,
                opacity: 0.5,
            }).addTo(S.layers.cam);

            // Badge: cantidad de cámaras si > 1
            if (site.cams.length > 1) {
                marker.setRadius(6);
                marker.setStyle({ weight: 1.5, opacity: 0.7 });
            }

            // Lazy popup — se construye solo al primer mouseover
            let popupReady = false;
            marker.on('mouseover', function () {
                if (popupReady) { marker.openPopup(); return; }
                popupReady = true;
                const popupDiv = document.createElement('div');
                popupDiv.style.cssText = 'text-align:center;min-width:60px;max-width:220px';

                site.cams.forEach((cam, i) => {
                    const short = codigoCorto(cam);
                    const camColor = PROG_COLOR[cam.programa] || '#3b82f6';
                    const row = document.createElement('div');
                    row.style.cssText = `font:700 13px -apple-system,sans-serif;color:${camColor};cursor:pointer;padding:2px 0;${i > 0 ? 'border-top:1px solid rgba(255,255,255,.08)' : ''}`;
                    row.textContent = short + (cam.tipo ? ` · ${cam.tipo}` : '');
                    row.addEventListener('click', () => {
                        navigator.clipboard.writeText(short).then(() => {
                            row.style.color = '#34d399'; row.textContent = '✓ ' + short;
                            setTimeout(() => { row.style.color = camColor; row.textContent = short + (cam.tipo ? ` · ${cam.tipo}` : ''); }, 800);
                        });
                    });
                    popupDiv.appendChild(row);
                });

                if (site.dir) {
                    const dirEl = document.createElement('div');
                    dirEl.style.cssText = 'font-size:11px;color:rgba(255,255,255,.35);margin-top:3px';
                    dirEl.textContent = site.dir;
                    popupDiv.appendChild(dirEl);
                }

                marker.bindPopup(popupDiv, { closeButton: false, className: 'mi-cam-popup', pane: 'camPopupPane' });
                marker.openPopup();
            });
            marker.on('mouseout', function () { marker.closePopup(); });
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

        // ── Switch TV/PC ──
        container.querySelector('#mi-view-switch').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-view]');
            if (!btn) return;
            const panel = container.querySelector('#mi-panel');
            container.querySelectorAll('#mi-view-switch button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            panel.classList.toggle('compact', btn.dataset.view === 'pc');
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
        S.cameras.sites = [];
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
