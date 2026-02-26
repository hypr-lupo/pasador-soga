// ==UserScript==
// @name         Sistema Mapa Integrado
// @namespace    http://tampermonkey.net/
// @version      3.0
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
        CRITICAS: ['robo', 'sospechoso'],
        REFRESH_CRITICO: 5,
        VENTANA_MIN: 60,
        // Nominatim throttle (ms)
        GEO_THROTTLE: 1100,
        // Retry config
        FETCH_MAX_RETRIES: 2,
        FETCH_RETRY_DELAY: 2000,
        // Leaflet CDN (fallback si @require/@resource fallan)
        LEAFLET_CSS: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
        LEAFLET_JS: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
        // Mapa
        PAN_PX: 150,
        PAN_INTERVAL: 120,
        NEARBY_RADIUS: 250,
        // Bounds de Las Condes
        BOUNDS: { latMin: -33.44, latMax: -33.36, lonMin: -70.62, lonMax: -70.49 },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  2. ESTADO CENTRALIZADO                                       ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const S = {
        // Mapa y capas
        map: null,
        layers: { proc: null, cam: null, nearby: null, draw: null },
        // Procedimientos
        procs: { all: [], markers: new Map(), ignored: new Set() },
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

    /** Normaliza texto removiendo acentos para comparación */
    function norm(text) {
        return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

    /** Prepara dirección para geocoding/búsqueda */
    function prepararDireccion(dir) {
        return dir
            .replace(/,\s*\d+$/, '')
            .replace(/\(.*?\)/g, '')
            .replace(/\.\s/g, ' CON ')
            .replace(/\//g, ' ')
            .replace(/LPR\s*\d+/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  4. CATEGORÍAS                                                ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const CATEGORIAS = [
        { id: 'robo', nombre: 'Robos', color: '#ef4444', icon: '🔴', keywords: [
            'robo', 'hurto', 'asalto', 'portonazo', 'encerrona', 'intimidación', 'sustracción'
        ]},
        { id: 'accidente', nombre: 'Accidentes', color: '#f59e0b', icon: '🟡', keywords: [
            'colisión', 'choque', 'atropello', 'accidente', 'volcamiento', 'caída en vehículo'
        ]},
        { id: 'salud', nombre: 'Salud', color: '#10b981', icon: '🟢', keywords: [
            'lesionado', 'persona desmayada', 'parturienta', 'suicidio', 'salud', 'oxígeno', 'paramédico'
        ]},
        { id: 'sospechoso', nombre: 'Sospechosos', color: '#8b5cf6', icon: '🟣', keywords: [
            'sospechoso', 'merodeo', 'detección de vehículo', 'encargo', 'hallazgo', 'lector ppu'
        ]},
        { id: 'infraestructura', nombre: 'Infraestructura', color: '#06b6d4', icon: '🔵', keywords: [
            'semáforo', 'luminaria', 'hoyo', 'hundimiento', 'grifo', 'sumidero', 'tapa cámara',
            'cables cortados', 'corte de energía', 'corte de agua', 'desganche', 'árbol',
            'material de arrastre', 'poste chocado', 'reja de plaza'
        ]},
        { id: 'orden', nombre: 'Orden Público', color: '#ec4899', icon: '🩷', keywords: [
            'riña', 'pendencia', 'ruidos molestos', 'consumo de cannabis', 'huelga', 'manifestación',
            'comercio ambulante', 'limpia vidrios'
        ]},
    ];

    const CAT_OTRO = { id: 'otro', nombre: 'Otro', color: '#6b7280', icon: '⚪' };

    // Pre-normalizar keywords una sola vez al inicio
    const _catLookup = CATEGORIAS.map(cat => ({
        ...cat,
        _norms: cat.keywords.map(norm),
    }));

    function clasificar(tipo) {
        if (!tipo) return CAT_OTRO;
        const t = norm(tipo);
        for (const cat of _catLookup) {
            for (const kw of cat._norms) {
                if (t.includes(kw)) return cat;
            }
        }
        return CAT_OTRO;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  5. GEOCODING (Nominatim + caché + cola throttled)            ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const geoCache = new Map();
    let geoQueue = [];
    let geoProcessing = false;

    async function geocodificar(dir) {
        if (!dir) return null;
        const clave = dir.toUpperCase().trim();
        if (geoCache.has(clave)) return geoCache.get(clave);

        const q = prepararDireccion(dir) + ', Las Condes, Santiago, Chile';
        try {
            const resp = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&bounded=1&viewbox=-70.62,-33.36,-70.49,-33.44`
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                if (dentroDeLC(lat, lon)) {
                    const coords = [lat, lon];
                    geoCache.set(clave, coords);
                    return coords;
                }
                console.warn('[MapaIntegrado] Geocode fuera de LC:', dir, lat, lon);
            }
        } catch (e) {
            console.warn('[MapaIntegrado] Geocoding error:', e);
        }
        geoCache.set(clave, null);
        return null;
    }

    async function processGeoQueue() {
        if (geoProcessing) return;
        geoProcessing = true;
        while (geoQueue.length > 0) {
            const { dir, resolve } = geoQueue.shift();
            const coords = await geocodificar(dir);
            resolve(coords);
            if (geoQueue.length > 0) await sleep(CONFIG.GEO_THROTTLE);
        }
        geoProcessing = false;
    }

    function geocodificarEnCola(dir) {
        return new Promise(resolve => {
            const clave = dir?.toUpperCase().trim();
            if (clave && geoCache.has(clave)) { resolve(geoCache.get(clave)); return; }
            geoQueue.push({ dir, resolve });
            processGeoQueue();
        });
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

        filas.forEach(fila => {
            const celdas = fila.querySelectorAll('td');
            if (celdas.length < 7) return;

            const fechaTexto = celdas[1]?.textContent?.trim();
            if (!fechaTexto) return;

            const m = fechaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
            if (!m) return;
            const fecha = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);

            if (fecha.getTime() < limite) return;

            const areaHTML = celdas[0]?.innerHTML || '';
            const estado = areaHTML.includes('badge-danger') ? 'PENDIENTE' : 'CERRADO';
            const tipo = celdas[2]?.textContent?.trim() || '';
            const id = celdas[3]?.textContent?.trim() || '';
            const operador = celdas[4]?.textContent?.trim() || '';
            const descRaw = celdas[5]?.textContent?.trim() || '';
            const desc = descRaw.split('\n')[0]?.substring(0, 120) || '';
            const dir = celdas[6]?.textContent?.trim() || '';

            resultados.push({
                fecha: fechaTexto, fechaObj: fecha,
                tipo, id, operador, desc, dir,
                estado, cat: clasificar(tipo),
            });
        });

        resultados.sort((a, b) => b.fechaObj - a.fechaObj);
        return resultados;
    }

    async function fetchProcedimientos() {
        let lastError = null;
        for (let attempt = 0; attempt <= CONFIG.FETCH_MAX_RETRIES; attempt++) {
            try {
                if (attempt > 0) await sleep(CONFIG.FETCH_RETRY_DELAY * attempt);
                const resp = await fetch(CONFIG.PROC_URL, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'text/html' },
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const html = await resp.text();
                return { procs: parseProcedimientosHTML(html), live: true };
            } catch (e) {
                lastError = e;
                console.warn(`[MapaIntegrado] Fetch intento ${attempt + 1} fallido:`, e.message);
            }
        }
        console.error('[MapaIntegrado] Fetch agotó reintentos:', lastError);
        return { procs: [], live: false };
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  7. DATOS DE CÁMARAS                                          ║
    // ╚═══════════════════════════════════════════════════════════════╝
    // 1.997 cámaras reales. Formato: [lat, lon, barrio, id_cámara, dirección, destacamento, tipo, programa]
    // Programa: B=Barrio Protegido, R=Red Municipal, P=Postes Inteligentes, F=Refugios Inteligentes

    const CAMARAS_RAW = [
[-33.40788,-70.54511,'','001 APOQUINDO - EL ALBA / FIJA','Apoquindo & Camino el Alba','','FIJA','R'],
[-33.40788,-70.54511,'','001 APOQUINDO - EL ALBA / PTZ','Apoquindo & Camino el Alba','','PTZ','R'],
[-33.42401,-70.52958,'','002 VITAL APOQUINDO - FLEMING / FIJA 1','Alejandro Fleming & Vital Apoquindo','','FIJA','R'],
[-33.42401,-70.52958,'','002 VITAL APOQUINDO - FLEMING / FIJA 2','Alejandro Fleming & Vital Apoquindo','','FIJA','R'],
[-33.42401,-70.52958,'','002 VITAL APOQUINDO - FLEMING / PTZ','Alejandro Fleming & Vital Apoquindo','','PTZ','R'],
[-33.41249,-70.53825,'','003 RIO GUADIANA - DIAGUITAS / PTZ','Diaguitas & Rio Guadiana','','PTZ','R'],
[-33.41751,-70.55331,'','004 ROTONDA ATENAS / FIJA 1','Tomás Moro & IV Centenario','','FIJA','R'],
[-33.41751,-70.55331,'','004 ROTONDA ATENAS / FIJA 2','Tomás Moro & IV Centenario','','FIJA','R'],
[-33.41751,-70.55331,'','004 ROTONDA ATENAS / FIJA 3','Tomás Moro & IV Centenario','','FIJA','R'],
[-33.41751,-70.55331,'','004 ROTONDA ATENAS / FIJA 4','Tomás Moro & IV Centenario','','FIJA','R'],
[-33.41751,-70.55331,'','004 ROTONDA ATENAS / PTZ','Tomás Moro & IV Centenario','','PTZ','R'],
[-33.40919,-70.56828,'','005 APUMANQUE / LPR','Apoquindo & Manquehue Sur','','LPR','R'],
[-33.40919,-70.56828,'','005 APUMANQUE / PTZ','Apoquindo & Manquehue Sur','','PTZ','R'],
[-33.40919,-70.56828,'','005 APUMANQUE / PTZ 2','Apoquindo & Manquehue Sur','','PTZ','R'],
[-33.40919,-70.56828,'','005 APUMANQUE / SOS','Apoquindo & Manquehue Sur','','VIDEOPORTERO','R'],
[-33.39404,-70.54556,'','006 PADRE HURTADO - LAS CONDES / FIJA','Las Condes & Padre Hurtado Norte','','FIJA','R'],
[-33.39404,-70.54556,'','006 PADRE HURTADO - LAS CONDES / PTZ','Las Condes & Padre Hurtado Norte','','PTZ','R'],
[-33.42379,-70.53316,'','007 PUNITAQUI - FLEMING / PTZ','Alejandro Fleming & Punitaqui','','PTZ','R'],
[-33.401468,-70.568058,'','008 CARRO MOVIL / PTZ','Carro Móvil','','PTZ','R'],
[-33.40728,-70.56158,'','009 APOQUINDO - LAS CONDES / FIJA 1','Apoquindo & Las Condes','','FIJA','R'],
[-33.40728,-70.56158,'','009 APOQUINDO - LAS CONDES / FIJA 2','Apoquindo & Las Condes','','FIJA','R'],
[-33.40728,-70.56158,'','009 APOQUINDO - LAS CONDES / FIJA 3','Apoquindo & Las Condes','','FIJA','R'],
[-33.40728,-70.56158,'','009 APOQUINDO - LAS CONDES / PTZ','Apoquindo & Las Condes','','PTZ','R'],
[-33.40833,-70.55187,'','010 TOMAS MORO - APOQUINDO / FIJA 1','Tomás Moro & Apoquindo','','FIJA','R'],
[-33.40833,-70.55187,'','010 TOMAS MORO - APOQUINDO / FIJA 2','Tomás Moro & Apoquindo','','FIJA','R'],
[-33.40833,-70.55187,'','010 TOMAS MORO - APOQUINDO / PTZ','Tomás Moro & Apoquindo','','PTZ','R'],
[-33.40618,-70.54346,'','011 PADRE HURTADO - EL ALBA / FIJA 1','Padre Hurtado Central & Camino el Alba','','FIJA','R'],
[-33.40618,-70.54346,'','011 PADRE HURTADO - EL ALBA / FIJA 2','Padre Hurtado Central & Camino el Alba','','FIJA','R'],
[-33.40618,-70.54346,'','011 PADRE HURTADO - EL ALBA / PTZ','Padre Hurtado Central & Camino el Alba','','PTZ','R'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / FIJA 1','Francisco Bilbao & Tomás Moro','','FIJA','R'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / FIJA 2','Francisco Bilbao & Tomás Moro','','FIJA','R'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / LPR 1','Francisco Bilbao & Tomás Moro','','LPR','R'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / LPR 2','Francisco Bilbao & Tomás Moro','','LPR','R'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / PTZ','Francisco Bilbao & Tomás Moro','','PTZ','R'],
[-33.38402,-70.53415,'','013 LAS CONDES - ESTORIL / FIJA 1','Las Condes & Estoril','','FIJA','R'],
[-33.38402,-70.53415,'','013 LAS CONDES - ESTORIL / FIJA 2','Las Condes & Estoril','','FIJA','R'],
[-33.38402,-70.53415,'','013 LAS CONDES - ESTORIL / PTZ','Las Condes & Estoril','','PTZ','R'],
[-33.39546,-70.50943,'','014 SAN CARLOS DE APOQUINDO - LAS FLORES / PTZ','San Carlos de Apoquindo & Camino las Flores','','PTZ','R'],
[-33.41477,-70.56533,'','015 MANQUEHUE - MARTIN DE ZAMORA / PTZ','Manquehue Sur & Martín de Zamora','','PTZ','R'],
[-33.42307,-70.55364,'','016 TOMAS MORO - FLORENCIO BARRIOS / PTZ','Tomás Moro & Florencio Barrios','','PTZ','R'],
[-33.43098,-70.56509,'','017 MANQUEHUE - BILBAO / PTZ','Manquehue Sur & Francisco Bilbao','','PTZ','R'],
[-33.4161,-70.53383,'','018 COLON / PAUL HARRIS / PTZ','Av. Cristobal Colón & Paul Harris','','PTZ','R'],
[-33.40538,-70.52569,'','019 ARTURO MATTE - VISTA HERMOSA / LPR','Arturo Matte Larrain & Colina Vista Hermosa','','LPR','R'],
[-33.40538,-70.52569,'','019 ARTURO MATTE - VISTA HERMOSA / PTZ','Arturo Matte Larrain & Colina Vista Hermosa','','PTZ','R'],
[-33.40368,-70.52767,'','020 VISTA HERMOSA 1890 / LPR','Colina Vista Hermosa 1890','','LPR','R'],
[-33.40368,-70.52767,'','020 VISTA HERMOSA 1890 / PTZ','Colina Vista Hermosa 1890','','PTZ','R'],
[-33.40825,-70.52384,'','021 VISTA HERMOSA - QUEBRADA HONDA / LPR','Colina Vista Hermosa 2560','','LPR','R'],
[-33.40825,-70.52384,'','021 VISTA HERMOSA - QUEBRADA HONDA / PTZ','Colina Vista Hermosa 2560','','PTZ','R'],
[-33.41333,-70.53637,'','022 LOMA LARGA - ALACALUFES / PTZ','Loma Larga & Alacalufes','','PTZ','R'],
[-33.41333,-70.53637,'','022 LOMA LARGA - ALACALUFES / SOS','Loma Larga & Alacalufes','','VIDEOPORTERO','R'],
[-33.41482,-70.53563,'','023 PLAZA MAPUCHES / PTZ','Mapuches & Islas Guaitecas','','PTZ','R'],
[-33.41482,-70.53563,'','023 PLAZA MAPUCHES / SOS','Mapuches & Islas Guaitecas','','VIDEOPORTERO','R'],
[-33.41365,-70.53636,'','024 CESFAM - LOMA LARGA / FIJA','Loma Larga & Nevados de Piuquenes','','FIJA','R'],
[-33.41365,-70.53636,'','024 CESFAM - LOMA LARGA / PTZ','Loma Larga & Nevados de Piuquenes','','PTZ','R'],
[-33.408255,-70.5665,'','025 APOQUINDO - ALONSO DE CORDOVA / PTZ','Apoquindo & Alonso de Cordova','','PTZ','R'],
[-33.41641,-70.59412,'','026 APOQUINDO - ENRIQUE FOSTER / PTZ','Apoquindo & Enrique Foster Sur','','PTZ','R'],
[-33.41641,-70.59412,'','026 APOQUINDO - ENRIQUE FOSTER / SOS','Apoquindo & Enrique Foster Sur','','VIDEOPORTERO','R'],
[-33.41641,-70.59412,'','026 APOQUNDO - ENRIQUE FOSTER / RF 03 FOSTER B / PTZ','Enrique Foster & Apoquindo Norte','','PTZ','R'],
[-33.41343,-70.58272,'','027 APOQUINDO - ESCUELA MILITAR NORTE / PTZ','Apoquindo & General Barceló','','PTZ','R'],
[-33.41343,-70.58272,'','027 APOQUINDO - ESCUELA MILITAR NORTE / SOS','Apoquindo & General Barceló','','VIDEOPORTERO','R'],
[-33.41343,-70.58272,'','027 APOQUINDO - ESCUELA MILITAR NORTE / RF 05 PTZ','Apoquindo & General Barceló','','PTZ','R'],
[-33.41343,-70.58272,'','027 APOQUINDO - ESCUELA MILITAR NORTE / FIJA 2','Apoquindo & General Barceló','','FIJA','R'],
[-33.4159,-70.59165,'','028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 1','Apoquindo & Gertrudis Echeñique','','FIJA','R'],
[-33.4159,-70.59165,'','028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 2','Apoquindo & Gertrudis Echeñique','','FIJA','R'],
[-33.4159,-70.59165,'','028 APOQUINDO - GERTRUDIS ECHEÑIQUE / PTZ','Apoquindo & Gertrudis Echeñique','','PTZ','R'],
[-33.4159,-70.59165,'','028 APOQUINDO - GERTRUDIS ECHEÑIQUE / SOS','Apoquindo & Gertrudis Echeñique','','VIDEOPORTERO','R'],
[-33.408014,-70.555617,'','029 APOQUINDO - HERNANDO DE MAGALLANES / PTZ','Apoquindo & Hernando de Magallanes','','PTZ','R'],
[-33.41124,-70.57596,'','030 APOQUINDO - LA GLORIA / PTZ','Apoquindo & La Gloria','','PTZ','R'],
[-33.39071,-70.52578,'','031 ESTORIL - LAVANDULAS / LPR','Camino de las Lavandulas & Estoril','','LPR','R'],
[-33.39071,-70.52578,'','031 ESTORIL - LAVANDULAS / PTZ','Camino de las Lavandulas & Estoril','','PTZ','R'],
[-33.39417,-70.53093,'','032 LAS FLORES - CAMINO LAS FLORES / LPR','Camino del Algarrobo & Camino las Flores','','LPR','R'],
[-33.39417,-70.53093,'','032 LAS FLORES - FRAY PEDRO / LPR','Camino del Algarrobo & Fray Pedro Subercaseaux','','LPR','R'],
[-33.39417,-70.53093,'','032 ROTONDA LAS FLORES / PTZ','Camino del Algarrobo & Fray Pedro Subercaseaux','','PTZ','R'],
[-33.401268,-70.526045,'','033 EL ALBA - PIEDRA ROJA / PTZ','Camino el Alba & Camino Piedra Roja','','PTZ','R'],
[-33.40501,-70.53823,'','034 EL ALBA - PAUL HARRIS / LPR','Camino el Alba & Paul Harris','','LPR','R'],
[-33.40501,-70.53823,'','034 EL ALBA - PAUL HARRIS / PTZ','Camino el Alba & Paul Harris','','PTZ','R'],
[-33.386142,-70.521127,'','035 CHARLES HAMILTON - LA FUENTE / LPR','Charles Hamilton & Camino La Fuente','','LPR','R'],
[-33.386142,-70.521127,'','035 CHARLES HAMILTON - LA FUENTE / PTZ','Charles Hamilton & Camino La Fuente','','PTZ','R'],
[-33.381152,-70.51227,'','036 CHARLES HAMILTON - SAN FRANCISCO / LPR','Charles Hamilton & San Francisco de Asis','','LPR','R'],
[-33.381152,-70.51227,'','036 CHARLES HAMILTON - SAN FRANCISCO / PTZ','Charles Hamilton & San Francisco de Asis','','PTZ','R'],
[-33.41377,-70.52982,'','037 CARLOS PEÑA - VITAL APOQUINDO / LPR','Vital Apoquindo & Carlos Peña Otaegui','','LPR','R'],
[-33.41377,-70.52982,'','037 CARLOS PEÑA - VITAL APOQUINDO / LPR 2','Vital Apoquindo & Carlos Peña Otaegui','','LPR','R'],
[-33.41377,-70.52982,'','037 CARLOS PEÑA - VITAL APOQUINDO / PTZ','Vital Apoquindo & Carlos Peña Otaegui','','PTZ','R'],
[-33.41255,-70.52896,'','038 COLINA MIRAVALLE - PEUMO / LPR','Colina Miravalle & Colina del Peumo','','LPR','R'],
[-33.41255,-70.52896,'','038 COLINA MIRAVALLE - PEUMO / PTZ','Colina Miravalle & Colina del Peumo','','PTZ','R'],
[-33.4059,-70.53319,'','039 VITAL APOQUINDO - BLANCHE / LPR','Vital Apoquindo & General Blanche','','LPR','R'],
[-33.4059,-70.53319,'','039 VITAL APOQUINDO - BLANCHE / PTZ','Vital Apoquindo & General Blanche','','PTZ','R'],
[-33.38582,-70.53133,'','040 ESTORIL - PAUL HARRIS / PTZ','Paul Harris & Estoril','','PTZ','R'],
[-33.41654,-70.5648,'','041 COLON - MANQUEHUE / FIJA 1','Av. Cristobal Colón & Manquehue Sur','','FIJA','R'],
[-33.41654,-70.5648,'','041 COLON - MANQUEHUE / FIJA 2','Av. Cristobal Colón & Manquehue Sur','','FIJA','R'],
[-33.41654,-70.5648,'','041 COLON - MANQUEHUE / FIJA 3','Av. Cristobal Colón & Manquehue Sur','','FIJA','R'],
[-33.41654,-70.5648,'','041 COLON - MANQUEHUE / PTZ','Av. Cristobal Colón & Manquehue Sur','','PTZ','R'],
[-33.40234,-70.56968,'','042 MANQUEHUE - RIESCO / FIJA 1','Manquehue Norte & Presidente Riesco','','FIJA','R'],
[-33.40234,-70.56968,'','042 MANQUEHUE - RIESCO / FIJA 2','Manquehue Norte & Presidente Riesco','','FIJA','R'],
[-33.40234,-70.56968,'','042 MANQUEHUE - RIESCO / LPR','Manquehue Norte & Presidente Riesco','','LPR','R'],
[-33.40234,-70.56968,'','042 MANQUEHUE - RIESCO / PTZ','Manquehue Norte & Presidente Riesco','','PTZ','R'],
[-33.39767,-70.56892,'','043 KENNEDY - N. SRA DEL ROSARIO / FIJA','Kennedy Lateral & Nuestra Señora del Rosario','','FIJA','R'],
[-33.39767,-70.56892,'','043 KENNEDY - N. SRA DEL ROSARIO / LPR','Kennedy Lateral & Nuestra Señora del Rosario','','LPR','R'],
[-33.39767,-70.56892,'','043 KENNEDY - N. SRA DEL ROSARIO / PTZ','Kennedy Lateral & Nuestra Señora del Rosario','','PTZ','R'],
[-33.42118,-70.59343,'','044 SAN CRESCENTE - PDTE. ERRAZURIZ / LPR','San Crescente & Pdte. Errazuriz','','LPR','R'],
[-33.42118,-70.59343,'','044 SAN CRESCENTE - PDTE. ERRAZURIZ / PTZ','San Crescente & Pdte. Errazuriz','','PTZ','R'],
[-33.42118,-70.59343,'','044 SAN CRESCENTE - PDTE. ERRAZURIZ / SOS','San Crescente & Pdte. Errazuriz','','VIDEOPORTERO','R'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / FIJA 1','Apoquindo & El Bosque Norte','','FIJA','R'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / FIJA 2','Apoquindo & El Bosque Norte','','FIJA','R'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / FIJA 3','Apoquindo & El Bosque Norte','','FIJA','R'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / PTZ','Apoquindo & El Bosque Norte','','PTZ','R'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / SOS','Apoquindo & El Bosque Norte','','VIDEOPORTERO','R'],
[-33.4175587,-70.5998241,'','045 APOQUINDO EL BOSQUE / RF 01 EL BOSQUE A / PTZ','Apoquindo & El Bosque Norte','','PTZ','R'],
[-33.413653,-70.58266,'','046 APOQUINDO - ESCUELA MILITAR SUR / RF 05 FIJA 1','Apoquindo & Felix de amesti','','FIJA','R'],
[-33.413653,-70.58266,'','046 APOQUINDO - ESCUELA MILITAR SUR / RF 05 FIJA 2','Apoquindo & Felix de amesti','','FIJA','R'],
[-33.409493,-70.570306,'','047 APOQUINDO ROSARIO NORTE / RF 07 ROSARIO NORTE / PTZ','Apoquindo & Rosario Norte','','PTZ','R'],
[-33.42749,-70.53844,'','048 PADRE HURTADO - SKATEPARK / PTZ','Skate Padre Hurtado','','PTZ','R'],
[-33.42749,-70.53844,'','048 PADRE HURTADO - SKATEPARK / SOS','Skate Padre Hurtado','','VIDEOPORTERO','R'],
[-33.408777,-70.567855,'','049 MANQUEHUE - O\'CONNELL / RF 08 MANQUEHUE / PTZ','Manquehue & Apoquindo Norte','','PTZ','R'],
[-33.41557,-70.53859,'','050 CERRO TOLOLO - CERRO NEGRO / PTZ','Cerro Tololo & Cerro Negro','','PTZ','R'],
[-33.41557,-70.53859,'','050 CERRO TOLOLO - CERRO NEGRO / SOS','Cerro Tololo & Cerro Negro','','VIDEOPORTERO','R'],
[-33.42248,-70.5318,'','051 PUNITAQUI - PICHIDANGUI / PTZ','Punitaqui & Pichidangui','','PTZ','R'],
[-33.425115,-70.551724,'','052 FLEMING - CAÑUMANQUI / PTZ','Alejandro Fleming & Cañumanqui','','PTZ','R'],
[-33.414724,-70.585897,'','053 APOQUINDO - ASTURIAS / PTZ','Apoquindo & Asturias','','PTZ','R'],
[-33.416877,-70.597449,'','054 APOQUINDO - AUGUSTO LEGUIA / FIJA 1','Apoquindo & Augusto Leguía','','FIJA','R'],
[-33.416877,-70.597449,'','054 APOQUINDO - AUGUSTO LEGUIA / FIJA 2','Apoquindo & Augusto Leguía','','FIJA','R'],
[-33.416877,-70.597449,'','054 APOQUINDO - AUGUSTO LEGUIA / PTZ','Apoquindo & Augusto Leguía','','PTZ','R'],
[-33.416877,-70.597449,'','054 APOQUINDO - AUGUSTO LEGUIA / SOS','Apoquindo & Augusto Leguía','','VIDEOPORTERO','R'],
[-33.415202,-70.589327,'','055 APOQUINDO - LAS TORCAZAS / PTZ','Apoquindo & Las Torcazas','','PTZ','R'],
[-33.415202,-70.589327,'','055 APOQUINDO - LAS TORCAZAS / SOS','Apoquindo & Las Torcazas','','VIDEOPORTERO','R'],
[-33.416766,-70.595785,'','056 APOQUINDO - SAN CRESCENTE / PTZ','Apoquindo & San Crescente','','PTZ','R'],
[-33.409589,-70.570624,'','057 APOQUINDO - ROSARIO NORTE / FIJA 1','Av Apoquindo & Rosario Norte','','FIJA','R'],
[-33.409589,-70.570624,'','057 APOQUINDO - ROSARIO NORTE / FIJA 2','Av Apoquindo & Rosario Norte','','FIJA','R'],
[-33.409589,-70.570624,'','057 APOQUINDO - ROSARIO NORTE / FIJA 3','Av Apoquindo & Rosario Norte','','FIJA','R'],
[-33.409589,-70.570624,'','057 APOQUINDO - ROSARIO NORTE / PTZ','Av Apoquindo & Rosario Norte','','PTZ','R'],
[-33.409589,-70.570624,'','057 APOQUINDO - ROSARIO NORTE / SOS','Av Apoquindo & Rosario Norte','','VIDEOPORTERO','R'],
[-33.421259,-70.570853,'','058 ALONSO DE CAMARGO - SEBASTIAN EL CANO / FIJA 1','Sebastián Elcano & Alonso de Camargo','','FIJA','R'],
[-33.421259,-70.570853,'','058 ALONSO DE CAMARGO - SEBASTIAN ELCANO / PTZ','Sebastián Elcano & Alonso de Camargo','','PTZ','R'],
[-33.396858,-70.566948,'','059 KENNEDY - BRASILIA / FIJA','Av. Kennedy & Brasilia','','FIJA','R'],
[-33.396858,-70.566948,'','059 KENNEDY - BRASILIA / LPR','Av. Kennedy & Brasilia','','LPR','R'],
[-33.396858,-70.566948,'','059 KENNEDY - BRASILIA / PTZ','Av. Kennedy & Brasilia','','PTZ','R'],
[-33.396858,-70.566948,'','059 KENNEDY - BRASILIA / SOS','Av. Kennedy & Brasilia','','VIDEOPORTERO','R'],
[-33.392003,-70.553489,'','060 KENNEDY - LAS TRANQUERAS / FIJA','Av. Kennedy & Las Tranqueras','','FIJA','R'],
[-33.392003,-70.553489,'','060 KENNEDY - LAS TRANQUERAS / LPR 1','Av. Kennedy & Las Tranqueras','','LPR','R'],
[-33.392003,-70.553489,'','060 KENNEDY - LAS TRANQUERAS / LPR 2','Av. Kennedy & Las Tranqueras','','LPR','R'],
[-33.392003,-70.553489,'','060 KENNEDY - LAS TRANQUERAS / LPR 3','Av. Kennedy & Las Tranqueras','','LPR','R'],
[-33.392003,-70.553489,'','060 KENNEDY - LAS TRANQUERAS / PTZ','Av. Kennedy & Las Tranqueras','','PTZ','R'],
[-33.398316,-70.55131,'','061 LAS CONDES - BOCACCIO / FIJA 1','Av. Las Condes & Bocaccio','','FIJA','R'],
[-33.398316,-70.55131,'','061 LAS CONDES - BOCACCIO / FIJA 2','Av. Las Condes & Bocaccio','','FIJA','R'],
[-33.398316,-70.55131,'','061 LAS CONDES - BOCACCIO / PTZ','Av. Las Condes & Bocaccio','','PTZ','R'],
[-33.401421,-70.555218,'','062 LAS CONDES - LAS TRANQUERAS / PTZ','Av. Las Condes & Las Tranqueras','','PTZ','R'],
[-33.401421,-70.555218,'','062 LAS CONDES - LAS TRANQUERAS / SOS','Av. Las Condes & Las Tranqueras','','VIDEOPORTERO','R'],
[-33.405052,-70.568479,'','063 MANQUEHUE - LOS MILITARES / FIJA 1','Av. Manquehue & Los Militares','','FIJA','R'],
[-33.405052,-70.568479,'','063 MANQUEHUE - LOS MILITARES / FIJA 2','Av. Manquehue & Los Militares','','FIJA','R'],
[-33.405052,-70.568479,'','063 MANQUEHUE - LOS MILITARES / PTZ','Av. Manquehue & Los Militares','','PTZ','R'],
[-33.405052,-70.568479,'','063 MANQUEHUE - LOS MILITARES / SOS','Av. Manquehue & Los Militares','','VIDEOPORTERO','R'],
[-33.39711,-70.560346,'','064 RIESCO - GERONIMO DE ALDERETE / PTZ','Av. Presidente Riesco & Gerónimo de Alderete','','PTZ','R'],
[-33.403844,-70.573456,'','065 RIESCO - ROSARIO NORTE / PTZ','Av. Presidente Riesco & Rosario Norte','','PTZ','R'],
[-33.403844,-70.573456,'','065 RIESCO - ROSARIO NORTE / SOS','Av. Presidente Riesco & Rosario Norte','','VIDEOPORTERO','R'],
[-33.40869,-70.600436,'','066 KENNEDY - VITACURA / FIJA 1','Av. Vitacura & Calle Luz','','FIJA','R'],
[-33.40869,-70.600436,'','066 KENNEDY - VITACURA / FIJA 2','Av. Vitacura & Calle Luz','','FIJA','R'],
[-33.40869,-70.600436,'','066 KENNEDY - VITACURA / PTZ','Av. Vitacura & Calle Luz','','PTZ','R'],
[-33.431206,-70.578645,'','067 BILBAO - LATADIA / LPR 1','Bilbao & Latadía','','LPR','R'],
[-33.431206,-70.578645,'','067 BILBAO - LATADIA / LPR 2','Bilbao & Latadía','','LPR','R'],
[-33.431206,-70.578645,'','067 BILBAO & LATADIA (JUAN DE AUSTRIA) / LPR','Bilbao & Latadía','','LPR','R'],
[-33.431206,-70.578645,'','067 BILBAO LATADIA / FIJA 1','Bilbao & Latadía','','FIJA','R'],
[-33.431206,-70.578645,'','067 BILBAO LATADIA / FIJA 2','Bilbao & Latadía','','FIJA','R'],
[-33.431206,-70.578645,'','067 BILBAO LATADIA / PTZ','Bilbao & Latadía','','PTZ','R'],
[-33.414913,-70.512784,'','068 BULNES CORREA - SAN RAMON / PTZ','Bulnes Correa & San Ramón','','PTZ','R'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / FIJA 1','Av. Vitacura & Isidora Goyenechea','','FIJA','R'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / FIJA 2','Av. Vitacura & Isidora Goyenechea','','FIJA','R'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / LPR 1','Av. Vitacura & Isidora Goyenechea','','LPR','R'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / LPR 2','Av. Vitacura & Isidora Goyenechea','','LPR','R'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / PTZ','Av. Vitacura & Isidora Goyenechea','','PTZ','R'],
[-33.411572,-70.52049,'','070 CARLOS PEÑA- LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas','','PTZ','R'],
[-33.416976,-70.55256,'','071 CHOAPA - TINGUIRIRICA / PTZ','Choapa & Tinguiririca','','PTZ','R'],
[-33.424314,-70.583266,'','072 COLON - MALAGA / PTZ','Av. Cristobal Colón & Malaga','','PTZ','R'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / FIJA 1','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','FIJA','R'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / FIJA 2','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','FIJA','R'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / FIJA 3','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','FIJA','R'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / LPR','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','LPR','R'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / PTZ','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','PTZ','R'],
[-33.401294,-70.522912,'','074 EL ALBA - LA FUENTE / PTZ','Camino el Alba & Camino La Fuente','','PTZ','R'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / FIJA 1','El Bosque Central & Callao','','FIJA','R'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / FIJA 2','El Bosque Central & Callao','','FIJA','R'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / LPR 1','El Bosque Central & Callao','','LPR','R'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / LPR 2','El Bosque Central & Callao','','LPR','R'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / PTZ','El Bosque Central & Callao','','PTZ','R'],
[-33.425952,-70.580754,'','076 FLANDES - VATICANO / PTZ','Flandes & Vaticano','','PTZ','R'],
[-33.407551,-70.537209,'','077 BLANCHE - PAUL HARRIS / PTZ','General Blanche & Paul Harris','','PTZ','R'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / FIJA 1','Isidora Goyenechea & Enrique Foster','','FIJA','R'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / FIJA 2','Isidora Goyenechea & Enrique Foster','','FIJA','R'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster','','PTZ','R'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / SOS','Isidora Goyenechea & Enrique Foster','','VIDEOPORTERO','R'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / RF 11 FOSTER - ISIDORA GOYENECHEA / PTZ','Isidora Goyenechea & Enrique Foster','','PTZ','R'],
[-33.413528,-70.558785,'','079 IV CENTENARIO - HDO DE MAGALLANES / PTZ','IV Centenario & Hernando de Magallanes','','PTZ','R'],
[-33.413528,-70.558785,'','079 IV CENTENARIO - HDO DE MAGALLANES / SOS','IV Centenario & Hernando de Magallanes','','VIDEOPORTERO','R'],
[-33.395986,-70.506019,'','080 LA PLAZA - LAS FLORES / PTZ','La Plaza & Camino las Flores','','PTZ','R'],
[-33.392763,-70.503793,'','081 LA PLAZA - REP DE HONDURAS / PTZ','La Plaza & Rep. Honduras','','PTZ','R'],
[-33.427341,-70.5642,'','082 MANQUEHUE - LATADIA / PTZ','Latadía & Manquehue','','PTZ','R'],
[-33.427755,-70.570121,'','083 ROTONDA LATADIA / PTZ','Latadía & Sebastián Elcano','','PTZ','R'],
[-33.427755,-70.570121,'','083 ROTONDA LATADIA / SOS','Latadía & Sebastián Elcano','','VIDEOPORTERO','R'],
[-33.400783,-70.544448,'','084 PADRE HURTADO - BOCACCIO / PTZ','Padre Hurtado Norte & Bocaccio','','PTZ','R'],
[-33.396426,-70.544252,'','085 PADRE HURTADO - EL ALAMEIN / PTZ','Padre Hurtado Norte & El Alamein','','PTZ','R'],
[-33.413103,-70.537537,'','086 NAME - SIERRA NEVADA / FIJA 1','Pje. Cerro Name & Pje. Sierra Nevada','','FIJA','R'],
[-33.413103,-70.537537,'','086 NAME - SIERRA NEVADA / FIJA 2','Pje. Cerro Name & Pje. Sierra Nevada','','FIJA','R'],
[-33.413103,-70.537537,'','086 NAME - SIERRA NEVADA / PTZ','Pje. Cerro Name & Pje. Sierra Nevada','','PTZ','R'],
[-33.413103,-70.537537,'','086 NAME - SIERRA NEVADA / SOS','Pje. Cerro Name & Pje. Sierra Nevada','','VIDEOPORTERO','R'],
[-33.414423,-70.537494,'','087 DIAGUITAS - LEON BLANCO / PTZ','Pje. Diaguitas & Pje. León Blanco','','PTZ','R'],
[-33.409235,-70.568171,'','088 APUMANQUE (FARO) / RF 09 APUMANQUE / FIJA','Apumanque & Apoquindo Sur','','FIJA','R'],
[-33.413853,-70.53676,'','089 NEVADO DE PIUQUENES - CERRO MARMOLEJO / PTZ','Pje. Marmolejo & Pje. Nevado de Piuquenes','','PTZ','R'],
[-33.392319,-70.538217,'','090 PAUL HARRIS - CHARLES HAMILTON / FIJA 1','Paul Harris & Charles Hamilton','','FIJA','R'],
[-33.392319,-70.538217,'','090 PAUL HARRIS - CHARLES HAMILTON / FIJA 2','Paul Harris & Charles Hamilton','','FIJA','R'],
[-33.392319,-70.538217,'','090 PAUL HARRIS - CHARLES HAMILTON / FIJA 3','Paul Harris & Charles Hamilton','','FIJA','R'],
[-33.392319,-70.538217,'','090 PAUL HARRIS - CHARLES HAMILTON / PTZ','Paul Harris & Charles Hamilton','','PTZ','R'],
[-33.420242,-70.588399,'','091 ERRAZURIZ - ALCANTARA / PTZ','Pdte. Errazuriz & Alcantara','','PTZ','R'],
[-33.420242,-70.588399,'','091 ERRAZURIZ - ALCANTARA / SOS','Pdte. Errazuriz & Alcantara','','VIDEOPORTERO','R'],
[-33.412534,-70.597635,'','092 RIESCO - AUGUSTO LEGUIA / PTZ','Pdte. Riesco & Augusto Leguía','','PTZ','R'],
[-33.423615,-70.527308,'','093 PLAZA FLEMING / PTZ','Alejandro Fleming 9695','','PTZ','R'],
[-33.413274,-70.570203,'','094 ROTONDA LA CAPITANIA / PTZ','La Capitanía & Del Inca','','PTZ','R'],
[-33.413274,-70.570203,'','094 ROTONDA LA CAPITANIA / SOS','La Capitanía & Del Inca','','VIDEOPORTERO','R'],
[-33.415373,-70.551429,'','095 MONROE - ANDALIEN / PTZ','Monroe & Andalién','','PTZ','R'],
[-33.415373,-70.551429,'','095 MONROE - ANDALIEN / SOS','Monroe & Andalién','','VIDEOPORTERO','R'],
[-33.411931,-70.535445,'','096 RIO GUADIANA - PAUL HARRIS / FIJA 1','Rio Guadiana & Paul Harris','','FIJA','R'],
[-33.411931,-70.535445,'','096 RIO GUADIANA - PAUL HARRIS / FIJA 2','Rio Guadiana & Paul Harris','','FIJA','R'],
[-33.411931,-70.535445,'','096 RIO GUADIANA - PAUL HARRIS / PTZ','Rio Guadiana & Paul Harris','','PTZ','R'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / LPR 1','Sánchez Fontecilla & Isabel La Católica','','LPR','R'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / LPR 2','Sánchez Fontecilla & Isabel La Católica','','LPR','R'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 1','Sánchez Fontecilla & Isabel La Católica','','FIJA','R'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / FIJA 2','Sánchez Fontecilla & Isabel La Católica','','FIJA','R'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / PTZ','Sánchez Fontecilla & Isabel La Católica','','PTZ','R'],
[-33.413522,-70.539614,'','098 LEON NEGRO - FUEGUINOS / PTZ','Sierra Nevada & Leon Negro','','PTZ','R'],
[-33.413522,-70.539614,'','098 LEON NEGRO - FUEGUINOS / SOS','Sierra Nevada & Leon Negro','','VIDEOPORTERO','R'],
[-33.401927,-70.570086,'','099 PARQUE ARAUCANO SKATEPARK / PTZ','Skatepark Parque Araucano','','PTZ','R'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / FIJA 1','Tajamar & Vitacura','','FIJA','R'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / FIJA 2','Tajamar & Vitacura','','FIJA','R'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / FIJA 3','Tajamar & Vitacura','','FIJA','R'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / PTZ','Tajamar & Vitacura','','PTZ','R'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / SOS','Tajamar & Vitacura','','VIDEOPORTERO','R'],
[-33.425341,-70.553952,'','101 TOMAS MORO - FLEMING / PTZ','Tomás Moro & Alejandro Fleming','','PTZ','R'],
[-33.425341,-70.553952,'','101 TOMAS MORO - FLEMING / SOS','Tomás Moro & Alejandro Fleming','','VIDEOPORTERO','R'],
[-33.419409,-70.552891,'','102 TOMAS MORO - ATENAS / PTZ','Tomás Moro & Atenas','','PTZ','R'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / FIJA 1','A. Vespucio & Latadía','','FIJA','R'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / FIJA 2','A. Vespucio & Latadía','','FIJA','R'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / FIJA 3','A. Vespucio & Latadía','','FIJA','R'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / PTZ','A. Vespucio & Latadía','','PTZ','R'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / SOS','A. Vespucio & Latadía','','VIDEOPORTERO','R'],
[-33.419697,-70.582303,'','104 VESPUCIO - RAPALLO / FIJA 1','A. Vespucio Sur & Rapallo','','FIJA','R'],
[-33.419697,-70.582303,'','104 VESPUCIO - RAPALLO / PTZ','A. Vespucio Sur & Rapallo','','PTZ','R'],
[-33.415982,-70.583668,'','105 VESPUCIO - NEVERIA / FIJA 1','A. Vespucio Sur & Nevería','','FIJA','R'],
[-33.415982,-70.583668,'','105 VESPUCIO - NEVERIA / PTZ','A. Vespucio Sur & Nevería','','PTZ','R'],
[-33.41622,-70.594066,'','106 APOQUINDO - FOSTER/ FIJA','Enrique Foster & Apoquindo Norte','','FIJA','R'],
[-33.41639,-70.594105,'','106 APOQUINOD - FOSTER / RF 03 FOSTER A / PTZ','Enrique Foster & Apoquindo Sur','','PTZ','R'],
[-33.392448,-70.514809,'','107 LAS TERRAZAS - VALLE NEVADO / PTZ','Circunvalación Las Terrazas & Valle Nevado','','PTZ','R'],
[-33.368424,-70.501713,'','108 QUINCHAMALI 1 / PTZ','DESCATAMENTO QUINCHAMALI','','PTZ','R'],
[-33.368424,-70.501713,'','108 QUINCHAMALI 2 / FIJA 1','DESCATAMENTO QUINCHAMALI','','FIJA','R'],
[-33.368424,-70.501713,'','108 QUINCHAMALI 3 / FIJA 2','DESCATAMENTO QUINCHAMALI','','FIJA','R'],
[-33.415837,-70.59623,'','109 CENTRO CIVICO / LPR','Centro Civico / Apoquindo','','LPR','R'],
[-33.415837,-70.59623,'','109 CENTRO CIVICO / PTZ','Centro Civico / Apoquindo','','PTZ','R'],
[-33.423541,-70.57904,'','110 VESPUCIO - COLON / FIJA 1','Américo Vespucio & Cristóbal Colon','','FIJA','R'],
[-33.423541,-70.57904,'','110 VESPUCIO - COLON / FIJA 2','Américo Vespucio & Cristóbal Colon','','FIJA','R'],
[-33.423541,-70.57904,'','110 VESPUCIO - COLON / FIJA 3','Américo Vespucio & Cristóbal Colon','','FIJA','R'],
[-33.423541,-70.57904,'','110 VESPUCIO - COLON / PTZ','Américo Vespucio & Cristóbal Colon','','PTZ','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / FIJA 1','Francisco Bilbao & Américo Vespucio','','FIJA','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / FIJA 2','Francisco Bilbao & Américo Vespucio','','FIJA','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / FIJA 3','Francisco Bilbao & Américo Vespucio','','FIJA','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / LPR 1','Francisco Bilbao & Américo Vespucio','','LPR','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / LPR 2','Francisco Bilbao & Américo Vespucio','','LPR','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / LPR 3','Francisco Bilbao & Américo Vespucio','','LPR','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / LPR 4','Francisco Bilbao & Américo Vespucio','','LPR','R'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / PTZ','Francisco Bilbao & Américo Vespucio','','PTZ','R'],
[-33.414304,-70.597954,'','112 ISIDORA GOYENECHEA - AUGUSTO LEGUIA / PTZ','Isidora Goyenechea & Augusto Leguía Norte','','PTZ','R'],
[-33.398687,-70.571163,'','113 MANQUEHUE - KENNEDY / PTZ','Manquehue Sur Poniente & Kenedy','','PTZ','R'],
[-33.425349,-70.564257,'','114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 1','Manquehue & Isabel La Catolica','','FIJA','R'],
[-33.425349,-70.564257,'','114 MANQUEHUE - ISABEL LA CATOLICA / FIJA 2','Manquehue & Isabel La Catolica','','FIJA','R'],
[-33.425349,-70.564257,'','114 MANQUEHUE - ISABEL LA CATOLICA / PTZ','Manquehue & Isabel La Catolica','','PTZ','R'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / FIJA 1','Mariano Sánchez Fontecilla & Francisco Bilbao','','FIJA','R'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / FIJA 2','Mariano Sánchez Fontecilla & Francisco Bilbao','','FIJA','R'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / LPR 1','Mariano Sánchez Fontecilla & Francisco Bilbao','','LPR','R'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / LPR 2','Mariano Sánchez Fontecilla & Francisco Bilbao','','LPR','R'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / PTZ','Mariano Sánchez Fontecilla & Francisco Bilbao','','PTZ','R'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 1','Mariano Sánchez Fontecilla & Martín de Zamora','','FIJA','R'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 2','Mariano Sánchez Fontecilla & Martín de Zamora','','FIJA','R'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 1','Mariano Sánchez Fontecilla & Martín de Zamora','','LPR','R'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / LPR 2','Mariano Sánchez Fontecilla & Martín de Zamora','','LPR','R'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / PTZ','Mariano Sánchez Fontecilla & Martín de Zamora','','PTZ','R'],
[-33.421457,-70.5966,'','117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 1','Mariano Sánchez Fontecilla & Presidente Errázuriz','','FIJA','R'],
[-33.421457,-70.5966,'','117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 2','Mariano Sánchez Fontecilla & Presidente Errázuriz','','FIJA','R'],
[-33.421457,-70.5966,'','117 SANCHEZ FONTECILLA - ERRAZURIZ / PTZ','Mariano Sánchez Fontecilla & Presidente Errázuriz','','PTZ','R'],
[-33.420547,-70.590365,'','118 ERRAZURIZ - GERTRUDIZ ECHEÑIQUE / PTZ','Presidente Errázuriz & Gertrudiz Echeñique','','PTZ','R'],
[-33.417629,-70.530741,'','119 YOLANDA - LA PAZ / PTZ','Yolanda & La Paz','','PTZ','R'],
[-33.428334,-70.549394,'','120 CURACO - M CLARO VIAL / PTZ','Curcaco & Manuel Claro Vial','','PTZ','R'],
[-33.40484,-70.58199,'','121 ALONSO DE CORDOVA - CERRO COLORADO / FIJA 1','Alonso de Córdova & Cerro Colorado','','FIJA','R'],
[-33.40484,-70.58199,'','121 ALONSO DE CORDOVA - CERRO COLORADO / PTZ','Alonso de Córdova & Cerro Colorado','','PTZ','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / FIJA 1','Padre Hurtado Sur & Bilbao','','FIJA','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / FIJA 2','Padre Hurtado Sur & Bilbao','','FIJA','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / FIJA 3','Padre Hurtado Sur & Bilbao','','FIJA','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / LPR 1','Padre Hurtado Sur & Bilbao','','LPR','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / LPR 2','Padre Hurtado Sur & Bilbao','','LPR','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / LPR 3','Padre Hurtado Sur & Bilbao','','LPR','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / LPR 4','Padre Hurtado Sur & Bilbao','','LPR','R'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / PTZ','Padre Hurtado Sur & Bilbao','','PTZ','R'],
[-33.42999,-70.55171,'','123 BILBAO - FLORENCIO BARRIOS / FIJA 1','Bilbao & Florencio Barrios','','FIJA','R'],
[-33.42999,-70.55171,'','123 BILBAO - FLORENCIO BARRIOS / FIJA 2','Bilbao & Florencio Barrios','','FIJA','R'],
[-33.42999,-70.55171,'','123 BILBAO - FLORENCIO BARRIOS / PTZ','Bilbao & Florencio Barrios','','PTZ','R'],
[-33.4307,-70.55993,'','124 BILBAO - HUARAHUARA / PTZ','Bilbao & Huarahuara','','PTZ','R'],
[-33.43112,-70.57006,'','125 BILBAO - SEBASTIAN ELCANO / FIJA 1','Bilbao & Sebastián Elcano','','FIJA','R'],
[-33.43112,-70.57006,'','125 BILBAO - SEBASTIAN ELCANO / FIJA 2','Bilbao & Sebastián Elcano','','FIJA','R'],
[-33.43112,-70.57006,'','125 BILBAO - SEBASTIAN ELCANO / PTZ','Bilbao & Sebastián Elcano','','PTZ','R'],
[-33.4315,-70.58093,'','126 BILBAO - ALCANTARA / FIJA 1','Bilbao & Alcantara','','FIJA','R'],
[-33.4315,-70.58093,'','126 BILBAO - ALCANTARA / PTZ','Bilbao & Alcantara','','PTZ','R'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / FIJA 1','Pdte Riesco & Vespucio','','FIJA','R'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / FIJA 2','Pdte Riesco & Vespucio','','FIJA','R'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / LPR 1','Pdte Riesco & Vespucio','','LPR','R'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / LPR 2','Pdte Riesco & Vespucio','','LPR','R'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / PTZ','Pdte Riesco & Vespucio','','PTZ','R'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / FIJA 1','Kennedy & Rosario Norte','','FIJA','R'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / FIJA 2','Kennedy & Rosario Norte','','FIJA','R'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / LPR 1','Kennedy & Rosario Norte','','LPR','R'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / LPR 2','Kennedy & Rosario Norte','','LPR','R'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / PTZ','Kennedy & Rosario Norte','','PTZ','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / FIJA 1','Av. Kennedy & Gerónimo de Alderete','','FIJA','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / FIJA 2','Av. Kennedy & Gerónimo de Alderete','','FIJA','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / FIJA 3','Av. Kennedy & Gerónimo de Alderete','','FIJA','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / LPR 1','Av. Kennedy & Gerónimo de Alderete','','LPR','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / LPR 2','Av. Kennedy & Gerónimo de Alderete','','LPR','R'],
[-33.39477,-70.56152,'','129 KENNEDY - GERONIMO DE ALDERETE / PTZ','Av. Kennedy & Gerónimo de Alderete','','PTZ','R'],
[-33.38992,-70.54828,'','130 KENNEDY - PADRE HURTADO / FIJA 1','Av. Kennedy & Padre Hurtado','','FIJA','R'],
[-33.38992,-70.54828,'','130 KENNEDY - PADRE HURTADO / FIJA 2','Av. Kennedy & Padre Hurtado','','FIJA','R'],
[-33.38992,-70.54828,'','130 KENNEDY - PADRE HURTADO / PTZ','Av. Kennedy & Padre Hurtado','','PTZ','R'],
[-33.38883,-70.54527,'','131 KENNEDY - GILBERTO FUENZALIDA / PTZ','Kennedy & Gilberto Fuenzalida','','PTZ','R'],
[-33.38673,-70.53833,'','132 LAS CONDES - KENNEDY / FIJA 1','Av. Las Condes & Kennedy','','FIJA','R'],
[-33.38673,-70.53833,'','132 LAS CONDES - KENNEDY / PTZ','Av. Las Condes & Kennedy','','PTZ','R'],
[-33.37805,-70.5281,'','133 LAS CONDES - VALLE ALEGRE / PTZ','Av. Las Condes & Valle Alegre','','PTZ','R'],
[-33.376189,-70.525616,'','134 LAS CONDES - SAN DAMIAN / FIJA 1','Av. Las Condes & San Damián','','FIJA','R'],
[-33.376189,-70.525616,'','134 LAS CONDES - SAN DAMIAN / FIJA 2','Av. Las Condes & San Damián','','FIJA','R'],
[-33.376189,-70.525616,'','134 LAS CONDES - SAN DAMIAN / PTZ','Av. Las Condes & San Damián','','PTZ','R'],
[-33.37275,-70.51748,'','135 LAS CONDES - SAN FRANCISCO / FIJA 1','Av. Las Condes & San Francisco de Asis','','FIJA','R'],
[-33.37275,-70.51748,'','135 LAS CONDES - SAN FRANCISCO / FIJA 2','Av. Las Condes & San Francisco de Asis','','FIJA','R'],
[-33.37275,-70.51748,'','135 LAS CONDES - SAN FRANCISCO / PTZ','Av. Las Condes & San Francisco de Asis','','PTZ','R'],
[-33.37417,-70.50212,'','136 LA POSADA - SAN JOSE DE LA SIERRA / PTZ','La Posada & San Jose de la Sierra','','PTZ','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / FIJA 1','Av. Las Condes & Camino San Antonio','','FIJA','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / FIJA 2','Av. Las Condes & Camino San Antonio','','FIJA','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / FIJA 3','Av. Las Condes & Camino San Antonio','','FIJA','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / FIJA 4','Av. Las Condes & Camino San Antonio','','FIJA','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / LPR 1','Av. Las Condes & Camino San Antonio','','LPR','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / LPR 2','Av. Las Condes & Camino San Antonio','','LPR','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / LPR 3','Av. Las Condes & Camino San Antonio','','LPR','R'],
[-33.37091,-70.51162,'','137 LAS CONDES - SAN ANTONIO / PTZ','Av. Las Condes & Camino San Antonio','','PTZ','R'],
[-33.37034,-70.50779,'','138 LAS CONDES - FERNANDEZ CONCHA / PTZ','Av. Las Condes & Fernandez Concha','','PTZ','R'],
[-33.36967,-70.50441,'','139 LAS CONDES - SAN JOSE DE LA SIERRA / PTZ','AV. Las Condes & San José de la Sierra','','PTZ','R'],
[-33.36701,-70.49694,'','140 CAMINO FARELLONES - AV EL MONTE / FIJA 1','Camino a Farellones & Av. del Monte','','FIJA','R'],
[-33.36701,-70.49694,'','140 CAMINO FARELLONES - AV EL MONTE / LPR','Camino a Farellones & Av. del Monte','','LPR','R'],
[-33.36701,-70.49694,'','140 CAMINO FARELLONES - AV EL MONTE / PTZ','Camino a Farellones & Av. del Monte','','PTZ','R'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / FIJA 1','Pdte Riesco & Vitacura','','FIJA','R'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / FIJA 2','Pdte Riesco & Vitacura','','FIJA','R'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / FIJA 3','Pdte Riesco & Vitacura','','FIJA','R'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / LPR','Pdte Riesco & Vitacura','','LPR','R'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / PTZ','Pdte Riesco & Vitacura','','PTZ','R'],
[-33.413588,-70.58466,'','142 VESPUCIO - LOS MILITARES / FIJA 1','Los Militares & Americo Vespucio','','FIJA','R'],
[-33.413588,-70.58466,'','142 VESPUCIO - LOS MILITARES / FIJA 2','Los Militares & Americo Vespucio','','FIJA','R'],
[-33.413588,-70.58466,'','142 VESPUCIO - LOS MILITARES / PTZ','Los Militares & Americo Vespucio','','PTZ','R'],
[-33.40438,-70.58408,'','143 KENNEDY - ALONSO DE CORDOVA / FIJA 1','Kennedy & Alonso de Cordova','','FIJA','R'],
[-33.40438,-70.58408,'','143 KENNEDY - ALONSO DE CORDOVA / PTZ','Kennedy & Alonso de Cordova','','PTZ','R'],
[-33.42773,-70.58861,'','144 SANCHEZ FONTECILLA - VATICANO / PTZ','Sanchez Fontecilla & Vaticano','','PTZ','R'],
[-33.41468,-70.60554,'','145 ANDRES BELLO - COSTANERA SUR / PTZ','Andres Bello & Costanera Sur','','PTZ','R'],
[-33.40158,-70.50974,'','146 BLANCHE - SAN CARLOS DE APOQUINDO / PTZ','U. LOS ANDES - San Carlos de Apoquindo & Blanche','','PTZ','R'],
[-33.41626,-70.53908,'','147 COLON - PADRE HURTADO / FIJA 1','Colón & Padre Hurtado','','FIJA','R'],
[-33.41626,-70.53908,'','147 COLON - PADRE HURTADO / FIJA 2','Colón & Padre Hurtado','','FIJA','R'],
[-33.41626,-70.53908,'','147 COLON - PADRE HURTADO / FIJA 3','Colón & Padre Hurtado','','FIJA','R'],
[-33.41626,-70.53908,'','147 COLON - PADRE HURTADO / PTZ','Colón & Padre Hurtado','','PTZ','R'],
[-33.41593,-70.60682,'','148 ANDRES BELLO - TAJAMAR / PTZ','Nueva Tajamar & Andres Bello','','PTZ','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / FIJA 1','Cerro Colorado & Manquehue','','FIJA','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / FIJA 2','Cerro Colorado & Manquehue','','FIJA','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / LPR 1','Cerro Colorado & Manquehue','','LPR','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / LPR 2','Cerro Colorado & Manquehue','','LPR','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / LPR 3','Cerro Colorado & Manquehue','','LPR','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / LPR 4','Cerro Colorado & Manquehue','','LPR','R'],
[-33.40054,-70.57028,'','149 CERRO COLORADO - MANQUEHUE / PTZ','Cerro Colorado & Manquehue','','PTZ','R'],
[-33.40043,-70.54767,'','150 CHESTERTON - BOCACCIO / PTZ','Chesterton & Bocaccio','','PTZ','R'],
[-33.40839,-70.55336,'','151 INACAP APOQUINDO / PTZ','INACAP APOQUINDO','','PTZ','R'],
[-33.41807,-70.6013,'','152 APOQUINDO - TOBALABA / FIJA 1','Apoquindo & Tobalaba','','FIJA','R'],
[-33.41807,-70.6013,'','152 APOQUINDO - TOBALABA / FIJA 2','Apoquindo & Tobalaba','','FIJA','R'],
[-33.41807,-70.6013,'','152 APOQUINDO - TOBALABA / FIJA 3','Apoquindo & Tobalaba','','FIJA','R'],
[-33.41807,-70.6013,'','152 APOQUINDO - TOBALABA / PTZ','Apoquindo & Tobalaba','','PTZ','R'],
[-33.39951,-70.5068,'','153 DUOC CAMINO EL ALBA - LA PLAZA / FIJA','DUOC - Camino El Alba & La PLaza','','FIJA','R'],
[-33.42114,-70.57645,'','154 COLON - FELIX DE AMESTI / PTZ','Colón & Felix de Amesti','','PTZ','R'],
[-33.39031,-70.49988,'','155 AV LA PLAZA - SAN FRANCISCO / PTZ','San Francisco de Asis & Av. La Plaza','','PTZ','R'],
[-33.42511,-70.53321,'','156 STA ZITA - CIRIO / PTZ','Sta Zita & Cirio','','PTZ','R'],
[-33.39494,-70.51256,'','157 LAS FLORES - SAN RAMON / PTZ','Las Flores & San Ramón','','PTZ','R'],
[-33.40226,-70.57547,'','158 CERRO COLORADO - ROSARIO NORTE / PTZ','Cerro Colorado & Rosario Norte','','PTZ','R'],
[-33.42376,-70.53797,'','159 PADRE HURTADO - FLEMING / FIJA 1','Av. Padre Hurtado & Alejandro Fleming','','FIJA','R'],
[-33.42376,-70.53797,'','159 PADRE HURTADO - FLEMING / FIJA 2','Av. Padre Hurtado & Alejandro Fleming','','FIJA','R'],
[-33.42376,-70.53797,'','159 PADRE HURTADO - FLEMING / PTZ','Av. Padre Hurtado & Alejandro Fleming','','PTZ','R'],
[-33.42185,-70.52968,'','160 PAUL HARRIS - VITAL APOQUINDO / PTZ','Paul Harris & Vital Apoquindo','','PTZ','R'],
[-33.4131,-70.54063,'','161 PADRE HURTADO - RIO GUADIANA / PTZ','Padre Hurtado & Rio Guadiana','','PTZ','R'],
[-33.41606,-70.5363,'','162 COLON - LOMA LARGA / PTZ','Colón & Loma Larga','','PTZ','R'],
[-33.39138,-70.50659,'','163 SAN CARLOS DE APOQUINDO - REP DE HONDURAS / PTZ','República de Honduras & San Carlos de Apoquindo','','PTZ','R'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / FIJA 1','Vespucio & Presidente Errázuriz','','FIJA','R'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / FIJA 2','Vespucio & Presidente Errázuriz','','FIJA','R'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / LPR 1','Vespucio & Presidente Errázuriz','','LPR','R'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / LPR 2','Vespucio & Presidente Errázuriz','','LPR','R'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / PTZ','Vespucio & Presidente Errázuriz','','PTZ','R'],
[-33.39457,-70.51576,'','165 LAS TERRAZAS - CAMINO LAS FLORES / PTZ','Las Terrazas - Camino Las Flores','','PTZ','R'],
[-33.40114,-70.51737,'','166 CAMINO EL ALBA - BULNES CORREA / PTZ','Camino El Alba & Bulnes Correa','','PTZ','R'],
[-33.40102,-70.51383,'','167 CAMINO EL ALBA - SAN RAMON / PTZ','Camino El Alba & San Ramón','','PTZ','R'],
[-33.41885,-70.57187,'','168 COLON - SEBASTIAN ELCANO / PTZ','Av. Colón & Sebastián Elcano','','PTZ','R'],
[-33.41271,-70.51259,'','169 BULNES CORREA - CARLOS PEÑA OTAEGUI / PTZ','Fco bulnes Correa & Carlos Peña Otaegui','','PTZ','R'],
[-33.384894,-70.495206,'','170 AV LA PLAZA - SAN CARLOS DE APOQUINDO / PTZ','Av La Plaza & San Carlos de Apoquindo','','PTZ','R'],
[-33.378881,-70.494678,'','171 SAN JOSE DE LA SIERRA - HUEICOLLA / PTZ','San Jose de la Sierra & Hueicolla','','PTZ','R'],
[-33.405137,-70.502465,'','172 AV LA PLAZA (U LOS ANDES) / PTZ','Av La Plaza 2440','','PTZ','R'],
[-33.425597,-70.588208,'','173 COLON - MARCO POLO / PTZ','Colón & Marco Polo','','PTZ','R'],
[-33.42079,-70.564455,'','174 MANQUEHUE - ALONSO DE CAMARGO / PTZ','Manquehue & Alonso de Camargo','','PTZ','R'],
[-33.429068,-70.564614,'','175 MANQUEHUE - CARLOS ALVARADO / PTZ','Manquehue & Carlos Alvarado','','PTZ','R'],
[-33.420254,-70.578361,'','176 MARTIN DE ZAMORA - FELIX DE AMESTI / PTZ','Martin de Zamora & Felix de Amesti','','PTZ','R'],
[-33.3996646,-70.5745422,'','177 MARRIOT / PTZ','Av. Kennedy 5741','','PTZ','R'],
[-33.3996646,-70.5745422,'','177 MARRIOT / SOS','Av. Kennedy 5741','','VIDEOPORTERO','R'],
[-33.395151,-70.517012,'','178 FRANCISCO BULNES - LAS FLORES / PTZ','Francisco Bulnes Correa & Las Flores','','PTZ','R'],
[-33.395054,-70.522219,'','179 LAS FLORES - LA FUENTE / PTZ','Las Flores & La Fuente','','PTZ','R'],
[-33.385163,-70.503149,'','180 EL CONVENTO - SAN FRANCISCO / PTZ','El Convento & San Francisco de Asis','','PTZ','R'],
[-33.387669,-70.501016,'','181 SAN FRANCISCO - SAN CARLOS DE APOQUINDO / PTZ','San Carlos de Apoquindo & San Francisco de Asis','','PTZ','R'],
[-33.407638,-70.510605,'','182 SAN RAMON - LOS OLIVILLOS / PTZ','San Ramon & Los Olivillos','','PTZ','R'],
[-33.39027,-70.514928,'','183 FRANCISCO BULNES - REPUBLICA DE HONDURAS / PTZ','Republica de Honduras & Francisco Bulnes Correa','','PTZ','R'],
[-33.387651,-70.51911,'','184 LAS LAVANDULAS - LA FUENTE / FIJA 1','Las Lavandulas & La Fuente','','FIJA','R'],
[-33.387651,-70.51911,'','184 LAS LAVANDULAS - LA FUENTE / PTZ','Las Lavandulas & La Fuente','','PTZ','R'],
[-33.405826,-70.516216,'','185 FRANCISCO BULNES - QUEBRADA HONDA / PTZ','Francisco Bulnes Correa & Quebrada Honda','','PTZ','R'],
[-33.403527,-70.51943,'','186 GENERAL BLANCHE - CAMINO OTOÑAL / PTZ','General Blanche & Camino Otoñal','','PTZ','R'],
[-33.412133,-70.52532,'','187 QUEBRADA HONDA - CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña Otaegui','','PTZ','R'],
[-33.427483,-70.578904,'','188 ISABEL LA CATOLICA -CARLOS V / PTZ','Isabel la Católica & Carlos V','','PTZ','R'],
[-33.394277,-70.545404,'','189 PADRE HURTADO - LAS CONDES / PTZ','Padre Hurtado & Las Condes','','PTZ','R'],
[-33.41539,-70.60106,'','190 EL BOSQUE - SAN SEBASTIAN / FIJA 1','EL BOSQUE & SAN SEBASTIAN','','FIJA','R'],
[-33.41539,-70.60106,'','190 EL BOSQUE - SAN SEBASTIAN / FIJA 2','EL BOSQUE & SAN SEBASTIAN','','FIJA','R'],
[-33.41539,-70.60106,'','190 EL BOSQUE - SAN SEBASTIAN / PTZ','EL BOSQUE & SAN SEBASTIAN','','PTZ','R'],
[-33.414805,-70.587055,'','191 APOQUINDO - GOLDA MEIR / FIJA 1','APOQUINDO & GOLDA MEIR','','FIJA','R'],
[-33.414805,-70.587055,'','191 APOQUINDO - GOLDA MEIR / FIJA 2','APOQUINDO & GOLDA MEIR','','FIJA','R'],
[-33.414805,-70.587055,'','191 APOQUINDO - GOLDA MEIR / PTZ','APOQUINDO & GOLDA MEIR','','PTZ','R'],
[-33.411838,-70.591128,'','192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 1','PRESIDENTE RIESCO & LAS TORCAZAS','','FIJA','R'],
[-33.411838,-70.591128,'','192 PRESIDENTE RIESCO - LAS TORCAZAS / FIJA 2','PRESIDENTE RIESCO & LAS TORCAZAS','','FIJA','R'],
[-33.411838,-70.591128,'','192 PRESIDENTE RIESCO - LAS TORCAZAS / PTZ','PRESIDENTE RIESCO & LAS TORCAZAS','','PTZ','R'],
[-33.40668,-70.57307,'','193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 1','ALONSO DE CÓRDOVA & LOS MILITARES','','FIJA','R'],
[-33.40668,-70.57307,'','193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 2','ALONSO DE CÓRDOVA & LOS MILITARES','','FIJA','R'],
[-33.40668,-70.57307,'','193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 3','ALONSO DE CÓRDOVA & LOS MILITARES','','FIJA','R'],
[-33.40668,-70.57307,'','193 ALONSO DE CORDOVA - LOS MILITARES / PTZ','ALONSO DE CÓRDOVA & LOS MILITARES','','PTZ','R'],
[-33.429776,-70.547426,'','194 FRANCISCO BILBAO - DUQUECO / FIJA 1','FRANCISCO BILBAO & DUQUECO','','FIJA','R'],
[-33.429776,-70.547426,'','194 FRANCISCO BILBAO - DUQUECO / FIJA 2','FRANCISCO BILBAO & DUQUECO','','FIJA','R'],
[-33.429776,-70.547426,'','194 FRANCISCO BILBAO - DUQUECO / PTZ','FRANCISCO BILBAO & DUQUECO','','PTZ','R'],
[-33.419519,-70.551361,'','195 GREDOS - IV CENTENARIO / FIJA 1','GREDOS & CUARTO CENTENARIO','','FIJA','R'],
[-33.419519,-70.551361,'','195 GREDOS - IV CENTENARIO / FIJA 2','GREDOS & CUARTO CENTENARIO','','FIJA','R'],
[-33.419519,-70.551361,'','195 GREDOS - IV CENTENARIO / FIJA PTZ','GREDOS & CUARTO CENTENARIO','','PTZ','R'],
[-33.413302,-70.537968,'','196 SIERRA NEVADA - DIAGUITAS / FIJA 1','SIERRA NEVADA & DIAGUITAS','','FIJA','R'],
[-33.413302,-70.537968,'','196 SIERRA NEVADA - DIAGUITAS / FIJA 2','SIERRA NEVADA & DIAGUITAS','','FIJA','R'],
[-33.413302,-70.537968,'','196 SIERRA NEVADA - DIAGUITAS / PTZ','SIERRA NEVADA & DIAGUITAS','','PTZ','R'],
[-33.4271,-70.52965,'','197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 1','NUEVA BILBAO & VITAL APOQUINDO','','FIJA','R'],
[-33.4271,-70.52965,'','197 NUEVA BILBAO - VITAL APOQUINDO / FIJA 2','NUEVA BILBAO & VITAL APOQUINDO','','FIJA','R'],
[-33.4271,-70.52965,'','197 NUEVA BILBAO - VITAL APOQUINDO / PTZ','NUEVA BILBAO & VITAL APOQUINDO','','PTZ','R'],
[-33.43077,-70.56367,'','198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / FIJA 1','FRANCISCO BILBAO & HERNANDO DE MAGALLANES','','FIJA','R'],
[-33.43077,-70.56367,'','198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / LPR','FRANCISCO BILBAO & HERNANDO DE MAGALLANES','','LPR','R'],
[-33.43077,-70.56367,'','198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / PTZ','FRANCISCO BILBAO & HERNANDO DE MAGALLANES','','PTZ','R'],
[-33.412869,-70.55242,'','199 TOMAS MORO - IMPERIAL / FIJA 1','TOMAS MORO & IMPERIAL','','FIJA','R'],
[-33.412869,-70.55242,'','199 TOMAS MORO - IMPERIAL / PTZ','TOMAS MORO & IMPERIAL','','PTZ','R'],
[-33.41213,-70.59259,'','200 PRESIDENTE RIESCO - EL GOLF / FIJA 1','PRESIDENTE RIESCO & EL GOLF','','FIJA','R'],
[-33.41213,-70.59259,'','200 PRESIDENTE RIESCO - EL GOLF / FIJA 2','PRESIDENTE RIESCO & EL GOLF','','FIJA','R'],
[-33.41213,-70.59259,'','200 PRESIDENTE RIESCO - EL GOLF / PTZ','PRESIDENTE RIESCO & EL GOLF','','PTZ','R'],
[-33.42463,-70.54632,'','201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 1','ALEJANDRO FLEMING & FUENTE OVEJUNA','','FIJA','R'],
[-33.42463,-70.54632,'','201 ALEJANDRO FLEMING - FUENTE OVEJUNA / FIJA 2','ALEJANDRO FLEMING & FUENTE OVEJUNA','','FIJA','R'],
[-33.42463,-70.54632,'','201 ALEJANDRO FLEMING - FUENTE OVEJUNA / PTZ','ALEJANDRO FLEMING & FUENTE OVEJUNA','','PTZ','R'],
[-33.40167,-70.56071,'','202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 1','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA','','FIJA','R'],
[-33.40167,-70.56071,'','202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / FIJA 2','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA','','FIJA','R'],
[-33.40167,-70.56071,'','202 NUESTRA SEÑORA DEL ROSARIO - PEDRO GAMBOA / PTZ','NUESTRA SEÑORA DEL ROSARIO & PEDRO DE GAMBOA','','PTZ','R'],
[-33.41701,-70.60193,'','203 ENCOMENDEROS - ROGER DE FLOR / FIJA 1','ENCOMENDEROS & ROGER DE FLOR','','FIJA','R'],
[-33.41701,-70.60193,'','203 ENCOMENDEROS - ROGER DE FLOR / LPR 1','ENCOMENDEROS & ROGER DE FLOR','','LPR','R'],
[-33.41701,-70.60193,'','203 ENCOMENDEROS - ROGER DE FLOR / PTZ','ENCOMENDEROS & ROGER DE FLOR','','PTZ','R'],
[-33.417615,-70.568104,'','204 CRISTOBAL COLON - DOMINGO BONDI / FIJA 1','CRISTÓBAL COLÓN & DOMINGO BONDI','','FIJA','R'],
[-33.417615,-70.568104,'','204 CRISTOBAL COLON - DOMINGO BONDI / PTZ','CRISTÓBAL COLÓN & DOMINGO BONDI','','PTZ','R'],
[-33.40556,-70.57913,'','205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 1','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA','','FIJA','R'],
[-33.40556,-70.57913,'','205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 2','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA','','FIJA','R'],
[-33.40556,-70.57913,'','205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 3','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA','','FIJA','R'],
[-33.40556,-70.57913,'','205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / PTZ','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA','','PTZ','R'],
[-33.41108,-70.5622,'','206 IV CENTENARIO - VIRGILIO FIGUEROA / FIJA 1','IV CENTENARIO & VIRGILIO FIGUEROA','','FIJA','R'],
[-33.41108,-70.5622,'','206 IV CENTENARIO - VIRGILIO FIGUEROA / PTZ','IV CENTENARIO & VIRGILIO FIGUEROA','','PTZ','R'],
[-33.417507,-70.54716,'','207 CRISTOBAL COLON - IMPERIAL / FIJA 1','CRISTÓBAL COLÓN & IMPERIAL','','FIJA','R'],
[-33.417507,-70.54716,'','207 CRISTOBAL COLON - IMPERIAL / FIJA 2','CRISTÓBAL COLÓN & IMPERIAL','','FIJA','R'],
[-33.417507,-70.54716,'','207 CRISTOBAL COLON - IMPERIAL / PTZ','CRISTÓBAL COLÓN & IMPERIAL','','PTZ','R'],
[-33.417972,-70.555661,'','208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 1','ROBINSON CRUSOE & CRISTÓBAL CÓLON','','FIJA','R'],
[-33.417972,-70.555661,'','208 ROBINSON CRUSOE - CRISTOBAL COLON / FIJA 2','ROBINSON CRUSOE & CRISTÓBAL CÓLON','','FIJA','R'],
[-33.417972,-70.555661,'','208 ROBINSON CRUSOE - CRISTOBAL COLON / PTZ','ROBINSON CRUSOE & CRISTÓBAL CÓLON','','PTZ','R'],
[-33.41645,-70.52947,'','209 VITAL APOQUINDO - LA QUEBRADA / FIJA 1','VITAL APOQUINDO & LA QUEBRADA','','FIJA','R'],
[-33.41645,-70.52947,'','209 VITAL APOQUINDO - LA QUEBRADA / FIJA 2','VITAL APOQUINDO & LA QUEBRADA','','FIJA','R'],
[-33.41645,-70.52947,'','209 VITAL APOQUINDO - LA QUEBRADA / PTZ','VITAL APOQUINDO & LA QUEBRADA','','PTZ','R'],
[-33.412219,-70.536938,'','210 LOMA LARGA - RIO GUADIANA / FIJA 1','LOMA LARGA & RIO GUADIANA','','FIJA','R'],
[-33.412219,-70.536938,'','210 LOMA LARGA - RIO GUADIANA / PTZ','LOMA LARGA & RIO GUADIANA','','PTZ','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 1','FRANCISCO BILBAO & IV CENTENARIO','','FIJA','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 2','FRANCISCO BILBAO & IV CENTENARIO','','FIJA','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / LPR 1','Francisco Bilbao & IV Centenario','','LPR','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / LPR 2','Francisco Bilbao & IV Centenario','','LPR','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / LPR 3','Francisco Bilbao & IV Centenario','','LPR','R'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / PTZ','FRANCISCO BILBAO & IV CENTENARIO','','PTZ','R'],
[-33.417123,-70.560436,'','212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 1','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES','','FIJA','R'],
[-33.417123,-70.560436,'','212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 2','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES','','FIJA','R'],
[-33.417123,-70.560436,'','212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / FIJA 3','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES','','FIJA','R'],
[-33.417123,-70.560436,'','212 CRISTOBAL COLON - HERNANDO DE MAGALLANES / PTZ','CRISTÓBAL COLÓN & HERNANDO DE MAGALLANES','','PTZ','R'],
[-33.416619,-70.541325,'','213 TALAVERA DE LA REINA - CRISTOBAL COLON / FIJA 1','TALAVERA DE LA REINA & CRISTOBAL COLON','','FIJA','R'],
[-33.416619,-70.541325,'','213 TALAVERA DE LA REINA - CRISTOBAL COLON / PTZ','TALAVERA DE LA REINA & CRISTOBAL COLON','','PTZ','R'],
[-33.42496,-70.585738,'','214 CRISTOBAL COLON - ALCANTARA / FIJA 1','CRISTÓBAL COLÓN & ALCÁNTARA','','FIJA','R'],
[-33.42496,-70.585738,'','214 CRISTOBAL COLON - ALCANTARA / PTZ','CRISTÓBAL COLÓN & ALCÁNTARA','','PTZ','R'],
[-33.402362,-70.533829,'','215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 1','CAMINO DEL ALGARROBO & CAMINO EL ALBA','','FIJA','R'],
[-33.402362,-70.533829,'','215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 2','CAMINO DEL ALGARROBO & CAMINO EL ALBA','','FIJA','R'],
[-33.402362,-70.533829,'','215 CAMINO EL ALGARROBO - CAMINO EL ALBA / FIJA 3','CAMINO DEL ALGARROBO & CAMINO EL ALBA','','FIJA','R'],
[-33.402362,-70.533829,'','215 CAMINO EL ALGARROBO - CAMINO EL ALBA / PTZ','CAMINO DEL ALGARROBO & CAMINO EL ALBA','','PTZ','R'],
[-33.41417,-70.538279,'','216 CERRO ALTAR - NEVADO DE PIUQUENES / FIJA 1','NEVADA DE PIUQUENES & CERRO ALTAR','','FIJA','R'],
[-33.41417,-70.538279,'','216 CERRO ALTAR - NEVADO DE PIUQUENES / PTZ','NEVADA DE PIUQUENES & CERRO ALTAR','','PTZ','R'],
[-33.415809,-70.536966,'','217 DIAGUITAS - CERRO NEGRO / FIJA 1','DIAGUITAS & CERRO NEGRO','','FIJA','R'],
[-33.415809,-70.536966,'','217 DIAGUITAS - CERRO NEGRO / PTZ','DIAGUITAS & CERRO NEGRO','','PTZ','R'],
[-33.425745,-70.53518,'','218 VIA LACTEA - BELATRIX / FIJA 1','VÍA LACTEA & BELATRIX','','FIJA','R'],
[-33.425745,-70.53518,'','218 VIA LACTEA - BELATRIX / PTZ','VÍA LACTEA & BELATRIX','','PTZ','R'],
[-33.423915,-70.531771,'','219 ALEXANDER FLEMING - SANTA ZITA / FIJA 1','ALEXANDER FLEMING & SANTA ZITA','','FIJA','R'],
[-33.423915,-70.531771,'','219 ALEXANDER FLEMING - SANTA ZITA / FIJA 2','ALEXANDER FLEMING & SANTA ZITA','','FIJA','R'],
[-33.423915,-70.531771,'','219 ALEXANDER FLEMING - SANTA ZITA / PTZ','ALEXANDER FLEMING & SANTA ZITA','','PTZ','R'],
[-33.424857,-70.531199,'','220 LUCARO - LUCERO / FIJA 1','LUCARO & LUCERO','','FIJA','R'],
[-33.424857,-70.531199,'','220 LUCARO - LUCERO / FIJA 2','LUCARO & LUCERO','','FIJA','R'],
[-33.424857,-70.531199,'','220 LUCARO - LUCERO / PTZ','LUCARO & LUCERO','','PTZ','R'],
[-33.419672,-70.532299,'','221 OLGA - PAUL HARRIS / FIJA 1','OLGA & PAUL HARRIS','','FIJA','R'],
[-33.419672,-70.532299,'','221 OLGA - PAUL HARRIS / FIJA 2','OLGA & PAUL HARRIS','','FIJA','R'],
[-33.419672,-70.532299,'','221 OLGA - PAUL HARRIS / PTZ','OLGA & PAUL HARRIS','','PTZ','R'],
[-33.419146,-70.535518,'','222 LOS VILOS - SOCOMPA / FIJA 1','LOS VILOS & SOCOMPA','','FIJA','R'],
[-33.419146,-70.535518,'','222 LOS VILOS - SOCOMPA / FIJA 2','LOS VILOS & SOCOMPA','','FIJA','R'],
[-33.419146,-70.535518,'','222 LOS VILOS - SOCOMPA / PTZ','LOS VILOS & SOCOMPA','','PTZ','R'],
[-33.41455,-70.596326,'','223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 1','LA PASTORA & ISIDORA GOYENECHEA','','FIJA','R'],
[-33.41455,-70.596326,'','223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 2','LA PASTORA & ISIDORA GOYENECHEA','','FIJA','R'],
[-33.41455,-70.596326,'','223 LA PASTORA - ISIDORA GOYENECHEA / PTZ','LA PASTORA & ISIDORA GOYENECHEA','','PTZ','R'],
[-33.414125,-70.600074,'','224 ISIDORA GOYENECHEA - SAN SEBASTIAN / FIJA 1','ISIDORA GOYENECHEA & SAN SEBASTIAN','','FIJA','R'],
[-33.414125,-70.600074,'','224 ISIDORA GOYENECHEA - SAN SEBASTIAN / PTZ','ISIDORA GOYENECHEA & SAN SEBASTIAN','','PTZ','R'],
[-33.413898,-70.602403,'','225 ISIDORA GOYENECHEA - LUZ / FIJA 1','ISIDORA GOYENECHEA & LUZ','','FIJA','R'],
[-33.413898,-70.602403,'','225 ISIDORA GOYENECHEA - LUZ / FIJA 2','ISIDORA GOYENECHEA & LUZ','','FIJA','R'],
[-33.413898,-70.602403,'','225 ISIDORA GOYENECHEA - LUZ / PTZ','ISIDORA GOYENECHEA & LUZ','','PTZ','R'],
[-33.416739,-70.600311,'','226 ROGER DE FLOR - EL BOSQUE / FIJA 1','ROGER DE FLOR & EL BOSQUE NORTE','','FIJA','R'],
[-33.416739,-70.600311,'','226 ROGER DE FLOR - EL BOSQUE / PTZ','ROGER DE FLOR & EL BOSQUE NORTE','','PTZ','R'],
[-33.414185,-70.593525,'','227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 1','ISIDORA GOYENECHEA & MAGDALENA','','FIJA','R'],
[-33.414185,-70.593525,'','227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 2','ISIDORA GOYENECHEA & MAGDALENA','','FIJA','R'],
[-33.414185,-70.593525,'','227 ISIDORA GOYENECHEA - MAGDALENA / PTZ','ISIDORA GOYENECHEA & MAGDALENA','','PTZ','R'],
[-33.411494,-70.603307,'','228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 1','ANDRES BELLO & PRESIDENTE RIESCO','','FIJA','R'],
[-33.411494,-70.603307,'','228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 2','ANDRES BELLO & PRESIDENTE RIESCO','','FIJA','R'],
[-33.411494,-70.603307,'','228 ANDRES BELLO - PRESIDENTE RIESCO / PTZ','ANDRES BELLO & PRESIDENTE RIESCO','','PTZ','R'],
[-33.41221,-70.599665,'','229 PRESIDENTE RIESCO - SAN SEBASTIAN / FIJA 1','PRESIDENTE RIESCO & SAN SEBASTIAN','','FIJA','R'],
[-33.41221,-70.599665,'','229 PRESIDENTE RIESCO - SAN SEBASTIAN / PTZ','PRESIDENTE RIESCO & SAN SEBASTIAN','','PTZ','R'],
[-33.37846,-70.501625,'','230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / LPR','Charles Hamilton & San José de la Sierra','','LPR','R'],
[-33.37846,-70.501625,'','230 CHARLES HAMILTON - SAN JOSE DE LA SIERRA / PTZ','CHARLES HAMILTON & SAN JOSÉ DE LA SIERRA','','PTZ','R'],
[-33.413703,-70.577755,'','231 NEVERIA - PUERTA DEL SOL / PTZ','NEVERIA & PUERTA DEL SOL','','PTZ','R'],
[-33.415153,-70.566841,'','232 LA CAPITANIA - MARTIN DE ZAMORA / FIJA 1','LA CAPITANIA & MARTIN DE ZAMORA','','FIJA','R'],
[-33.410247,-70.572071,'','233 APOQUINDO - LA CAPITANIA / PTZ','APOQUINDO & LA CAPITANIA','','PTZ','R'],
[-33.410719,-70.574329,'','234 APOQUINDO - JORGE IV / PTZ','APOQUINDO & JORGE IV','','PTZ','R'],
[-33.420651,-70.533969,'','235 ESTADIO PATRICIA / FIJA','PATRICIA & PICHIDANGUI','','FIJA','R'],
[-33.420651,-70.533969,'','235 ESTADIO PATRICIA / PTZ','PATRICIA & PICHIDANGUI','','PTZ','R'],
[-33.420651,-70.533969,'','235 ESTADIO PATRICIA / SOS','Patricia & Pichidangui','','VIDEOPORTERO','R'],
[-33.418215,-70.588849,'','236 RENATO SANCHEZ - ALCANTARA / PTZ','RENATO SANCHEZ & ALCANTARA','','PTZ','R'],
[-33.417728,-70.585905,'','237 RENATO SANCHEZ - MALAGA / PTZ','RENATO SANCHEZ & MALAGA','','PTZ','R'],
[-33.418966,-70.584098,'','238 PRESIDENTE ERRAZURIZ - ASTURIAS / PTZ','PRESIDENTE ERRAZURIZ & ASTURIAS','','PTZ','R'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / FIJA 1','ISABEL LA CATÓLICA 4601','','FIJA','R'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / FIJA 2','ISABEL LA CATÓLICA 4601','','FIJA','R'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / LPR 1','ISABEL LA CATÓLICA 4601','','LPR','R'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / LPR 2','ISABEL LA CATÓLICA 4601','','LPR','R'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / PTZ','ISABEL LA CATÓLICA 4601','','PTZ','R'],
[-33.422519,-70.583931,'','240 MARTÍN DE ZAMORA - MALAGA / PTZ','MARTÍN DE ZAMORA & MALAGA','','PTZ','R'],
[-33.415401,-70.604042,'','241 VITACURA & ZURICH / LPR 1','Vitacura & Zurich','','LPR','R'],
[-33.417549,-70.5992,'','242 APOQUINDO SUR & EL BOSQUE / LPR 1','Apoquindo & El Bosque','','LPR','R'],
[-33.417549,-70.5992,'','242 APOQUINDO SUR & EL BOSQUE / LPR 2','Apoquindo & El Bosque','','LPR','R'],
[-33.417341,-70.599257,'','243 APOQUINDO NORTE & EL BOSQUE / LPR 1','Apoquindo & El Bosque','','LPR','R'],
[-33.417341,-70.599257,'','243 APOQUINDO NORTE & EL BOSQUE / LPR 2','Apoquindo & El Bosque','','LPR','R'],
[-33.430741,-70.570046,'','244 SEBASTIAN ELCANO ORIENTE & BILBAO / FIJA','Sebastián Elcano & Francisco Bilbao','','FIJA','R'],
[-33.430741,-70.570046,'','244 SEBASTIAN ELCANO ORIENTE & BILBAO / LPR','Sebastián Elcano & Francisco Bilbao','','LPR','R'],
[-33.430077,-70.56487,'','245 MANQUEHUE & BILBAO / LPR 1','Manquehue Sur & Francisco Bilbao','','LPR','R'],
[-33.430077,-70.56487,'','245 MANQUEHUE & BILBAO / LPR 2','Manquehue Sur & Francisco Bilbao','','LPR','R'],
[-33.429471,-70.551494,'','246 FLORENCIO BARRIOS & BILBAO / LPR 1','Florencio Barrios & Francisco Bilbao','','LPR','R'],
[-33.429471,-70.551494,'','246 FLORENCIO BARRIOS & BILBAO / LPR 2','Florencio Barrios & Francisco Bilbao','','LPR','R'],
[-33.405192,-70.581774,'','247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 1','Alonso de Córdova 4471','','LPR','R'],
[-33.405192,-70.581774,'','247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 2','Alonso de Córdova 4471','','LPR','R'],
[-33.391187,-70.547628,'','248 PADRE HURTADO & KENNEDY (HNOS CABOT) / FIJA','Padre Hurtado Norte & Pdte. Kennedy Lateral','','FIJA','R'],
[-33.391187,-70.547628,'','248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 1','Padre Hurtado Norte & Pdte. Kennedy Lateral','','LPR','R'],
[-33.391187,-70.547628,'','248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 2','Padre Hurtado Norte & Pdte. Kennedy Lateral','','LPR','R'],
[-33.391187,-70.547628,'','248 PADRE HURTADO & KENNEDY (HNOS CABOT) / LPR 3','Padre Hurtado Norte & Pdte. Kennedy Lateral','','LPR','R'],
[-33.385083,-70.532717,'','249 INGRESO ESTORIL - LAS CONDES / FIJA','Estoril & Av. Las Condes','','FIJA','R'],
[-33.385083,-70.532717,'','249 INGRESO ESTORIL - LAS CONDES / LPR 1','Estoril & Av. Las Condes','','LPR','R'],
[-33.373483,-70.517037,'','250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / FIJA','Nueva las Condes & San Francisco de Asis','','FIJA','R'],
[-33.373483,-70.517037,'','250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / LPR','Nueva las Condes & San Francisco de Asis','','LPR','R'],
[-33.373483,-70.517037,'','250 NUEVA LAS CONDES - SAN FRANCISCO DE ASIS / LPR 2','Nueva las Condes & San Francisco de Asis','','LPR','R'],
[-33.415785,-70.60273,'','251 ZURICH & EBRO / FIJA 1','Zurich & Ebro','','FIJA','R'],
[-33.415785,-70.60273,'','251 ZURICH & EBRO / FIJA 2','Zurich & Ebro','','FIJA','R'],
[-33.415785,-70.60273,'','251 ZURICH & EBRO / PTZ','Zurich & Ebro','','PTZ','R'],
[-33.412694,-70.588724,'','252 HAMLET & LAS TORCAZAS / FIJA 1','Hamlet & Las Torcazas','','FIJA','R'],
[-33.412694,-70.588724,'','252 HAMLET & LAS TORCAZAS / FIJA 2','Hamlet & Las Torcazas','','FIJA','R'],
[-33.412694,-70.588724,'','252 HAMLET & LAS TORCAZAS / PTZ','Hamlet & Las Torcazas','','PTZ','R'],
[-33.41869,-70.590882,'','253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 1','Gertrudis Echeñique & Renato Sánchez','','FIJA','R'],
[-33.41869,-70.590882,'','253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 2','Gertrudis Echeñique & Renato Sánchez','','FIJA','R'],
[-33.41869,-70.590882,'','253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / PTZ','Gertrudis Echeñique & Renato Sánchez','','PTZ','R'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 1','Américo Vespucio Norte & Presidente Kennedy','','FIJA','R'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 2','Américo Vespucio Norte & Presidente Kennedy','','FIJA','R'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 1','Américo Vespucio Norte & Presidente Kennedy','','LPR','R'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / LPR 2','Américo Vespucio Norte & Presidente Kennedy','','LPR','R'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / PTZ','Américo Vespucio Norte & Presidente Kennedy','','PTZ','R'],
[-33.406879,-70.586659,'','255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 1','Américo Vespucio Norte & Cerro Colorado','','FIJA','R'],
[-33.406879,-70.586659,'','255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 2','Américo Vespucio Norte & Cerro Colorado','','FIJA','R'],
[-33.406879,-70.586659,'','255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / PTZ','Américo Vespucio Norte & Cerro Colorado','','PTZ','R'],
[-33.421921,-70.580718,'','256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 1','Américo Vespucio Sur & Martín de Zamora','','FIJA','R'],
[-33.421921,-70.580718,'','256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 2','Américo Vespucio Sur & Martín de Zamora','','FIJA','R'],
[-33.421921,-70.580718,'','256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / PTZ','Américo Vespucio Sur & Martín de Zamora','','PTZ','R'],
[-33.425868,-70.576776,'','257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 1','Américo Vespucio Sur & Isabel La Católica (poniente)','','FIJA','R'],
[-33.425868,-70.576776,'','257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 2','Américo Vespucio Sur & Isabel La Católica (poniente)','','FIJA','R'],
[-33.425868,-70.576776,'','257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / PTZ','Américo Vespucio Sur & Isabel La Católica (poniente)','','PTZ','R'],
[-33.403723,-70.568983,'','258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 1','Manquehue Norte & Cerro El Plomo','','FIJA','R'],
[-33.403723,-70.568983,'','258 MANQUEHUE NORTE & CERRO EL PLOMO / FIJA 2','Manquehue Norte & Cerro El Plomo','','FIJA','R'],
[-33.403723,-70.568983,'','258 MANQUEHUE NORTE & CERRO EL PLOMO / PTZ','Manquehue Norte & Cerro El Plomo','','PTZ','R'],
[-33.4025,-70.566286,'','259 CERRO EL PLOMO & ESTOCOLMO / FIJA 1','Cerro El Plomo & Estocolmo','','FIJA','R'],
[-33.4025,-70.566286,'','259 CERRO EL PLOMO & ESTOCOLMO / FIJA 2','Cerro El Plomo & Estocolmo','','FIJA','R'],
[-33.4025,-70.566286,'','259 CERRO EL PLOMO & ESTOCOLMO / PTZ','Cerro El Plomo & Estocolmo','','PTZ','R'],
[-33.403851,-70.565511,'','260 LOS MILITARES & ESTOCOLMO / FIJA 1','Los Militares & Estocolmo','','FIJA','R'],
[-33.403851,-70.565511,'','260 LOS MILITARES & ESTOCOLMO / FIJA 2','Los Militares & Estocolmo','','FIJA','R'],
[-33.403851,-70.565511,'','260 LOS MILITARES & ESTOCOLMO / PTZ','Los Militares & Estocolmo','','PTZ','R'],
[-33.408602,-70.577331,'','261 LOS MILITARES & LA GLORIA / FIJA 1','Los Militares & La Gloria','','FIJA','R'],
[-33.408602,-70.577331,'','261 LOS MILITARES & LA GLORIA / FIJA 2','Los Militares & La Gloria','','FIJA','R'],
[-33.408602,-70.577331,'','261 LOS MILITARES & LA GLORIA / PTZ','Los Militares & La Gloria','','PTZ','R'],
[-33.407796,-70.56868,'','262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 1','Alonso de Córdova & O\'Connell','','FIJA','R'],
[-33.407796,-70.56868,'','262 ALONSO DE CÓRDOVA & O\'CONNELL / FIJA 2','Alonso de Córdova & O\'Connell','','FIJA','R'],
[-33.407796,-70.56868,'','262 ALONSO DE CÓRDOVA & O\'CONNELL / PTZ','Alonso de Córdova & O\'Connell','','PTZ','R'],
[-33.412174,-70.578476,'','263 APOQUINDO & PUERTA DEL SOL / FIJA 1','Apoquindo & Puerta del Sol','','FIJA','R'],
[-33.412174,-70.578476,'','263 APOQUINDO & PUERTA DEL SOL / FIJA 2','Apoquindo & Puerta del Sol','','FIJA','R'],
[-33.412174,-70.578476,'','263 APOQUINDO & PUERTA DEL SOL / PTZ','Apoquindo & Puerta del Sol','','PTZ','R'],
[-33.410633,-70.573248,'','264 APOQUINDO & LUIS ZEGERS / FIJA 1','Apoquindo & Luis Zegers','','FIJA','R'],
[-33.410633,-70.573248,'','264 APOQUINDO & LUIS ZEGERS / FIJA 2','Apoquindo & Luis Zegers','','FIJA','R'],
[-33.410633,-70.573248,'','264 APOQUINDO & LUIS ZEGERS / PTZ','Apoquindo & Luis Zegers','','PTZ','R'],
[-33.41234,-70.565949,'','265 MANQUEHUE SUR & EL DIRECTOR / FIJA 1','Manquehue Sur & El Director','','FIJA','R'],
[-33.41234,-70.565949,'','265 MANQUEHUE SUR & EL DIRECTOR / FIJA 2','Manquehue Sur & El Director','','FIJA','R'],
[-33.41234,-70.565949,'','265 MANQUEHUE SUR & EL DIRECTOR / PTZ','Manquehue Sur & El Director','','PTZ','R'],
[-33.415274,-70.574224,'','266 ROSA O\'HIGGINS & DEL INCA / FIJA 1','Rosa O\'Higgins & Del Inca','','FIJA','R'],
[-33.415274,-70.574224,'','266 ROSA O\'HIGGINS & DEL INCA / FIJA 2','Rosa O\'Higgins & Del Inca','','FIJA','R'],
[-33.415274,-70.574224,'','266 ROSA O\'HIGGINS & DEL INCA / PTZ','Rosa O\'Higgins & Del Inca','','PTZ','R'],
[-33.407912,-70.563413,'','267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 1','Apoquindo & Esteban Dell\'Orto','','FIJA','R'],
[-33.407912,-70.563413,'','267 APOQUINDO & ESTEBAN DELL\'ORTO / FIJA 2','Apoquindo & Esteban Dell\'Orto','','FIJA','R'],
[-33.407912,-70.563413,'','267 APOQUINDO & ESTEBAN DELL\'ORTO / PTZ','Apoquindo & Esteban Dell\'Orto','','PTZ','R'],
[-33.404426,-70.556827,'','268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 1','Las Condes & General Carol Urzúa','','FIJA','R'],
[-33.404426,-70.556827,'','268 LAS CONDES & GENERAL CAROL URZÚA / FIJA 2','Las Condes & General Carol Urzúa','','FIJA','R'],
[-33.404426,-70.556827,'','268 LAS CONDES & GENERAL CAROL URZÚA / PTZ','Las Condes & General Carol Urzúa','','PTZ','R'],
[-33.386478,-70.538867,'','269 PRESIDENTE KENNEDY 9351 / PTZ','Presidente Kennedy 9351','','PTZ','R'],
[-33.386478,-70.538867,'','269 PRESIDENTE KENNEDY 9352 / FIJA 1','Presidente Kennedy 9352','','FIJA','R'],
[-33.386478,-70.538867,'','269 PRESIDENTE KENNEDY 9353 / FIJA 2','Presidente Kennedy 9353','','FIJA','R'],
[-33.39237,-70.543142,'','270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 1','Las Condes & Gilberto Fuenzalida','','FIJA','R'],
[-33.39237,-70.543142,'','270 LAS CONDES & GILBERTO FUENZALIDA / FIJA 2','Las Condes & Gilberto Fuenzalida','','FIJA','R'],
[-33.39237,-70.543142,'','270 LAS CONDES & GILBERTO FUENZALIDA / PTZ','Las Condes & Gilberto Fuenzalida','','PTZ','R'],
[-33.408208,-70.547839,'','271 APOQUINDO & TALAVERA DE LA REINA / FIJA 1','Apoquindo & Talavera de La Reina','','FIJA','R'],
[-33.408208,-70.547839,'','271 APOQUINDO & TALAVERA DE LA REINA / FIJA 2','Apoquindo & Talavera de La Reina','','FIJA','R'],
[-33.408208,-70.547839,'','271 APOQUINDO & TALAVERA DE LA REINA / PTZ','Apoquindo & Talavera de La Reina','','PTZ','R'],
[-33.409355,-70.543813,'','272 LOS DOMÍNICOS & PATAGONIA / FIJA 1','Los Domínicos & Patagonia','','FIJA','R'],
[-33.409355,-70.543813,'','272 LOS DOMÍNICOS & PATAGONIA / FIJA 2','Los Domínicos & Patagonia','','FIJA','R'],
[-33.409355,-70.543813,'','272 LOS DOMÍNICOS & PATAGONIA / PTZ','Los Domínicos & Patagonia','','PTZ','R'],
[-33.412691,-70.547483,'','273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 1','Los Domínicos & Santa Magdalena Sofía','','FIJA','R'],
[-33.412691,-70.547483,'','273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / FIJA 2','Los Domínicos & Santa Magdalena Sofía','','FIJA','R'],
[-33.412691,-70.547483,'','273 LOS DOMÍNICOS & SANTA MAGDALENA SOFÍA / PTZ','Los Domínicos & Santa Magdalena Sofía','','PTZ','R'],
[-33.411312,-70.538768,'','274 DIAGUITAS & CERRO MESON ALTO','Diaguitas & Cerro Meson Alto','','FIJA','R'],
[-33.411312,-70.538768,'','274 DIAGUITAS & CERRO MESON ALTO / FIJA 2','Diaguitas & Cerro Meson Alto','','FIJA','R'],
[-33.411312,-70.538768,'','274 DIAGUITAS & CERRO MESON ALTO / PTZ','Diaguitas & Cerro Meson Alto','','PTZ','R'],
[-33.423232,-70.534788,'','275 INCA DE ORO & TOTORALILLO / FIJA 1','Inca de Oro & Totoralillo','','FIJA','R'],
[-33.423232,-70.534788,'','275 INCA DE ORO & TOTORALILLO / FIJA 2','Inca de Oro & Totoralillo','','FIJA','R'],
[-33.423232,-70.534788,'','275 INCA DE ORO & TOTORALILLO / PTZ','Inca de Oro & Totoralillo','','PTZ','R'],
[-33.393515,-70.539256,'','276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 1','Paul Harris Oriente & Abadía','','FIJA','R'],
[-33.393515,-70.539256,'','276 PAUL HARRIS ORIENTE & ABADÍA / FIJA 2','Paul Harris Oriente & Abadía','','FIJA','R'],
[-33.393515,-70.539256,'','276 PAUL HARRIS ORIENTE & ABADÍA / PTZ','Paul Harris Oriente & Abadía','','PTZ','R'],
[-33.386918,-70.512545,'','277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 1','Francisco Bulnes Correa & Los Monjes','','FIJA','R'],
[-33.386918,-70.512545,'','277 FRANCISCO BULNES CORREA & LOS MONJES / FIJA 2','Francisco Bulnes Correa & Los Monjes','','FIJA','R'],
[-33.386918,-70.512545,'','277 FRANCISCO BULNES CORREA & LOS MONJES / PTZ','Francisco Bulnes Correa & Los Monjes','','PTZ','R'],
[-33.392427,-70.496347,'','278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 1','San Francisco de Asís & Genova Oriente','','FIJA','R'],
[-33.392427,-70.496347,'','278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / FIJA 2','San Francisco de Asís & Genova Oriente','','FIJA','R'],
[-33.392427,-70.496347,'','278 SAN FRANCISCO DE ASÍS & GENOVA ORIENTE / PTZ','San Francisco de Asís & Genova Oriente','','PTZ','R'],
[-33.403978,-70.512889,'','279 SAN RAMÓN & DEL PARQUE / FIJA 1','San Ramón & Del Parque','','FIJA','R'],
[-33.403978,-70.512889,'','279 SAN RAMÓN & DEL PARQUE / FIJA 2','San Ramón & Del Parque','','FIJA','R'],
[-33.403978,-70.512889,'','279 SAN RAMÓN & DEL PARQUE / PTZ','San Ramón & Del Parque','','PTZ','R'],
[-33.425846,-70.57029,'','280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 1','Sebastián Elcano & Isabel La Católica','','FIJA','R'],
[-33.425846,-70.57029,'','280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / FIJA 2','Sebastián Elcano & Isabel La Católica','','FIJA','R'],
[-33.425846,-70.57029,'','280 SEBASTIÁN ELCANO & ISABEL LA CATÓLICA / PTZ','Sebastián Elcano & Isabel La Católica','','PTZ','R'],
[-33.409948,-70.563751,'','281 IV CENTENARIO & MARIA TERESA / PTZ','IV Centenario & María Teresa','','PTZ','R'],
[-33.40701,-70.56122,'','282 NUESTRA SEÑORA DEL ROSARIO & AV. LAS CONDES / PTZ','Nuestra Sra del Rosario & Av. Las Condes','','PTZ','R'],
[-33.42721,-70.563569,'','283 NUEVA DELHI & LATADIA / FIJA 1','Nueva Delhi & Latadía','','FIJA','R'],
[-33.42721,-70.563569,'','283 NUEVA DELHI & LATADIA / FIJA 2','Nueva Delhi & Latadía','','FIJA','R'],
[-33.42721,-70.563569,'','283 NUEVA DELHI & LATADIA / PTZ','Nueva Delhi & Latadía','','PTZ','R'],
[-33.410038,-70.538415,'','284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 1','Almirante Soublette & Comodoro Arturo Merino Benitez','','FIJA','R'],
[-33.410038,-70.538415,'','284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / FIJA 2','Almirante Soublette & Comodoro Arturo Merino Benitez','','FIJA','R'],
[-33.410038,-70.538415,'','284 ALMIRANTE SOUBLETTE & COMODORO ARTURO MERINO BENITEZ / PTZ','Almirante Soublette & Comodoro Arturo Merino Benitez','','PTZ','R'],
[-33.414543,-70.536223,'','285 LOMA LARGA & LEON BLANCO / FIJA 1','Loma Larga & Leon Blanco','','FIJA','R'],
[-33.414543,-70.536223,'','285 LOMA LARGA & LEON BLANCO / FIJA 2','Loma Larga & Leon Blanco','','FIJA','R'],
[-33.414543,-70.536223,'','285 LOMA LARGA & LEON BLANCO / FIJA 3','Loma Larga & Leon Blanco','','FIJA','R'],
[-33.414543,-70.536223,'','285 LOMA LARGA & LEON BLANCO / FIJA 4','Loma Larga & Leon Blanco','','FIJA','R'],
[-33.414543,-70.536223,'','285 LOMA LARGA & LEON BLANCO / PTZ','Loma Larga & Leon Blanco','','PTZ','R'],
[-33.413088,-70.538597,'','286 FUEGUINOS & CERRO ALTAR / FIJA 1','Fueguinos & Cerro Altar','','FIJA','R'],
[-33.413088,-70.538597,'','286 FUEGUINOS & CERRO ALTAR / FIJA 2','Fueguinos & Cerro Altar','','FIJA','R'],
[-33.413088,-70.538597,'','286 FUEGUINOS & CERRO ALTAR / PTZ','Fueguinos & Cerro Altar','','PTZ','R'],
[-33.412815,-70.537536,'','287 CERRO NAME & FUEGUINOS / FIJA 1','Fueguinos & Cerro Name','','FIJA','R'],
[-33.412815,-70.537536,'','287 CERRO NAME & FUEGUINOS / FIJA 2','Fueguinos & Cerro Name','','FIJA','R'],
[-33.412815,-70.537536,'','287 CERRO NAME & FUEGUINOS / PTZ','Fueguinos & Cerro Name','','PTZ','R'],
[-33.409081,-70.542328,'','288 PADRE HURTADO & GENERAL BLANCHE / PTZ','Padre Hurtado & General Blanche','','PTZ','R'],
[-33.409081,-70.542328,'','288 PADRE HURTADO & GENERAL BLANCHE / FIJA','Padre Hurtado & General Blanche','','FIJA','R'],
[-33.403132,-70.517221,'','289 FRANCISCO BULNES CORREA - GENERAL BLANCHE / PTZ','FRANCISCO BULNES CORREA & GENERAL BLANCHE','','PTZ','R'],
[-33.39962,-70.510327,'','290 SAN CARLOS DE APOQUINDO - CAMINO EL ALBA / PTZ','SAN CARLOS DE APOQUINDO & CAMINO EL ALBA','','PTZ','R'],
[-33.390545,-70.513418,'','291 CERRO CATEDRAL NORTE & REP DE HONDURAS / PTZ','REPUBLICA DE HONDURAS & CERRO CATEDRAL NORTE','','PTZ','R'],
[-33.423132,-70.586652,'','292 MARTIN DE ZAMORA & ALCANTARA / PTZ','MARTIN DE ZAMORA & ALCANTARA','','PTZ','R'],
[-33.425147,-70.563476,'','293 ISABEL LA CATOLICA - MANQUEHUE ORIENTE / PTZ','Isabel la Católica & Manquehue Oriente','','PTZ','R'],
[-33.430863,-70.574788,'','294 VESPUCIO - BILBAO / FIJA 1','Vespucio Poniente & Bilbao','','FIJA','R'],
[-33.430863,-70.574788,'','294 VESPUCIO - BILBAO / FIJA 2','Vespucio Poniente & Bilbao','','FIJA','R'],
[-33.430863,-70.574788,'','294 VESPUCIO - BILBAO / LPR 1','Vespucio Poniente & Bilbao','','LPR','R'],
[-33.410653,-70.579161,'','295 LOS MILITARES - ORINOCO / FIJA 1','Los Militares & Orinoco','','FIJA','R'],
[-33.410653,-70.579161,'','295 LOS MILITARES - ORINOCO / FIJA 2','Los Militares & Orinoco','','FIJA','R'],
[-33.410653,-70.579161,'','295 LOS MILITARES - ORINOCO / LPR 1','Los Militares & Orinoco','','LPR','R'],
[-33.410653,-70.579161,'','295 LOS MILITARES - ORINOCO / LPR 2','Los Militares & Orinoco','','LPR','R'],
[-33.39919105,-70.53719574,'','296 CERRO CALAN / PTZ ZOOM','Camino el Observatorio 1515','','PTZ','R'],
[-33.41613497,-70.59469294,'','297 EDIFICIO APOQUINDO 3400 / PTZ ZOOM','Apoquindo 3400','','PTZ','R'],
[-33.40005926,-70.5743476,'','298 EDIFICIO MARRIOT / PTZ ZOOM','Presidente Kennedy 5741','','PTZ','R'],
[-33.42954485,-70.54878839,'','299 EDIFICIO BILBAO 8080 / PTZ ZOOM','Francisco Bilbao 8080','','PTZ','R'],
[-33.41827139,-70.55479779,'','300 EDIFICIO COLON 7337 / PTZ ZOOM','Av. Cristóbal Colón 7337','','PTZ','R'],
[-33.4135869,-70.5826024,'','301 EDIFICIO ESCUELA MILITAR / PTZ ZOOM','Evaristo Lillo 29','','PTZ','R'],
[-33.410121,-70.528968,'','302 CERRO MIRADOR / PTZ ZOOM','San Vicente Ferrer 2494','','PTZ','R'],
[-33.418069,-70.553606,'','303 ROTONDA ATENAS - CRISTOBAL COLON','ROTONDA ATENAS & CRISTOBAL COLON','','PTZ','R'],
[-33.407479,-70.558462,'','304 APOQUINDO - CAROL URZUA','APOQUINDO & CAROL URZUA','','PTZ','R'],
[-33.373437,-70.518407,'','305 ESTACIONAMIENTO CANTAGALLO / FIJA 1','Av Las Condes & Nueva Las Condes','','FIJA','R'],
[-33.373437,-70.518407,'','305 ESTACIONAMIENTO CANTAGALLO / FIJA 2','Av Las Condes & Nueva Las Condes','','FIJA','R'],
[-33.42387,-70.53145,'','RI 01 FLEMING - SANTA ZITA / FISHEYE','FLEMING & SANTA ZITA','','FISHEYE','F'],
[-33.42387,-70.53145,'','RI 01 FLEMING - SANTA ZITA / SOS','FLEMING & SANTA ZITA','','VIDEOPORTERO','F'],
[-33.40909,-70.56798,'','RI 02 APOQUINDO - MANQUEHUE / FISHEYE','APOQUINDO & MANQUEHUE','','FISHEYE','F'],
[-33.40909,-70.56798,'','RI 02 APOQUINDO - MANQUEHUE / SOS','APOQUINDO & MANQUEHUE','','VIDEOPORTERO','F'],
[-33.39219,-70.54302,'','RI 03 LAS CONDES - GILBERTO FUENZALIDA / FISHEYE','LAS CONDES & GILBERTO FUENZALIDA','','FISHEYE','F'],
[-33.39219,-70.54302,'','RI 03 LAS CONDES - GILBERTO FUENZALIDA / SOS','LAS CONDES & GILBERTO FUENZALIDA','','VIDEOPORTERO','F'],
[-33.41744,-70.59944,'','RI 04 APOQUINDO - EL BOSQUE / FISHEYE','APOQUINDO & EL BOSQUE','','FISHEYE','F'],
[-33.41744,-70.59944,'','RI 04 APOQUINDO - EL BOSQUE / SOS','APOQUINDO & EL BOSQUE','','VIDEOPORTERO','F'],
[-33.41706,-70.59756,'','RI 05 APOQUINDO - A. LEGUIA SUR / FISHEYE','APOQUINDO & A. LEGUIA SUR','','FISHEYE','F'],
[-33.41706,-70.59756,'','RI 05 APOQUINDO - A. LEGUIA SUR / SOS','APOQUINDO & A. LEGUIA SUR','','VIDEOPORTERO','F'],
[-33.41669,-70.59656,'','RI 06 APOQUINDO - A. LEGUIA NORTE / FISHEYE','APOQUINDO & A. LEGUIA NORTE','','FISHEYE','F'],
[-33.41669,-70.59656,'','RI 06 APOQUINDO - A. LEGUIA NORTE / SOS','APOQUINDO & A. LEGUIA NORTE','','VIDEOPORTERO','F'],
[-33.41644,-70.59431,'','RI 07 APOQUINDO - E. FOSTER / FISHEYE','APOQUINDO & E. FOSTER','','FISHEYE','F'],
[-33.41644,-70.59431,'','RI 07 APOQUINDO - E. FOSTER / SOS','APOQUINDO & E. FOSTER','','VIDEOPORTERO','F'],
[-33.41505,-70.58725,'','RI 08 APOQUINDO - MALAGA / FISHEYE','APOQUINDO & MALAGA','','FISHEYE','F'],
[-33.41505,-70.58725,'','RI 08 APOQUINDO - MALAGA / SOS','APOQUINDO & MALAGA','','VIDEOPORTERO','F'],
[-33.41469,-70.58669,'','RI 09 APOQUINDO - GOLDA MEIR / FISHEYE','APOQUINDO & GOLDA MEIR','','FISHEYE','F'],
[-33.41469,-70.58669,'','RI 09 APOQUINDO - GOLDA MEIR / SOS','APOQUINDO & GOLDA MEIR','','VIDEOPORTERO','F'],
[-33.41319,-70.58156,'','RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / FISHEYE','APOQUINDO & ESCUELA MILITAR','','FISHEYE','F'],
[-33.41319,-70.58156,'','RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / SOS','APOQUINDO & ESCUELA MILITAR','','VIDEOPORTERO','F'],
[-33.41352,-70.58422,'','RI 11 LOS MILITARES - BARCELO / FISHEYE','LOS MILITARES & BARCELO','','FISHEYE','F'],
[-33.41352,-70.58422,'','RI 11 LOS MILITARES - BARCELO / SOS','LOS MILITARES & BARCELO','','VIDEOPORTERO','F'],
[-33.41184,-70.57819,'','RI 12 APOQUINDO - ORINOCO / FISHEYE','APOQUINDO & ORINOCO','','FISHEYE','F'],
[-33.41184,-70.57819,'','RI 12 APOQUINDO - ORINOCO / SOS','APOQUINDO & ORINOCO','','VIDEOPORTERO','F'],
[-33.40994,-70.57169,'','RI 13 APOQUINDO - BADAJOZ / FISHEYE','APOQUINDO & BADAJOZ','','FISHEYE','F'],
[-33.40994,-70.57169,'','RI 13 APOQUINDO - BADAJOZ / SOS','APOQUINDO & BADAJOZ','','VIDEOPORTERO','F'],
[-33.41395,-70.58566,'','RI 14 LOS MILITARES - VESPUCIO / FISHEYE','LOS MILITARES & VESPUCIO','','FISHEYE','F'],
[-33.41395,-70.58566,'','RI 14 LOS MILITARES - VESPUCIO / SOS','LOS MILITARES & VESPUCIO','','VIDEOPORTERO','F'],
[-33.4013,-70.57867,'','RI 15 L.KENNEDY - P.ARAUCO / FISHEYE','Av. Pdte. Kennedy Lateral & Parque Araucano','','FISHEYE','F'],
[-33.4013,-70.57867,'','RI 15 L.KENNEDY - P.ARAUCO / SOS','KENNEDY LATERAL & PARQUE ARAUCANO','','VIDEOPORTERO','F'],
[-33.40319,-70.57781,'','RI 16 CERRO COLORADO - A. DE CORDOVA / FISHEYE','CERRO COLORADO & A. DE CORDOVA','','FISHEYE','F'],
[-33.40319,-70.57781,'','RI 16 CERRO COLORADO - A. DE CORDOVA / SOS','CERRO COLORADO & A. DE CORDOVA','','VIDEOPORTERO','F'],
[-33.40144,-70.57006,'','RI 17 MANQUEHUE - C. COLORADO / FISHEYE','MANQUEHUE & C. COLORADO','','FISHEYE','F'],
[-33.40144,-70.57006,'','RI 17 MANQUEHUE - C. COLORADO / SOS','MANQUEHUE & C. COLORADO','','VIDEOPORTERO','F'],
[-33.40544,-70.56844,'','RI 18 MANQUEHUE - LOS MILITARES / FISHEYE','MANQUEHUE & LOS MILITARES','','FISHEYE','F'],
[-33.40544,-70.56844,'','RI 18 MANQUEHUE - LOS MILITARES / SOS','MANQUEHUE & LOS MILITARES','','VIDEOPORTERO','F'],
[-33.40106,-70.55469,'','RI 19 LAS CONDES - LAS TRANQUERAS / FISHEYE','LAS CONDES & LAS TRANQUERAS','','FISHEYE','F'],
[-33.40106,-70.55469,'','RI 19 LAS CONDES - LAS TRANQUERAS / SOS','LAS CONDES & LAS TRANQUERAS','','VIDEOPORTERO','F'],
[-33.39856,-70.55152,'','RI 20 LAS CONDES - BOCACCIO / FISHEYE','LAS CONDES & BOCACCIO','','FISHEYE','F'],
[-33.39856,-70.55152,'','RI 20 LAS CONDES - BOCACCIO / SOS','LAS CONDES & BOCACCIO','','VIDEOPORTERO','F'],
[-33.39556,-70.54866,'','RI 21 LAS CONDES - HOSPITAL FACH / FISHEYE','LAS CONDES & HOSPITAL FACH','','FISHEYE','F'],
[-33.39556,-70.54866,'','RI 21 LAS CONDES - HOSPITAL FACH / SOS','LAS CONDES & HOSPITAL FACH','','VIDEOPORTERO','F'],
[-33.39381,-70.54519,'','RI 22 LAS CONDES - P. HURTADO CENTRAL / FISHEYE','LAS CONDES & P. HURTADO CENTRAL','','FISHEYE','F'],
[-33.39381,-70.54519,'','RI 22 LAS CONDES - P. HURTADO CENTRAL / SOS','LAS CONDES & P. HURTADO CENTRAL','','VIDEOPORTERO','F'],
[-33.39035,-70.54143,'','RI 23 LAS CONDES - CHARLES HAMILTON / FISHEYE','LAS CONDES & CHARLES HAMILTON','','FISHEYE','F'],
[-33.39035,-70.54143,'','RI 23 LAS CONDES - CHARLES HAMILTON / SOS','LAS CONDES & CHARLES HAMILTON','','VIDEOPORTERO','F'],
[-33.384562,-70.534568,'','RI 24 LAS CONDES - RIO MAULE / FISHEYE','LAS CONDES & RIO MAULE','','FISHEYE','F'],
[-33.384562,-70.534568,'','RI 24 LAS CONDES - RIO MAULE / SOS','LAS CONDES & RIO MAULE','','VIDEOPORTERO','F'],
[-33.39631,-70.50381,'','RI 25 LAS FLORES - LA PLAZA / FISHEYE','LAS FLORES & LA PLAZA','','FISHEYE','F'],
[-33.39631,-70.50381,'','RI 25 LAS FLORES - LA PLAZA / SOS','LAS FLORES & LA PLAZA','','VIDEOPORTERO','F'],
[-33.400855,-70.506563,'','RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / FISHEYE','AV. LA PLAZA & M. ALVARO DE PORTILLO','','FISHEYE','F'],
[-33.400855,-70.506563,'','RI 26 AV. LA PLAZA - M. ALVARO DE PORTILLO / SOS','AV. LA PLAZA & M. ALVARO DE PORTILLO','','VIDEOPORTERO','F'],
[-33.40056,-70.51344,'','RI 27 CAMINO EL ALBA - SAN RAMON / FISHEYE','CAMINO EL ALBA & SAN RAMON','','FISHEYE','F'],
[-33.40056,-70.51344,'','RI 27 CAMINO EL ALBA - SAN RAMON / SOS','CAMINO EL ALBA & SAN RAMON','','VIDEOPORTERO','F'],
[-33.40673,-70.54434,'','RI 28 CAMINO EL ALBA - LOS DOMINICOS / FISHEYE','CAMINO EL ALBA & LOS DOMINICOS','','FISHEYE','F'],
[-33.40673,-70.54434,'','RI 28 CAMINO EL ALBA - LOS DOMINICOS / SOS','CAMINO EL ALBA & LOS DOMINICOS','','VIDEOPORTERO','F'],
[-33.40821,-70.54503,'','RI 29 PATAGONIA - P. LOS DOMINICOS / FISHEYE','PATAGONIA & P. LOS DOMINICOS','','FISHEYE','F'],
[-33.40821,-70.54503,'','RI 29 PATAGONIA - P. LOS DOMINICOS / SOS','PATAGONIA & P. LOS DOMINICOS','','VIDEOPORTERO','F'],
[-33.40868,-70.54511,'','RI 30 PATAGONIA - S. CIUDADANA / FISHEYE','PATAGONIA & S. CIUDADANA','','FISHEYE','F'],
[-33.40868,-70.54511,'','RI 30 PATAGONIA - S. CIUDADANA / SOS','PATAGONIA & S. CIUDADANA','','VIDEOPORTERO','F'],
[-33.40794,-70.54619,'','RI 31 APOQUINDO - PARANA / FISHEYE','APOQUINDO & PARANA','','FISHEYE','F'],
[-33.40794,-70.54619,'','RI 31 APOQUINDO - PARANA / SOS','APOQUINDO & PARANA','','VIDEOPORTERO','F'],
[-33.4085,-70.55232,'','RI 32 APOQUINDO - TOMAS MORO / FISHEYE','APOQUINDO & TOMAS MORO','','FISHEYE','F'],
[-33.4085,-70.55232,'','RI 32 APOQUINDO - TOMAS MORO / SOS','APOQUINDO & TOMAS MORO','','VIDEOPORTERO','F'],
[-33.40969,-70.54194,'','RI 33 PADRE HURTADO - PATAGONIA / FISHEYE','PADRE HURTADO & PATAGONIA','','FISHEYE','F'],
[-33.40969,-70.54194,'','RI 33 PADRE HURTADO - PATAGONIA / SOS','PADRE HURTADO & PATAGONIA','','VIDEOPORTERO','F'],
[-33.41331,-70.54031,'','RI 34 PADRE HURTADO - RIO GUADIANA / FISHEYE','PADRE HURTADO & RIO GUADIANA','','FISHEYE','F'],
[-33.41331,-70.54031,'','RI 34 PADRE HURTADO - RIO GUADIANA / SOS','PADRE HURTADO & RIO GUADIANA','','VIDEOPORTERO','F'],
[-33.41606,-70.53369,'','RI 35 PAUL HARRIS - LA QUEBRADA / FISHEYE','PAUL HARRIS & LA QUEBRADA','','FISHEYE','F'],
[-33.41606,-70.53369,'','RI 35 PAUL HARRIS - LA QUEBRADA / SOS','PAUL HARRIS & LA QUEBRADA','','VIDEOPORTERO','F'],
[-33.41669,-70.53244,'','RI 36 AV. LA ESCUELA - LA QUEBRADA / FISHEYE','AV. LA ESCUELA & LA QUEBRADA','','FISHEYE','F'],
[-33.41669,-70.53244,'','RI 36 AV. LA ESCUELA - LA QUEBRADA / SOS','AV. LA ESCUELA & LA QUEBRADA','','VIDEOPORTERO','F'],
[-33.42094,-70.53769,'','RI 37 PADRE HURTADO - PATRICIA / FISHEYE','PADRE HURTADO & PATRICIA','','FISHEYE','F'],
[-33.42094,-70.53769,'','RI 37 PADRE HURTADO - PATRICIA / SOS','PADRE HURTADO & PATRICIA','','VIDEOPORTERO','F'],
[-33.42869,-70.54069,'','RI 38 BILBAO - PORTAL LA REINA / FISHEYE','BILBAO & PORTAL LA REINA','','FISHEYE','F'],
[-33.42869,-70.54069,'','RI 38 BILBAO - PORTAL LA REINA / SOS','BILBAO & PORTAL LA REINA','','VIDEOPORTERO','F'],
[-33.42456,-70.54594,'','RI 39 FLEMING - IV CENTENARIO / FISHEYE','FLEMING & IV CENTENARIO','','FISHEYE','F'],
[-33.42456,-70.54594,'','RI 39 FLEMING - IV CENTENARIO / SOS','FLEMING & IV CENTENARIO','','VIDEOPORTERO','F'],
[-33.42494,-70.54944,'','RI 40 FLEMING - FRENTE CLINICA CORDILLERA / FISHEYE','FLEMING & FRENTE CLINICA CORDILLERA','','FISHEYE','F'],
[-33.42494,-70.54944,'','RI 40 FLEMING - FRENTE CLINICA CORDILLERA / SOS','FLEMING & FRENTE CLINICA CORDILLERA','','VIDEOPORTERO','F'],
[-33.42507,-70.55003,'','RI 41 FLEMING - CLINICA CORDILLERA / FISHEYE','FLEMING & CLINICA CORDILLERA','','FISHEYE','F'],
[-33.42507,-70.55003,'','RI 41 FLEMING - CLINICA CORDILLERA / SOS','FLEMING & CLINICA CORDILLERA','','VIDEOPORTERO','F'],
[-33.42573,-70.55403,'','RI 42 TOMAS MORO - FLEMING / FISHEYE','TOMAS MORO & FLEMING','','FISHEYE','F'],
[-33.42573,-70.55403,'','RI 42 TOMAS MORO - FLEMING / SOS','TOMAS MORO & FLEMING','','VIDEOPORTERO','F'],
[-33.4253,-70.55343,'','RI 43 FLEMING - TOMAS MORO / FISHEYE','FLEMING & TOMAS MORO','','FISHEYE','F'],
[-33.4253,-70.55343,'','RI 43 FLEMING - TOMAS MORO / SOS','FLEMING & TOMAS MORO','','VIDEOPORTERO','F'],
[-33.42244,-70.55344,'','RI 44 TOMAS MORO - ALONSO DE CAMARGO / FISHEYE','TOMAS MORO & ALONSO DE CAMARGO','','FISHEYE','F'],
[-33.42244,-70.55344,'','RI 44 TOMAS MORO - ALONSO DE CAMARGO / SOS','TOMAS MORO & ALONSO DE CAMARGO','','VIDEOPORTERO','F'],
[-33.41744,-70.55781,'','RI 45 COLON - PIACENZA / FISHEYE','COLON & PIACENZA','','FISHEYE','F'],
[-33.41744,-70.55781,'','RI 45 COLON - PIACENZA / SOS','COLON & PIACENZA','','VIDEOPORTERO','F'],
[-33.41706,-70.56006,'','RI 46 COLON - H. DE MAGALLANES / FISHEYE','COLON & H. DE MAGALLANES','','FISHEYE','F'],
[-33.41706,-70.56006,'','RI 46 COLON - H. DE MAGALLANES / SOS','COLON & H. DE MAGALLANES','','VIDEOPORTERO','F'],
[-33.41644,-70.56444,'','RI 47 COLON - MANQUEHUE / FISHEYE','COLON & MANQUEHUE','','FISHEYE','F'],
[-33.41644,-70.56444,'','RI 47 COLON - MANQUEHUE / SOS','COLON & MANQUEHUE','','VIDEOPORTERO','F'],
[-33.41857,-70.57161,'','RI 48 COLON - SEBASTIAN ELCANO / FISHEYE','COLON & SEBASTIAN ELCANO','','FISHEYE','F'],
[-33.41857,-70.57161,'','RI 48 COLON - SEBASTIAN ELCANO / SOS','COLON & SEBASTIAN ELCANO','','VIDEOPORTERO','F'],
[-33.423374,-70.578832,'','RI 49 COLON - VESPUCIO / FISHEYE','COLON & VESPUCIO','','FISHEYE','F'],
[-33.423374,-70.578832,'','RI 49 COLON - VESPUCIO / SOS','COLON & VESPUCIO','','VIDEOPORTERO','F'],
[-33.423632,-70.578703,'','RI 50 VESPUCIO SUR - COLON / FISHEYE','VESPUCIO SUR & COLON','','FISHEYE','F'],
[-33.423632,-70.578703,'','RI 50 VESPUCIO SUR - COLON / SOS','VESPUCIO SUR & COLON','','VIDEOPORTERO','F'],
[-33.415865,-70.534202,'','RI 51 PAUL HARRIS - COLON / FISHEYE','PAUL HARRIS & COLON','','FISHEYE','F'],
[-33.415865,-70.534202,'','RI 51 PAUL HARRIS - COLON / SOS','PAUL HARRIS & COLON','','VIDEOPORTERO','F'],
[-33.430241,-70.553874,'','RI 52 BILBAO / TOMAS MORO / FISHEYE','BILBAO & TOMAS MORO','','FISHEYE','F'],
[-33.430241,-70.553874,'','RI 52 BILBAO / TOMAS MORO / SOS','BILBAO & TOMAS MORO','','VIDEOPORTERO','F'],
[-33.394949,-70.561739,'','RI 53 KENNEDY / GERONIMO ALDERETE / FISHEYE','KENNEDY & GERONIMO ALDERETE','','FISHEYE','F'],
[-33.394949,-70.561739,'','RI 53 KENNEDY / GERONIMO ALDERETE / SOS','KENNEDY & GERONIMO ALDERETE','','VIDEOPORTERO','F'],
[-33.392126,-70.553605,'','RI 54 KENNEDY / LAS TRANQUERAS / FISHEYE','KENNEDY & LAS TRANQUERAS','','FISHEYE','F'],
[-33.392126,-70.553605,'','RI 54 KENNEDY / LAS TRANQUERAS / SOS','KENNEDY & LAS TRANQUERAS','','VIDEOPORTERO','F'],
[-33.372996,-70.518065,'','RI 55 LAS CONDES / CANTAGALLO / FISHEYE','LAS CONDES & CANTAGALLO','','FISHEYE','F'],
[-33.372996,-70.518065,'','RI 55 LAS CONDES / CANTAGALLO / SOS','LAS CONDES & CANTAGALLO','','VIDEOPORTERO','F'],
[-33.373458,-70.517101,'','RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / FISHEYE','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS','','FISHEYE','F'],
[-33.373458,-70.517101,'','RI 56 NUEVA LAS CONDES / SAN FRANCISCO DE ASIS / SOS','NUEVA LAS CONDES & SAN FRANCISCO DE ASIS','','VIDEOPORTERO','F'],
[-33.431031,-70.569571,'','RI 57 BILBAO / SEBASTIAN EL CANO / FISHEYE','BILBAO & SEBASTIAN EL CANO','','FISHEYE','F'],
[-33.431031,-70.569571,'','RI 57 BILBAO / SEBASTIAN EL CANO / SOS','BILBAO & SEBASTIAN EL CANO','','VIDEOPORTERO','F'],
[-33.431403,-70.580734,'','RI 58 BILBAO / ALCANTARA / FISHEYE','BILBAO & ALCANTARA','','FISHEYE','F'],
[-33.431403,-70.580734,'','RI 58 BILBAO / ALCANTARA / SOS','BILBAO & ALCANTARA','','VIDEOPORTERO','F'],
[-33.42909,-70.574719,'','RI 59 MANUEL BARRIOS / VESPUCIO / FISHEYE','MANUEL BARRIOS & VESPUCIO','','FISHEYE','F'],
[-33.42909,-70.574719,'','RI 59 MANUEL BARRIOS / VESPUCIO / SOS','MANUEL BARRIOS & VESPUCIO','','VIDEOPORTERO','F'],
[-33.369716,-70.504553,'','RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / FISHEYE','AV. LAS CONDES & SAN JOSE DE LA SIERRA','','FISHEYE','F'],
[-33.369716,-70.504553,'','RI 60 AV. LAS CONDES - SAN JOSE DE LA SIERRA / SOS','AV. LAS CONDES & SAN JOSE DE LA SIERRA','','VIDEOPORTERO','F'],
[-33.405028,-70.557472,'','PI 01 LAS CONDES - CAROL URZUA / PTZ','Av. Las condes &Carol Urzua','','PTZ','P'],
[-33.405028,-70.557472,'','PI 01 LAS CONDES - CAROL URZUA / SOS','Av. Las condes & Carol Urzua','','VIDEOPORTERO','P'],
[-33.417472,-70.545972,'','PI 02 COLON - FUENTEOVEJUNA / PTZ','C. Colon & Fuenteovejuna','','PTZ','P'],
[-33.417472,-70.545972,'','PI 02 COLON - FUENTEOVEJUNA / SOS','C. Colon & Fuenteovejuna','','VIDEOPORTERO','P'],
[-33.414611,-70.537361,'','PI 04 DIAGUITAS - ATACAMEÑOS / PTZ','Diaguitas & Atacameños','','PTZ','P'],
[-33.414611,-70.537361,'','PI 04 DIAGUITAS - ATACAMEÑOS / SOS','Diaguitas & Atacameños','','VIDEOPORTERO','P'],
[-33.428333,-70.551056,'','PI 05 F BARRIOS . M CLARO VIAL / PTZ','Florencio Barrios & Miguel Claro Vial','','PTZ','P'],
[-33.428333,-70.551056,'','PI 05 F BARRIOS . M CLARO VIAL / SOS','Florencio Barrios & Miguel Claro Vial','','VIDEOPORTERO','P'],
[-33.42425,-70.547,'','PI 06 IV CENTENARIO - FLEMING / PTZ','IV Centenario & Alejandro Fleming','','PTZ','P'],
[-33.42425,-70.547,'','PI 06 IV CENTENARIO - FLEMING / SOS','IV Centenario & Alejandro Fleming','','VIDEOPORTERO','P'],
[-33.423639,-70.546528,'','PI 07 IV CENTENARIO - FUENTEOVEJUNA / PTZ','IV Centenario & Fuenteovejuna','','PTZ','P'],
[-33.423639,-70.546528,'','PI 07 IV CENTENARIO - FUENTEOVEJUNA / SOS','IV Centenario & Fuenteovejuna','','VIDEOPORTERO','P'],
[-33.401056,-70.555167,'','PI 08 LAS CONDES - LAS TRANQUERAS / PTZ','Las Tranqueras & Av. Las condes','','PTZ','P'],
[-33.401056,-70.555167,'','PI 08 LAS CONDES - LAS TRANQUERAS / SOS','Las Tranqueras & Av. Las condes','','VIDEOPORTERO','P'],
[-33.412667,-70.536278,'','PI 09 FUEGUINOS - PATAGONES / PTZ','Los Fueguinos & Patagones','','PTZ','P'],
[-33.412667,-70.536278,'','PI 09 FUEGUINOS - PATAGONES / SOS','Los Fueguinos & Patagones','','VIDEOPORTERO','P'],
[-33.414472,-70.535694,'','PI 10 MAPUCHES - HUALTECAS / PTZ','Los mapuches & Las Hualtecas','','PTZ','P'],
[-33.414472,-70.535694,'','PI 10 MAPUCHES - HUALTECAS / SOS','Los mapuches & Las Hualtecas','','VIDEOPORTERO','P'],
[-33.421528,-70.535611,'','PI 11 LOS VILOS - PEÑUELAS / SOS','Los Vilos & Peñuelas','','VIDEOPORTERO','P'],
[-33.421528,-70.535611,'','PI 11 LOS VILOS - PEÑUELAS / PTZ','Los Vilos & Peñuelas','','PTZ','P'],
[-33.418111,-70.53575,'','PI 12 LOS VILOS - SOCOMPA / SOS','Los Vilos & Socompa','','VIDEOPORTERO','P'],
[-33.418111,-70.53575,'','PI 12 LOS VILOS - SOCOMPA / PTZ','Los Vilos & Socompa','','PTZ','P'],
[-33.428861,-70.553722,'','PI 13 M CLARO VIAL - CALEU / SOS','Miguel Claro Vial & Caleu','','VIDEOPORTERO','P'],
[-33.428861,-70.553722,'','PI 13 M CLARO VIAL - CALEU / PTZ','Miguel Claro Vial & Caleu','','PTZ','P'],
[-33.420361,-70.530361,'','PI 14 MARISOL - ROSITA / SOS','Marisol & Rosita','','VIDEOPORTERO','P'],
[-33.420361,-70.530361,'','PI 14 MARISOL - ROSITA / PTZ','Marisol & Rosita','','PTZ','P'],
[-33.403,-70.574028,'','PI 15 PARQUE ARAUCANO CENTRAL / SOS','Parque Araucano Central','','VIDEOPORTERO','P'],
[-33.403,-70.574028,'','PI 15 PARQUE ARAUCANO CENTRAL / PTZ','Parque Araucano Central','','PTZ','P'],
[-33.403,-70.572583,'','PI 18 PARQUE ARAUCANO Z DEPORTIVA / SOS','Parque Araucano Z. Deportiva','','VIDEOPORTERO','P'],
[-33.403,-70.572583,'','PI 18 PARQUE ARAUCANO Z DEPORTIVA / PTZ','Parque Araucano Z. Deportiva','','PTZ','P'],
[-33.404056,-70.576778,'','PI 17 PARQUE ARAUCANO PONIENTE / SOS','Parque Araucano Poniente','','VIDEOPORTERO','P'],
[-33.404056,-70.576778,'','PI 17 PARQUE ARAUCANO PONIENTE / PTZ','Parque Araucano Poniente','','PTZ','P'],
[-33.401417,-70.570583,'','PI 16 PARQUE ARAUCANO SKATEPARK /SOS','Parque Araucano Oriente (skatepark)','','VIDEOPORTERO','P'],
[-33.401417,-70.570583,'','PI 16 PARQUE ARAUCANO SKATEPARK / PTZ','Parque Araucano Oriente (skatepark)','','PTZ','P'],
[-33.404889,-70.547639,'','PI 19 PARQUE MONTEGRANDE NORTE / SOS','Parque Montegrande Norte','','VIDEOPORTERO','P'],
[-33.404889,-70.547639,'','PI 19 PARQUE MONTEGRANDE NORTE / PTZ','Parque Montegrande Norte','','PTZ','P'],
[-33.406361,-70.548333,'','PI 20 PARQUE MONTEGRANDE / SOS','Parque Montegrande II','','VIDEOPORTERO','P'],
[-33.406361,-70.548333,'','PI 20 PARQUE MONTEGRANDE / PTZ','Parque Montegrande II','','PTZ','P'],
[-33.429861,-70.548472,'','PI 21 BILBAO - DUQUECO / SOS','Plaza Bilbao & Duqueco','','VIDEOPORTERO','P'],
[-33.429861,-70.548472,'','PI 21 BILBAO - DUQUECO / PTZ','Plaza Bilbao & Duqueco','','PTZ','P'],
[-33.42925,-70.542972,'','PI 22 BILBAO - IV CENTENARIO / SOS','Plaza Bilbao & Enrique Bunster','','VIDEOPORTERO','P'],
[-33.42925,-70.542972,'','PI 22 BILBAO - IV CENTENARIO / PTZ','Plaza Bilbao & Enrique Bunster','','PTZ','P'],
[-33.414056,-70.558722,'','PI 23 IV CENTENARIO - H DE MAGALLANES / SOS','Plaza IV Centenario & H. Magallanes','','VIDEOPORTERO','P'],
[-33.414056,-70.558722,'','PI 23 IV CENTENARIO - H DE MAGALLANES / PTZ','Plaza IV Centenario & H. Magallanes','','PTZ','P'],
[-33.408194,-70.555972,'','PI 24 METRO H DE MAGALLANES / SOS','Apoquindo & Hernando de magallanes','','VIDEOPORTERO','P'],
[-33.408194,-70.555972,'','PI 24 METRO H DE MAGALLANES / PTZ','Apoquindo & Hernando de magallanes','','PTZ','P'],
[-33.420417,-70.535167,'','PI 25 PATRICIA & LOS VILOS / SOS','Plaza Patricia & Los vilos','','VIDEOPORTERO','P'],
[-33.420417,-70.535167,'','PI 25 PATRICIA & LOS VILOS / PTZ','Plaza Patricia & Los vilos','','PTZ','P'],
[-33.42575,-70.532972,'','PI 26 VIA LACTEA - CIRIO / SOS','Via Lactea & Cirio','','VIDEOPORTERO','P'],
[-33.42575,-70.532972,'','PI 26 VIA LACTEA - CIRIO / PTZ','Via Lactea & Cirio','','PTZ','P'],
[-33.425667,-70.53775,'','PI 27 VIA LACTEA - PADRE HURTADO / SOS','Via Lactea & Padre Hurtado','','VIDEOPORTERO','P'],
[-33.425667,-70.53775,'','PI 27 VIA LACTEA - PADRE HURTADO / PTZ','Via Lactea & Padre Hurtado','','PTZ','P'],
[-33.417889,-70.552528,'','PI 28 ROTONDA ATENAS - PETROBRAS / SOS','Cristobal Colón & Los Dominicos','','VIDEOPORTERO','P'],
[-33.417889,-70.552528,'','PI 28 ROTONDA ATENAS - PETROBRAS / PTZ','Cristobal Colón & Los Dominicos','','PTZ','P'],
[-33.4148443,-70.5984676,'','PI 32 CARMENCITA & DON CARLOS / SOS','Carmencita & Don carlos','','VIDEOPORTERO','P'],
[-33.4148443,-70.5984676,'','PI 32 CARMENCITA & DON CARLOS / PTZ','Carmencita & Don carlos','','PTZ','P'],
[-33.420261,-70.589371,'','PI 37 PDTE ERRAZURIZ & POLONIA / SOS','Presidente Errazuriz & Polonia','','VIDEOPORTERO','P'],
[-33.420261,-70.589371,'','PI 37 PDTE ERRAZURIZ & POLONIA / PTZ','Presidente Errazuriz & Polonia','','PTZ','P'],
[-33.4133378,-70.5704813,'','PI 38 LA CAPITANIA & DEL INCA / SOS','Plaza La Capitania / Del Inca','','VIDEOPORTERO','P'],
[-33.4133378,-70.5704813,'','PI 38 LA CAPITANIA & DEL INCA / PTZ','Plaza La Capitania / Del Inca','','PTZ','P'],
[-33.4280611,-70.5851885,'','PI 39 TARRAGONA & ALCANTARA / SOS','Tarragona & Alcantara','','VIDEOPORTERO','P'],
[-33.4280611,-70.5851885,'','PI 39 TARRAGONA & ALCANTARA / PTZ','Tarragona & Alcantara','','PTZ','P'],
[-33.4170462,-70.5404356,'','PI 40 COLÓN & VISVIRI / SOS','Cristobal colón & Visviri','','VIDEOPORTERO','P'],
[-33.4170462,-70.5404356,'','PI 40 COLÓN & VISVIRI / PTZ','Cristobal colón & Visviri','','PTZ','P'],
[-33.4268826,-70.5790429,'','PI 41 FDO DE ARAGON & CARLOS V / SOS','Fernando de Aragon & Carlos V','','VIDEOPORTERO','P'],
[-33.4268826,-70.5790429,'','PI 41 FDO DE ARAGON & CARLOS V / PTZ','Fernando de Aragon & Carlos V','','PTZ','P'],
[-33.4278929,-70.570032,'','PI 42 MANUEL BARRIOS & LATADIA / SOS','Manuel Barrios & Latadia','','VIDEOPORTERO','P'],
[-33.4278929,-70.570032,'','PI 42 MANUEL BARRIOS & LATADIA / PTZ','Manuel Barrios & Latadia','','PTZ','P'],
[-33.4262413,-70.5642786,'','PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / SOS','Juan Esteban Montero & Manquehue','','VIDEOPORTERO','P'],
[-33.4262413,-70.5642786,'','PI 43 JUAN ESTEBAN MONTERO & MANQUEHUE / PTZ','Juan Esteban Montero & Manquehue','','PTZ','P'],
[-33.4206262,-70.5706905,'','PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / SOS','Martin Alonso Pinzon & Sebastian Elcano','','VIDEOPORTERO','P'],
[-33.4206262,-70.5706905,'','PI 44 MARTIN ALONSO PINZON & SEBASTIAN ELCANO / PTZ','Martin Alonso Pinzon & Sebastian Elcano','','PTZ','P'],
[-33.4242567,-70.5641437,'','PI 45 PEDRO BLANQUIER & MANQUEHUE SUR / SOS','Ingeniero Pedro Blanquier & Manquehue sur','','VIDEOPORTERO','P'],
[-33.4242567,-70.5641437,'','PI 45 PEDRO BLANQUIER & MANQUEHUE SUR / PTZ','Ingeniero Pedro Blanquier & Manquehue sur','','PTZ','P'],
[-33.4198,-70.567566,'','PI 46 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / SOS','Domingo Bondi & Martín Alonso Pinzón','','VIDEOPORTERO','P'],
[-33.4198,-70.567566,'','PI 46 PLAZA DOMINGO BONDI - MARTIN ALONZO PINZON / PTZ','Domingo Bondi & Martín Alonso Pinzón','','PTZ','P'],
[-33.4141836,-70.5836375,'','PI 47 VESPUCIO & APOQUINDO / SOS','Americo Vespucio Norte & Apoquindo','','VIDEOPORTERO','P'],
[-33.4141836,-70.5836375,'','PI 47 VESPUCIO & APOQUINDO / PTZ','Americo Vespucio Norte & Apoquindo','','PTZ','P'],
[-33.417836,-70.5814304,'','PI 48 CRUZ DEL SUR & DEL INCA / SOS','Cruz del Sur & del Inca','','VIDEOPORTERO','P'],
[-33.417836,-70.5814304,'','PI 48 CRUZ DEL SUR & DEL INCA / PTZ','Cruz del Sur & del Inca','','PTZ','P'],
[-33.4112045,-70.5750936,'','PI 49 COIMBRA & ROSA O\'HIGGINS / SOS','Coimbra & Rosa O\'higgins','','VIDEOPORTERO','P'],
[-33.4112045,-70.5750936,'','PI 49 COIMBRA & ROSA O\'HIGGINS / PTZ','Coimbra & Rosa O\'higgins','','PTZ','P'],
[-33.4094633,-70.5690955,'','PI 50 APOQUINDO & MAR DE LOS SARGAZOS / SOS','Apoquindo & Mar de los Sargazos','','VIDEOPORTERO','P'],
[-33.4094633,-70.5690955,'','PI 50 APOQUINDO & MAR DE LOS SARGAZOS / PTZ','Apoquindo & Mar de los Sargazos','','PTZ','P'],
[-33.424845,-70.559541,'','PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / SOS','Av Alejandro Fleming & Isabel La Católica','','VIDEOPORTERO','P'],
[-33.424845,-70.559541,'','PI 59 PLAZA FLEMING & ISABEL LA CATOLICA / PTZ','Av Alejandro Fleming & Isabel La Católica','','PTZ','P'],
[-33.4003108,-70.5677107,'','PI 52 RIESCO & MANQUEHUE / SOS','Presidente Riesco & Manquehue Norte','','VIDEOPORTERO','P'],
[-33.4003108,-70.5677107,'','PI 52 RIESCO & MANQUEHUE / PTZ','Presidente Riesco & Manquehue Norte','','PTZ','P'],
[-33.3972257,-70.5669206,'','PI 53 KENNEDY & BRASILIA / SOS','Presidente Kennedy & Brasilia','','VIDEOPORTERO','P'],
[-33.3972257,-70.5669206,'','PI 53 KENNEDY & BRASILIA / PTZ','Presidente Kennedy & Brasilia','','PTZ','P'],
[-33.3975832,-70.5586473,'','PI 54 MAR DE CORAL & GARCIA PICA / SOS','Mar de Coral & Garcia Pica','','VIDEOPORTERO','P'],
[-33.3975832,-70.5586473,'','PI 54 MAR DE CORAL & GARCIA PICA / PTZ','Mar de Coral & Garcia Pica','','PTZ','P'],
[-33.3986308,-70.5535266,'','PI 56 SOR JOSEFA & LAS VERBENAS / SOS','Sor Josefa & Las Verbenas','','VIDEOPORTERO','P'],
[-33.3986308,-70.5535266,'','PI 56 SOR JOSEFA & LAS VERBENAS / PTZ','Sor Josefa & Las Verbenas','','PTZ','P'],
[-33.4165352,-70.5550044,'','PI 58 LOS POZOS & IV CENTENARIO / SOS','Los Pozos & Cuarto Centenario','','VIDEOPORTERO','P'],
[-33.4165352,-70.5550044,'','PI 58 LOS POZOS & IV CENTENARIO / PTZ','Los Pozos & Cuarto Centenario','','PTZ','P'],
[-33.4223975,-70.5532948,'','PI 60 ALONSO DE CAMARGO & TOMAS MORO / SOS','Alonso de Camargo & Tomas Moro','','VIDEOPORTERO','P'],
[-33.4223975,-70.5532948,'','PI 60 ALONSO DE CAMARGO & TOMAS MORO / PTZ','Alonso de Camargo & Tomas Moro','','PTZ','P'],
[-33.4213771,-70.5506334,'','PI 61 TEZCUCO & PRETORIA / SOS','Tezcuco & Pretoria','','VIDEOPORTERO','P'],
[-33.4213771,-70.5506334,'','PI 61 TEZCUCO & PRETORIA / PTZ','Tezcuco & Pretoria','','PTZ','P'],
[-33.4181138,-70.5490165,'','PI 62 COLON & VIZCAYA / SOS','Cristobal Colón & Vizcaya','','VIDEOPORTERO','P'],
[-33.4181138,-70.5490165,'','PI 62 COLON & VIZCAYA / PTZ','Cristobal Colón & Vizcaya','','PTZ','P'],
[-33.4157828,-70.5520425,'','PI 63 TINGUIRIRICA & MONROE / SOS','Tinguiririca & Monroe','','VIDEOPORTERO','P'],
[-33.4157828,-70.5520425,'','PI 63 TINGUIRIRICA & MONROE / PTZ','Tinguiririca & Monroe','','PTZ','P'],
[-33.4158648,-70.5424879,'','PI 64 ISLOTE SNIPE & RIO TAMESIS / SOS','Islote Snipe & Rio Tamesis','','VIDEOPORTERO','P'],
[-33.4158648,-70.5424879,'','PI 64 ISLOTE SNIPE & RIO TAMESIS / PTZ','Islote Snipe & Rio Tamesis','','PTZ','P'],
[-33.4147653,-70.5421475,'','PI 65 TALAVERA DE LA REINA & RIO CONGO / SOS','Talavera de la Teina & Rio Congo','','VIDEOPORTERO','P'],
[-33.4147653,-70.5421475,'','PI 65 TALAVERA DE LA REINA & RIO CONGO / PTZ','Talavera de la Teina & Rio Congo','','PTZ','P'],
[-33.3945023,-70.5411983,'','PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / SOS','Cardenal newman & Punta del este','','VIDEOPORTERO','P'],
[-33.3945023,-70.5411983,'','PI 66 CARDENAL NEWMAN & PUNTA DEL ESTE / PTZ','Cardenal Newman & Punta del Este','','PTZ','P'],
[-33.4082287,-70.5377428,'','PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / SOS','Viejos Estandartes & General Blanche','','VIDEOPORTERO','P'],
[-33.4082287,-70.5377428,'','PI 67 VIEJOS ESTANDARTES & GRAL BLANCHE / PTZ','Viejos Estandartes & General Blanche','','PTZ','P'],
[-33.3732698,-70.5184412,'','PI 71 NUEVA LAS CONDES & LAS CONDES / SOS','Nueva Las Condes & Las Condes','','VIDEOPORTERO','P'],
[-33.3732698,-70.5184412,'','PI 71 NUEVA LAS CONDES & LAS CONDES / PTZ','Nueva Las Condes & Las Condes','','PTZ','P'],
[-33.4068561,-70.5353621,'','PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / SOS','General Blanche & Luis Matte Larrain','','VIDEOPORTERO','P'],
[-33.4068561,-70.5353621,'','PI 74 GRAL BLANCHE & LUIS MATTE LARRAIN / PTZ','General Blanche & Luis Matte Larrain','','PTZ','P'],
[-33.4134503,-70.5417018,'','PI 75 RIO GUADIANA & LONTANANZA / SOS','Rio Guadiana & Lontananza','','VIDEOPORTERO','P'],
[-33.4134503,-70.5417018,'','PI 75 RIO GUADIANA & LONTANANZA / PTZ','Rio Guadiana & Lontananza','','PTZ','P'],
[-33.4127554,-70.5413688,'','PI 76 LA RECOBA & EL TORRENTE / SOS','La Recoba & El Torrente','','VIDEOPORTERO','P'],
[-33.4127554,-70.5413688,'','PI 76 LA RECOBA & EL TORRENTE / PTZ','La Recoba & El Torrente','','PTZ','P'],
[-33.416755,-70.5298359,'','PI 77 LA QUEBRADA & VITAL APOQUINDO / SOS','La Quebrada & Vital apoquindo','','VIDEOPORTERO','P'],
[-33.416755,-70.5298359,'','PI 77 LA QUEBRADA & VITAL APOQUINDO / PTZ','La Quebrada & Vital apoquindo','','PTZ','P'],
[-33.4206654,-70.5325498,'','PI 79 RIVADAVIA & INCAHUASI / SOS','Rivadavia & Incahuasi','','VIDEOPORTERO','P'],
[-33.4206654,-70.5325498,'','PI 79 RIVADAVIA & INCAHUASI / PTZ','Rivadavia & Incahuasi','','PTZ','P'],
[-33.4228497,-70.5376698,'','PI 80 PADRE HURTADO & INCA DE ORO / SOS','Padre Hurtado Sur & Inca de Oro','','VIDEOPORTERO','P'],
[-33.4228497,-70.5376698,'','PI 80 PADRE HURTADO & INCA DE ORO / PTZ','Padre Hurtado Sur & Inca de Oro','','PTZ','P'],
[-33.4264012,-70.5374592,'','PI 81 ALTAIR & PLAZA ALTAIR / SOS','Altair & Altair','','VIDEOPORTERO','P'],
[-33.4264012,-70.5374592,'','PI 81 ALTAIR & PLAZA ALTAIR / PTZ','Altair & Altair','','PTZ','P'],
[-33.4121166,-70.5077351,'','PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / SOS','Quebrada Honda & Carlos Peña otaegui','','VIDEOPORTERO','P'],
[-33.4121166,-70.5077351,'','PI 82 QUEBRADA HONDA & CARLOS PEÑA OTAEGUI / PTZ','Quebrada Honda & Carlos Peña otaegui','','PTZ','P'],
[-33.402408,-70.510345,'','PI 84 DEL PARQUE & SANTOS APOSTOLES / SOS','Del Parque & Santos Apostoles','','VIDEOPORTERO','P'],
[-33.402408,-70.510345,'','PI 84 DEL PARQUE & SANTOS APOSTOLES / PTZ','Del Parque & Santos Apostoles','','PTZ','P'],
[-33.411443,-70.5205123,'','PI 85 CARLOS PEÑA & LAS CONDESAS / SOS','Carlos Peña Otaegui & Las Condesas','','VIDEOPORTERO','P'],
[-33.411443,-70.5205123,'','PI 85 CARLOS PEÑA & LAS CONDESAS / PTZ','Carlos Peña Otaegui & Las Condesas','','PTZ','P'],
[-33.3896369,-70.5076899,'','PI 87 LOS MONJES EL CONVENTO / SOS','Los Monjes & El Convento','','VIDEOPORTERO','P'],
[-33.3896369,-70.5076899,'','PI 87 LOS MONJES EL CONVENTO / PTZ','Los Monjes & El Convento','','PTZ','P'],
[-33.3933798,-70.5076621,'','PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / SOS','Cerro Catedral Sur & San Carlos de Apoquindo','','VIDEOPORTERO','P'],
[-33.3933798,-70.5076621,'','PI 88 CERRO CATEDRAL SUR & SAN CARLOS DE APOQUINDO / PTZ','Cerro Catedral Sur & San Carlos de Apoquindo','','PTZ','P'],
[-33.3966781,-70.5127471,'','PI 90 CERRO PROVINCIA & LOS PUMAS / SOS','Cerro Provincia & Los Pumas','','VIDEOPORTERO','P'],
[-33.3966781,-70.5127471,'','PI 90 CERRO PROVINCIA & LOS PUMAS / PTZ','Cerro Provincia & Los Pumas','','PTZ','P'],
[-33.3982371,-70.5153436,'','PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / SOS','Camino las Vertientes & Camino de los Arrieros','','VIDEOPORTERO','P'],
[-33.3982371,-70.5153436,'','PI 91 CAMINO LAS VERTIENTES & CAMINO DE LOS ARRIEROS / PTZ','Camino las Vertientes & Camino de los Arrieros','','PTZ','P'],
[-33.4274252,-70.5428274,'','PI 93 IV CENTENARIO & MANUEL CLARO VIAL / SOS','IV Centenario & Manuel Claro Vial','','VIDEOPORTERO','P'],
[-33.4274252,-70.5428274,'','PI 93 IV CENTENARIO & MANUEL CLARO VIAL / PTZ','IV Centenario & Manuel Claro Vial','','PTZ','P'],
[-33.4265259,-70.548812,'','PI 94 LOLCO & RUCALHUE / SOS','Lolco & Rucalhue','','VIDEOPORTERO','P'],
[-33.4265259,-70.548812,'','PI 94 LOLCO & RUCALHUE / PTZ','Lolco & Rucalhue','','PTZ','P'],
[-33.4190505,-70.5309456,'','PI 95 PLAZA OLGA NORTE / SOS','Pasaje Olga Norte','','VIDEOPORTERO','P'],
[-33.4190505,-70.5309456,'','PI 95 PLAZA OLGA NORTE / PTZ','Pasaje Olga Norte','','PTZ','P'],
[-33.4174539,-70.5296866,'','PI 96 YOLANDA & VITAL APOQUINDO / SOS','Yolanda & Vital Apoquindo','','VIDEOPORTERO','P'],
[-33.4174539,-70.5296866,'','PI 96 YOLANDA & VITAL APOQUINDO / PTZ','Yolanda & Vital Apoquindo','','PTZ','P'],
[-33.418403,-70.530209,'','PI 97 YOLANDA INTERIOR / SOS','Yolanda Interior','','VIDEOPORTERO','P'],
[-33.418403,-70.530209,'','PI 97 YOLANDA INTERIOR / PTZ','Yolanda Interior','','PTZ','P'],
[-33.3978262,-70.511007,'','PI 98 CERRO EL CEPO & CERRO EL CEPO / SOS','Cerro el Cepo & Cerro el Cepo','','VIDEOPORTERO','P'],
[-33.3978262,-70.511007,'','PI 98 CERRO EL CEPO & CERRO EL CEPO / PTZ','Cerro el Cepo & Cerro el Cepo','','PTZ','P'],
[-33.3962895,-70.5106642,'','PI 99 CERRO LITORIA & CERRO LITORIA / SOS','Cerro litoria & Cerro litoria','','VIDEOPORTERO','P'],
[-33.3962895,-70.5106642,'','PI 99 CERRO LITORIA & CERRO LITORIA / PTZ','Cerro litoria & Cerro litoria','','PTZ','P'],
[-33.4230714,-70.5423081,'','PI 102 EL TATIO & PICA / PTZ','El tatio & Pica','','PTZ','P'],
[-33.4230714,-70.5423081,'','PI 102 EL TATIO & PICA / SOS','El tatio & Pica','','VIDEOPORTERO','P'],
[-33.4237313,-70.5350428,'','PI 103 ALEXANDER FLEMING & TOTORALILLO / PTZ','Alexander Fleming & Totoralillo','','PTZ','P'],
[-33.4237313,-70.5350428,'','PI 103 ALEXANDER FLEMING & TOTORALILLO / SOS','Alexander Fleming & Totoralillo','','VIDEOPORTERO','P'],
[-33.4250162,-70.5331834,'','PI 104 SANTA ZITA & SANTA ZITA / PTZ','Santa Zita & Santa Zita','','PTZ','P'],
[-33.4250162,-70.5331834,'','PI 104 SANTA ZITA & SANTA ZITA / SOS','Santa Zita & Santa Zita','','VIDEOPORTERO','P'],
[-33.4237453,-70.5331522,'','PI 105 FLEMING & PUNITAQUI / PTZ','Alexander Fleming & Punitaqui','','PTZ','P'],
[-33.4237453,-70.5331522,'','PI 105 FLEMING & PUNITAQUI / SOS','Alexander Fleming & Punitaqui','','VIDEOPORTERO','P'],
[-33.4012945,-70.5502472,'','PI 106 PETRARCA & BENVENUTTO CELLINI / PTZ','Petrarca & Benvenuto Cellini','','PTZ','P'],
[-33.4012945,-70.5502472,'','PI 106 PETRARCA & BENVENUTTO CELLINI / SOS','Petrarca & Benvenuto Cellini','','VIDEOPORTERO','P'],
[-33.4029133,-70.5507536,'','PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / PTZ','Lorenzo de Medicis & Benvenuto Cellini','','PTZ','P'],
[-33.4029133,-70.5507536,'','PI 107 LORENZO DE MEDICIS & BENVENUTTO CELLINI / SOS','Lorenzo de Medicis & Benvenuto Cellini','','VIDEOPORTERO','P'],
[-33.404444,-70.553531,'','PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / PTZ','Padre Errazuriz & Miguel Angel Buonarotti','','PTZ','P'],
[-33.404444,-70.553531,'','PI 108 PADRE ERRAZURIZ & MIGUEL ANGEL BUONAROTTI / SOS','Padre Errazuriz & Miguel Angel Buonarotti','','VIDEOPORTERO','P'],
[-33.4205468,-70.5374973,'','PI 109 PADRE HURTADO & PATRICIA / PTZ','Padre Hurtado Sur & Patricia','','PTZ','P'],
[-33.4205468,-70.5374973,'','PI 109 PADRE HURTADO & PATRICIA / SOS','Padre Hurtado Sur & Patricia','','VIDEOPORTERO','P'],
[-33.4202195,-70.5453317,'','PI 110 TOCONAO & CHIUCHIU / PTZ','Toconao & Chiu chiu','','PTZ','P'],
[-33.4202195,-70.5453317,'','PI 110 TOCONAO & CHIUCHIU / SOS','Toconao & Chiu chiu','','VIDEOPORTERO','P'],
[-33.418758,-70.53352,'','PI 111 PAUL HARRIS & SOCOMPA / PTZ','Paul harris sur & Socompa','','PTZ','P'],
[-33.418758,-70.53352,'','PI 111 PAUL HARRIS & SOCOMPA / SOS','Paul harris sur & Socompa','','VIDEOPORTERO','P'],
[-33.412861,-70.523871,'','PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / PTZ','atalaya & carlos peña otaegui','','PTZ','P'],
[-33.412861,-70.523871,'','PI 112 ATALAYA (MIRADOR) & CARLOS PEÑA OTAEGUI / SOS','atalaya & carlos peña otaegui','','VIDEOPORTERO','P'],
[-33.4188493,-70.5413745,'','PI 113 ZARAGOZA & AYQUINA / PTZ','zaragoza & ayquina','','PTZ','P'],
[-33.4188493,-70.5413745,'','PI 113 ZARAGOZA & AYQUINA / SOS','zaragoza & ayquina','','VIDEOPORTERO','P'],
[-33.418537,-70.545239,'','PI 114 LERIDA & TOCONAO / PTZ','Lerida & Toconao','','PTZ','P'],
[-33.418537,-70.545239,'','PI 114 LERIDA & TOCONAO / SOS','Lerida & Toconao','','VIDEOPORTERO','P'],
[-33.419553,-70.544831,'','PI 115 ZARAGOZA & TOCONAO / PTZ','Zaragoza & Toconao','','PTZ','P'],
[-33.419553,-70.544831,'','PI 115 ZARAGOZA & TOCONAO / SOS','Zaragoza & Toconao','','VIDEOPORTERO','P'],
[-33.419785,-70.570616,'','PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / PTZ','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano','','PTZ','P'],
[-33.419785,-70.570616,'','PI 116 PJE. MARTIN ALONSO PINZON & PJE. SEBASTIAN ELCANO / SOS','Pje. Martin Alonso Pinzon & Pje. Sebastian Elcano','','VIDEOPORTERO','P'],
[-33.420014,-70.543798,'','PI 117 ZARAGOZA & PUREN / PTZ','Puren. Entre Zaragoza & Alonso de Camargo','','PTZ','P'],
[-33.420014,-70.543798,'','PI 117 ZARAGOZA & PUREN / SOS','Puren. Entre Zaragoza & Alonso de Camargo','','VIDEOPORTERO','P'],
[-33.403675,-70.566929,'','PI 118 VILLA SAN LUIS A / PTZ','Cerro el Plomo & Estocolmo','','PTZ','P'],
[-33.403675,-70.566929,'','PI 118 VILLA SAN LUIS A / SOS','Cerro el Plomo & Estocolmo','','VIDEOPORTERO','P'],
[-33.40249,-70.567499,'','PI 119 VILLA SAN LUIS B / PTZ','Cerro el Plomo & Estocolmo','','PTZ','P'],
[-33.40249,-70.567499,'','PI 119 VILLA SAN LUIS B / SOS','Cerro el Plomo & Estocolmo','','VIDEOPORTERO','P'],
[-33.413497,-70.596308,'','PI 120 GLAMIS & LA PASTORA / PTZ','Glamis & La Pastora','','PTZ','P'],
[-33.413497,-70.596308,'','PI 120 GLAMIS & LA PASTORA / SOS','Glamis & La Pastora','','VIDEOPORTERO','P'],
[-33.408344,-70.571159,'','PI 121 ROSARIO NORTE & EDIPO REY / PTZ','Rosario Norte & Edipo Rey','','PTZ','P'],
[-33.408344,-70.571159,'','PI 121 ROSARIO NORTE & EDIPO REY / SOS','Rosario Norte & Edipo Rey','','VIDEOPORTERO','P'],
[-33.417699,-70.602121,'','PI 122 TAJAMAR & ENCOMENDEROS / PTZ','Tajamar & Encomenderos','','PTZ','P'],
[-33.417699,-70.602121,'','PI 122 TAJAMAR & ENCOMENDEROS / SOS','Tajamar & Encomenderos','','VIDEOPORTERO','P'],
[-33.423377,-70.54122,'','PI 123 PLAZA AYQUINA ASCOTAN / PTZ','Ayquina & Ascotan','','PTZ','P'],
[-33.423377,-70.54122,'','PI 123 PLAZA AYQUINA ASCOTAN / SOS','Ayquina & Ascotan','','VIDEOPORTERO','P'],
[-33.4311624,-70.5786614,'','PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PTZ','Francisco Bilbao & Juan de Austria','','PTZ','P'],
[-33.4311624,-70.5786614,'','PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / SOS','Francisco Bilbao & Juan de Austria','','VIDEOPORTERO','P'],
[-33.4169955,-70.5405648,'','PI 127 PARQUE SANTA ROSA / PTZ','Cristobal colón & Visviri','','PTZ','P'],
[-33.4169955,-70.5405648,'','PI 127 PARQUE SANTA ROSA / SOS','Cristobal colón & Visviri','','VIDEOPORTERO','P'],
[-33.405275,-70.572463,'','PI 128 ROSARIO NORTE - CERRO EL PLOMO / PTZ','Rosario Norte & Cerro el Plomo','','PTZ','P'],
[-33.405275,-70.572463,'','PI 128 ROSARIO NORTE - CERRO EL PLOMO / SOS','Rosario Norte & Cerro el Plomo','','VIDEOPORTERO','P'],
[-33.4135847,-70.5836062,'','PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PTZ','Apoquindo & Gral Francisco Barceló','','PTZ','P'],
[-33.4135847,-70.5836062,'','PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / SOS','Apoquindo & Gral Francisco Barceló','','VIDEOPORTERO','P'],
[-33.4068978,-70.5615346,'','PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / PTZ','Av. Las Condes & Nuestra Sra. del Rosario','','PTZ','P'],
[-33.4068978,-70.5615346,'','PI 131 CENTRO CULTURAL LAS CONDES - N. SRA DEL ROSARIO / SOS','Av. Las Condes & Nuestra Sra. del Rosario','','VIDEOPORTERO','P'],
[-33.3910837,-70.5134891,'','PI 134 PLAZA CORAZÓN / PTZ','Republica de Honduras & Catedral Sur','','PTZ','P'],
[-33.3910837,-70.5134891,'','PI 134 PLAZA CORAZÓN / SOS','Republica de Honduras & Catedral Sur','','VIDEOPORTERO','P'],
[-33.4216939,-70.5456271,'','PI 135 CHIU CHIU - CODPA / PTZ','Chiu Chiu & Codpa','','PTZ','P'],
[-33.4216939,-70.5456271,'','PI 135 CHIU CHIU - CODPA / SOS','Chiu Chiu & Codpa','','VIDEOPORTERO','P'],
[-33.4214702,-70.5443339,'','PI 136 PARINACOTA - CODPA / PTZ','Codpa & Parinacota','','PTZ','P'],
[-33.4214702,-70.5443339,'','PI 136 PARINACOTA - CODPA / SOS','Codpa & Parinacota','','VIDEOPORTERO','P'],
[-33.4234815,-70.5492744,'','PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / PTZ','Pintor R. Monvoisin & Pintora Aurora Mira','','PTZ','P'],
[-33.4234815,-70.5492744,'','PI 137 PINTORA AURORA MIRA - PINTOR R. MONVOISIN / SOS','Pintor R. Monvoisin & Pintora Aurora Mira','','VIDEOPORTERO','P'],
[-33.418847,-70.540482,'','PI 138 VISVIRI - ZARAGOZA / PTZ','Visviri & Zaragoza','','PTZ','P'],
[-33.418847,-70.540482,'','PI 138 VISVIRI - ZARAGOZA / SOS','Visviri & Zaragoza','','VIDEOPORTERO','P'],
[-33.426615,-70.553101,'','PI 141 TORRE FLEMING / PTZ','Lolco 7680','','PTZ','P'],
[-33.426615,-70.553101,'','PI 141 TORRE FLEMING / SOS','Lolco 7680','','VIDEOPORTERO','P'],
[-33.396871,-70.552641,'','Pi 143 PLAZA SOR LAURA ROSA / PTZ','Sor Laura Rosa 220','','PTZ','P'],
[-33.396871,-70.552641,'','Pi 143 PLAZA SOR LAURA ROSA / SOS','Sor Laura Rosa 220','','VIDEOPORTERO','P'],
[-33.421748,-70.541165,'','Pi 144 TOCONCE & CHAPIQUIÑA / PTZ','Chapiquiña 8851','','PTZ','P'],
[-33.421748,-70.541165,'','Pi 144 TOCONCE & CHAPIQUIÑA / SOS','Chapiquiña 8851','','VIDEOPORTERO','P'],
[-33.414607,-70.534543,'','PI 145 PAUL HARRIS & ATACAMEÑOS / PTZ','Paul Harris & Atacameños','','PTZ','P'],
[-33.414607,-70.534543,'','PI 145 PAUL HARRIS & ATACAMEÑOS / SOS','Paul Harris & Atacameños','','VIDEOPORTERO','P'],
[-33.425435,-70.591556,'','PI 146 LA NIÑA - SANCHEZ FONTECILLA / PTZ','La niña & Sanchez Fontecilla','','PTZ','P'],
[-33.425435,-70.591556,'','PI 146 LA NIÑA - SANCHEZ FONTECILLA / SOS','La niña & Sanchez Fontecilla','','VIDEOPORTERO','P'],
[-33.388356,-70.525315,'','PI 147 CHARLES HAMILTON - LO FONTECILLA / PTZ','Charles Hamilton & Lo Fontecilla','','PTZ','P'],
[-33.388356,-70.525315,'','PI 147 CHARLES HAMILTON - LO FONTECILLA / SOS','Charles Hamilton & Lo Fontecilla','','VIDEOPORTERO','P'],
[-33.407581,-70.544921,'','PI 148 LOS DOMINICOS / PTZ','Los Dominicos (Pista Patinaje)','','PTZ','P'],
[-33.407581,-70.544921,'','PI 148 LOS DOMINICOS / SOS','Los Dominicos (Pista Patinaje)','','VIDEOPORTERO','P'],
[-33.415,-70.597893,'','PI 149 DON CARLOS & AUGUSTO LEGUIA / PTZ','Don Carlos & Augusto Leguia','','PTZ','P'],
[-33.415,-70.597893,'','PI 149 DON CARLOS & AUGUSTO LEGUIA / SOS','Don Carlos & Augusto Leguia','','VIDEOPORTERO','P'],
[-33.392293,-70.54002,'','PI 152 PLAZA DANURRO - PDTE. SANFUENTES / PTZ','Pdte. San Fuentes - Euzkadi','','PTZ','P'],
[-33.392293,-70.54002,'','PI 152 PLAZA DANURRO - PDTE. SANFUENTES / SOS','Pdte. San Fuentes - Euzkadi','','VIDEOPORTERO','P'],
[-33.374123,-70.520551,'','PI 153 COLEGIO LAS CONDES / PTZ','Av. Las condes 12125','','PTZ','P'],
[-33.374123,-70.520551,'','PI 153 COLEGIO LAS CONDES / SOS','Av. Las condes 12125','','VIDEOPORTERO','P'],
[-33.42062,-70.536441,'','PI 157 COLEGIO JUAN PABLO II / PTZ','Patricia 9040','','PTZ','P'],
[-33.42062,-70.536441,'','PI 157 COLEGIO JUAN PABLO II / SOS','Patricia 9040','','VIDEOPORTERO','P'],
[-33.425799,-70.532285,'','PI 158 COLEGIO SANTA MARIA DE LAS CONDES / PTZ','VIA LACTEA & CIRIO','','PTZ','P'],
[-33.425799,-70.532285,'','PI 158 COLEGIO SANTA MARIA DE LAS CONDES / SOS','VIA LACTEA & CIRIO','','VIDEOPORTERO','P'],
[-33.400343,-70.56491,'','PI 159 COLEGIO LEONARDO DA VINCI / PTZ','Cerro Altar 6811','','PTZ','P'],
[-33.400343,-70.56491,'','PI 159 COLEGIO LEONARDO DA VINCI / SOS','Cerro Altar 6811','','VIDEOPORTERO','P'],
[-33.403933,-70.536128,'','PI 160 COLEGIO SAN FCO. DEL ALBA / PTZ','CAMINO EL ALBA & VITAL APOQUINDO','','PTZ','P'],
[-33.403933,-70.536128,'','PI 160 COLEGIO SAN FCO. DEL ALBA / SOS','CAMINO EL ALBA & VITAL APOQUINDO','','VIDEOPORTERO','P'],
[-33.415965,-70.536116,'','PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / PTZ','Av. Cristóbal Colón 9070','','PTZ','P'],
[-33.415965,-70.536116,'','PI 161 COLEGIO SAN FCO TEC.PROFESIONAL / SOS','Av. Cristóbal Colón 9070','','VIDEOPORTERO','P'],
[-33.416044,-70.534556,'','PI 162 COLEGIO PAUL HARRIS / PTZ','CRISTOBAL COLON 9188','','PTZ','P'],
[-33.416044,-70.534556,'','PI 162 COLEGIO PAUL HARRIS / SOS','CRISTOBAL COLON 9188','','VIDEOPORTERO','P'],
[-33.425536,-70.554461,'','PI 163 COLEGIO SIMON BOLIVAR / PTZ','TOMAS MORO 1651','','PTZ','P'],
[-33.425536,-70.554461,'','PI 163 COLEGIO SIMON BOLIVAR / SOS','TOMAS MORO 1651','','VIDEOPORTERO','P'],
[-33.404941,-70.578501,'','PI 164 DEPARTAMENTO DE TRANSITO / PTZ','PDTE RIESCO 5296','','PTZ','P'],
[-33.404941,-70.578501,'','PI 164 DEPARTAMENTO DE TRANSITO / SOS','PDTE RIESCO 5296','','VIDEOPORTERO','P'],
[-33.398751,-70.561971,'','PI 165 CIRCULO POLAR / PTZ','CÍRCULO POLAR 6652','','PTZ','P'],
[-33.398751,-70.561971,'','PI 165 CIRCULO POLAR / SOS','CÍRCULO POLAR 6652','','VIDEOPORTERO','P'],
[-33.414261,-70.588148,'','PI 166 JEAN MERMOZ / PTZ','JEAN MERMOZ 4115','','PTZ','P'],
[-33.414261,-70.588148,'','PI 166 JEAN MERMOZ / SOS','JEAN MERMOZ 4115','','VIDEOPORTERO','P'],
[-33.37008,-70.505555,'','PI 167 COLEGIO SOUTHERN CROSS / PTZ','LAS CONDES 13525','','PTZ','P'],
[-33.37008,-70.505555,'','PI 167 COLEGIO SOUTHERN CROSS / SOS','LAS CONDES 13525','','VIDEOPORTERO','P'],
[-33.3703016,-70.5081841,'','PI 168 COLEGIO PEDRO DE VALDIVIA / PTZ','AV. LAS CONDES 13349','','PTZ','P'],
[-33.3703016,-70.5081841,'','PI 168 COLEGIO PEDRO DE VALDIVIA / SOS','AV. LAS CONDES 13349','','VIDEOPORTERO','P'],
[-33.403125,-70.564497,'','PI 169 COLEGIO SEK / PTZ','LOS MILITARES 6640','','PTZ','P'],
[-33.403125,-70.564497,'','PI 169 COLEGIO SEK / SOS','LOS MILITARES 6640','','VIDEOPORTERO','P'],
[-33.4006449,-70.5666387,'','PI 170 COLEGIO ARABE / PTZ','PDTE. RIESCO 6437','','PTZ','P'],
[-33.4006449,-70.5666387,'','PI 170 COLEGIO ARABE / SOS','PDTE. RIESCO 6437','','VIDEOPORTERO','P'],
[-33.4204548,-70.5891287,'','PI 171 COLEGIO VILLA MARIA ACADEMY / PTZ','PDTE ERRÁZURIZ 3753','','PTZ','P'],
[-33.4204548,-70.5891287,'','PI 171 COLEGIO VILLA MARIA ACADEMY / SOS','PDTE ERRÁZURIZ 3753','','VIDEOPORTERO','P'],
[-33.4199954,-70.5869363,'','PI 172 COLEGIO VERBO DIVINO / PTZ','PDTE ERRÁZURIZ 4055','','PTZ','P'],
[-33.4199954,-70.5869363,'','PI 172 COLEGIO VERBO DIVINO / SOS','PDTE ERRÁZURIZ 4055','','VIDEOPORTERO','P'],
[-33.4196048,-70.5468986,'','PI 173 COLEGIO COOCENDE / PTZ','ZARAGOZA 8065','','PTZ','P'],
[-33.4106423,-70.5496322,'','PI 174 COLEGIO SAGRADO CORAZÓN / PTZ','STA. MAGDALENA SOFÍA 277','','PTZ','P'],
[-33.4106423,-70.5496322,'','PI 174 COLEGIO SAGRADO CORAZÓN / SOS','STA. MAGDALENA SOFÍA 277','','VIDEOPORTERO','P'],
[-33.4055382,-70.5405481,'','PI 175 COLEGIO VIRGEN DE POMPEYA / PTZ','CAMINO EL ALBA N° 9145','','PTZ','P'],
[-33.4055382,-70.5405481,'','PI 175 COLEGIO VIRGEN DE POMPEYA / SOS','CAMINO EL ALBA N° 9145','','VIDEOPORTERO','P'],
[-33.3884497,-70.5333258,'','PI 176 COLEGIO SAN MIGUEL ARCANGEL / PTZ','CAMPANARIO 000','','PTZ','P'],
[-33.3884497,-70.5333258,'','PI 176 COLEGIO SAN MIGUEL ARCANGEL / SOS','CAMPANARIO 000','','VIDEOPORTERO','P'],
[-33.425544,-70.5551181,'','PI 177 COLEGIO ALEXANDER FLEMING / PTZ','AV. ALEJANDRO FLEMING 7315','','PTZ','P'],
[-33.425544,-70.5551181,'','PI 177 COLEGIO ALEXANDER FLEMING / SOS','AV. ALEJANDRO FLEMING 7315','','VIDEOPORTERO','P'],
[-33.4213844,-70.5585823,'','PI 178 COLEGIO ACHIGA COMEDUC / PTZ','ALONSO DE CAMARGO 6615','','PTZ','P'],
[-33.4213844,-70.5585823,'','PI 178 COLEGIO ACHIGA COMEDUC / SOS','ALONSO DE CAMARGO 6615','','VIDEOPORTERO','P'],
[-33.4192629,-70.5885682,'','PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PTZ','ALCÁNTARA 445','','PTZ','P'],
[-33.4192629,-70.5885682,'','PI 179 COLEGIO PRESIDENTE ERRAZURIZ / SOS','ALCÁNTARA 445','','VIDEOPORTERO','P'],
[-33.4056546,-70.5607239,'','PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / PTZ','LA PIEDAD 35','','PTZ','P'],
[-33.4056546,-70.5607239,'','PI 180 COLEGIO NUESTRA SEÑORA DEL ROSARIO / SOS','LA PIEDAD 35','','VIDEOPORTERO','P'],
[-33.3952067,-70.5540277,'','PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / PTZ','LAS TRANQUERAS 726','','PTZ','P'],
[-33.3952067,-70.5540277,'','PI 181 COLEGIO LICEO RAFAEL SOTOMAYOR / SOS','LAS TRANQUERAS 726','','VIDEOPORTERO','P'],
[-33.4112682,-70.5522887,'','PI 182 COLEGIO SAN JORGE / PTZ','AVENIDA TOMÁS MORO 272','','PTZ','P'],
[-33.4112682,-70.5522887,'','PI 182 COLEGIO SAN JORGE / SOS','AVENIDA TOMÁS MORO 272','','VIDEOPORTERO','P'],
[-33.3989726,-70.5599046,'','PI 183 COLEGIO EMAUS / PTZ','GERÓNIMO DE ALDERETE 481','','PTZ','P'],
[-33.3989726,-70.5599046,'','PI 183 COLEGIO EMAUS / SOS','GERÓNIMO DE ALDERETE 481','','VIDEOPORTERO','P'],
[-33.4261453,-70.5728639,'','PI 184 COLEGIO QUIMAY / PTZ','ISABEL LA CATOLICA 4774','','PTZ','P'],
[-33.4261453,-70.5728639,'','PI 184 COLEGIO QUIMAY / SOS','ISABEL LA CATOLICA 4774','','VIDEOPORTERO','P'],
[-33.4114499,-70.5220909,'','PI 185 COLEGIO WENLOCK SCHOOL / PTZ','CALLE CARLOS PEÑA OTAEGUI 10880','','PTZ','P'],
[-33.4114499,-70.5220909,'','PI 185 COLEGIO WENLOCK SCHOOL / SOS','CALLE CARLOS PEÑA OTAEGUI 10880','','VIDEOPORTERO','P'],
[-33.4147518,-70.5630787,'','PI 186 COLEGIO SAN JUAN EVANGELISTA / PTZ','MARTÍN DE ZAMORA 6395','','PTZ','P'],
[-33.4147518,-70.5630787,'','PI 186 COLEGIO SAN JUAN EVANGELISTA / SOS','MARTÍN DE ZAMORA 6395','','VIDEOPORTERO','P'],
[-33.419581,-70.542305,'','PI 187 PLAZA EL TATIO / PTZ','CALLE PICA 1220','','PTZ','P'],
[-33.419581,-70.542305,'','PI 187 PLAZA EL TATIO / SOS','CALLE PICA 1220','','VIDEOPORTERO','P'],
[-33.4071595,-70.5548273,'','PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / PTZ','PADRE ERRAZURIZ 7001','','PTZ','P'],
[-33.4071595,-70.5548273,'','PI 188 COLEGIO SEMINARIO PONTIFICIO MENOR / SOS','PADRE ERRAZURIZ 7001','','VIDEOPORTERO','P'],
[-33.4207426,-70.5463573,'','PI 189 COLEGIO ALAMIRO / PTZ','FUENTE OVEJUNA 1235','','PTZ','P'],
[-33.4207426,-70.5463573,'','PI 189 COLEGIO ALAMIRO / SOS','FUENTE OVEJUNA 1235','','VIDEOPORTERO','P'],
[-33.40704,-70.581401,'','PI 190 COLEGIO ALCAZAR DE LAS CONDES / PTZ','PRESIDENTE RIESCO 4902','','PTZ','P'],
[-33.40704,-70.581401,'','PI 190 COLEGIO ALCAZAR DE LAS CONDES / SOS','PRESIDENTE RIESCO 4902','','VIDEOPORTERO','P'],
[-33.398249,-70.567799,'','PI 191 COLEGIO ALEMAN DE SANTIAGO / PTZ','NUESTRA SEÑORA DEL ROSARIO 850','','PTZ','P'],
[-33.398249,-70.567799,'','PI 191 COLEGIO ALEMAN DE SANTIAGO / SOS','NUESTRA SEÑORA DEL ROSARIO 850','','VIDEOPORTERO','P'],
[-33.425653,-70.570196,'','PI 192 COLEGIO ANDINO ANTILLANCA / PTZ','SEBASTIAN ELCANO 1590','','PTZ','P'],
[-33.425653,-70.570196,'','PI 192 COLEGIO ANDINO ANTILLANCA / SOS','SEBASTIAN ELCANO 1590','','VIDEOPORTERO','P'],
[-33.389257,-70.531581,'','PI 193 COLEGIO BRITISH HIGH SCHOOL / PTZ','LOS GLADIOLOS 10031','','PTZ','P'],
[-33.389257,-70.531581,'','PI 193 COLEGIO BRITISH HIGH SCHOOL / SOS','LOS GLADIOLOS 10031','','VIDEOPORTERO','P'],
[-33.40915,-70.564771,'','PI 194 COLEGIO LIFE SUPPORT / PTZ','IV CENTENARIO 68','','PTZ','P'],
[-33.40915,-70.564771,'','PI 194 COLEGIO LIFE SUPPORT / SOS','IV CENTENARIO 68','','VIDEOPORTERO','P'],
[-33.413211,-70.55941,'','PI 195 COLEGIO CIUDADELA MONTESSORI / PTZ','IV CENTENARIO 605','','PTZ','P'],
[-33.413211,-70.55941,'','PI 195 COLEGIO CIUDADELA MONTESSORI / SOS','IV CENTENARIO 605','','VIDEOPORTERO','P'],
[-33.409437,-70.566742,'','PI 196 COLEGIO COMPAÑÍA DE MARÍA / PTZ','AV. MANQUEHUE SUR 116','','PTZ','P'],
[-33.409437,-70.566742,'','PI 196 COLEGIO COMPAÑÍA DE MARÍA / SOS','AV. MANQUEHUE SUR 116','','VIDEOPORTERO','P'],
[-33.396287,-70.513887,'','PI 197 COLEGIO CORDILLERA DE LAS CONDES / PTZ','LOS PUMAS 12015','','PTZ','P'],
[-33.396287,-70.513887,'','PI 197 COLEGIO CORDILLERA DE LAS CONDES / SOS','LOS PUMAS 12015','','VIDEOPORTERO','P'],
[-33.429265,-70.586696,'','PI 198 COLEGIO COYANCURA / PTZ','MARIANO SANCHEZ FONTECILLA 1552','','PTZ','P'],
[-33.429265,-70.586696,'','PI 198 COLEGIO COYANCURA / SOS','MARIANO SANCHEZ FONTECILLA 1552','','VIDEOPORTERO','P'],
[-33.394369,-70.504856,'','PI 199 COLEGIO CUMBRES / PTZ','AV. PLAZA 1150','','PTZ','P'],
[-33.394369,-70.504856,'','PI 199 COLEGIO CUMBRES / SOS','AV. PLAZA 1150','','VIDEOPORTERO','P'],
[-33.398647,-70.544789,'','PI 200 COLEGIO DALCAHUE / PTZ','PADRE HURTADO CENTRAL 605','','PTZ','P'],
[-33.398647,-70.544789,'','PI 200 COLEGIO DALCAHUE / SOS','PADRE HURTADO CENTRAL 605','','VIDEOPORTERO','P'],
[-33.374363,-70.520918,'','PI 201 COLEGIO DUNALASTAIR / PTZ','AV. LAS CONDES 11931','','PTZ','P'],
[-33.374363,-70.520918,'','PI 201 COLEGIO DUNALASTAIR / SOS','AV. LAS CONDES 11931','','VIDEOPORTERO','P'],
[-33.392114,-70.50925,'','PI 202 COLEGIO SAN FRANCISCO DE ASIS / PTZ','CERRO CATEDRAL NORTE 12150','','PTZ','P'],
[-33.392114,-70.50925,'','PI 202 COLEGIO SAN FRANCISCO DE ASIS / SOS','CERRO CATEDRAL NORTE 12150','','VIDEOPORTERO','P'],
[-33.424052,-70.555008,'','PI 203 COLEGIO INSTITUCION TERESIANA / PTZ','ISABEL LA CATOLICA 7445','','PTZ','P'],
[-33.424052,-70.555008,'','PI 203 COLEGIO INSTITUCION TERESIANA / SOS','ISABEL LA CATOLICA 7445','','VIDEOPORTERO','P'],
[-33.413619,-70.512481,'','PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / PTZ','FRANCISCO BULNES CORREA 3000','','PTZ','P'],
[-33.413619,-70.512481,'','PI 204 COLEGIO PADRE HURTADO Y JUANITA DE LOS ANDES / SOS','FRANCISCO BULNES CORREA 3000','','VIDEOPORTERO','P'],
[-33.43058,-70.563589,'','PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PTZ','FRANCISCO BILBAO 6300','','PTZ','P'],
[-33.43058,-70.563589,'','PI 205 COLEGIO KENDAL ENGLISH SCHOOL / SOS','FRANCISCO BILBAO 6300','','VIDEOPORTERO','P'],
[-33.420564,-70.568728,'','PI 206 COLEGIO LA GIOURETTE / PTZ','MAR DEL SUR 1238','','PTZ','P'],
[-33.420564,-70.568728,'','PI 206 COLEGIO LA GIOURETTE / SOS','MAR DEL SUR 1238','','VIDEOPORTERO','P'],
[-33.379334,-70.508343,'','PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / PTZ','AV. CHARLES HAMILTON 12880','','PTZ','P'],
[-33.379334,-70.508343,'','PI 207 COLEGIO NUESTRA SEÑORA DE LORETO / SOS','AV. CHARLES HAMILTON 12880','','VIDEOPORTERO','P'],
[-33.401524,-70.521361,'','PI 208 COLEGIO REDLAND SCHOOL / PTZ','CAMINO EL ALBA 11357','','PTZ','P'],
[-33.401524,-70.521361,'','PI 208 COLEGIO REDLAND SCHOOL / SOS','CAMINO EL ALBA 11357','','VIDEOPORTERO','P'],
[-33.419439,-70.588478,'','PI 209 COLEGIO SAIN PAUL MONTESSORI / PTZ','ALCÁNTARA 464','','PTZ','P'],
[-33.419439,-70.588478,'','PI 209 COLEGIO SAIN PAUL MONTESSORI / SOS','ALCÁNTARA 464','','VIDEOPORTERO','P'],
[-33.429551,-70.583641,'','PI 210 COLEGIO SAN JUAN DE LAS CONDES / PTZ','CANCILLER DOLLFUSS 1801','','PTZ','P'],
[-33.429551,-70.583641,'','PI 210 COLEGIO SAN JUAN DE LAS CONDES / SOS','CANCILLER DOLLFUSS 1801','','VIDEOPORTERO','P'],
[-33.430412,-70.574176,'','PI 211 COLEGIO SAN LUIS DE LAS CONDES / PTZ','VICTOR RAE 4420','','PTZ','P'],
[-33.430412,-70.574176,'','PI 211 COLEGIO SAN LUIS DE LAS CONDES / SOS','VICTOR RAE 4420','','VIDEOPORTERO','P'],
[-33.39377,-70.505077,'','PI 212 COLEGIO NICOLAS DE MYRA / PTZ','AV PLAZA 1157','','PTZ','P'],
[-33.39377,-70.505077,'','PI 212 COLEGIO NICOLAS DE MYRA / SOS','AV PLAZA 1157','','VIDEOPORTERO','P'],
[-33.39965,-70.50582,'','PI 213 COLEGIO SCUOLA ITALIANA / PTZ','CAMINO EL ALBA 12881','','PTZ','P'],
[-33.39965,-70.50582,'','PI 213 COLEGIO SCUOLA ITALIANA / SOS','CAMINO EL ALBA 12881','','VIDEOPORTERO','P'],
[-33.39483,-70.521538,'','PI 214 COLEGIO KILPATRICK / PTZ','CAMINO LAS FLORES 11280','','PTZ','P'],
[-33.39483,-70.521538,'','PI 214 COLEGIO KILPATRICK / SOS','CAMINO LAS FLORES 11280','','VIDEOPORTERO','P'],
[-33.413781,-70.574749,'','PI 215 COLEGIO MOUNIER / PTZ','ROSA O\'HIGGINS 298','','PTZ','P'],
[-33.413781,-70.574749,'','PI 215 COLEGIO MOUNIER / SOS','ROSA O\'HIGGINS 298','','VIDEOPORTERO','P'],
[-33.424902,-70.56184,'','PI 216 COLEGIO GUNMAN / PTZ','ISABEL LA CATÓLICA 6366','','PTZ','P'],
[-33.424902,-70.56184,'','PI 216 COLEGIO GUNMAN / SOS','ISABEL LA CATÓLICA 6366','','VIDEOPORTERO','P'],
[-33.38943,-70.531894,'LOS GLADIOLOS','LG1-01 - C 490','CAMPANARIO 499','APOQUINDO','FIJA','B'],
[-33.38943,-70.531894,'LOS GLADIOLOS','LG2-06 - LG 9861','CAMPANARIO 499','APOQUINDO','FIJA','B'],
[-33.389714,-70.532341,'LOS GLADIOLOS','LG1-02 - C 490','LOS GLADIOLOS 9930','APOQUINDO','FIJA','B'],
[-33.389714,-70.532341,'LOS GLADIOLOS','LG1-03 - LG 9930','LOS GLADIOLOS 9930','APOQUINDO','FIJA','B'],
[-33.389758,-70.532412,'LOS GLADIOLOS','LG1-04 - LG 9930','LOS GLADIOLOS 9885','APOQUINDO','FIJA','B'],
[-33.390279,-70.532877,'LOS GLADIOLOS','LG1-05 - LG 9885','LOS GLADIOLOS 9805','APOQUINDO','FIJA','B'],
[-33.389779,-70.533631,'LOS GLADIOLOS','LG1-07 - LG 9805','QUEPE 410','APOQUINDO','FIJA','B'],
[-33.389779,-70.533631,'LOS GLADIOLOS','LG1-08 - Q 433','QUEPE 410','APOQUINDO','FIJA','B'],
[-33.390497,-70.533115,'LOS GLADIOLOS','LG1-09 - Q 433','LOS GLADIOLOS 9763','APOQUINDO','FIJA','B'],
[-33.390778,-70.533428,'LOS GLADIOLOS','LG1-11 - LG 9763','LOS GLADIOLOS 9716','APOQUINDO','FIJA','B'],
[-33.390778,-70.533428,'LOS GLADIOLOS','LG1-12 - LG 9595','LOS GLADIOLOS 9716','APOQUINDO','FIJA','B'],
[-33.390758,-70.53349,'LOS GLADIOLOS','LG1-17 - H 386','LOS GLADIOLOS 9716','APOQUINDO','FIJA','B'],
[-33.391276,-70.533934,'LOS GLADIOLOS','LG1-18 - LG 9619','LOS GLADIOLOS 9619','APOQUINDO','FIJA','B'],
[-33.389974,-70.53262,'LOS GLADIOLOS','LG2-10 - Q 394','LOS GLADIOLOS 9861','APOQUINDO','FIJA','B'],
[-33.38929,-70.534331,'LOS GLADIOLOS','LG2-13 - LG 9595','PAUL HARRIS QUEPE','APOQUINDO','FIJA','B'],
[-33.39015,-70.534345,'LOS GLADIOLOS','LG2-14 - LG 9716','HUENTELAUQUEN 410','APOQUINDO','FIJA','B'],
[-33.39015,-70.534345,'LOS GLADIOLOS','LG2-15 - H 421','HUENTELAUQUEN 410','APOQUINDO','FIJA','B'],
[-33.389673,-70.535018,'LOS GLADIOLOS','LG2-16 - H 421','PAUL HARRIS HUENTELAUQUEN','APOQUINDO','FIJA','B'],
[-33.391317,-70.533955,'LOS GLADIOLOS','LG2-19 - M 511','MARBERIA 511','APOQUINDO','FIJA','B'],
[-33.391317,-70.533955,'LOS GLADIOLOS','LG2-20 - M 511','MARBERIA 511','APOQUINDO','FIJA','B'],
[-33.39079,-70.534701,'LOS GLADIOLOS','LG2-21 - M 433','MARBERIA 433','APOQUINDO','FIJA','B'],
[-33.39079,-70.534701,'LOS GLADIOLOS','LG2-22 - M 433','MARBERIA 433','APOQUINDO','FIJA','B'],
[-33.39012,-70.535617,'LOS GLADIOLOS','LG2-23 - M 361','PAUL HARRIS MARBERIA','APOQUINDO','FIJA','B'],
[-33.393223,-70.507113,'CUMBRES SAN JUAN','CSJ-01-PTZ - CSJ 12350','CUMBRE SAN JUAN 12350','SCDAPQ','PTZ','B'],
[-33.393223,-70.507113,'CUMBRES SAN JUAN','CSJ-02 - CSJ 12350','CUMBRE SAN JUAN 12350','SCDAPQ','FIJA','B'],
[-33.393223,-70.507113,'CUMBRES SAN JUAN','CSJ-03 - CSJ 12350','CUMBRE SAN JUAN 12350','SCDAPQ','FIJA','B'],
[-33.39324,-70.506804,'CUMBRES SAN JUAN','CSJ-04 - CSJ 12415','CUMBRE SAN JUAN 12415','SCDAPQ','FIJA','B'],
[-33.393625,-70.507064,'CUMBRES SAN JUAN','CSJ-05 - CSJ 12408','CUMBRE SAN JUAN 12408','SCDAPQ','FIJA','B'],
[-33.393625,-70.507064,'CUMBRES SAN JUAN','CSJ-06 - CSJ 12408','CUMBRE SAN JUAN 12408','SCDAPQ','FIJA','B'],
[-33.394005,-70.506323,'CUMBRES SAN JUAN','CSJ-07 - CSJ 12485','CUMBRE SAN JUAN 12485','SCDAPQ','FIJA','B'],
[-33.393645,-70.50595,'CUMBRES SAN JUAN','CSJ-08 - CSJ 12490','CUMBRE SAN JUAN 12490','SCDAPQ','FIJA','B'],
[-33.393645,-70.50595,'CUMBRES SAN JUAN','CSJ-09 - CSJ 12490','CUMBRE SAN JUAN 12490','SCDAPQ','FIJA','B'],
[-33.393645,-70.50595,'CUMBRES SAN JUAN','CSJ-10 - CSJ 12490','CUMBRE SAN JUAN 12490','SCDAPQ','FIJA','B'],
[-33.39324,-70.506804,'CUMBRES SAN JUAN','CSJ-11 - CSJ 12415','CUMBRE SAN JUAN 12415','SCDAPQ','FIJA','B'],
[-33.39324,-70.506804,'CUMBRES SAN JUAN','CSJ-12 - CSJ 12415','CUMBRE SAN JUAN 12415','SCDAPQ','FIJA','B'],
[-33.399393,-70.51017,'CAMINO LAS HOJAS','CLH-01 - SCDA 12212','SAN CARLOS DE APOQUINDO 12212','SCDAPQ','FIJA','B'],
[-33.399393,-70.51017,'CAMINO LAS HOJAS','CLH-02 - SCDA 12212','SAN CARLOS DE APOQUINDO 12212','SCDAPQ','FIJA','B'],
[-33.399098,-70.510554,'CAMINO LAS HOJAS','CLH-03 - CDLH 12298','CAMINO DE LAS HOJAS 12298','SCDAPQ','FIJA','B'],
[-33.399098,-70.510554,'CAMINO LAS HOJAS','CLH-04 - CDLH 12298','CAMINO DE LAS HOJAS 12298','SCDAPQ','FIJA','B'],
[-33.399084,-70.511045,'CAMINO LAS HOJAS','CLH-05 - CDLH 12233','CAMINO DE LAS HOJAS 12233','SCDAPQ','FIJA','B'],
[-33.399084,-70.511045,'CAMINO LAS HOJAS','CLH-06 - CDLH 12233','CAMINO DE LAS HOJAS 12233','SCDAPQ','FIJA','B'],
[-33.399084,-70.511045,'CAMINO LAS HOJAS','CLH-07 - CDLH 12233','CAMINO DE LAS HOJAS 12233','SCDAPQ','FIJA','B'],
[-33.399256,-70.511468,'CAMINO LAS HOJAS','CLH-08 - CDLH 12151','CAMINO DE LAS HOJAS 12151','SCDAPQ','FIJA','B'],
[-33.399256,-70.511468,'CAMINO LAS HOJAS','CLH-09 - CDLH 12151','CAMINO DE LAS HOJAS 12151','SCDAPQ','FIJA','B'],
[-33.39934,-70.511447,'CAMINO LAS HOJAS','CLH-10 - CDLH 12151','CAMINO DE LAS HOJAS 12151','SCDAPQ','FIJA','B'],
[-33.399422,-70.511768,'CAMINO LAS HOJAS','CLH-11 - CDLH 12145','CAMINO DE LAS HOJAS 12145','SCDAPQ','FIJA','B'],
[-33.399412,-70.512074,'CAMINO LAS HOJAS','CLH-12 - CP 1490','CERRO PINTOR 1490','SCDAPQ','FIJA','B'],
[-33.399412,-70.512074,'CAMINO LAS HOJAS','CLH-13 - CP 1490','CERRO PINTOR 1490','SCDAPQ','FIJA','B'],
[-33.420973,-70.545116,'CHIU CHIU TOCONAO','CCT-01 - ADC 8607','ALONSO DE CAMARGO 8607','FLEMING','FIJA','B'],
[-33.420973,-70.545116,'CHIU CHIU TOCONAO','CCT-02 - ADC 8607','ALONSO DE CAMARGO 8607','FLEMING','FIJA','B'],
[-33.421033,-70.545705,'CHIU CHIU TOCONAO','CCT-03 - ADC 8591','ALONSO DE CAMARGO 8591','FLEMING','FIJA','B'],
[-33.421033,-70.545705,'CHIU CHIU TOCONAO','CCT-04 - ADC 8591','ALONSO DE CAMARGO 8591','FLEMING','FIJA','B'],
[-33.420543,-70.545785,'CHIU CHIU TOCONAO','CCT-05 - CC 1229','CHIU CHIU 1229','FLEMING','FIJA','B'],
[-33.420313,-70.545748,'CHIU CHIU TOCONAO','CCT-06 - CC 1207','CHIU CHIU 1207','FLEMING','FIJA','B'],
[-33.419983,-70.545809,'CHIU CHIU TOCONAO','CCT-07 - CC 1179','CHIU CHIU 1179','FLEMING','FIJA','B'],
[-33.419983,-70.545809,'CHIU CHIU TOCONAO','CCT-08 - CC 1179','CHIU CHIU 1179','FLEMING','FIJA','B'],
[-33.419572,-70.54583,'CHIU CHIU TOCONAO','CCT-09 - CC 1164','CHIU CHIU 1164','FLEMING','FIJA','B'],
[-33.419487,-70.545783,'CHIU CHIU TOCONAO','CCT-10 - Z 8580','ZARAGOZA 8580','FLEMING','FIJA','B'],
[-33.419527,-70.545124,'CHIU CHIU TOCONAO','CCT-11 - T 1208','TOCONAO 1208','FLEMING','FIJA','B'],
[-33.420021,-70.545108,'CHIU CHIU TOCONAO','CCT-12 - T 1208','TOCONAO 1208','FLEMING','FIJA','B'],
[-33.421033,-70.545705,'CHIU CHIU TOCONAO','CCT-13 - ADC 8591','ALONSO DE CAMARGO 8591','FLEMING','FIJA','B'],
[-33.39023,-70.529788,'LOS CARPINTEROS','LC-01 - LC 10123','LOS CARPINTEROS 10123','APOQUINDO','FIJA','B'],
[-33.389731,-70.530339,'LOS CARPINTEROS','LC-02 - LC 10176','LOS CARPINTEROS 10176','APOQUINDO','FIJA','B'],
[-33.389731,-70.530339,'LOS CARPINTEROS','LC-03 - LC 10176','LOS CARPINTEROS 10176','APOQUINDO','FIJA','B'],
[-33.389696,-70.530396,'LOS CARPINTEROS','LC-04-PTZ - LC 10132','LOS CARPINTEROS 10132','APOQUINDO','PTZ','B'],
[-33.407191,-70.535608,'LA ESCUELA','LEGB-01 - GB 9395','GENERAL BLANCHE 9395','SCDAPQ','FIJA','B'],
[-33.40776,-70.535354,'LA ESCUELA','LEGB-02 - LE 379','LA ESCUELA 379','SCDAPQ','FIJA','B'],
[-33.407658,-70.535216,'LA ESCUELA','LEGB-03 - LE 374','LA ESCUELA 374','SCDAPQ','FIJA','B'],
[-33.407658,-70.535216,'LA ESCUELA','LEGB-04 - LE 374','LA ESCUELA 374','SCDAPQ','FIJA','B'],
[-33.408405,-70.534912,'LA ESCUELA','LEGB-05 - LE 442','LA ESCUELA 442','SCDAPQ','FIJA','B'],
[-33.408405,-70.534912,'LA ESCUELA','LEGB-06 - LE 442','LA ESCUELA 442','SCDAPQ','FIJA','B'],
[-33.408886,-70.53492,'LA ESCUELA','LEGB-07 - LE 475','LA ESCUELA 475','SCDAPQ','FIJA','B'],
[-33.388783,-70.503802,'SAN BENITO','SB-01 - SB 12295','SAN BENITO 12295','SCDAPQ','FIJA','B'],
[-33.388058,-70.504297,'SAN BENITO','SB-02 - SB 12222','SAN BENITO 12222','SCDAPQ','FIJA','B'],
[-33.388122,-70.504565,'SAN BENITO','SB-03 - SB 12196','SAN BENITO 12196','SCDAPQ','FIJA','B'],
[-33.387741,-70.504928,'SAN BENITO','SB-04 - SB 12154','SAN BENITO 12154','SCDAPQ','FIJA','B'],
[-33.387741,-70.504928,'SAN BENITO','SB-05 - SB 12154','SAN BENITO 12154','SCDAPQ','FIJA','B'],
[-33.387409,-70.505304,'SAN BENITO','SB-06 - SB 12150','San Benito 12150','SCDAPQ','FIJA','B'],
[-33.387608,-70.505664,'SAN BENITO','SB-07 - EC 803','EL CONVENTO 803','SCDAPQ','FIJA','B'],
[-33.38803,-70.50519,'SAN BENITO','SB-08-PTZ - EO 12161','EL OBISPO 12161','SCDAPQ','PTZ','B'],
[-33.388295,-70.504738,'SAN BENITO','SB-09 - EO - 12195','EL OBISPO 12195','SCDAPQ','FIJA','B'],
[-33.388469,-70.504848,'SAN BENITO','SB-10 - EM 821','EL MONASTERIO 821','SCDAPQ','FIJA','B'],
[-33.388917,-70.505406,'SAN BENITO','SB-11 - EM 838','EL MONASTERIO 838','SCDAPQ','FIJA','B'],
[-33.388578,-70.504847,'SAN BENITO','SB-12 - EM 826','EL MONASTERIO 826','SCDAPQ','FIJA','B'],
[-33.388397,-70.504493,'SAN BENITO','SB-13 - EM 814','EL MONASTERIO 814','SCDAPQ','FIJA','B'],
[-33.413754,-70.531416,'LOMA VERDE','CLV-01-PTZ - LV 934','LOMA VERDE 934','SCDAPQ','PTZ','B'],
[-33.413754,-70.531416,'LOMA VERDE','CLV-02 - LV 934','LOMA VERDE 934','SCDAPQ','FIJA','B'],
[-33.413328,-70.53151,'LOMA VERDE','CLV-03 - LV 929','LOMA VERDE 929','SCDAPQ','FIJA','B'],
[-33.413109,-70.531569,'LOMA VERDE','CLV-04 - LV 926','LOMA VERDE 926','SCDAPQ','FIJA','B'],
[-33.413109,-70.531569,'LOMA VERDE','CLV-05 - LV 926','LOMA VERDE 926','SCDAPQ','FIJA','B'],
[-33.412328,-70.532126,'LOMA VERDE','CLV-06 - LV 912','LOMA VERDE 912','SCDAPQ','FIJA','B'],
[-33.412328,-70.532126,'LOMA VERDE','CLV-07 - LV 912','LOMA VERDE 912','SCDAPQ','FIJA','B'],
[-33.412374,-70.532568,'LOMA VERDE','CLV-08-PTZ - LE 906','LA ESCUELA 906','SCDAPQ','PTZ','B'],
[-33.412374,-70.532568,'LOMA VERDE','CLV-09 - LE 906','LA ESCUELA 906','SCDAPQ','FIJA','B'],
[-33.39965,-70.568561,'CERRO COLORADO','CC-01 - CC 6160','CERRO COLORADO 6160','EL GOLF','FIJA','B'],
[-33.39965,-70.568561,'CERRO COLORADO','CC-02 - CC 6160','CERRO COLORADO 6160','EL GOLF','FIJA','B'],
[-33.400034,-70.569333,'CERRO COLORADO','CC-03 - CC 6130','CERRO COLORADO 6130','EL GOLF','FIJA','B'],
[-33.400034,-70.569333,'CERRO COLORADO','CC-05 - CC 6130','CERRO COLORADO 6130','EL GOLF','FIJA','B'],
[-33.400056,-70.569319,'CERRO COLORADO','CC-04 - CC 6130','CERRO COLORADO 6130','EL GOLF','FIJA','B'],
[-33.400056,-70.569319,'CERRO COLORADO','CC-06 - CC 6130','CERRO COLORADO 6130','EL GOLF','FIJA','B'],
[-33.400395,-70.570072,'CERRO COLORADO','CC-07 - CC 6110','CERRO COLORADO 6110','EL GOLF','FIJA','B'],
[-33.409928,-70.558034,'PASAJE ICTINO NORTE','PIN-01 - AI 286','ARQUITECTO ICTINOS 286','APOQUINDO','FIJA','B'],
[-33.409832,-70.55804,'PASAJE ICTINO NORTE','PIN-02 - AI 273','ARQUITECTO ICTINOS 273','APOQUINDO','FIJA','B'],
[-33.409832,-70.55804,'PASAJE ICTINO NORTE','PIN-03 - AI 273','ARQUITECTO ICTINOS 273','APOQUINDO','FIJA','B'],
[-33.409347,-70.557806,'PASAJE ICTINO NORTE','PIN-04 - AI 245','ARQUITECTO ICTINOS 245','APOQUINDO','FIJA','B'],
[-33.409347,-70.557806,'PASAJE ICTINO NORTE','PIN-05 - AI 245','ARQUITECTO ICTINOS 245','APOQUINDO','FIJA','B'],
[-33.409009,-70.557646,'PASAJE ICTINO NORTE','PIN-06 - AI 225','ARQUITECTO ICTINOS 225','APOQUINDO','FIJA','B'],
[-33.408814,-70.557526,'PASAJE ICTINO NORTE','PIN-07-PTZ - AI 203','ARQUITECTO ICTINOS 203','APOQUINDO','PTZ','B'],
[-33.408814,-70.557526,'PASAJE ICTINO NORTE','PIN-08 - AI 203','ARQUITECTO ICTINOS 203','APOQUINDO','FIJA','B'],
[-33.390988,-70.520902,'CAMINO LA FUENTE - LAS FLORES','CLFLF-01 - CLF 1158','CAMINO LA FUENTE 1158','SCDAPQ','FIJA','B'],
[-33.390973,-70.520827,'CAMINO LA FUENTE - LAS FLORES','CLFLF-02 - CLF 1158','CAMINO LA FUENTE 1158','SCDAPQ','FIJA','B'],
[-33.389049,-70.511096,'BEURON','B-01-PTZ - LM 970','LOS MAITENES 970','SCDAPQ','PTZ','B'],
[-33.388937,-70.511084,'BEURON','B-02 - LM 937','LOS MAITENES 937','SCDAPQ','FIJA','B'],
[-33.388422,-70.511982,'BEURON','B-03 - B 11882','BEURON 11882','SCDAPQ','FIJA','B'],
[-33.388422,-70.511982,'BEURON','B-04 - B 11882','BEURON 11882','SCDAPQ','FIJA','B'],
[-33.38795,-70.512999,'BEURON','B-05 - B 11821','BEURON 11821','SCDAPQ','FIJA','B'],
[-33.38795,-70.512999,'BEURON','B-06 - B 11821','BEURON 11821','SCDAPQ','FIJA','B'],
[-33.387845,-70.513236,'BEURON','B-07-PTZ - FBC 912','FRANCISCO BULNES CORREA 912','SCDAPQ','PTZ','B'],
[-33.390245,-70.50935,'EL CAMPANIL','EC-01 - EC 994','EL CAMPANIL 994','SCDAPQ','FIJA','B'],
[-33.389796,-70.509045,'EL CAMPANIL','EC-02 - EC 980','EL CAMPANIL 980','SCDAPQ','FIJA','B'],
[-33.389796,-70.509045,'EL CAMPANIL','EC-03 - EC 980','EL CAMPANIL 980','SCDAPQ','FIJA','B'],
[-33.3895,-70.508843,'EL CAMPANIL','EC-04 - EC 950','EL CAMPANIL 950','SCDAPQ','FIJA','B'],
[-33.3895,-70.508843,'EL CAMPANIL','EC-05 - EC 950','EL CAMPANIL 950','SCDAPQ','FIJA','B'],
[-33.389172,-70.508627,'EL CAMPANIL','EC-06 - EC 926','EL CAMPANIL 926','SCDAPQ','FIJA','B'],
[-33.389172,-70.508627,'EL CAMPANIL','EC-07 - EC 926','EL CAMPANIL 926','SCDAPQ','FIJA','B'],
[-33.388799,-70.508379,'EL CAMPANIL','EC-08 - LM 12060','LOS MONJES 12060','SCDAPQ','FIJA','B'],
[-33.388711,-70.508664,'EL CAMPANIL','EC-09 - LM 12042','LOS MONJES 12042','SCDAPQ','FIJA','B'],
[-33.391924,-70.530754,'FRAY CHARLES','FC-01 - CH 9633','CHARLES HAMILTON 9633','APOQUINDO','FIJA','B'],
[-33.392333,-70.531854,'FRAY CHARLES','FC-02 - CH 9351','CHARLES HAMILTON 9351','APOQUINDO','FIJA','B'],
[-33.39254,-70.532566,'FRAY CHARLES','FC-03-PTZ - CH 9307','CHARLES HAMILTON 9307','APOQUINDO','PTZ','B'],
[-33.392685,-70.532414,'FRAY CHARLES','FC-04 - FPS 925','FRAY PEDRO SUBERCASEUX 925','APOQUINDO','FIJA','B'],
[-33.39411,-70.531075,'FRAY CHARLES','FC-05 - RLF 1205','ROTONDA LAS FLORES 1205','APOQUINDO','FIJA','B'],
[-33.42344,-70.540735,'TOCONCE','T-01 - T A','TOCONCE & ASCOTAN','FLEMING','FIJA','B'],
[-33.42344,-70.540735,'TOCONCE','T-02 - T A','TOCONCE & ASCOTAN','FLEMING','FIJA','B'],
[-33.42344,-70.540735,'TOCONCE','T-03 - T A','TOCONCE & ASCOTAN','FLEMING','FIJA','B'],
[-33.422847,-70.540798,'TOCONCE','T-04 - T 1520','TOCONCE 1530','FLEMING','FIJA','B'],
[-33.422847,-70.540798,'TOCONCE','T-05 - T 1520','TOCONCE 1530','FLEMING','FIJA','B'],
[-33.4224,-70.540813,'TOCONCE','T-06 -PTZ - T 1501','TOCONCE 1481','FLEMING','PTZ','B'],
[-33.422288,-70.540765,'TOCONCE','T-07 - T 1496','TOCONCE & ROBERTO GUZMAN','FLEMING','FIJA','B'],
[-33.422627,-70.54078,'TOCONCE','T-08 - T RG','TOCONCE 1501','FLEMING','FIJA','B'],
[-33.4222284,-70.5403403,'TOCONCE','T-09 - PTZ - RG 1439','ROBERTO GUZMAN 8885','FLEMING','PTZ','B'],
[-33.40464,-70.540375,'CANTERBURY ISLANDIA','CI-01 - I 9154','ISLANDIA 9154','APOQUINDO','FIJA','B'],
[-33.404894,-70.541645,'CANTERBURY ISLANDIA','CI-02 - I 9116','ISLANDIA 9116','APOQUINDO','FIJA','B'],
[-33.404781,-70.541101,'CANTERBURY ISLANDIA','CI-03-PTZ - I 9127','ISLANDIA 9127','APOQUINDO','PTZ','B'],
[-33.404304,-70.54127,'CANTERBURY ISLANDIA','CI-04 - C 1360','CANTERBURY 1360','APOQUINDO','FIJA','B'],
[-33.404304,-70.54127,'CANTERBURY ISLANDIA','CI-05 - C 1360','CANTERBURY 1360','APOQUINDO','FIJA','B'],
[-33.403969,-70.541374,'CANTERBURY ISLANDIA','CI-06 - C 1343','CARTERBURY 1343','APOQUINDO','FIJA','B'],
[-33.403969,-70.541374,'CANTERBURY ISLANDIA','CI-07 - C 1343','CARTERBURY 1343','APOQUINDO','FIJA','B'],
[-33.403592,-70.541497,'CANTERBURY ISLANDIA','CI-08 - C 1221','CANTERBURY 1221','APOQUINDO','FIJA','B'],
[-33.403592,-70.541497,'CANTERBURY ISLANDIA','CI-09 - C 1221','CANTERBURY 1221','APOQUINDO','FIJA','B'],
[-33.410775,-70.533063,'LUIS MATTE LARRAIN 3','LML3-01 - LML 732','LUIS MATTE LARRAIN 764','SCDAPQ','FIJA','B'],
[-33.410326,-70.5336,'LUIS MATTE LARRAIN 3','LML3-02 - LML 680','LUIS MATTE LARRAIN 680','SCDAPQ','FIJA','B'],
[-33.410326,-70.5336,'LUIS MATTE LARRAIN 3','LML3-03-PTZ - LML 680','LUIS MATTE LARRAIN 680','SCDAPQ','PTZ','B'],
[-33.410099,-70.533447,'LUIS MATTE LARRAIN 3','LML3-04 - LML 657','LUIS MATTE LARRAIN 657','SCDAPQ','FIJA','B'],
[-33.410099,-70.533447,'LUIS MATTE LARRAIN 3','LML3-05 - LML 657','LUIS MATTE LARRAIN 657','SCDAPQ','FIJA','B'],
[-33.409623,-70.533632,'LUIS MATTE LARRAIN 3','LML3-06 - LML 621','LUIS MATTE LARRAIN 621','SCDAPQ','FIJA','B'],
[-33.408695,-70.533985,'LUIS MATTE LARRAIN 3','LML3-07 - LML 496','LUIS MATTE LARRAIN 9880','SCDAPQ','FIJA','B'],
[-33.403076,-70.50994,'SANTOS APOSTOLES','SA-01 - SA 2266','SANTOS APOSTOLES 2266','SCDAPQ','FIJA','B'],
[-33.404961,-70.50929,'SANTOS APOSTOLES','SA-02 - SA 2416','SANTOS APOSTOLES 2416','SCDAPQ','FIJA','B'],
[-33.404961,-70.50929,'SANTOS APOSTOLES','SA-03 - SA 2416','SANTOS APOSTOLES 2416','SCDAPQ','FIJA','B'],
[-33.406308,-70.508797,'SANTOS APOSTOLES','SA-04 - SA 2542','SANTOS APOSTOLES 2542','SCDAPQ','FIJA','B'],
[-33.403352,-70.519332,'OTOÑAL 2017','O-01 - GB 1598','GENERAL BLANCHE 1598','SCDAPQ','FIJA','B'],
[-33.40373,-70.51927,'OTOÑAL 2017','O-02 - CO 1801','CAMINO OTOÑAL 1801','SCDAPQ','FIJA','B'],
[-33.404472,-70.519085,'OTOÑAL 2017','O-03 - CO 1902','CAMINO OTOÑAL 1902','SCDAPQ','FIJA','B'],
[-33.40447,-70.51908,'OTOÑAL 2017','O-04 - CO 1902','CAMINO OTOÑAL 1902','SCDAPQ','FIJA','B'],
[-33.40516,-70.51882,'OTOÑAL 2017','O-05-PTZ - CO 1958','CAMINO OTOÑAL 1958','SCDAPQ','PTZ','B'],
[-33.405586,-70.518617,'OTOÑAL 2017','O-06 - CO 2046','CAMINO OTOÑAL 2046','SCDAPQ','FIJA','B'],
[-33.405586,-70.518617,'OTOÑAL 2017','O-07 - CO 2046','CAMINO OTOÑAL 2046','SCDAPQ','FIJA','B'],
[-33.406121,-70.518273,'OTOÑAL 2017','O-08 - CO 2595','CAMINO OTOÑAL 2595','SCDAPQ','FIJA','B'],
[-33.406551,-70.518004,'OTOÑAL 2017','O-09 - CO 2881','CAMINO OTOÑAL 2881','SCDAPQ','FIJA','B'],
[-33.4217289,-70.5948292,'MARNE Y UNAMUNO','MU-01 - U 547','Unamuno 547','EL GOLF','FIJA','B'],
[-33.4218146,-70.5947283,'MARNE Y UNAMUNO','MU-02 - U 550','Unamuno 550','EL GOLF','FIJA','B'],
[-33.4219406,-70.594563,'MARNE Y UNAMUNO','MU-03 - U 560','Unamuno 560','EL GOLF','FIJA','B'],
[-33.4222113,-70.5942126,'MARNE Y UNAMUNO','MU-04 - U 607','Unamuno 607','EL GOLF','FIJA','B'],
[-33.4222113,-70.5942126,'MARNE Y UNAMUNO','MU-05 - U 607','Unamuno 607','EL GOLF','FIJA','B'],
[-33.4226448,-70.5936415,'MARNE Y UNAMUNO','MU-06 - U 691','Unamuno 691','EL GOLF','FIJA','B'],
[-33.4229896,-70.5931623,'MARNE Y UNAMUNO','MU-07 - U 779','Unamuno 779','EL GOLF','FIJA','B'],
[-33.4229896,-70.5931623,'MARNE Y UNAMUNO','MU-08 - U 779','Unamuno 779','EL GOLF','FIJA','B'],
[-33.4227505,-70.594144,'MARNE Y UNAMUNO','MU-09 - M 2956','Marne 2956','EL GOLF','FIJA','B'],
[-33.4227505,-70.594144,'MARNE Y UNAMUNO','MU-10 - M 2956','Marne 2956','EL GOLF','FIJA','B'],
[-33.4223876,-70.5937321,'MARNE Y UNAMUNO','MU-11 - M 3031','Marne 3031','EL GOLF','FIJA','B'],
[-33.4221376,-70.5934628,'MARNE Y UNAMUNO','MU-12 - M 3172','Marne 3172','EL GOLF','FIJA','B'],
[-33.4221376,-70.5934628,'MARNE Y UNAMUNO','MU-13 - M 3172','Marne 3172','EL GOLF','FIJA','B'],
[-33.4218355,-70.5931692,'MARNE Y UNAMUNO','MU-14 - SC 585','San Crescente 585','EL GOLF','FIJA','B'],
[-33.4234787,-70.5925564,'MARNE Y UNAMUNO','MU-15 - U 853','Unamuno 853','EL GOLF','FIJA','B'],
[-33.4234787,-70.5925564,'MARNE Y UNAMUNO','MU-16 - U 853','Unamuno 853','EL GOLF','FIJA','B'],
[-33.381614,-70.517817,'BENEDICTINOS','BEN-01-PTZ - CLV 11933','CAMINO LA VIÑA 11933','SCDAPQ','PTZ','B'],
[-33.381657,-70.51777,'BENEDICTINOS','BEN-02 - CFJ 765','CAMINO FRAY JORGE 765','SCDAPQ','FIJA','B'],
[-33.381657,-70.51777,'BENEDICTINOS','BEN-03 - CFJ 765','CAMINO FRAY JORGE 765','SCDAPQ','FIJA','B'],
[-33.382285,-70.517268,'BENEDICTINOS','BEN-04-PTZ - CFJ 777','CAMINO FRAY JORGE 777','SCDAPQ','PTZ','B'],
[-33.382376,-70.517199,'BENEDICTINOS','BEN-05 - CFJ 798','CAMINO FRAY JORGE 798','SCDAPQ','FIJA','B'],
[-33.382376,-70.517199,'BENEDICTINOS','BEN-06 - CFJ 798','CAMINO FRAY JORGE 798','SCDAPQ','FIJA','B'],
[-33.382653,-70.516991,'BENEDICTINOS','BEN-07 - CFJ 807','CAMINO FRAY JORGE 807','SCDAPQ','FIJA','B'],
[-33.377158,-70.516457,'FRAY BERNARDO','FBA-01 - FB 12236','FRAY BERNARDO 12236','SCDAPQ','FIJA','B'],
[-33.377158,-70.516457,'FRAY BERNARDO','FBA-02 - FB 12236','FRAY BERNARDO 12236','SCDAPQ','FIJA','B'],
[-33.377538,-70.517135,'FRAY BERNARDO','FBA-03 - FB 12195','FRAY BERNARDO 12195','SCDAPQ','FIJA','B'],
[-33.377538,-70.517135,'FRAY BERNARDO','FBA-04 - FB 12200','FRAY BERNARDO 12200','SCDAPQ','FIJA','B'],
[-33.377457,-70.517016,'FRAY BERNARDO','FBA-05 - FB 12120','FRAY BERNARDO 12120','SCDAPQ','FIJA','B'],
[-33.377457,-70.517016,'FRAY BERNARDO','FBA-06 - FB 12120','FRAY BERNARDO 12120','SCDAPQ','FIJA','B'],
[-33.377606,-70.517351,'FRAY BERNARDO','FBA-07-PTZ - FB 12109','FRAY BERNARDO 12109','SCDAPQ','PTZ','B'],
[-33.377333,-70.516811,'FRAY BERNARDO','FBB-01 - FB 11958','FRAY BERBARDO 11958','SCDAPQ','FIJA','B'],
[-33.377333,-70.516811,'FRAY BERNARDO','FBB-02 - FB 11958','FRAY BERBARDO 11958','SCDAPQ','FIJA','B'],
[-33.378301,-70.51888,'FRAY BERNARDO','FBB-03 - FB 11854','FRAY BERBARDO 11854','SCDAPQ','FIJA','B'],
[-33.378301,-70.51888,'FRAY BERNARDO','FBB-04 - FB 11854','FRAY BERBARDO 11854','SCDAPQ','FIJA','B'],
[-33.37814,-70.50718,'CAMINO SAN ANTONIO','CSA-01 - CSA 1026','CAMINO SAN ANTONIO 1026','SCDAPQ','FIJA','B'],
[-33.37814,-70.50718,'CAMINO SAN ANTONIO','CSA-02 - CSA 1026','CAMINO SAN ANTONIO 1026','SCDAPQ','FIJA','B'],
[-33.37702,-70.50778,'CAMINO SAN ANTONIO','CSA-03-PTZ - CSA 910','CAMINO SAN ANTONIO 910','SCDAPQ','PTZ','B'],
[-33.37702,-70.50778,'CAMINO SAN ANTONIO','CSA-04 - CSA 910','CAMINO SAN ANTONIO 910','SCDAPQ','FIJA','B'],
[-33.376524,-70.50815,'CAMINO SAN ANTONIO','CSA-05 - CSA 821','CAMINO SAN ANTONIO 821','SCDAPQ','FIJA','B'],
[-33.376203,-70.508436,'CAMINO SAN ANTONIO','CSA-06 - CSA 782','CAMINO SAN ANTONIO 782','SCDAPQ','FIJA','B'],
[-33.376085,-70.508573,'CAMINO SAN ANTONIO','CSA-07 - CSA 782','CAMINO SAN ANTONIO 782','SCDAPQ','FIJA','B'],
[-33.395612,-70.541096,'CARDENAL NEWMAN','CNN-01 - CN 470','CARDENAL NEWMAN 470','APOQUINDO','FIJA','B'],
[-33.395561,-70.541145,'CARDENAL NEWMAN','CNN-02 - CN 470','CARDENAL NEWMAN 470','APOQUINDO','FIJA','B'],
[-33.394254,-70.540768,'CARDENAL NEWMAN','CNN-03 - CN 394','CARDENAL NEWMAN 394','APOQUINDO','FIJA','B'],
[-33.394051,-70.541652,'CARDENAL NEWMAN','CNN-04 - D 9136','DUNKERQUE 9136','APOQUINDO','FIJA','B'],
[-33.396678,-70.541083,'CARDENAL NEWMAN','CNS-01 - CN 507','CARDENAL NEWMAN 507','APOQUINDO','FIJA','B'],
[-33.396678,-70.541083,'CARDENAL NEWMAN','CNS-02 - CN 507','CARDENAL NEWMAN 507','APOQUINDO','FIJA','B'],
[-33.397513,-70.541119,'CARDENAL NEWMAN','CNS-03-PTZ - CN 536','CARDENAL NEWMAN 536','APOQUINDO','PTZ','B'],
[-33.398592,-70.541134,'CARDENAL NEWMAN','CNS-04 - CN 576','CARDENAL NEWMAN 576','APOQUINDO','FIJA','B'],
[-33.398592,-70.541134,'CARDENAL NEWMAN','CNS-05 - CN 576','CARDENAL NEWMAN 576','APOQUINDO','FIJA','B'],
[-33.410742,-70.5987,'CERRO SAN LUIS','CSL-01 - LP 2991','LAS PENAS 2991','EL GOLF','FIJA','B'],
[-33.411047,-70.597371,'CERRO SAN LUIS','CSL-02 - LP 3114','LAS PENAS 3114 C','EL GOLF','FIJA','B'],
[-33.411047,-70.597371,'CERRO SAN LUIS','CSL-03 - LP 3114','LAS PENAS 3114 C','EL GOLF','FIJA','B'],
[-33.411445,-70.596287,'CERRO SAN LUIS','CSL-04 - LP 3297','LAS PEÑAS 3297','EL GOLF','FIJA','B'],
[-33.411445,-70.596287,'CERRO SAN LUIS','CSL-05 - LP 3297','LAS PEÑAS 3297','EL GOLF','FIJA','B'],
[-33.41144,-70.598399,'CERRO SAN LUIS','CSL-06 - CDA 3051','CRISTAL DE ABELLI 3051','EL GOLF','FIJA','B'],
[-33.41144,-70.598399,'CERRO SAN LUIS','CSL-07 - CDA 3051','CRISTAL DE ABELLI 3051','EL GOLF','FIJA','B'],
[-33.41352,-70.528766,'COLINA DEL PEUMO','CP-01 - CPO 9702','Carlos Peña Otagui 9702','SCDAPQ','FIJA','B'],
[-33.413642,-70.528827,'COLINA DEL PEUMO','CP-02 - CP 921','Colina del Peumo 921','SCDAPQ','FIJA','B'],
[-33.414141,-70.528748,'COLINA DEL PEUMO','CP-03 - CP 927','Colina del Peumo 927','SCDAPQ','FIJA','B'],
[-33.414402,-70.528688,'COLINA DEL PEUMO','CP-04-PTZ - CP 935','Colina del Peumo 935','SCDAPQ','PTZ','B'],
[-33.414402,-70.528688,'COLINA DEL PEUMO','CP-05 - CP 935','Colina del Peumo 935','SCDAPQ','FIJA','B'],
[-33.414533,-70.528662,'COLINA DEL PEUMO','CP-06 - CP 937','Colina del Peumo 937','SCDAPQ','FIJA','B'],
[-33.414533,-70.528662,'COLINA DEL PEUMO','CP-07 - CP 937','Colina del Peumo 937','SCDAPQ','FIJA','B'],
[-33.414416,-70.528432,'COLINA DEL PEUMO','CP-08 - CP 951','Colina del Peumo 951','SCDAPQ','FIJA','B'],
[-33.414363,-70.528006,'COLINA DEL PEUMO','CP-09-PTZ - CP 956','Colina del Peumo 956','SCDAPQ','PTZ','B'],
[-33.414363,-70.528006,'COLINA DEL PEUMO','CP-10 - CP 956','Colina del Peumo 956','SCDAPQ','FIJA','B'],
[-33.414374,-70.527713,'COLINA DEL PEUMO','CP-11 - CP 968','Colina del Peumo 968','SCDAPQ','FIJA','B'],
[-33.414374,-70.527713,'COLINA DEL PEUMO','CP-12 - CP 968','Colina del Peumo 968','SCDAPQ','FIJA','B'],
[-33.41448,-70.527266,'COLINA DEL PEUMO','CP-13 - CP 974','Colina del Peumo 974','SCDAPQ','FIJA','B'],
[-33.41448,-70.527266,'COLINA DEL PEUMO','CP-14 - CP 974','Colina del Peumo 974','SCDAPQ','FIJA','B'],
[-33.414544,-70.52698,'COLINA DEL PEUMO','CP-15 - CP 978','Colina del Peumo 978','SCDAPQ','FIJA','B'],
[-33.414485,-70.526958,'COLINA DEL PEUMO','CP-16 - CP 981','Colina del Peumo 981','SCDAPQ','FIJA','B'],
[-33.380287,-70.524857,'VALLE FRAY','VF-01 - FL 11335','FRAY LEON 11335','SCDAPQ','FIJA','B'],
[-33.380904,-70.526131,'VALLE FRAY','VF-02 - FL 11200','FRAY LEON 11200','SCDAPQ','FIJA','B'],
[-33.380904,-70.526131,'VALLE FRAY','VF-05 - FL 11200','FRAY LEON 11200','SCDAPQ','FIJA','B'],
[-33.381467,-70.527558,'VALLE FRAY','VF-03 - FL 11140','FRAY LEON 11140','SCDAPQ','FIJA','B'],
[-33.381039,-70.527558,'VALLE FRAY','VF-04 - FL 11180','FRAY LEON 11180','SCDAPQ','FIJA','B'],
[-33.381775,-70.52578,'VALLE FRAY','VF-06 - VA 430','VALLE ALEGRE 430','SCDAPQ','FIJA','B'],
[-33.381775,-70.52578,'VALLE FRAY','VF-07 - VA 430','VALLE ALEGRE 430','SCDAPQ','FIJA','B'],
[-33.382056,-70.526353,'VALLE FRAY','VF-08 - VA 505','VALLE ALEGRE 505','SCDAPQ','FIJA','B'],
[-33.381857,-70.525963,'VALLE FRAY','VF-09 - VA 505','VALLE ALEGRE 505','SCDAPQ','FIJA','B'],
[-33.382134,-70.525564,'VALLE FRAY','VF-10 - VA 445','VALLE ALEGRE 445','SCDAPQ','FIJA','B'],
[-33.376052,-70.515586,'LA CABAÑA','LCS-09 - CSFDA 387','CAMINO SAN FRANCISCO DE ASIS 387','SCDAPQ','FIJA','B'],
[-33.374421,-70.511138,'LA CABAÑA','LCN-01 - FM 12853','FRAY MARTIN 12853','SCDAPQ','FIJA','B'],
[-33.37385,-70.511349,'LA CABAÑA','LCN-02-PTZ - LC 316','LA CABAÑA 316','SCDAPQ','PTZ','B'],
[-33.372892,-70.511883,'LA CABAÑA','LCN-03 - LC 270','LA CABAÑA 270','SCDAPQ','FIJA','B'],
[-33.372892,-70.511883,'LA CABAÑA','LCN-04 - LC 270','LA CABAÑA 270','SCDAPQ','FIJA','B'],
[-33.376161,-70.510442,'LA CABAÑA','LCS-01 - CLP 12866','CAMINO LA POSADA 12866','SCDAPQ','FIJA','B'],
[-33.376074,-70.510167,'LA CABAÑA','LCS-02 - CLP 12889','CAMINO LA POSADA 12889','SCDAPQ','FIJA','B'],
[-33.375553,-70.510364,'LA CABAÑA','LCS-03 - LC 606','LA CABAÑA 606','SCDAPQ','FIJA','B'],
[-33.375553,-70.510364,'LA CABAÑA','LCS-04 - LC 606','LA CABAÑA 606','SCDAPQ','FIJA','B'],
[-33.375193,-70.510603,'LA CABAÑA','LCS-05 - LC 606','LA CABAÑA 606','SCDAPQ','FIJA','B'],
[-33.375802,-70.512199,'LA CABAÑA','LCS-06 - FB 12702','FRAY BERNARDO 12702','SCDAPQ','FIJA','B'],
[-33.375802,-70.512199,'LA CABAÑA','LCS-07 - FB 12702','FRAY BERNARDO 12702','SCDAPQ','FIJA','B'],
[-33.375699,-70.512456,'LA CABAÑA','LCS-08 - FG 483','FRAY GABRIEL 483','SCDAPQ','FIJA','B'],
[-33.412614,-70.527987,'COLINA MIRAVALLE','CMIR-01-PTZ - CM 9721','COLINA MIRAVALLE 9721','SCDAPQ','PTZ','B'],
[-33.412685,-70.526491,'COLINA MIRAVALLE','CMIR-02 - CM 9783','COLINA MIRAVALLE 9783','SCDAPQ','FIJA','B'],
[-33.412685,-70.526491,'COLINA MIRAVALLE','CMIR-03 - CM 9783','COLINA MIRAVALLE 9783','SCDAPQ','FIJA','B'],
[-33.411286,-70.52566,'COLINA MIRAVALLE','CMIR-04 - CM 9881','COLINA MIRAVALLE 9881','SCDAPQ','FIJA','B'],
[-33.412694,-70.526511,'COLINA MIRAVALLE','CMIR-05 - CM 9783','COLINA MIRAVALLE 9783','SCDAPQ','FIJA','B'],
[-33.408207,-70.516901,'EL CORRALERO VIEJO','ECV-01 - CO 2490','CAMINO OTOÑAL 2490','SCDAPQ','FIJA','B'],
[-33.408207,-70.516901,'EL CORRALERO VIEJO','ECV-05 - CO 2490','CAMINO OTOÑAL 2490','SCDAPQ','FIJA','B'],
[-33.408682,-70.516608,'EL CORRALERO VIEJO','ECV-02-PTZ - CO 2491','CAMINO OTOÑAL 2491','SCDAPQ','PTZ','B'],
[-33.407899,-70.517119,'EL CORRALERO VIEJO','ECV-03 - CO 2396','CAMINO OTOÑAL 2396','SCDAPQ','FIJA','B'],
[-33.407899,-70.517119,'EL CORRALERO VIEJO','ECV-06 - CO 2396','CAMINO OTOÑAL 2396','SCDAPQ','FIJA','B'],
[-33.40884,-70.516518,'EL CORRALERO VIEJO','ECV-04 - CO 2510','CAMINO OTOÑAL 2510','SCDAPQ','FIJA','B'],
[-33.408515,-70.516056,'EL CORRALERO VIEJO','ECV-07 - EC 11695','EL CORRALERO 11695','SCDAPQ','FIJA','B'],
[-33.408515,-70.516056,'EL CORRALERO VIEJO','ECV-09 - EC 11695','EL CORRALERO 11695','SCDAPQ','FIJA','B'],
[-33.408199,-70.515345,'EL CORRALERO VIEJO','ECV-08 - EC 11797','EL CORRALERO 11797','SCDAPQ','FIJA','B'],
[-33.407877,-70.515205,'EL CORRALERO VIEJO','ECV-10 - FBC 2483','FRANCISCO BULNES CORREA 2483','SCDAPQ','FIJA','B'],
[-33.408317,-70.514906,'EL CORRALERO VIEJO','ECV-11-PTZ - FBC 2541','FRANCISCO BULNES CORREA 2541','SCDAPQ','PTZ','B'],
[-33.375137,-70.501751,'SAN JOSE DE LA SIERRA','SJS-01 - SJDLS 780','SAN JOSE DE LA SIERRA 780','SCDAPQ','FIJA','B'],
[-33.375578,-70.501535,'SAN JOSE DE LA SIERRA','SJS-02 - SJDLS 710','SAN JOSE DE LA SIERRA 710','SCDAPQ','FIJA','B'],
[-33.375578,-70.501535,'SAN JOSE DE LA SIERRA','SJS-03 - SJDLS 720','SAN JOSE DE LA SIERRA 720','SCDAPQ','FIJA','B'],
[-33.375979,-70.501337,'SAN JOSE DE LA SIERRA','SJS-04-PTZ - SJDLS 845','SAN JOSE DE LA SIERRA 845','SCDAPQ','PTZ','B'],
[-33.376707,-70.500995,'SAN JOSE DE LA SIERRA','SJS-05 - SJDLS 890','SAN JOSE DE LA SIERRA 890','SCDAPQ','FIJA','B'],
[-33.376707,-70.500995,'SAN JOSE DE LA SIERRA','SJS-06 - SJDLS 890','SAN JOSE DE LA SIERRA 890','SCDAPQ','FIJA','B'],
[-33.388524,-70.538776,'DOCTOR LUIS CALVO MACKENA','DLCM-01 - PAPC 60','PASAJE ARTURO PEREZ CANTO 60','APOQUINDO','FIJA','B'],
[-33.388524,-70.538776,'DOCTOR LUIS CALVO MACKENA','DLCM-02 - PAPC 60','PASAJE ARTURO PEREZ CANTO 60','APOQUINDO','FIJA','B'],
[-33.388598,-70.537522,'DOCTOR LUIS CALVO MACKENA','DLCM-03-PTZ - L 9669','LUXEMBURGO 9669','APOQUINDO','PTZ','B'],
[-33.388517,-70.537271,'DOCTOR LUIS CALVO MACKENA','DLCM-04 - L 9711','LUXEMBURGO 9711','APOQUINDO','FIJA','B'],
[-33.388517,-70.537271,'DOCTOR LUIS CALVO MACKENA','DLCM-05 - L 9711','LUXEMBURGO 9711','APOQUINDO','FIJA','B'],
[-33.387748,-70.536388,'DOCTOR LUIS CALVO MACKENA','DLCM-06 - L 9875','LUXEMBURGO 9875','APOQUINDO','FIJA','B'],
[-33.387748,-70.536388,'DOCTOR LUIS CALVO MACKENA','DLCM-07 - L 9875','LUXEMBURGO 9875','APOQUINDO','FIJA','B'],
[-33.387205,-70.535922,'DOCTOR LUIS CALVO MACKENA','DLCM-08 - L 9910','LUXEMBURGO 9910','APOQUINDO','FIJA','B'],
[-33.387205,-70.535922,'DOCTOR LUIS CALVO MACKENA','DLCM-09 - L 9910','LUXEMBURGO 9910','APOQUINDO','FIJA','B'],
[-33.387366,-70.536906,'DOCTOR LUIS CALVO MACKENA','DLCM-10 - DLCM 9854','DOCTOR LUIS CALVO MACKENNA 9854','APOQUINDO','FIJA','B'],
[-33.387884,-70.537567,'DOCTOR LUIS CALVO MACKENA','DLCM-11 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759','APOQUINDO','FIJA','B'],
[-33.387884,-70.537567,'DOCTOR LUIS CALVO MACKENA','DLCM-12 - DLCM 9759','DOCTOR LUIS CALVO MACKENNA 9759','APOQUINDO','FIJA','B'],
[-33.388125,-70.538319,'DOCTOR LUIS CALVO MACKENA','DLCM-13 - CAMA 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78','APOQUINDO','FIJA','B'],
[-33.388125,-70.538319,'DOCTOR LUIS CALVO MACKENA','DLCM-14 - CAMA 78','CALLE ALMIRANTE MIGUEL AGUIRRE 78','APOQUINDO','FIJA','B'],
[-33.396971,-70.519365,'CAMINO EL OTOÑAL','CEO-01 - CO 1382','CAMINO OTOÑAL 1382','SCDAPQ','FIJA','B'],
[-33.39683,-70.519401,'CAMINO EL OTOÑAL','CEO-02 - CO 1390','CAMINO OTOÑAL 1390','SCDAPQ','FIJA','B'],
[-33.396971,-70.519415,'CAMINO EL OTOÑAL','CEO-03-PTZ - CO 1382','CAMINO OTOÑAL 1382','SCDAPQ','PTZ','B'],
[-33.396531,-70.519312,'CAMINO EL OTOÑAL','CEO-04 - CO 1368','CAMINO OTOÑAL 1368','SCDAPQ','FIJA','B'],
[-33.396156,-70.519266,'CAMINO EL OTOÑAL','CEO-05 - CO 1326','CAMINO OTOÑAL 1326','SCDAPQ','FIJA','B'],
[-33.422479,-70.584054,'MALAGA','M-01 - M 897','MALAGA 897','EL GOLF','FIJA','B'],
[-33.42226,-70.584059,'MALAGA','M-02 - M 888','MALAGA 888','EL GOLF','FIJA','B'],
[-33.422181,-70.584148,'MALAGA','M-03 - M 859','MALAGA 859','EL GOLF','FIJA','B'],
[-33.422181,-70.584148,'MALAGA','M-04 - M 859','MALAGA 859','EL GOLF','FIJA','B'],
[-33.421382,-70.584424,'MALAGA','M-05 - M 808','MALAGA 808','EL GOLF','FIJA','B'],
[-33.421362,-70.58452,'MALAGA','M-06 - M 782','MALAGA 749','EL GOLF','FIJA','B'],
[-33.421098,-70.5846,'MALAGA','M-07 - M 701','MALAGA 701','EL GOLF','FIJA','B'],
[-33.421098,-70.5846,'MALAGA','M-08 - M 701','MALAGA 701','EL GOLF','FIJA','B'],
[-33.421098,-70.5846,'MALAGA','M-09 - M 701','MALAGA 701','EL GOLF','FIJA','B'],
[-33.420873,-70.5846,'MALAGA','M-10 - M 782','MALAGA 720','EL GOLF','FIJA','B'],
[-33.420631,-70.584838,'MALAGA','M-11-PTZ - M 670','MALAGA 670','EL GOLF','PTZ','B'],
[-33.420553,-70.584856,'MALAGA','M-12 - M 661','MALAGA 661','EL GOLF','FIJA','B'],
[-33.420525,-70.584747,'MALAGA','M-13 - M R','MALAGA & RAPALLO','EL GOLF','FIJA','B'],
[-33.420119,-70.585006,'MALAGA','M-14 - M 557','MALAGA 557','EL GOLF','FIJA','B'],
[-33.420119,-70.585006,'MALAGA','M-15 - M 557','MALAGA 557','EL GOLF','FIJA','B'],
[-33.420068,-70.585046,'MALAGA','M-16 - M 529','MALAGA 529','EL GOLF','FIJA','B'],
[-33.417643,-70.579625,'LA SERENA','LS-01 - LS 511','LA SERENA 511','EL GOLF','FIJA','B'],
[-33.417643,-70.579625,'LA SERENA','LS-02 - LS 511','LA SERENA 511','EL GOLF','FIJA','B'],
[-33.418432,-70.579079,'LA SERENA','LS-03-PTZ - LS 640','LA SERENA 640','EL GOLF','PTZ','B'],
[-33.419347,-70.578373,'LA SERENA','LS-04 - LS 841','LA SERENA 841','EL GOLF','FIJA','B'],
[-33.419347,-70.578373,'LA SERENA','LS-05 - LS 841','LA SERENA 841','EL GOLF','FIJA','B'],
[-33.415484,-70.581533,'FELIX DE AMESTI','FDA-01 - FDA 218','FELIX DE AMESTI 218','EL GOLF','FIJA','B'],
[-33.415484,-70.581533,'FELIX DE AMESTI','FDA-02 - FDA 218','FELIX DE AMESTI 218','EL GOLF','FIJA','B'],
[-33.415833,-70.581349,'FELIX DE AMESTI','FDA-03 - FDA 255','FELIX DE AMESTI 255','EL GOLF','FIJA','B'],
[-33.415833,-70.581349,'FELIX DE AMESTI','FDA-04 - FDA 255','FELIX DE AMESTI 255','EL GOLF','FIJA','B'],
[-33.416395,-70.581042,'FELIX DE AMESTI','FDA-05-PTZ - FDA 327','FELIZ DE AMESTI 327','EL GOLF','PTZ','B'],
[-33.416395,-70.581042,'FELIX DE AMESTI','FDA-06 - FDA 327','FELIX DE AMESTI 327','EL GOLF','FIJA','B'],
[-33.416395,-70.581042,'FELIX DE AMESTI','FDA-07 - FDA 327','FELIX DE AMESTI 327','EL GOLF','FIJA','B'],
[-33.417041,-70.580692,'FELIX DE AMESTI','FDA-08 - FDA 403','FELIX DE AMESTI 403','EL GOLF','FIJA','B'],
[-33.417111,-70.580654,'FELIX DE AMESTI','FDA-09 - FDA 432','FELIX DE AMESTI 432','EL GOLF','FIJA','B'],
[-33.417382,-70.580504,'FELIX DE AMESTI','FDA-10 - FDA 451','FELIX DE AMESTI 451','EL GOLF','FIJA','B'],
[-33.417615,-70.580364,'FELIX DE AMESTI','FDA-11 - FDA 477','FELIX DE AMESTI 477','EL GOLF','FIJA','B'],
[-33.417616,-70.580352,'FELIX DE AMESTI','FDA-12 - FDA 462','FELIX DE AMESTI 462','EL GOLF','FIJA','B'],
[-33.409896,-70.565237,'LOS MILAGROS','LM-01 - LM 6255','LOS MILAGROS 6255','APOQUINDO','FIJA','B'],
[-33.409962,-70.565387,'LOS MILAGROS','LM-02 - LM 6255','LOS MILAGROS 6255','APOQUINDO','FIJA','B'],
[-33.410076,-70.565845,'LOS MILAGROS','LM-03 - LM 6231','LOS MILAGROS 6231','APOQUINDO','FIJA','B'],
[-33.410076,-70.565845,'LOS MILAGROS','LM-04 - LM 6231','LOS MILAGROS 6231','APOQUINDO','FIJA','B'],
[-33.4102,-70.566337,'LOS MILAGROS','LM-05 - LM 6206','LOS MILAGROS 6206','APOQUINDO','FIJA','B'],
[-33.421424,-70.548203,'GUADARRAMA SUR','GS-01 - G 1251','GUADARRAMA 1251','FLEMING','FIJA','B'],
[-33.421717,-70.547915,'GUADARRAMA SUR','GS-02 - G 1264','GUADARRAMA 1264','FLEMING','FIJA','B'],
[-33.42183,-70.547832,'GUADARRAMA SUR','GS-03 - G EP','GUADARRAMA & EL PASTOR','FLEMING','FIJA','B'],
[-33.421905,-70.547765,'GUADARRAMA SUR','GS-04 - G 1272','GUADARRAMA 1272','FLEMING','FIJA','B'],
[-33.422228,-70.547562,'GUADARRAMA SUR','GS-05-PTZ - G 1287','GUADARRAMA 1287','FLEMING','PTZ','B'],
[-33.422246,-70.547469,'GUADARRAMA SUR','GS-06 - G EO','GUADARRAMA & EL OVEJERO','FLEMING','FIJA','B'],
[-33.422449,-70.547259,'GUADARRAMA SUR','GS-07 - G 1295','GUADARRAMA 1295','FLEMING','FIJA','B'],
[-33.422532,-70.547242,'GUADARRAMA SUR','GS-08 - G 1299','GUADARRAMA 1299','FLEMING','FIJA','B'],
[-33.422535,-70.547161,'GUADARRAMA SUR','GS-09 - G 1304','GUADARRAMA 1304','FLEMING','FIJA','B'],
[-33.422742,-70.54704,'GUADARRAMA SUR','GS-10 - G 1315','GUADARRAMA 1315','FLEMING','FIJA','B'],
[-33.422762,-70.54694,'GUADARRAMA SUR','GS-11 - G 1316','GUADARRAMA 1316','FLEMING','FIJA','B'],
[-33.422907,-70.546451,'GUADARRAMA SUR','GS-12 - G 1324','GUADARRAMA 1324','FLEMING','FIJA','B'],
[-33.421641,-70.546345,'GUADARRAMA SUR','GS-13 - EP FO','EL PASTOR & FUENTE OVEJUNA','FLEMING','FIJA','B'],
[-33.422191,-70.547492,'GUADARRAMA SUR','GS-14 - G EO','GUADARRAMA & EL OVEJERO','FLEMING','FIJA','B'],
[-33.42212,-70.546345,'GUADARRAMA SUR','GS-15 - EO 8036','EL OVEJERO 8036','FLEMING','FIJA','B'],
[-33.422095,-70.546685,'GUADARRAMA SUR','GS-16 - EO FO','EL OVEJERO & FUENTE OVEJUNA','FLEMING','FIJA','B'],
[-33.398593,-70.545355,'ESCOCIA','E-01 - ME 553','MARÍA ESTUARDO 553','APOQUINDO','FIJA','B'],
[-33.399136,-70.545348,'ESCOCIA','E-02 - E 572','ESCOCIA 572','APOQUINDO','FIJA','B'],
[-33.399484,-70.545352,'ESCOCIA','E-03 - E 598','ESCOCIA 598','APOQUINDO','FIJA','B'],
[-33.399484,-70.545352,'ESCOCIA','E-04 - E 598','ESCOCIA 598','APOQUINDO','FIJA','B'],
[-33.399878,-70.545343,'ESCOCIA','E-05 - E 614','ESCOCIA 614','APOQUINDO','FIJA','B'],
[-33.399878,-70.545343,'ESCOCIA','E-06-PTZ - E 614','ESCOCIA 614','APOQUINDO','PTZ','B'],
[-33.400353,-70.545332,'ESCOCIA','E-07 - E 635','ESCOCIA 635','APOQUINDO','FIJA','B'],
[-33.400353,-70.545332,'ESCOCIA','E-08 - E 635','ESCOCIA 635','APOQUINDO','FIJA','B'],
[-33.401025,-70.545323,'ESCOCIA','E-09 - E 659','ESCOCIA 659','APOQUINDO','FIJA','B'],
[-33.427434,-70.5440072,'EL TATIO','ET-01 - MCV ET','MANUEL CLARO VIAL & EL TATIO','FLEMING','FIJA','B'],
[-33.427372,-70.541448,'EL TATIO','ET-02 - ET 1843','EL TATIO 1843','FLEMING','FIJA','B'],
[-33.426963,-70.541483,'EL TATIO','ET-03 - ET 1842','El TATIO 1842','FLEMING','FIJA','B'],
[-33.426963,-70.541483,'EL TATIO','ET-04 - ET 1842','El TATIO 1842','FLEMING','FIJA','B'],
[-33.426751,-70.541535,'EL TATIO','ET-05 - ET 1818','EL TATIO 1818','FLEMING','FIJA','B'],
[-33.426751,-70.541535,'EL TATIO','ET-06 - ET 1818','EL TATIO 1818','FLEMING','FIJA','B'],
[-33.426597,-70.541557,'EL TATIO','ET-07 - ET 1791','EL TATIO 1791','FLEMING','FIJA','B'],
[-33.426439,-70.541557,'EL TATIO','ET-08 - ET 1786','El TATIO 1786','FLEMING','FIJA','B'],
[-33.426439,-70.541557,'EL TATIO','ET-09 - ET 1786','El TATIO 1786','FLEMING','FIJA','B'],
[-33.42611,-70.541636,'EL TATIO','ET-10-PTZ - ET 1781','EL TATIO 1781','FLEMING','PTZ','B'],
[-33.425989,-70.541651,'EL TATIO','ET-11 - R 8769','RUPANCO 8769','FLEMING','FIJA','B'],
[-33.425989,-70.541651,'EL TATIO','ET-12 - R 8769','RUPANCO 8769','FLEMING','FIJA','B'],
[-33.425969,-70.541051,'EL TATIO','ET-13 - R A','RUPANCO & AYQUINA','FLEMING','FIJA','B'],
[-33.425969,-70.541051,'EL TATIO','ET-14 - R 8828','RUPANCO 8828','FLEMING','FIJA','B'],
[-33.425569,-70.541705,'EL TATIO','ET-15 - ET 1735','El TATIO 1735','FLEMING','FIJA','B'],
[-33.367825,-70.498687,'AUGUSTO MIRA FERNANDEZ','AMF-01 - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272','SCDAPQ','FIJA','B'],
[-33.367825,-70.498687,'AUGUSTO MIRA FERNANDEZ','AMF-02-PTZ - AMF 14272','AUGUSTO MIRA FERNANDEZ 14272','SCDAPQ','PTZ','B'],
[-33.367625,-70.497944,'AUGUSTO MIRA FERNANDEZ','AMF-03 - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377','SCDAPQ','FIJA','B'],
[-33.367625,-70.497944,'AUGUSTO MIRA FERNANDEZ','AMF-04 - AMF 14377','AUGUSTO MIRA FERNANDEZ 14377','SCDAPQ','FIJA','B'],
[-33.366998,-70.497437,'AUGUSTO MIRA FERNANDEZ','AMF-05 - CAF 14420','CAMINO A FARELLONES 14420','SCDAPQ','FIJA','B'],
[-33.37923,-70.50768,'FERNANDEZ MIRA','FM-01-PTZ - CH 12920','CHARLES HAMILTON 12920','SCDAPQ','PTZ','B'],
[-33.379097,-70.507814,'FERNANDEZ MIRA','FM-02 - FM 1088','FERNANDEZ MIRA 1088','SCDAPQ','FIJA','B'],
[-33.378865,-70.507925,'FERNANDEZ MIRA','FM-03 - FM 1061','FERNANDEZ MIRA 1061','SCDAPQ','FIJA','B'],
[-33.378385,-70.508212,'FERNANDEZ MIRA','FM-04 - FM 1005','FERNANDEZ MIRA 1005','SCDAPQ','FIJA','B'],
[-33.378385,-70.508212,'FERNANDEZ MIRA','FM-05 - FM 1005','FERNANDEZ MIRA 1005','SCDAPQ','FIJA','B'],
[-33.377824,-70.50855,'FERNANDEZ MIRA','FM-06 - FM 958','FERNANDEZ MIRA 958','SCDAPQ','FIJA','B'],
[-33.377824,-70.50855,'FERNANDEZ MIRA','FM-07 - FM 958','FERNANDEZ MIRA 958','SCDAPQ','FIJA','B'],
[-33.377289,-70.508838,'FERNANDEZ MIRA','FM-08 - FM 865','FERNANDEZ MIRA 865','SCDAPQ','FIJA','B'],
[-33.377289,-70.508838,'FERNANDEZ MIRA','FM-09 - FM 865','FERNANDEZ MIRA 865','SCDAPQ','FIJA','B'],
[-33.404413,-70.525435,'CAMINO MIRASOL Nº 2224','CMQH-01 - CM 2099','CAMINO MIRASOL 2099','SCDAPQ','FIJA','B'],
[-33.404413,-70.525435,'CAMINO MIRASOL Nº 2224','CMQH-02 - CM 2099','CAMINO MIRASOL 2099','SCDAPQ','FIJA','B'],
[-33.405802,-70.524458,'CAMINO MIRASOL Nº 2224','CMQH-03 - CM 2315','CAMINO MIRASOL 2315','SCDAPQ','FIJA','B'],
[-33.405802,-70.524458,'CAMINO MIRASOL Nº 2224','CMQH-04 - CM 2315','CAMINO MIRASOL 2315','SCDAPQ','FIJA','B'],
[-33.408363,-70.522687,'CAMINO MIRASOL Nº 2224','CMQH-05 - QH 9990','QUEBRADA HONDA 9990','SCDAPQ','FIJA','B'],
[-33.408363,-70.522687,'CAMINO MIRASOL Nº 2224','CMQH-06 - QH 9990','QUEBRADA HONDA 9990','SCDAPQ','FIJA','B'],
[-33.407512,-70.523279,'CAMINO MIRASOL Nº 2224','CMQH-07 - CM 2511','CAMINO MIRASOL 2511','SCDAPQ','FIJA','B'],
[-33.407512,-70.523279,'CAMINO MIRASOL Nº 2224','CMQH-08 - CM 2511','CAMINO MIRASOL 2511','SCDAPQ','FIJA','B'],
[-33.403389,-70.522694,'LA FUENTE - QUEBRADA HONDA','CLFQH-01-PTZ - GB CLF','GENERAL BLANCHE - CAMINO LA FUENTE','SCDAPQ','PTZ','B'],
[-33.404189,-70.522627,'LA FUENTE - QUEBRADA HONDA','CLFQH-02 - CLF 1917','CAMINO LA FUENTE 1917','SCDAPQ','FIJA','B'],
[-33.404189,-70.522627,'LA FUENTE - QUEBRADA HONDA','CLFQH-03 - CLF 1917','CAMINO LA FUENTE 1917','SCDAPQ','FIJA','B'],
[-33.405284,-70.521906,'LA FUENTE - QUEBRADA HONDA','CLFQH-04 - CLF 2041','CAMINO LA FUENTE 2041','SCDAPQ','FIJA','B'],
[-33.405284,-70.521906,'LA FUENTE - QUEBRADA HONDA','CLFQH-05 - CLF 2041','CAMINO LA FUENTE 2041','SCDAPQ','FIJA','B'],
[-33.405793,-70.521543,'LA FUENTE - QUEBRADA HONDA','CLFQH-06-PTZ - CLF 2117','CAMINO LA FUENTE 2117','SCDAPQ','PTZ','B'],
[-33.406887,-70.520762,'LA FUENTE - QUEBRADA HONDA','CLFQH-07 - CLF 2237','CAMINO LA FUENTE 2237','SCDAPQ','FIJA','B'],
[-33.406887,-70.520762,'LA FUENTE - QUEBRADA HONDA','CLFQH-08 - CLF 2237','CAMINO LA FUENTE 2237','SCDAPQ','FIJA','B'],
[-33.407099,-70.520627,'LA FUENTE - QUEBRADA HONDA','CLFQH-09-PTZ - CLF 2259','CAMINO LA FUENTE 2259','SCDAPQ','PTZ','B'],
[-33.385556,-70.503398,'EL CONVENTO','ECM-01 - EC 629','EL CONVENTO 629','SCDAPQ','FIJA','B'],
[-33.385556,-70.503398,'EL CONVENTO','ECM-02 - EC 629','EL CONVENTO 629','SCDAPQ','FIJA','B'],
[-33.385297,-70.503686,'EL CONVENTO','ECM-03 - EC 619','EL CONVENTO 619','SCDAPQ','FIJA','B'],
[-33.386495,-70.504913,'EL CONVENTO','ECM-04 - EC 619','EL CONVENTO 619','SCDAPQ','FIJA','B'],
[-33.386413,-70.50434,'EL CONVENTO','ECM-05 - EC 715','EL CONVENTO 715','SCDAPQ','FIJA','B'],
[-33.386413,-70.50434,'EL CONVENTO','ECM-06 - EC 715','EL CONVENTO 715','SCDAPQ','FIJA','B'],
[-33.38685,-70.504815,'EL CONVENTO','ECM-07 - EC 759','EL CONVENTO 759','SCDAPQ','FIJA','B'],
[-33.385706,-70.503446,'EL CONVENTO','ECM-08 - AQ 1603','AGUA QUIETA 1603','SCDAPQ','FIJA','B'],
[-33.394162,-70.514541,'LOS FALDEOS','LF-01 - LF CLS','LOS FALDEOS & CERRO CATEDRAL SUR','SCDAPQ','FIJA','B'],
[-33.393664,-70.514366,'LOS FALDEOS','LF-02 - LF 1149','LOS FALDEOS 1149','SCDAPQ','FIJA','B'],
[-33.393024,-70.514119,'LOS FALDEOS','LF-03 - LF 1149','LOS FALDEOS 1149','SCDAPQ','FIJA','B'],
[-33.392032,-70.513706,'LOS FALDEOS','LF-04 - LF 1169','LOS FALDEOS 1169','SCDAPQ','FIJA','B'],
[-33.392032,-70.513706,'LOS FALDEOS','LF-05 - LF 1215','LOS FALDEOS 1215','SCDAPQ','FIJA','B'],
[-33.393024,-70.514119,'LOS FALDEOS','LF-06 - LF 1227','LOS FALDEOS 1227','SCDAPQ','FIJA','B'],
[-33.393024,-70.514119,'LOS FALDEOS','LF-07 - LF 1227','LOS FALDEOS 1227','SCDAPQ','FIJA','B'],
[-33.393024,-70.514119,'LOS FALDEOS','LF-08-PTZ - LF 1227','LOS FALDEOS 1227','SCDAPQ','PTZ','B'],
[-33.393398,-70.51426,'LOS FALDEOS','LF-09 - LF 1241','LOS FALDEOS 1241','SCDAPQ','FIJA','B'],
[-33.393663,-70.514372,'LOS FALDEOS','LF-10 - LF 1253','LOS FALDEOS 1253','SCDAPQ','FIJA','B'],
[-33.393707,-70.514361,'LOS FALDEOS','LF-11 - LF 1262','LOS FALDEOS 1262','SCDAPQ','FIJA','B'],
[-33.393981,-70.514491,'LOS FALDEOS','LF-12 - LF 1277','LOS FALDEOS 1277','SCDAPQ','FIJA','B'],
[-33.394162,-70.514541,'LOS FALDEOS','LF-13 - LF 1286','LOS FALDEOS 1286','SCDAPQ','FIJA','B'],
[-33.394162,-70.514541,'LOS FALDEOS','LF-14 - LF 1286','LOS FALDEOS 1286','SCDAPQ','FIJA','B'],
[-33.41692,-70.5792,'ALGECIRAS','A-01 - DI 4622','DEL INCA 4622','EL GOLF','FIJA','B'],
[-33.417254,-70.579042,'ALGECIRAS','A-02 - A 506','ALGECIRAS 506','EL GOLF','FIJA','B'],
[-33.417743,-70.578725,'ALGECIRAS','A-03 - A 567','ALGECIRAS 567','EL GOLF','FIJA','B'],
[-33.417743,-70.578725,'ALGECIRAS','A-04 - A 567','ALGECIRAS 567','EL GOLF','FIJA','B'],
[-33.418109,-70.578462,'ALGECIRAS','A-05-PTZ - A 684','ALGECIRAS 684','EL GOLF','PTZ','B'],
[-33.41845,-70.578236,'ALGECIRAS','A-06 - A 778','ALGECIRAS 778','EL GOLF','FIJA','B'],
[-33.41845,-70.578236,'ALGECIRAS','A-07 - A 778','ALGECIRAS 778','EL GOLF','FIJA','B'],
[-33.4188,-70.577956,'ALGECIRAS','A-08 - A 829','ALGECIRAS 829','EL GOLF','FIJA','B'],
[-33.4188,-70.577956,'ALGECIRAS','A-09 - A 829','ALGECIRAS 829','EL GOLF','FIJA','B'],
[-33.402306,-70.527848,'LUIS MATTE - MARISOL','LMM-01 - CM 1744','CAMINO MIRASOL 1744','SCDAPQ','FIJA','B'],
[-33.402033,-70.528432,'LUIS MATTE - MARISOL','LMM-02 - CM 1701','CAMINO MIRASOL 1701','SCDAPQ','FIJA','B'],
[-33.402275,-70.52853,'LUIS MATTE - MARISOL','LMM-03 - LML 10185','LUIS MATTE LARRAIN 10185','SCDAPQ','FIJA','B'],
[-33.402496,-70.529201,'LUIS MATTE - MARISOL','LMM-04 - LML 10162','LUIS MATTE LARRAIN 10162','SCDAPQ','FIJA','B'],
[-33.402504,-70.529225,'LUIS MATTE - MARISOL','LMM-05 - LML 10135','LUIS MATTE LARRAIN 10135','SCDAPQ','FIJA','B'],
[-33.402575,-70.529572,'LUIS MATTE - MARISOL','LMM-06-PTZ - LML 10091','LUIS MATTE LARRAIN 10091','SCDAPQ','PTZ','B'],
[-33.402651,-70.530001,'LUIS MATTE - MARISOL','LMM-07 - LML 10066','LUIS MATTE LARRAIN 10066','SCDAPQ','FIJA','B'],
[-33.402758,-70.530482,'LUIS MATTE - MARISOL','LMM-08 - LML 10011','LUIS MATTE LARRAIN 10011','SCDAPQ','FIJA','B'],
[-33.402757,-70.530788,'LUIS MATTE - MARISOL','LMM-09 - LML 9972','LUIS MATTE LARRAIN 9972','SCDAPQ','FIJA','B'],
[-33.402753,-70.530761,'LUIS MATTE - MARISOL','LMM-10 - LML 9996','LUIS MATTE LARRAIN 9966','SCDAPQ','FIJA','B'],
[-33.4029579,-70.5314732,'LUIS MATTE - MIRASOL','LMM-11 - LML 9924','Luis Matte Larrain 9924','SCDAPQ','FIJA','B'],
[-33.4029228,-70.5313713,'LUIS MATTE - MIRASOL','LMM-12 - LML 9924','Luis Matte Larrain 9923','SCDAPQ','FIJA','B'],
[-33.403003,-70.531571,'LUIS MATTE - MIRASOL','LMM-13 - LML 9898','Luis Matte Larrain 9898','SCDAPQ','FIJA','B'],
[-33.393802,-70.51121,'ANILLO LA CUMBRE','AC-01 - CF 1211','CERRO FRANCISCANO 1211','SCDAPQ','FIJA','B'],
[-33.3936,-70.51112,'ANILLO LA CUMBRE','AC-02 - CF 1171','CERRO FRANCISCANO 1171','SCDAPQ','FIJA','B'],
[-33.393891,-70.510644,'ANILLO LA CUMBRE','AC-03-PTZ - ALC 12098','ANILLO LA CUMBRE 12098','SCDAPQ','PTZ','B'],
[-33.393891,-70.510644,'ANILLO LA CUMBRE','AC-04 - ALC 12098','ANILLO LA CUMBRE 12098','SCDAPQ','FIJA','B'],
[-33.394596,-70.51077,'ANILLO LA CUMBRE','AC-05 - ALC 1259','ANILLO LA CUMBRE 1259','SCDAPQ','FIJA','B'],
[-33.394681,-70.510178,'ANILLO LA CUMBRE','AC-06 - ALC 1241','ANILLO LA CUMBRE 1241','SCDAPQ','FIJA','B'],
[-33.394102,-70.509934,'ANILLO LA CUMBRE','AC-07 - ALC 1211','ANILLO LA CUMBRE 1211','SCDAPQ','FIJA','B'],
[-33.393418,-70.509704,'ANILLO LA CUMBRE','AC-08 - ALC 1187','ANILLO LA CUMBRE 1187','SCDAPQ','FIJA','B'],
[-33.393181,-70.510201,'ANILLO LA CUMBRE','AC-09 - ALC 1153','ANILLO LA CUMBRE 1153','SCDAPQ','FIJA','B'],
[-33.38678,-70.5037,'PASAJE SANTA CLARA','PSC-01 - PSC 741','PASAJE SANTA CLARA 741','SCDAPQ','FIJA','B'],
[-33.38671,-70.503451,'PASAJE SANTA CLARA','PSC-02 - PSC 711','PASAJE SANTA CLARA 711','SCDAPQ','FIJA','B'],
[-33.38671,-70.503451,'PASAJE SANTA CLARA','PSC-03 - PSC 667','PASAJE SANTA CLARA 667','SCDAPQ','FIJA','B'],
[-33.38653,-70.503546,'PASAJE SANTA CLARA','PSC-04 - PSC 686','PASAJE SANTA CLARA 686','SCDAPQ','FIJA','B'],
[-33.38653,-70.503546,'PASAJE SANTA CLARA','PSC-05 - PSC 711','PASAJE SANTA CLARA 711','SCDAPQ','FIJA','B'],
[-33.412034,-70.517389,'LAS TORTOLAS','LT2-01-PTZ - LT CPO','LAS TORTOLAS / CARLOS PEÑA OTAEGUI','SCDAPQ','PTZ','B'],
[-33.411634,-70.517225,'LAS TORTOLAS','LT2-02 - LT 2958','LAS TORTOLAS 2958','SCDAPQ','FIJA','B'],
[-33.411559,-70.517193,'LAS TORTOLAS','LT2-03 - LT 2929','LAS TORTOLAS 2929','SCDAPQ','FIJA','B'],
[-33.410919,-70.516988,'LAS TORTOLAS','LT2-04 - LT 2796','LAS TORTOLAS 2796','SCDAPQ','FIJA','B'],
[-33.410684,-70.516991,'LAS TORTOLAS','LT2-05 - LT 2778','LAS TORTOLAS 2778','SCDAPQ','FIJA','B'],
[-33.410149,-70.517121,'LAS TORTOLAS','LT2-06 - LT 2712','LAS TORTOLAS 2712','SCDAPQ','FIJA','B'],
[-33.409521,-70.517527,'LAS TORTOLAS','LT2-07 - LT 2658','LAS TORTOLAS 2658','SCDAPQ','FIJA','B'],
[-33.408842,-70.51798,'LAS TORTOLAS','LT2-08 - LT 2550','LAS TORTOLAS 2550','SCDAPQ','FIJA','B'],
[-33.407444,-70.518859,'LAS TORTOLAS','LT2-09 - LT 2358','LAS TORTOLAS 2358','SCDAPQ','FIJA','B'],
[-33.407444,-70.518859,'LAS TORTOLAS','LT2-10 - LT 2358','LAS TORTOLAS 2358','SCDAPQ','FIJA','B'],
[-33.407097,-70.519095,'LAS TORTOLAS','LT2-11-PTZ - LT QH','LAS TORTOLAS / QUEBRADA HONDA','SCDAPQ','PTZ','B'],
[-33.403512,-70.520937,'LAS TORTOLAS','LT-01 - LT 1807','LAS TORTOLAS 1807','SCDAPQ','FIJA','B'],
[-33.404367,-70.520919,'LAS TORTOLAS','LT-02 - LT 1901','LAS TORTOLAS 1901','SCDAPQ','FIJA','B'],
[-33.404367,-70.520919,'LAS TORTOLAS','LT-03 - LT 1901','LAS TORTOLAS 1901','SCDAPQ','FIJA','B'],
[-33.404986,-70.520538,'LAS TORTOLAS','LT-04 - LT 2008','LAS TORTOLAS 2008','SCDAPQ','FIJA','B'],
[-33.404986,-70.520538,'LAS TORTOLAS','LT-05 - LT 2008','LAS TORTOLAS 2008','SCDAPQ','FIJA','B'],
[-33.405727,-70.520026,'LAS TORTOLAS','LT-06 - LT 2084','LAS TORTOLAS 2084','SCDAPQ','FIJA','B'],
[-33.405727,-70.520026,'LAS TORTOLAS','LT-07 - LT 2084','LAS TORTOLAS 2084','SCDAPQ','FIJA','B'],
[-33.407117,-70.519045,'LAS TORTOLAS','LT-08 - LT 2346','LAS TORTOLAS 2346','SCDAPQ','FIJA','B'],
[-33.403159,-70.524231,'LAS CONDESAS','LC1-01 - LC 1950','LAS CONDESAS 1950','SCDAPQ','FIJA','B'],
[-33.403822,-70.524307,'LAS CONDESAS','LC1-02 - LC 2032','LAS CONDESAS 2032','SCDAPQ','FIJA','B'],
[-33.405043,-70.523563,'LAS CONDESAS','LC1-03 - LC 2248','LAS CONDESAS 2248','SCDAPQ','FIJA','B'],
[-33.405043,-70.523563,'LAS CONDESAS','LC1-04 - LC 2248','LAS CONDESAS 2248','SCDAPQ','FIJA','B'],
[-33.405043,-70.523563,'LAS CONDESAS','LC1-05-PTZ - LC 2248','LAS CONDESAS 2248','SCDAPQ','PTZ','B'],
[-33.407805,-70.521644,'LAS CONDESAS','LC2-01 - LC 2334','LAS CONDESAS 2334','SCDAPQ','FIJA','B'],
[-33.407805,-70.521644,'LAS CONDESAS','LC2-02 - LC 2422','LAS CONDESAS 2422','SCDAPQ','FIJA','B'],
[-33.406015,-70.522879,'LAS CONDESAS','LC2-03 - LC 2536','LAS CONDESAS 2536','SCDAPQ','FIJA','B'],
[-33.406015,-70.522879,'LAS CONDESAS','LC2-04 - LC 2598','LAS CONDESAS 2398','SCDAPQ','FIJA','B'],
[-33.4128847,-70.534276,'CERRO ALEGRE','CA-01 - CA 825 (N)','Cerro Alegre 825','SCDAPQ','FIJA','B'],
[-33.4131348,-70.5341307,'CERRO ALEGRE','CA-02 - CA 830 (S)','Cerro Alegre 830','SCDAPQ','FIJA','B'],
[-33.4132994,-70.5340259,'CERRO ALEGRE','CA-03 - CA 841 (N)','Cerro Alegre 841','SCDAPQ','FIJA','B'],
[-33.4132994,-70.5340259,'CERRO ALEGRE','CA-04 - CA 841 (S)','Cerro Alegre 841','SCDAPQ','FIJA','B'],
[-33.4136753,-70.5337046,'CERRO ALEGRE','CA-05 - CA 860 (N)','Cerro Alegre 860','SCDAPQ','FIJA','B'],
[-33.4136753,-70.5337046,'CERRO ALEGRE','CA-06 - CA 860 (S)','Cerro Alegre 860','SCDAPQ','FIJA','B'],
[-33.4137522,-70.5336174,'CERRO ALEGRE','CA-07 - CA 879 (N)','Cerro Alegre 879','SCDAPQ','FIJA','B'],
[-33.4138891,-70.5335067,'CERRO ALEGRE','CA-08 - CA 887 (S)','Cerro Alegre 887','SCDAPQ','FIJA','B'],
[-33.4142034,-70.5332902,'CERRO ALEGRE','CA-09-PTZ - CA 900','Cerro Alegre 900','SCDAPQ','PTZ','B'],
[-33.4142915,-70.5332874,'CERRO ALEGRE','CA-10 -- CA 918 (N)','Cerro Alegre 918','SCDAPQ','FIJA','B'],
[-33.4142915,-70.5332874,'CERRO ALEGRE','CA-11 - CA 918 (S)','Cerro Alegre 918','SCDAPQ','FIJA','B'],
[-33.4146596,-70.5333289,'CERRO ALEGRE','CA-12 - CA 921 (N)','Cerro Alegre 921','SCDAPQ','FIJA','B'],
[-33.4146596,-70.5333289,'CERRO ALEGRE','CA-13 - CA 921 (S)','Cerro Alegre 921','SCDAPQ','FIJA','B'],
[-33.4152284,-70.5333387,'CERRO ALEGRE','CA-14-PTZ - CA 964','Cerro Alegre 964','SCDAPQ','PTZ','B'],
[-33.4152284,-70.5333387,'CERRO ALEGRE','CA-15 - CA 964 (N)','Cerro Alegre 964','SCDAPQ','FIJA','B'],
[-33.4152284,-70.5333387,'CERRO ALEGRE','CA-16 - CA 964 (O)','Cerro Alegre 964','SCDAPQ','FIJA','B'],
[-33.421468,-70.592275,'GALICIA','G-01 - G 547','GALICIA 547','EL GOLF','FIJA','B'],
[-33.421468,-70.592275,'GALICIA','G-02 - G 547','GALICIA 547','EL GOLF','FIJA','B'],
[-33.42194,-70.59171,'GALICIA','G-03 - G 628','GALICIA 628','EL GOLF','FIJA','B'],
[-33.42202,-70.591599,'GALICIA','G-04 - G 662','GALICIA 662','EL GOLF','FIJA','B'],
[-33.422338,-70.591205,'GALICIA','G-05 - G 727','GALICIA 727','EL GOLF','FIJA','B'],
[-33.422338,-70.591205,'GALICIA','G-06 - G 727','GALICIA 727','EL GOLF','FIJA','B'],
[-33.422564,-70.590919,'GALICIA','G-07 - G 788','GALICIA 788','EL GOLF','FIJA','B'],
[-33.422441,-70.592213,'GALICIA','G-08 - B 3326','BAZTAN 3326','EL GOLF','FIJA','B'],
[-33.422463,-70.59231,'GALICIA','G-09 - SC 644','SAN CRESCENTE 644','EL GOLF','FIJA','B'],
[-33.3938819,-70.5482978,'CIRCULO CALAFQUEN','CCQ-01 - B 8745','Bombay 8745','APOQUINDO','FIJA','B'],
[-33.393644,-70.5484311,'CIRCULO CALAFQUEN','CCQ-02 - CDM 223','Costa de Marfil 223','APOQUINDO','FIJA','B'],
[-33.3935324,-70.5484872,'CIRCULO CALAFQUEN','CCQ-03 - CDM 238','Costa de Marfil 238','APOQUINDO','FIJA','B'],
[-33.3933807,-70.5485921,'CIRCULO CALAFQUEN','CCQ-04 - CDM 250','Costa de Marfil 250','APOQUINDO','FIJA','B'],
[-33.3933807,-70.5485921,'CIRCULO CALAFQUEN','CCQ-05 - CDM 250','Costa de Marfil 250','APOQUINDO','FIJA','B'],
[-33.3931373,-70.5488708,'CIRCULO CALAFQUEN','CCQ-06 - CDM D','Costa de Marfil & Dakar','APOQUINDO','FIJA','B'],
[-33.3931373,-70.5488708,'CIRCULO CALAFQUEN','CCQ-07-PTZ - CDM D','Costa de Marfil & Dakar','APOQUINDO','PTZ','B'],
[-33.3929348,-70.5488343,'CIRCULO CALAFQUEN','CCQ-08 - CDM 282','Costa de Marfil 282','APOQUINDO','FIJA','B'],
[-33.3926282,-70.5490138,'CIRCULO CALAFQUEN','CCQ-09 - M 8680','Mardoñal 8680','APOQUINDO','FIJA','B'],
[-33.3928459,-70.5481435,'CIRCULO CALAFQUEN','CCQ-10 - D 8826','Dakar 8826','APOQUINDO','FIJA','B'],
[-33.3928459,-70.5481435,'CIRCULO CALAFQUEN','CCQ-11 - D 8826','Dakar 8826','APOQUINDO','FIJA','B'],
[-33.3927336,-70.5478118,'CIRCULO CALAFQUEN','CCQ-12 - D 8876','Dakar 8876','APOQUINDO','FIJA','B'],
[-33.3926465,-70.5476896,'CIRCULO CALAFQUEN','CCQ-13 - T D','Trinidad & Dakar','APOQUINDO','FIJA','B'],
[-33.3930913,-70.5473432,'CIRCULO CALAFQUEN','CCQ-14 - T 239','Trinidad 239','APOQUINDO','FIJA','B'],
[-33.38799,-70.50597,'PLAZA LOS MONJES','PLM-01 - EC 824','EL CONVENTO 824','SCDAPQ','FIJA','B'],
[-33.388508,-70.506658,'PLAZA LOS MONJES','PLM-02 - EC 863','EL CONVENTO 863','SCDAPQ','FIJA','B'],
[-33.388734,-70.506918,'PLAZA LOS MONJES','PLM-03 - EC 955','EL CONVENTO 955','SCDAPQ','FIJA','B'],
[-33.389499,-70.507144,'PLAZA LOS MONJES','PLM-04 - LM 12124','LOS MONJES 12124','SCDAPQ','FIJA','B'],
[-33.38975,-70.507209,'PLAZA LOS MONJES','PLM-05 - LM 12144','LOS MONJES 12144','SCDAPQ','FIJA','B'],
[-33.39021,-70.50745,'PLAZA LOS MONJES','PLM-06 - LM 12124','LOS MONJES 12124','SCDAPQ','FIJA','B'],
[-33.390265,-70.507434,'PLAZA LOS MONJES','PLM-07 - LM 12171','LOS MONJES 12171','SCDAPQ','FIJA','B'],
[-33.390608,-70.507002,'PLAZA LOS MONJES','PLM-08 - EM 973','EL MONASTERIO 973','SCDAPQ','FIJA','B'],
[-33.39003,-70.50843,'PLAZA LOS MONJES','PLM-09 - EC 969','EL CONVENTO 969','SCDAPQ','FIJA','B'],
[-33.38996,-70.508154,'PLAZA LOS MONJES','PLM-10 - LM 12109','LOS MONJES 12109','SCDAPQ','FIJA','B'],
[-33.390428,-70.506872,'PLAZA LOS MONJES','PLM-11 - EM 948','EL MONASTERIO 948','SCDAPQ','FIJA','B'],
[-33.389196,-70.507852,'PLAZA LOS MONJES','PLM-12 - EC 901','EL CONVENTO 901','SCDAPQ','FIJA','B'],
[-33.389191,-70.507628,'PLAZA LOS MONJES','PLM-13 - LM 12092','LOS MONJES 12092','SCDAPQ','FIJA','B'],
[-33.412081,-70.547172,'VALDEPEÑAS','V-01 - V 480','VALDEPEÑAS 480','APOQUINDO','FIJA','B'],
[-33.411334,-70.548182,'VALDEPEÑAS','V-02 - V 382','VALDEPEÑAS 382','APOQUINDO','FIJA','B'],
[-33.411334,-70.548182,'VALDEPEÑAS','V-03 - V 382','VALDEPEÑAS 382','APOQUINDO','FIJA','B'],
[-33.410668,-70.548822,'VALDEPEÑAS','V-04 - V 275','VALDEPEÑAS 275','APOQUINDO','FIJA','B'],
[-33.399376,-70.564303,'NUESTRA SEÑORA DEL ROSARIO INT','NSRI-01 - NSDRI 623','NUESTRA SEÑORA DEL ROSARIO INT 623','EL GOLF','FIJA','B'],
[-33.399271,-70.564186,'NUESTRA SEÑORA DEL ROSARIO INT','NSRI-02-PTZ - NSDRI 567','NUESTRA SEÑORA DEL ROSARIO INT 567','EL GOLF','PTZ','B'],
[-33.399043,-70.563276,'NUESTRA SEÑORA DEL ROSARIO INT','NSRI-03 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583','EL GOLF','FIJA','B'],
[-33.399043,-70.563276,'NUESTRA SEÑORA DEL ROSARIO INT','NSRI-04 - NSDRI 583','NUESTRA SEÑORA DEL ROSARIO INT 583','EL GOLF','FIJA','B'],
[-33.419617,-70.546271,'ZARAGOZA','Z-01 - FO 1172','FUENTE OVEJUNA 1172','FLEMING','FIJA','B'],
[-33.419614,-70.547442,'ZARAGOZA','Z-02 - Z 8018','ZARAGOZA 8018','FLEMING','FIJA','B'],
[-33.419614,-70.547442,'ZARAGOZA','Z-03 - Z 8018','ZARAGOZA 8018','FLEMING','FIJA','B'],
[-33.419668,-70.548032,'ZARAGOZA','Z-04 - G 1126','GUIPUZCOA 1126','FLEMING','FIJA','B'],
[-33.41976,-70.54831,'ZARAGOZA','Z-06 - V 1127','VIZCAYA 1127','FLEMING','FIJA','B'],
[-33.419784,-70.548475,'ZARAGOZA','Z-07 - Z 7899','ZARAGOZA 7899','FLEMING','FIJA','B'],
[-33.41976,-70.54831,'ZARAGOZA','Z-08 - V 1127','VIZCAYA 1127','FLEMING','FIJA','B'],
[-33.419917,-70.549571,'ZARAGOZA','Z-09 - Z 7782','ZARAGOZA 7782','FLEMING','FIJA','B'],
[-33.419917,-70.549571,'ZARAGOZA','Z-10 - Z 7782','ZARAGOZA 7782','FLEMING','FIJA','B'],
[-33.420053,-70.549696,'ZARAGOZA','Z-11 - G 1153','GUADARRAMA 1153','FLEMING','FIJA','B'],
[-33.419835,-70.549929,'ZARAGOZA','Z-12 - G 1135','GUADARRAMA 1135','FLEMING','FIJA','B'],
[-33.419415,-70.549475,'ZARAGOZA','Z-13 - L 7798','LERIDA 7798','FLEMING','FIJA','B'],
[-33.419415,-70.549475,'ZARAGOZA','Z-14 - L 7798','LERIDA 7798','FLEMING','FIJA','B'],
[-33.419315,-70.548636,'ZARAGOZA','Z-15 - L 7851','LERIDA 7851','FLEMING','FIJA','B'],
[-33.419224,-70.548025,'ZARAGOZA','Z-16 - L 7996','LERIDA 7996','FLEMING','FIJA','B'],
[-33.419784,-70.548475,'ZARAGOZA','Z-05-PTZ - Z 7899','ZARAGOZA 7899','FLEMING','PTZ','B'],
[-33.42521,-70.561071,'EL TOQUI','ELT-01 - ET 1635','EL TOQUI 1635','APOQUINDO','FIJA','B'],
[-33.42521,-70.561071,'EL TOQUI','ELT-02 - ET 1635','EL TOQUI 1635','APOQUINDO','FIJA','B'],
[-33.42585,-70.561234,'EL TOQUI','ELT-03 - ET 1663','EL TOQUI 1663','APOQUINDO','FIJA','B'],
[-33.42585,-70.561234,'EL TOQUI','ELT-04 - ET 1663','EL TOQUI 1663','APOQUINDO','FIJA','B'],
[-33.426559,-70.561415,'EL TOQUI','ELT-05 - ET 1711','EL TOQUI 1711','APOQUINDO','FIJA','B'],
[-33.426559,-70.561415,'EL TOQUI','ELT-06 - ET 1711','EL TOQUI 1711','APOQUINDO','FIJA','B'],
[-33.42585,-70.561234,'EL TOQUI','ELT-07 - ET 1677','EL TOQUI 1677','APOQUINDO','FIJA','B'],
[-33.42585,-70.561234,'EL TOQUI','ELT-08 - ET 1677','EL TOQUI 1677','APOQUINDO','FIJA','B'],
[-33.427539,-70.561536,'EL TOQUI','ELT-09 - ET 1770','EL TOQUI 1770','APOQUINDO','FIJA','B'],
[-33.427744,-70.561674,'EL TOQUI','ELT-10 - ET 1793','El Toqui 1793','APOQUINDO','FIJA','B'],
[-33.427744,-70.561674,'EL TOQUI','ELT-11 - ET 1793','El Toqui 1793','APOQUINDO','FIJA','B'],
[-33.428098,-70.561736,'EL TOQUI','ELT-12 - ET 1837','El Toqui 1837','APOQUINDO','FIJA','B'],
[-33.428512,-70.561833,'EL TOQUI','ELT-13 - ET 1853','EL TOQUI 1853','APOQUINDO','FIJA','B'],
[-33.428512,-70.561833,'EL TOQUI','ELT-14 - ET 1853','EL TOQUI 1853','APOQUINDO','FIJA','B'],
[-33.39237,-70.506289,'SANTA VERONICA','SV-01 - SV 1018','SANTA VERONICA 1018','SCDAPQ','FIJA','B'],
[-33.39237,-70.506289,'SANTA VERONICA','SV-02 - SV 1018','SANTA VERONICA 1018','SCDAPQ','FIJA','B'],
[-33.392535,-70.505889,'SANTA VERONICA','SV-03 - SV 1044','SANTA VERONICA 1044','SCDAPQ','FIJA','B'],
[-33.412575,-70.563352,'LOS ALMENDROS','LA-01 - M 6541','MONROE 6541','APOQUINDO','FIJA','B'],
[-33.412417,-70.563949,'LOS ALMENDROS','LA-02 - LA 561','LOS ALMENDROS 561','APOQUINDO','FIJA','B'],
[-33.412164,-70.564432,'LOS ALMENDROS','LA-03 - LA 485','LOS ALMENDROS 485','APOQUINDO','FIJA','B'],
[-33.412036,-70.564333,'LOS ALMENDROS','LA-04 - LA 483','LOS ALMENDROS 483','APOQUINDO','FIJA','B'],
[-33.412036,-70.564333,'LOS ALMENDROS','LA-05 - LA 483','LOS ALMENDROS 483','APOQUINDO','FIJA','B'],
[-33.411877,-70.563765,'LOS ALMENDROS','LA-06 - LA 498','LOS ALMENDROS 498','APOQUINDO','FIJA','B'],
[-33.412402,-70.5639,'LOS ALMENDROS','LA-07 - LA 537','Los Almendros 537','APOQUINDO','FIJA','B'],
[-33.413633,-70.530727,'VECINOS LUIS MATTE LARRAIN','VLML-01 - LML 917','LUIS MATTE LARRAIN 917','SCDAPQ','FIJA','B'],
[-33.413633,-70.530727,'VECINOS LUIS MATTE LARRAIN','VLML-02 - LML 917','LUIS MATTE LARRAIN 917','SCDAPQ','FIJA','B'],
[-33.412964,-70.530904,'VECINOS LUIS MATTE LARRAIN','VLML-04 - LML 907','LUIS MATTE LARRAIN 907','SCDAPQ','FIJA','B'],
[-33.412964,-70.530904,'VECINOS LUIS MATTE LARRAIN','VLML-05 - LML 907','LUIS MATTE LARRAIN 907','SCDAPQ','FIJA','B'],
[-33.412305,-70.531279,'VECINOS LUIS MATTE LARRAIN','VLML-06 - LML 899','LUIS MATTE LARRAIN 899','SCDAPQ','FIJA','B'],
[-33.412305,-70.531279,'VECINOS LUIS MATTE LARRAIN','VLML-07 - LML 899','LUIS MATTE LARRAIN 899','SCDAPQ','FIJA','B'],
[-33.411845,-70.531668,'VECINOS LUIS MATTE LARRAIN','VLML-09 - LML 885','LUIS MATTE LARRAIN 885','SCDAPQ','FIJA','B'],
[-33.411845,-70.531668,'VECINOS LUIS MATTE LARRAIN','VLML-10 - LML 885','LUIS MATTE LARRAIN 885','SCDAPQ','FIJA','B'],
[-33.413277,-70.530801,'VECINOS LUIS MATTE LARRAIN','VLML-03-PTZ - LML 913','LUIS MATTE LARRAIN 913','SCDAPQ','PTZ','B'],
[-33.412247,-70.531333,'VECINOS LUIS MATTE LARRAIN','VLML-08-PTZ - LML 893','LUIS MATTE LARRAIN 893','SCDAPQ','PTZ','B'],
[-33.393805,-70.507521,'SAN CARLOS LAS FLORES','SCLF-01 - CCS 12317','CERRO CATEDRAL SUR 12317','SCDAPQ','FIJA','B'],
[-33.393805,-70.507521,'SAN CARLOS LAS FLORES','SCLF-02 - CCS 12317','CERRO CATEDRAL SUR 12317','SCDAPQ','FIJA','B'],
[-33.393546,-70.508052,'SAN CARLOS LAS FLORES','SCLF-03 - SCDA 1126','SAN CARLOS DE APOQUINDO 1126','SCDAPQ','FIJA','B'],
[-33.393822,-70.508241,'SAN CARLOS LAS FLORES','SCLF-04 - SCDA 1128','SAN CARLOS DE APOQUINDO 1128','SCDAPQ','FIJA','B'],
[-33.394062,-70.508408,'SAN CARLOS LAS FLORES','SCLF-05 - SCDA 1154','SAN CARLOS DE APOQUINDO 1154','SCDAPQ','FIJA','B'],
[-33.394385,-70.508635,'SAN CARLOS LAS FLORES','SCLF-06 - SCDA 1218','SAN CARLOS DE APOQUINDO 1218','SCDAPQ','FIJA','B'],
[-33.394385,-70.508635,'SAN CARLOS LAS FLORES','SCLF-07 - SCDA 1218','SAN CARLOS DE APOQUINDO 1218','SCDAPQ','FIJA','B'],
[-33.394711,-70.508866,'SAN CARLOS LAS FLORES','SCLF-08 - SCDA 1248','SAN CARLOS DE APOQUINDO 1248','SCDAPQ','FIJA','B'],
[-33.394711,-70.508866,'SAN CARLOS LAS FLORES','SCLF-09 - SCDA 1248','SAN CARLOS DE APOQUINDO 1248','SCDAPQ','FIJA','B'],
[-33.394988,-70.509059,'SAN CARLOS LAS FLORES','SCLF-10 - SCDA 1290','SAN CARLSO DE APOQUINDO 1290','SCDAPQ','FIJA','B'],
[-33.395517,-70.509128,'SAN CARLOS LAS FLORES','SCLF-11 - CLF 12300','CAMINO LAS FLORES 12300','SCDAPQ','FIJA','B'],
[-33.395624,-70.50851,'SAN CARLOS LAS FLORES','SCLF-12 - CLF 12368','CAMINO LAS FLORES 12368','SCDAPQ','FIJA','B'],
[-33.395726,-70.507952,'SAN CARLOS LAS FLORES','SCLF-13 - CLF 12414','CAMINO LAS FLORES 12414','SCDAPQ','FIJA','B'],
[-33.395811,-70.507499,'SAN CARLOS LAS FLORES','SCLF-14 - CLF 12488','CAMINO LAS FLORES 12488','SCDAPQ','FIJA','B'],
[-33.395683,-70.507144,'SAN CARLOS LAS FLORES','SCLF-15 - STJDI 1094','SANTA TERESA JORNET DE IBARS 1094','SCDAPQ','FIJA','B'],
[-33.3907336,-70.5309123,'LOS CARPINTEROS 2','LCS2-01 - C 700','CAMPANARIO 700','APOQUINDO','FIJA','B'],
[-33.3908924,-70.5305183,'LOS CARPINTEROS 2','LCS2-02 - LC 10020','LOS CARPINTEROS 10020','APOQUINDO','FIJA','B'],
[-33.3908924,-70.5305183,'LOS CARPINTEROS 2','LCS2-03 - LC 10020','LOS CARPINTEROS 10020','APOQUINDO','FIJA','B'],
[-33.3904385,-70.5299653,'LOS CARPINTEROS 2','LCS2-04 - LC 10096','LOS CARPINTEROS 10096','APOQUINDO','FIJA','B'],
[-33.3904385,-70.5299653,'LOS CARPINTEROS 2','LCS2-05 - LC 10096','LOS CARPINTEROS 10096','APOQUINDO','FIJA','B'],
[-33.3900084,-70.5294545,'LOS CARPINTEROS 2','LCS2-06 - LC 10184','LOS CARPINTEROS 10184','APOQUINDO','FIJA','B'],
[-33.389867,-70.5292841,'LOS CARPINTEROS 2','LCS2-07 - LC 10195','LOS CARPINTEROS 10195','APOQUINDO','FIJA','B'],
[-33.3896655,-70.5290362,'LOS CARPINTEROS 2','LCS2-08 - LC 10231','LOS CARPINTEROS 10231','APOQUINDO','FIJA','B'],
[-33.3889483,-70.5281632,'LOS CARPINTEROS 2','LCS2-09 - LC 10277','LOS CARPINTEROS 10277','APOQUINDO','FIJA','B'],
[-33.403637,-70.512185,'ALTOS DE LA FORESTA 3','AFSR-01 - LO 12179','LOS OLIVOS 12179','SCDAPQ','FIJA','B'],
[-33.403615,-70.512141,'ALTOS DE LA FORESTA 3','AFSR-02 - LO 12179','LOS OLIVOS 12179','SCDAPQ','FIJA','B'],
[-33.403606,-70.512277,'ALTOS DE LA FORESTA 3','AFSR-03 - LO 12179','LOS OLIVOS 12179','SCDAPQ','FIJA','B'],
[-33.402829,-70.510934,'ALTOS DE LA FORESTA 3','AFSA-01 - LO 12289','LOS OLIVOS 12289','SCDAPQ','FIJA','B'],
[-33.402894,-70.510828,'ALTOS DE LA FORESTA 3','AFSA-02 - LO 12289','LOS OLIVOS 12289','SCDAPQ','FIJA','B'],
[-33.402894,-70.510828,'ALTOS DE LA FORESTA 3','AFSA-03 - LO 12289','LOS OLIVOS 12289','SCDAPQ','FIJA','B'],
[-33.404837,-70.525111,'CAMINO MIRASOL BLANCHE','CMGB-01 - CM 2148','CAMINO MIRASOL 2148','SCDAPQ','FIJA','B'],
[-33.404403,-70.525418,'CAMINO MIRASOL BLANCHE','CMGB-02 - CM 2099','CAMINO MIRASOL 2099','SCDAPQ','FIJA','B'],
[-33.404098,-70.525628,'CAMINO MIRASOL BLANCHE','CMGB-03 - CM 2080','CAMINO MIRASOL 2080','SCDAPQ','FIJA','B'],
[-33.403554,-70.526064,'CAMINO MIRASOL BLANCHE','CMGB-04 - CM 1982','CAMINO MIRASOL 1982','SCDAPQ','FIJA','B'],
[-33.403442,-70.52617,'CAMINO MIRASOL BLANCHE','CMGB-05 - CM 1943','CAMINO MIRASOL 1943','SCDAPQ','FIJA','B'],
[-33.403442,-70.52617,'CAMINO MIRASOL BLANCHE','CMGB-06 - CM 1943','CAMINO MIRASOL 1943','SCDAPQ','FIJA','B'],
[-33.403042,-70.526647,'CAMINO MIRASOL BLANCHE','CMGB-07 - CM 1888','CAMINO MIRASOL 1888','SCDAPQ','FIJA','B'],
[-33.402991,-70.525724,'CAMINO MIRASOL BLANCHE','CMGB-09 - GB 10364','GENERAL BLANCHE 10364','SCDAPQ','FIJA','B'],
[-33.402991,-70.525724,'CAMINO MIRASOL BLANCHE','CMGB-10 - GB 10364','GENERAL BLANCHE 10364','SCDAPQ','FIJA','B'],
[-33.402991,-70.525724,'CAMINO MIRASOL BLANCHE','CMGB-11 - GB 10364','GENERAL BLANCHE 10364','SCDAPQ','FIJA','B'],
[-33.403075,-70.524947,'CAMINO MIRASOL BLANCHE','CMGB-12 - GB 10472','GENERAL BLANCHE 10472','SCDAPQ','FIJA','B'],
[-33.402873,-70.527047,'CAMINO MIRASOL BLANCHE','CMGB-08-PTZ - GB 10260','GENERAL BLANCHE 10260','SCDAPQ','PTZ','B'],
[-33.400768,-70.513707,'LOS BENEDICTINOS - EL ALBA','LBEA-01 - CEA 12048','CAMINO EL ALBA 12048','SCDAPQ','FIJA','B'],
[-33.400414,-70.512759,'LOS BENEDICTINOS - EL ALBA','LBEA-02 - CEA 12061','CAMINO EL ALBA 12061','SCDAPQ','FIJA','B'],
[-33.400333,-70.512461,'LOS BENEDICTINOS - EL ALBA','LBEA-03 - CEA 12069','CAMINO EL ALBA 12069','SCDAPQ','FIJA','B'],
[-33.400333,-70.512461,'LOS BENEDICTINOS - EL ALBA','LBEA-04 - CEA 12069','CAMINO EL ALBA 12069','SCDAPQ','FIJA','B'],
[-33.400641,-70.512165,'LOS BENEDICTINOS - EL ALBA','LBEA-05 - CEA 12079','CAMINO EL ALBA 12079','SCDAPQ','FIJA','B'],
[-33.40047,-70.511556,'LOS BENEDICTINOS - EL ALBA','LBEA-06 - CEA 12141','CAMINO EL ALBA 12141','SCDAPQ','FIJA','B'],
[-33.40058,-70.511561,'LOS BENEDICTINOS - EL ALBA','LBEA-07 - CEA 12133','CAMINO EL ALBA 12133','SCDAPQ','FIJA','B'],
[-33.400087,-70.511596,'LOS BENEDICTINOS - EL ALBA','LBEA-08 - CEA 12145','CAMINO EL ALBA 12145','SCDAPQ','FIJA','B'],
[-33.399929,-70.511014,'LOS BENEDICTINOS - EL ALBA','LBEA-09 - CEA 12163','CAMINO EL ALBA 12163','SCDAPQ','FIJA','B'],
[-33.400331,-70.510952,'LOS BENEDICTINOS - EL ALBA','LBEA-10 - CEA 12169','CAMINO EL ALBA 12169','SCDAPQ','FIJA','B'],
[-33.3998,-70.510499,'LOS BENEDICTINOS - EL ALBA','LBEA-11 - CEA 12295','CAMINO EL ALBA 12295','SCDAPQ','FIJA','B'],
[-33.39985,-70.510219,'LOS BENEDICTINOS - EL ALBA','LBEA-12 - SCDA 1625','SAN CARLOS DE APOQUINDO 1625','SCDAPQ','FIJA','B'],
[-33.400505,-70.510228,'LOS BENEDICTINOS - EL ALBA','LBEA-13 - SCDA 1643','SAN CARLOS DE APOQUINDO 1643','SCDAPQ','FIJA','B'],
[-33.400804,-70.510228,'LOS BENEDICTINOS - EL ALBA','LBEA-14 - SCDA 1653','SAN CARLOS DE APOQUINDO 1653','SCDAPQ','FIJA','B'],
[-33.42402,-70.555304,'MAYECURA #2','MAY-01-PTZ - ILC 7400','ISABEL LA CATOLICA 7400','FLEMING','PTZ','B'],
[-33.423587,-70.555372,'MAYECURA #2','MAY-02 - M 1554','MAYECURA 1554','FLEMING','FIJA','B'],
[-33.423587,-70.555372,'MAYECURA #2','MAY-03 - M 1554','MAYECURA 1554','FLEMING','FIJA','B'],
[-33.423382,-70.555452,'MAYECURA #2','MAY-04 - M 1482','MAYECURA 1482','FLEMING','FIJA','B'],
[-33.422962,-70.555444,'MAYECURA #2','MAY-05 - M 1400','MAYECURA 1400','FLEMING','FIJA','B'],
[-33.422962,-70.555444,'MAYECURA #2','MAY-06 - M 1400','MAYECURA 1400','FLEMING','FIJA','B'],
[-33.422524,-70.555386,'MAYECURA #2','MAY-07-PTZ - M 1331','MAYECURA 1331','FLEMING','PTZ','B'],
[-33.422474,-70.555351,'MAYECURA #2','MAY-08 - M 1336','MAYECURA 1336','FLEMING','FIJA','B'],
[-33.422474,-70.555351,'MAYECURA #2','MAY-09 - M 1336','MAYECURA 1336','FLEMING','FIJA','B'],
[-33.421132,-70.560378,'MANUEL ALDUNATE','MA-01 - ADC 6497 (N)','ALONSO DE CAMARGO 6497','APOQUINDO','FIJA','B'],
[-33.42102,-70.560593,'MANUEL ALDUNATE','MA-02 - ADC 6466 (S)','ALONSO DE CAMARGO 6466','APOQUINDO','FIJA','B'],
[-33.420558,-70.56021,'MANUEL ALDUNATE','MA-03 - MA 6520 (P)','MANUEL ALDUNATE 6520','APOQUINDO','FIJA','B'],
[-33.420434,-70.56034,'MANUEL ALDUNATE','MA-04 - MA 6486 (O)','MANUEL ALDUNATE 6486','APOQUINDO','FIJA','B'],
[-33.420465,-70.560444,'MANUEL ALDUNATE','MA-05 - MA 6491 (P)','MANUEL ALDUNATE 6491','APOQUINDO','FIJA','B'],
[-33.420358,-70.560822,'MANUEL ALDUNATE','MA-06 - MA 6446 (O)','MANUEL ALDUNATE 6446','APOQUINDO','FIJA','B'],
[-33.420358,-70.560822,'MANUEL ALDUNATE','MA-07 - MA 6446 (P)','MANUEL ALDUNATE 6446','APOQUINDO','FIJA','B'],
[-33.420273,-70.561344,'MANUEL ALDUNATE','MA-08 - MA 6392 (O)','Manuel Aldunate 6392','APOQUINDO','FIJA','B'],
[-33.420273,-70.561344,'MANUEL ALDUNATE','MA-09 - MA 6392 (P)','Manuel Aldunate 6392','APOQUINDO','FIJA','B'],
[-33.42016,-70.561983,'MANUEL ALDUNATE','MA-10 - HDM 1227 (O)','Hernando De Magallanes 1227','APOQUINDO','FIJA','B'],
[-33.420475,-70.562058,'MANUEL ALDUNATE','MA-11 - HDM 1238 (N)','Hernando De Magallanes 1238','APOQUINDO','FIJA','B'],
[-33.415878,-70.57635,'PABLO EL VERONES','PEV-01 - D1 4852','DEL INCA 4852','EL GOLF','FIJA','B'],
[-33.416293,-70.576115,'PABLO EL VERONES','PEV-02 - PEV 555','PABLO EL VERONES 555','EL GOLF','FIJA','B'],
[-33.416657,-70.57587,'PABLO EL VERONES','PEV-03 - PEV 647','PABLO EL VERONES 647','EL GOLF','FIJA','B'],
[-33.416937,-70.57567,'PABLO EL VERONES','PEV-04 - PEV 696','PABLO EL VERONES 696','EL GOLF','FIJA','B'],
[-33.416937,-70.57567,'PABLO EL VERONES','PEV-05 - PEV 696','PABLO EL VERONES 696','EL GOLF','FIJA','B'],
[-33.417163,-70.575493,'PABLO EL VERONES','PEV-06-PTZ - PEV 773','PABLO EL VERONES 773','EL GOLF','PTZ','B'],
[-33.417163,-70.575493,'PABLO EL VERONES','PEV-07 - PEV 773','PABLO EL VERONES 773','EL GOLF','FIJA','B'],
[-33.417248,-70.575426,'PABLO EL VERONES','PEV-08 - PEV 782','PABLO EL VERONES 782','EL GOLF','FIJA','B'],
[-33.4171245,-70.5755441,'PABLO EL VERONES','PEV-09 - PEV 773','Pablo El Veronés 773','EL GOLF','FIJA','B'],
[-33.4172761,-70.5754248,'PABLO EL VERONES','PEV-10 - PEV 782','Pablo El Veronés 782','EL GOLF','FIJA','B'],
[-33.4177158,-70.5750327,'PABLO EL VERONES','PEV-11 - PEV MZ','Pablo El Veronés & Martín de Zamora','EL GOLF','FIJA','B'],
[-33.371878,-70.503344,'SANTA TERESA DE AVILA','STA-01 - SJDLS 201','SAN JOSE DE LA SIERRA 201','SCDAPQ','FIJA','B'],
[-33.371878,-70.503344,'SANTA TERESA DE AVILA','STA-02 - SJDLS 201','SAN JOSE DE LA SIERRA 201','SCDAPQ','FIJA','B'],
[-33.371894,-70.503421,'SANTA TERESA DE AVILA','STA-03 - STDA 13685','SANTA TERESA DE AVILA 13685','SCDAPQ','FIJA','B'],
[-33.372123,-70.504209,'SANTA TERESA DE AVILA','STA-04 - STDA 13610','SANTA TERESA DE AVILA 13610','SCDAPQ','FIJA','B'],
[-33.372123,-70.504209,'SANTA TERESA DE AVILA','STA-05 - STDA 13610','SANTA TERESA DE AVILA 13610','SCDAPQ','FIJA','B'],
[-33.372295,-70.504906,'SANTA TERESA DE AVILA','STA-06 - STDA 13516','SANTA TERESA DE AVILA 13516','SCDAPQ','FIJA','B'],
[-33.372295,-70.504906,'SANTA TERESA DE AVILA','STA-07 - STDA 13516','SANTA TERESA DE AVILA 13516','SCDAPQ','FIJA','B'],
[-33.372295,-70.504906,'SANTA TERESA DE AVILA','STA-08 - STDA 13516','SANTA TERESA DE AVILA 13516','SCDAPQ','FIJA','B'],
[-33.372274,-70.504706,'SANTA TERESA DE AVILA','STA-09 - STDA 13575','SANTA TERESA DE AVILA 13575','SCDAPQ','FIJA','B'],
[-33.372274,-70.504706,'SANTA TERESA DE AVILA','STA-10-PTZ - STDA 13575','SANTA TERESA DE AVILA 13575','SCDAPQ','PTZ','B'],
[-33.397034,-70.509857,'LOS PUMAS','LPS-01 - LP 12276','LOS PUMAS 12276','SCDAPQ','FIJA','B'],
[-33.397034,-70.509857,'LOS PUMAS','LPS-02 - LP 12276','LOS PUMAS 12276','SCDAPQ','FIJA','B'],
[-33.39691,-70.510596,'LOS PUMAS','LPS-03 - LP 12194','LOS PUMAS 12194','SCDAPQ','FIJA','B'],
[-33.39691,-70.510596,'LOS PUMAS','LPS-04 - LP 12194','LOS PUMAS 12194','SCDAPQ','FIJA','B'],
[-33.396767,-70.511445,'LOS PUMAS','LPS-05 - LP 12140','LOS PUMAS 12140','SCDAPQ','FIJA','B'],
[-33.396767,-70.511445,'LOS PUMAS','LPS-06 - LP 12140','LOS PUMAS 12140','SCDAPQ','FIJA','B'],
[-33.41166,-70.514918,'LA VIGUELA','LV-01 - CO 2837','CAMINO OTOÑAL 2837','SCDAPQ','FIJA','B'],
[-33.411365,-70.515678,'LA VIGUELA','LV-02 - CO 2785','CAMINO OTOÑAL 2785','SCDAPQ','FIJA','B'],
[-33.410678,-70.515687,'LA VIGUELA','LV-03 - CO 2708','CAMINO OTOÑAL 2708','SCDAPQ','FIJA','B'],
[-33.410141,-70.51584,'LA VIGUELA','LV-04-PTZ - CO 2678','CAMINO OTOÑAL 2678','SCDAPQ','PTZ','B'],
[-33.409775,-70.51455,'LA VIGUELA','LV-05 - LV 11717','LA VIGUELA 11717','SCDAPQ','FIJA','B'],
[-33.409775,-70.51455,'LA VIGUELA','LV-06 - LV 11717','LA VIGUELA 11717','SCDAPQ','FIJA','B'],
[-33.409037,-70.515251,'LA VIGUELA','LV-07 - LR 11771','LA RAMADA 11771','SCDAPQ','FIJA','B'],
[-33.409037,-70.515251,'LA VIGUELA','LV-08 - LR 11771','LA RAMADA 11771','SCDAPQ','FIJA','B'],
[-33.409175,-70.516279,'LA VIGUELA','LV-09 - CO 2536','CAMINO OTOÑAL 2536','SCDAPQ','FIJA','B'],
[-33.379915,-70.51289,'CAMINO LA VIÑA','CLV1-01 - CV 12314','CAMINO LA VIÑA 12314','SCDAPQ','FIJA','B'],
[-33.379897,-70.512829,'CAMINO LA VIÑA','CLV1-02 - CV 12314','CAMINO LA VIÑA 12314','SCDAPQ','FIJA','B'],
[-33.379706,-70.512402,'CAMINO LA VIÑA','CLV1-03 - CV 12368','CAMINO LA VIÑA 12368','SCDAPQ','FIJA','B'],
[-33.379577,-70.511975,'CAMINO LA VIÑA','CLV1-04 - CV 12439','CAMINO LA VIÑA 12439','SCDAPQ','FIJA','B'],
[-33.379409,-70.511669,'CAMINO LA VIÑA','CLV1-05 - CV 12442','CAMINO LA VIÑA 12442','SCDAPQ','FIJA','B'],
[-33.379124,-70.511007,'CAMINO LA VIÑA','CLV1-06 - CV 12479','CAMINO LA VIÑA 12479','SCDAPQ','FIJA','B'],
[-33.379124,-70.511007,'CAMINO LA VIÑA','CLV1-07 - CV 12479','CAMINO LA VIÑA 12479','SCDAPQ','FIJA','B'],
[-33.379124,-70.511007,'CAMINO LA VIÑA','CLV1-08 - CV 12479','CAMINO LA VIÑA 12479','SCDAPQ','FIJA','B'],
[-33.378331,-70.511474,'CAMINO LA VIÑA','CLV2-01 - CV 12486','CAMINO LA VIÑA 12486','SCDAPQ','FIJA','B'],
[-33.378331,-70.511474,'CAMINO LA VIÑA','CLV2-02 - CV-12486','CAMINO LA VIÑA 12486','SCDAPQ','FIJA','B'],
[-33.378222,-70.511626,'CAMINO LA VIÑA','CLV2-04 - CV 12478','CAMINO LA VIÑA 12478','SCDAPQ','FIJA','B'],
[-33.378222,-70.511626,'CAMINO LA VIÑA','CLV2-05 - CV 12478','CAMINO LA VIÑA 12472','SCDAPQ','FIJA','B'],
[-33.378379,-70.511937,'CAMINO LA VIÑA','CLV2-06 - CV 12444','CAMINO LA VIÑA 12444','SCDAPQ','FIJA','B'],
[-33.378808,-70.512934,'CAMINO LA VIÑA','CLV2-07 - CV 12354','CAMINO LA VIÑA 12354','SCDAPQ','FIJA','B'],
[-33.378808,-70.512934,'CAMINO LA VIÑA','CLV2-08 - CV 12354','CAMINO LA VIÑA 12354','SCDAPQ','FIJA','B'],
[-33.378724,-70.512799,'CAMINO LA VIÑA','CLV2-09 - CV 12313','CAMINO LA VIÑA 12313','SCDAPQ','FIJA','B'],
[-33.378212,-70.511548,'CAMINO LA VIÑA','CLV2-03-PTZ - CV 12482','CAMINO LA VIÑA 12482','SCDAPQ','PTZ','B'],
[-33.403136,-70.531858,'LUIS MATTE LARRAIN #2','LML2-01 - LML 9880','LUIS MATTE LARRAIN 9880','SCDAPQ','FIJA','B'],
[-33.403136,-70.531858,'LUIS MATTE LARRAIN #2','LML2-02 - LML 9880','LUIS MATTE LARRAIN 9880','SCDAPQ','FIJA','B'],
[-33.403317,-70.532175,'LUIS MATTE LARRAIN #2','LML2-03 - LML 9862','LUIS MATTE LARRAIN 9862','SCDAPQ','FIJA','B'],
[-33.403604,-70.532677,'LUIS MATTE LARRAIN #2','LML2-04 - LML 9818','LUIS MATTE LARRAIN 9818','SCDAPQ','FIJA','B'],
[-33.403604,-70.532677,'LUIS MATTE LARRAIN #2','LML2-05 - LML 9818','LUIS MATTE LARRAIN 9818','SCDAPQ','FIJA','B'],
[-33.404053,-70.533219,'LUIS MATTE LARRAIN #2','LML2-06 - LML 9744','LUIS MATTE LARRAIN 9774','SCDAPQ','FIJA','B'],
[-33.404053,-70.533219,'LUIS MATTE LARRAIN #2','LML2-08 - LML 9744','LUIS MATTE LARRAIN 9744','SCDAPQ','FIJA','B'],
[-33.404236,-70.533001,'LUIS MATTE LARRAIN #2','LML2-09 - LML 9743','LUIS MATTE LARRAIN 9743','SCDAPQ','FIJA','B'],
[-33.404439,-70.533657,'LUIS MATTE LARRAIN #2','LML2-10 - LML 9705','LUIS MATTE LARRAIN 9705','SCDAPQ','FIJA','B'],
[-33.404439,-70.533657,'LUIS MATTE LARRAIN #2','LML2-11 - LML 9705','LUIS MATTE LARRAIN 9705','SCDAPQ','FIJA','B'],
[-33.404453,-70.533644,'LUIS MATTE LARRAIN #2','LML2-12 - LML 9699','LUIS MATTE LARRAIN 9699','SCDAPQ','FIJA','B'],
[-33.404759,-70.534013,'LUIS MATTE LARRAIN #2','LML2-13 - LML 9647','LUIS MATTE LARRAIN 9647','SCDAPQ','FIJA','B'],
[-33.405062,-70.534364,'LUIS MATTE LARRAIN #2','LML2-14 - LML 9600','LUIS MATTE LARRAIN 9600','SCDAPQ','FIJA','B'],
[-33.404053,-70.533219,'LUIS MATTE LARRAIN #2','LML2-07-PTZ - LML 9744','LUIS MATTE LARRAIN 9744','SCDAPQ','PTZ','B'],
[-33.415607,-70.530465,'LUIS MATTE LARRAIN #5','LML5-01 - LML 940','Luis Matte Larraín 940','SCDAPQ','FIJA','B'],
[-33.4151747,-70.530424,'LUIS MATTE LARRAIN #5','LML5-02 - LML 936','Luis Matte Larraín 936','SCDAPQ','FIJA','B'],
[-33.4151747,-70.530424,'LUIS MATTE LARRAIN #5','LML5-03 - LML 936','Luis Matte Larraín 936','SCDAPQ','FIJA','B'],
[-33.414695,-70.530401,'LUIS MATTE LARRAIN #5','LML5-04 - LML 930','Luis Matte Larraín 930','SCDAPQ','FIJA','B'],
[-33.4145092,-70.530492,'LUIS MATTE LARRAIN #5','LML5-05 - LML 927','Luis Matte Larraín 927','SCDAPQ','FIJA','B'],
[-33.4145092,-70.530492,'LUIS MATTE LARRAIN #5','LML5-06 - LML 927','Luis Matte Larraín 927','SCDAPQ','FIJA','B'],
[-33.4141969,-70.530568,'LUIS MATTE LARRAIN #5','LML5-07 - LML 924','Luis Matte Larraín 924','SCDAPQ','FIJA','B'],
[-33.4141969,-70.530568,'LUIS MATTE LARRAIN #5','LML5-08 - LML 924','Luis Matte Larraín 924','SCDAPQ','FIJA','B'],
[-33.413714,-70.530547,'LUIS MATTE LARRAIN #5','LML5-09 - CPO 9574','Carlos Peña Otaegui 9574','SCDAPQ','FIJA','B'],
[-33.3923971,-70.51816,'CONDOMINIO OTOÑAL 1198','CO-01 - CO 1189','Camino Otoñal 1189','SCDAPQ','FIJA','B'],
[-33.3923971,-70.51816,'CONDOMINIO OTOÑAL 1198','CO-02 - CO 1189','Camino Otoñal 1189','SCDAPQ','FIJA','B'],
[-33.3929269,-70.516133,'CONDOMINIO OTOÑAL 1198','CO-03 - CO 1189','Camino Otoñal 1189','SCDAPQ','FIJA','B'],
[-33.3929269,-70.516133,'CONDOMINIO OTOÑAL 1198','CO-04 - CO 1189','Camino Otoñal 1189','SCDAPQ','FIJA','B'],
[-33.418875,-70.52017,'AVENIDA EL REMANSO','AER-01 - ER 9417','El Remanso 9417','SCDAPQ','FIJA','B'],
[-33.41939,-70.52028,'AVENIDA EL REMANSO','AER-02 - ER 11828','El Remanso 11828','SCDAPQ','FIJA','B'],
[-33.41939,-70.52028,'AVENIDA EL REMANSO','AER-03 - ER 11828','El Remanso 11828','SCDAPQ','FIJA','B'],
[-33.419721,-70.520521,'AVENIDA EL REMANSO','AER-04 - ER 11832','Caseta Norte','SCDAPQ','FIJA','B'],
[-33.419721,-70.520521,'AVENIDA EL REMANSO','AER-05 - ER 11832','Caseta Sur','SCDAPQ','FIJA','B'],
[-33.420116,-70.520713,'AVENIDA EL REMANSO','AER-06 - ER 11842','El Remanso 11842','SCDAPQ','FIJA','B'],
[-33.420116,-70.520713,'AVENIDA EL REMANSO','AER-07 - ER 11842','El Remanso 11842','SCDAPQ','FIJA','B'],
[-33.420584,-70.520658,'AVENIDA EL REMANSO','AER-08 - ER 11851','El Remanso 11851','SCDAPQ','FIJA','B'],
[-33.420584,-70.520658,'AVENIDA EL REMANSO','AER-09 - ER 11851','El Remanso 11851','SCDAPQ','FIJA','B'],
[-33.4167121,-70.572796,'SEBASTIAN ELCANO','SE-01 - SE 849 (N)','849 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4162907,-70.572964,'SEBASTIAN ELCANO','SE-02 - SE 756 (N)','756 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4162907,-70.572964,'SEBASTIAN ELCANO','SE-03 - SE 700 (S)','700 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4157992,-70.57316,'SEBASTIAN ELCANO','SE-04 - SE 628 (O)','628 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4157115,-70.5732012,'SEBASTIAN ELCANO','SE-05 - SE 609 (S)','609 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.415509,-70.5732762,'SEBASTIAN ELCANO','SE-06 - SE 538 (P)','538 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4153322,-70.5733486,'SEBASTIAN ELCANO','SE-07 - SE 487 (S)','487 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4153322,-70.5733486,'SEBASTIAN ELCANO','SE-08 - SE 487 (N)','487 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.4151459,-70.5734251,'SEBASTIAN ELCANO','SE-09 - SE 482 (O)','482 Sebastián Elcano','EL GOLF','FIJA','B'],
[-33.423508,-70.573045,'JOSE DE MORALEDA','JDM-01 - JDM 4894','José de Moraleda 4894','EL GOLF','FIJA','B'],
[-33.423508,-70.573045,'JOSE DE MORALEDA','JDM-02 - JDM 4894','José de Moraleda 4894','EL GOLF','FIJA','B'],
[-33.392616,-70.493305,'SAN FRANCISCO DE ASIS','SFDA-01 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398','SCDAPQ','FIJA','B'],
[-33.392677,-70.49388,'SAN FRANCISCO DE ASIS','SFDA-02 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398','SCDAPQ','FIJA','B'],
[-33.392677,-70.493881,'SAN FRANCISCO DE ASIS','SFDA-03 - CSFDA 2398','CAMINO SAN FRANCISCO DE ASIS 2398','SCDAPQ','FIJA','B'],
[-33.3884,-70.503295,'SANTA CLARA #2','SC2-01 - SC 12276','Sta Clara 12276','SCDAPQ','FIJA','B'],
[-33.3884,-70.503295,'SANTA CLARA #2','SC2-02 - SC 12276','Sta Clara 12276','SCDAPQ','FIJA','B'],
[-33.387997,-70.503569,'SANTA CLARA #2','SC2-03 - SC 12238','Sta Clara 12238','SCDAPQ','FIJA','B'],
[-33.387997,-70.503569,'SANTA CLARA #2','SC2-04 - SC 12238','Sta Clara 12238','SCDAPQ','FIJA','B'],
[-33.387225,-70.50412,'SANTA CLARA #2','SC2-05 - SC 12161','Sta Clara 12161','SCDAPQ','FIJA','B'],
[-33.387225,-70.50412,'SANTA CLARA #2','SC2-06 - SC 12161','Sta Clara 12161','SCDAPQ','FIJA','B'],
[-33.387295,-70.504029,'SANTA CLARA #2','SC2-07 - SC 12161','Sta Clara 12161','SCDAPQ','FIJA','B'],
[-33.387087,-70.504307,'SANTA CLARA #2','SC2-08 - SC 12135','Sta Clara 12135','SCDAPQ','FIJA','B'],
[-33.387087,-70.504307,'SANTA CLARA #2','SC2-09 - SC 12135','Sta Clara 12135','SCDAPQ','FIJA','B'],
[-33.386811,-70.504611,'SANTA CLARA #2','SC2-10 - SC 12150','Sta Clara 12150','SCDAPQ','FIJA','B'],
[-33.411904,-70.535469,'RIO GUADIANA','RG-01 - RG PH (N)','RIO GUADIANA & PAUL HARRIS','SCDAPQ','FIJA','B']
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

    /** Parsea array raw a objetos de cámara */
    function parseCamarasRaw(raw) {
        return raw.map(c => ({
            lat: c[0], lng: c[1],
            nombre: c[2] || 'Cámara',
            codigo: c[3] || '',
            dir: c[4] || '',
            destacamento: c[5] || '',
            tipo: c[6] || '',
            programa: c[7] || 'R',
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
                padding:8px 16px; display:flex; align-items:center; justify-content:space-between;
                height:42px;
            }
            #mi-topbar .left { display:flex; align-items:center; gap:12px; }
            #mi-topbar .right { display:flex; align-items:center; gap:16px; }
            #mi-topbar h1 { font-size:14px; font-weight:700; color:#fff; margin:0; }
            .mi-badge { background:rgba(37,99,235,.25); color:#60a5fa; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
            .mi-badge.live { background:rgba(16,185,129,.2); color:#34d399; }
            .mi-badge.demo { background:rgba(245,158,11,.2); color:#fbbf24; }
            #mi-back {
                background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.1);
                color:#fff; padding:4px 10px; border-radius:6px; cursor:pointer;
                font:500 11px -apple-system,sans-serif; transition:all .2s;
            }
            #mi-back:hover { background:rgba(255,255,255,.15); }
            .mi-stat { font-size:11px; color:rgba(255,255,255,.5); }
            .mi-stat strong { color:rgba(255,255,255,.8); }
            .mi-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:3px; }
            .mi-dot.p { background:#f87171; } .mi-dot.c { background:#60a5fa; }
            #mi-clock { font:600 12px -apple-system,sans-serif; color:rgba(255,255,255,.6); font-variant-numeric:tabular-nums; }
            #mi-refresh-info { font-size:10px; color:rgba(255,255,255,.35); display:flex; align-items:center; gap:4px; }
            .mi-spinner { width:8px;height:8px;border:1.5px solid rgba(96,165,250,.3);border-top-color:#60a5fa;border-radius:50%;display:none;animation:mi-spin .5s linear infinite; }
            .mi-spinner.on { display:inline-block; }
            @keyframes mi-spin { to{transform:rotate(360deg)} }

            /* ═══ PANEL ÚLTIMA HORA ═══ */
            #mi-panel {
                position:fixed; top:42px; right:0; width:340px; bottom:0; z-index:999;
                background:rgba(15,17,23,.94); backdrop-filter:blur(16px);
                border-left:1px solid rgba(255,255,255,.06);
                display:flex; flex-direction:column;
                transition:transform .25s cubic-bezier(.4,0,.2,1);
            }
            #mi-panel.collapsed { transform:translateX(100%); }
            #mi-panel-toggle {
                position:fixed; top:52px; right:352px; z-index:1001;
                background:rgba(15,17,23,.85); border:1px solid rgba(255,255,255,.1);
                color:#e2e4e9; padding:6px 10px; border-radius:6px; cursor:pointer;
                font:600 11px -apple-system,sans-serif; transition:all .25s;
            }
            #mi-panel.collapsed ~ #mi-panel-toggle { right:12px; }
            #mi-panel-toggle:hover { background:rgba(37,99,235,.25); }
            #mi-panel-head {
                padding:12px 14px 8px; border-bottom:1px solid rgba(255,255,255,.06); flex-shrink:0;
            }
            #mi-panel-head h3 { font-size:13px; font-weight:700; color:#fff; margin:0 0 6px; display:flex; align-items:center; gap:6px; }
            #mi-panel-body { flex:1; overflow-y:auto; padding:2px 0; }
            #mi-panel-body::-webkit-scrollbar { width:3px; }
            #mi-panel-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12); border-radius:2px; }

            .mi-sec {
                padding:5px 14px; font:700 9px -apple-system,sans-serif;
                text-transform:uppercase; letter-spacing:.7px; color:rgba(255,255,255,.3);
                background:rgba(255,255,255,.02); position:sticky; top:0; z-index:2;
            }
            .mi-card {
                padding:8px 14px; border-bottom:1px solid rgba(255,255,255,.03);
                cursor:pointer; transition:background .12s; border-left:3px solid transparent;
            }
            .mi-card:hover { filter:brightness(1.3); }
            .mi-card.new { animation:mi-flash .6s ease 2; }
            @keyframes mi-flash { 0%,100%{background:transparent} 50%{background:rgba(251,191,36,.1)} }

            .mi-card-top { display:flex; justify-content:space-between; align-items:flex-start; gap:6px; margin-bottom:3px; }
            .mi-card-tipo { font-size:11px; font-weight:600; color:#fff; flex:1; }
            .mi-card-est {
                font-size:8px; font-weight:700; padding:1px 5px; border-radius:3px;
                text-transform:uppercase; letter-spacing:.2px; flex-shrink:0;
            }
            .mi-card-est.p { background:rgba(239,68,68,.12); color:#f87171; }
            .mi-card-est.c { background:rgba(96,165,250,.1); color:#60a5fa; }
            .mi-card-meta { font-size:9px; color:rgba(255,255,255,.35); display:flex; gap:6px; margin-bottom:2px; }
            .mi-card-id { cursor:pointer; transition:color .12s; }
            .mi-card-id:hover { color:#60a5fa; text-decoration:underline; }
            .mi-card-id.copied { color:#34d399; }
            .mi-card-dir { font-size:10px; color:rgba(255,255,255,.5); }
            .mi-card-btns { display:flex; gap:3px; margin-top:4px; }
            .mi-card-btns button {
                background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.07);
                color:rgba(255,255,255,.45); padding:1px 6px; border-radius:3px;
                font:500 8px -apple-system,sans-serif; cursor:pointer; transition:all .12s;
            }
            .mi-card-btns button:hover { background:rgba(37,99,235,.18); color:#60a5fa; border-color:rgba(37,99,235,.3); }

            /* ═══ LEYENDA ═══ */
            #mi-legend {
                position:fixed; bottom:12px; left:12px; z-index:999;
                background:rgba(15,17,23,.88); backdrop-filter:blur(8px);
                border:1px solid rgba(255,255,255,.08); border-radius:6px;
                padding:6px 10px; font-size:9px;
            }
            #mi-legend h4 { font:600 9px -apple-system,sans-serif; color:rgba(255,255,255,.4); margin:0 0 3px; text-transform:uppercase; letter-spacing:.5px; }
            .mi-leg { display:flex; align-items:center; gap:5px; margin:1px 0; color:rgba(255,255,255,.45); }
            .mi-leg-d { width:7px; height:7px; border-radius:50%; }

            .mi-cursor-tooltip {
                background:rgba(0,0,0,.8)!important; border:1px solid rgba(52,211,153,.4)!important;
                color:#34d399!important; font:700 12px -apple-system,sans-serif!important;
                padding:2px 6px!important; border-radius:4px!important; box-shadow:none!important;
            }
            .mi-cursor-tooltip::before { display:none!important; }

            /* ═══ NEARBY CAMERA LABELS ═══ */
            .mi-nearby-label {
                background:rgba(0,0,0,.85); backdrop-filter:blur(6px);
                border-radius:4px; padding:3px 6px;
                font:700 10px -apple-system,sans-serif;
                white-space:nowrap; pointer-events:none;
                border:1px solid rgba(255,255,255,.15);
                box-shadow:0 2px 8px rgba(0,0,0,.5);
                line-height:1.3;
            }
            .mi-nearby-square {
                display:inline-block; width:6px; height:6px;
                border-radius:1px; margin-right:3px; vertical-align:middle;
            }

            .mi-cam-popup .leaflet-popup-content-wrapper { padding:0!important; min-width:auto!important; }
            .mi-cam-popup .leaflet-popup-content { margin:5px 8px!important; }

            /* ═══ LEAFLET POPUP OVERRIDE ═══ */
            .leaflet-popup-content-wrapper {
                background:rgba(15,17,23,.95)!important; backdrop-filter:blur(12px);
                border:1px solid rgba(255,255,255,.1)!important; border-radius:8px!important;
                color:#e2e4e9!important; box-shadow:0 8px 32px rgba(0,0,0,.5)!important;
            }
            .leaflet-popup-tip { background:rgba(15,17,23,.95)!important; }
            .mi-proc-popup .leaflet-popup-content-wrapper {
                background:rgba(15,17,23,.55)!important; border-color:rgba(255,255,255,.06)!important;
                box-shadow:0 2px 12px rgba(0,0,0,.3)!important; backdrop-filter:blur(6px)!important;
                overflow:hidden!important;
            }
            .mi-proc-popup .leaflet-popup-content { margin:8px 12px 8px!important; }
            .mi-proc-popup .leaflet-popup-tip { background:rgba(15,17,23,.55)!important; }
            .mi-proc-popup { pointer-events:none; }
            .mi-proc-popup .leaflet-popup-content-wrapper { pointer-events:auto; }
            .leaflet-popup-content { margin:8px 12px!important; font:12px -apple-system,sans-serif!important; line-height:1.4!important; }
            .mi-popup-tipo { font-weight:700; font-size:13px; margin-bottom:3px; }
            .mi-popup-dir { color:rgba(255,255,255,.55); font-size:11px; margin-bottom:4px; }
            .mi-popup-meta { font-size:10px; color:rgba(255,255,255,.35); }
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
            <div id="mi-map" style="top:42px"></div>

            <!-- PANEL -->
            <div id="mi-panel">
                <div id="mi-panel-head">
                    <h3>Pendientes <span class="mi-badge" id="mi-proc-cnt">0</span></h3>
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
        const idDisplay = p.id.length > 4 ? p.id.slice(0, -4) + '-' + p.id.slice(-4) : p.id;
        return `
            <div class="mi-card" data-id="${esc(p.id)}" style="border-left-color:${p.cat.color};background:${p.cat.color}1F">
                <div class="mi-card-top">
                    <span class="mi-card-tipo" style="color:${p.cat.color}">${p.cat.icon} ${esc(p.tipo)}</span>
                    <span class="mi-card-est p">PENDIENTE</span>
                </div>
                <div class="mi-card-meta">
                    <span>🕐 ${esc(hora)}</span>
                    <span class="mi-card-id" data-action="copy" data-copy="${esc(p.id)}">ID: ${esc(idDisplay)}</span>
                </div>
                ${p.dir ? `<div class="mi-card-dir">📍 ${esc(p.dir)}</div>` : ''}
                <div class="mi-card-btns">
                    <button data-action="arcgis" data-dir="${esc(p.dir)}" data-pid="${esc(p.id)}">🗺️ ArcGIS</button>
                    <button data-action="gmaps" data-dir="${esc(p.dir)}">📍 GMaps</button>
                    <button data-action="ignore" data-id="${esc(p.id)}">✕ Ignorar</button>
                </div>
            </div>`;
    }

    function renderPanel() {
        const container = S.ui.container;
        if (!container) return;
        const body = container.querySelector('#mi-panel-body');

        const pendientes = S.procs.all.filter(p => p.estado === 'PENDIENTE' && !S.procs.ignored.has(p.id));
        const ignorados = S.procs.all.filter(p => p.estado === 'PENDIENTE' && S.procs.ignored.has(p.id));

        container.querySelector('#mi-proc-cnt').textContent = pendientes.length;
        container.querySelector('#mi-cnt-p').textContent = pendientes.length;
        container.querySelector('#mi-cnt-c').textContent = ignorados.length;

        body.innerHTML = pendientes.length
            ? pendientes.map(cardHTML).join('')
            : '<div style="padding:30px;text-align:center;color:rgba(255,255,255,.2);font-size:11px">Sin pendientes activos</div>';
    }

    /** Event delegation: un solo listener para todo el panel */
    function setupPanelDelegation(signal) {
        const body = S.ui.container?.querySelector('#mi-panel-body');
        if (!body) return;

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

                if (action === 'ignore') {
                    e.stopPropagation();
                    const id = actionEl.dataset.id;
                    S.procs.ignored.add(id);
                    const entry = S.procs.markers.get(id);
                    if (entry) {
                        S.layers.proc.removeLayer(entry.marker);
                        S.procs.markers.delete(id);
                    }
                    S.layers.nearby?.clearLayers();
                    renderPanel();
                    return;
                }
            }

            // Click en card → centrar en mapa
            const card = target.closest('.mi-card');
            if (card) {
                const entry = S.procs.markers.get(card.dataset.id);
                if (entry) centrarEnProcedimiento(entry);
            }
        }, { signal });
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
        const q = prepararDireccion(dir) + ', Las Condes, Santiago, Chile';
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
        const panelW = panelOpen ? 340 : 0;
        const topbarH = 42;
        const mapSize = S.map.getSize();
        const centerX = (mapSize.x - panelW) / 2;
        const centerY = topbarH + ((mapSize.y - topbarH) / 2);

        S.map.setZoom(17, { animate: false });
        setTimeout(() => {
            const targetPoint = S.map.latLngToContainerPoint(entry.coords);
            S.map.panBy([targetPoint.x - centerX, targetPoint.y - centerY], { animate: true, duration: 0.4 });
            setTimeout(() => {
                entry.marker.openPopup();
                mostrarCamarasCercanas(entry.coords);
            }, 450);
        }, 100);
    }

    async function renderMapProcs() {
        S.layers.proc.clearLayers();
        S.procs.markers.clear();

        const filtered = S.procs.all.filter(p => p.estado === 'PENDIENTE' && !S.procs.ignored.has(p.id));

        for (const p of filtered) {
            if (!p.dir) continue;
            const coords = await geocodificarEnCola(p.dir);
            if (!coords) continue;

            const marker = L.circleMarker(coords, {
                radius: 8,
                fillColor: p.cat.color,
                fillOpacity: 0.8,
                color: '#fff',
                weight: 2,
            }).addTo(S.layers.proc);

            marker.bindPopup(`
                <div>
                    <div class="mi-popup-tipo" style="color:${p.cat.color}">${p.cat.icon} ${esc(p.tipo)}</div>
                    <div class="mi-popup-dir">📍 ${esc(p.dir)}</div>
                    <div class="mi-popup-meta">
                        ${esc(p.fecha)} · ID: ${esc(p.id)}<br>
                        Estado: <strong style="color:#f87171">PENDIENTE</strong>
                        ${p.desc ? `<br><em style="color:rgba(255,255,255,.3)">${esc(p.desc)}</em>` : ''}
                    </div>
                </div>
            `);

            marker.on('click', () => {
                setTimeout(() => mostrarCamarasCercanas(coords), 100);
            });

            S.procs.markers.set(p.id, { marker, coords, proc: p });
        }
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

        cercanas.forEach(cam => {
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
            L.marker([cam.lat, cam.lng], { icon, interactive: false }).addTo(S.layers.nearby);

            const tooltip = L.tooltip({
                permanent: true,
                direction: 'top',
                offset: [0, -8],
                className: 'mi-nearby-label',
            });
            tooltip.setContent(`<span class="mi-nearby-square" style="background:${color}"></span><strong>${esc(short)}</strong> <span style="font-size:8px;color:rgba(255,255,255,.3)">${dist}m</span>`);

            L.marker([cam.lat, cam.lng], {
                icon: L.divIcon({ className: '', html: '', iconSize: [0, 0] }),
            }).bindTooltip(tooltip).addTo(S.layers.nearby);
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
        const { procs, live } = await fetchProcedimientos();

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
        await renderMapProcs();
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

            const size = 11;
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:${size}px;height:${size}px;background:${color};border:1.5px solid ${border};opacity:0.75;border-radius:1px;cursor:pointer;transition:transform .1s;"></div>`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            const marker = L.marker([cam.lat, cam.lng], { icon }).addTo(S.layers.cam);

            // Popup con event delegation seguro (sin inline onclick)
            const popupDiv = document.createElement('div');
            popupDiv.style.cssText = 'text-align:center;min-width:50px';

            const codeEl = document.createElement('div');
            codeEl.style.cssText = `font:700 13px -apple-system,sans-serif;color:${color};cursor:pointer;border-bottom:1px dashed rgba(255,255,255,.2);padding-bottom:2px`;
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
                dirEl.style.cssText = 'font-size:9px;color:rgba(255,255,255,.35);margin-top:2px';
                dirEl.textContent = cam.dir;
                popupDiv.appendChild(dirEl);
            }

            marker.bindPopup(popupDiv, { closeButton: false, className: 'mi-cam-popup' });
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
                if (S.draw.mode) {
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
        // No limpiar procs.ignored — persiste entre activaciones
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

    console.log('[MapaIntegrado] ✅ v3.0 cargado. Usa #mapa-integrado para activar.');

})();
