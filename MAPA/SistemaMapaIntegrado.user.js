// ==UserScript==
// @name         Sistema Mapa Integrado
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Mapa Leaflet integrado con procedimientos en vivo y panel Última Hora. Accesible via #mapa-integrado
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2025-2026 Leonardo Navarro
// @license      MIT
// @match        https://seguridad.lascondes.cl/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/SistemaMapaIntegrado.user.js
// @downloadURL  https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/SistemaMapaIntegrado.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  CONFIGURACIÓN                                                ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const CONFIG = {
        HASH: '#mapa-integrado',
        CENTER: [-33.4153, -70.5730],
        ZOOM: 14,
        PROC_URL: '/incidents',
        ARCGIS_VISOR_URL: 'https://arcgismlc.lascondes.cl/portal/apps/webappviewer/index.html?id=118513d990134fcbb9196ac7884cfb8c',
        // ── Cámaras ──
        // Cuando tengas la URL del FeatureServer, ponela acá:
        // CAMARAS_FEATURESERVER: 'https://arcgismlc.lascondes.cl/server/rest/services/NOMBRE/FeatureServer/N',
        CAMARAS_FEATURESERVER: null,
        // ── Refresh adaptativo (segundos) ──
        REFRESH: { 0: 30, 5: 15, 15: 8, max: 5 },
        VENTANA_MIN: 60,
        // ── Leaflet CDN ──
        LEAFLET_CSS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
        LEAFLET_JS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  CATEGORÍAS (fuente compartida con Sistema Máscara)           ║
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

    function clasificar(tipo) {
        if (!tipo) return { id: 'otro', nombre: 'Otro', color: '#6b7280', icon: '⚪' };
        const t = tipo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        for (const cat of CATEGORIAS) {
            for (const kw of cat.keywords) {
                if (t.includes(kw.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return cat;
            }
        }
        return { id: 'otro', nombre: 'Otro', color: '#6b7280', icon: '⚪' };
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  GEOCODING LOCAL (Nominatim + caché)                          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const geoCache = new Map();
    let geoQueue = [];
    let geoProcessing = false;

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

    async function geocodificar(dir) {
        if (!dir) return null;
        const clave = dir.toUpperCase().trim();
        if (geoCache.has(clave)) return geoCache.get(clave);

        const q = prepararDireccion(dir) + ', Las Condes, Santiago, Chile';
        try {
            const resp = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&bounded=1&viewbox=-70.65,-33.35,-70.50,-33.45`
            );
            const data = await resp.json();
            if (data.length > 0) {
                const coords = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
                geoCache.set(clave, coords);
                return coords;
            }
        } catch (e) {
            console.warn('[MapaIntegrado] Geocoding error:', e);
        }
        // Fallback determinístico dentro de Las Condes
        let hash = 0;
        for (let i = 0; i < clave.length; i++) hash = ((hash << 5) - hash) + clave.charCodeAt(i);
        const lat = CONFIG.CENTER[0] + ((hash % 800) / 800) * 0.04 - 0.02;
        const lng = CONFIG.CENTER[1] + (((hash >> 10) % 800) / 800) * 0.05 - 0.025;
        const coords = [lat, lng];
        geoCache.set(clave, coords);
        return coords;
    }

    // Procesar cola con throttle (1 req/s para Nominatim)
    async function processGeoQueue() {
        if (geoProcessing) return;
        geoProcessing = true;
        while (geoQueue.length > 0) {
            const { dir, resolve } = geoQueue.shift();
            const coords = await geocodificar(dir);
            resolve(coords);
            if (geoQueue.length > 0) await new Promise(r => setTimeout(r, 1100));
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
    // ║  SCRAPER DE PROCEDIMIENTOS (mismo origen, sin CORS)           ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function parseProcedimientosHTML(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const filas = doc.querySelectorAll('table.table tbody tr');
        const resultados = [];
        const ahora = new Date();
        const limite = new Date(ahora.getTime() - CONFIG.VENTANA_MIN * 60000);

        filas.forEach(fila => {
            const celdas = fila.querySelectorAll('td');
            if (celdas.length < 7) return;

            // Columnas: 0=Área, 1=Fecha, 2=Procedimiento, 3=Identificador, 4=Operador, 5=Descripción, 6=Dirección
            const fechaTexto = celdas[1]?.textContent?.trim();
            if (!fechaTexto) return;

            const m = fechaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
            if (!m) return;
            const fecha = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5]));

            if (fecha < limite) return;

            // Estado: badge-danger = PENDIENTE, badge-primary = CERRADO
            const areaHTML = celdas[0]?.innerHTML || '';
            const estadoGlobal = areaHTML.includes('badge-danger') ? 'PENDIENTE' : 'CERRADO';

            const tipo = celdas[2]?.textContent?.trim() || '';
            const id = celdas[3]?.textContent?.trim() || '';
            const operador = celdas[4]?.textContent?.trim() || '';

            // Descripción: primera línea
            const descRaw = celdas[5]?.textContent?.trim() || '';
            const desc = descRaw.split('\n')[0]?.substring(0, 120) || '';

            const dir = celdas[6]?.textContent?.trim() || '';

            resultados.push({
                fecha: fechaTexto,
                fechaObj: fecha,
                tipo, id, operador, desc, dir,
                estado: estadoGlobal,
                cat: clasificar(tipo),
            });
        });

        // Ordenar más recientes primero
        resultados.sort((a, b) => b.fechaObj - a.fechaObj);
        return resultados;
    }

    async function fetchProcedimientos() {
        try {
            // Fetch desde mismo origen — sin CORS
            const resp = await fetch(CONFIG.PROC_URL, {
                credentials: 'same-origin',
                headers: { 'Accept': 'text/html' },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();
            const procs = parseProcedimientosHTML(html);
            return { procs, live: true };
        } catch (e) {
            console.error('[MapaIntegrado] Fetch error:', e);
            return { procs: [], live: false };
        }
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  CÁMARAS (FeatureServer o hardcoded)                          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    // 520 cámaras reales extraídas del FeatureServer ArcGIS (10/02/2026)
    // Formato: [lat, lon, nombre, id_cámara, dirección, destacamento, tipo]
    const CAMARAS_RAW = [
[-33.430769,-70.562437,'EL TOQUI #2','ELT2-01 - ET 2001','EL TOQUI 2001','APOQUINDO','FIJA'],
[-33.430497,-70.562345,'EL TOQUI #2','ELT2-03 - ET 1997','EL TOQUI 1977','APOQUINDO','FIJA'],
[-33.430403,-70.562314,'EL TOQUI #2','ELT2-04 - ET 1977','EL TOQUI 1977','APOQUINDO','FIJA'],
[-33.429992,-70.562182,'EL TOQUI #2','ELT2-05 - ET 1956','EL TOQUI 1956','APOQUINDO','FIJA'],
[-33.429642,-70.562134,'EL TOQUI #2','ELT2-06 - ET 1948','EL TOQUI 1948','APOQUINDO','FIJA'],
[-33.429188,-70.561954,'EL TOQUI #2','ELT2-07 - ET 1887','EL TOQUI 1887','APOQUINDO','FIJA'],
[-33.429612,-70.562655,'EL TOQUI #2','ELT2-08 - P 6420','PROGRESO 6420','APOQUINDO','FIJA'],
[-33.429549,-70.554328,'ÑANDU','N-01 - N TM','Ñandu & Tomas Moro','FLEMING','FIJA'],
[-33.429657,-70.553729,'ÑANDU','N-02 - N 7547','Ñandu 7547','FLEMING','FIJA'],
[-33.429629,-70.553598,'ÑANDU','N-04-PTZ - N 7567','Ñandu 7567','FLEMING','PTZ'],
[-33.429573,-70.553317,'ÑANDU','N-06 - N 7628','Ñandu 7628','FLEMING','FIJA'],
[-33.429596,-70.553202,'ÑANDU','N-05 - N 7611','Ñandu 7611','FLEMING','FIJA'],
[-33.429505,-70.552822,'ÑANDU','N-07 - P 1962','Polcura 1962','FLEMING','FIJA'],
[-33.430189,-70.557551,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-01 - JP 1960 (NO)','Juan Palau 1952','FLEMING','FIJA'],
[-33.430035,-70.557577,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-02 - JP 1952 (S)','Juan Palau 1952','FLEMING','FIJA'],
[-33.429494,-70.557422,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-03 - JP 1898 (P)','Juan Palau 1898','FLEMING','FIJA'],
[-33.428997,-70.557423,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-04-PTZ - JP CA','Juan Palau & Carlos Alvarado','FLEMING','PTZ'],
[-33.429162,-70.556671,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-05 - CA 7283 (P)','Carlos Alvarado 7283','FLEMING','FIJA'],
[-33.428976,-70.557415,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-07 - CA JP (SO)','Carlos Alvarado & Juan Palau?','FLEMING','FIJA'],
[-33.429078,-70.55745,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-08 - CA JP (N)','Carlos Alvarado & Juan Palau?','FLEMING','FIJA'],
[-33.429009,-70.557874,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-09 - CA 7105 (N)','Carlos Alvarado 7105','FLEMING','FIJA'],
[-33.428915,-70.557952,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-10 - CA 7128 (S)','Carlos Alvarado 7128','FLEMING','FIJA'],
[-33.428862,-70.558268,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-11 - CA 7080 (SP)','Carlos Alvarado 7080','FLEMING','FIJA'],
[-33.428932,-70.558437,'RED VECINOS C-14 SUR (Juan Palau / Carlos Alvarado)','RVC14S-JPCA-12 - CA V (NO)','Carlos Alvarado & Vichato','FLEMING','FIJA'],
[-33.430162,-70.55866,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-01 - V 1959','Vichato 1959','FLEMING','FIJA'],
[-33.429687,-70.558583,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-02 - V 1925','Vichato 1925','FLEMING','FIJA'],
[-33.429385,-70.55839,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-03 - V 1890','Vichato 1890','FLEMING','FIJA'],
[-33.42881,-70.558415,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-04-PTZ - V 1867','Vichato 1867','FLEMING','PTZ'],
[-33.428697,-70.558284,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-05 - V 1864','Vichato 1864','FLEMING','FIJA'],
[-33.428963,-70.558757,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-11 - CA 6963','Carlos Alvarado 6963?','FLEMING','FIJA'],
[-33.428869,-70.559119,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-12 - CA 6884','Carlos Alvarado 6883','FLEMING','FIJA'],
[-33.428634,-70.559638,'RED VECINOS C-14 SUR (Vichato)','RVC14S-V-14 - CA 6800','Carlos Alvarado 6800','FLEMING','FIJA'],
[-33.430445,-70.56002,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-01 - HH 1991','HUARA HUARA 1991','FLEMING','FIJA'],
[-33.430346,-70.56,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-02 - HH 1987','HUARA HUARA 1987','FLEMING','FIJA'],
[-33.430154,-70.559962,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-03 - HH 1970','HUARA HUARA? 1970?','FLEMING','FIJA'],
[-33.429972,-70.559926,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-04 - HH 1964','HUARA HUARA? 1964?','FLEMING','FIJA'],
[-33.429433,-70.559823,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-05 - HH 1925','HUARA HUARA? 1925?','FLEMING','FIJA'],
[-33.429256,-70.55979,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-06 - HH 1894','HUARA HUARA? 1894?','FLEMING','FIJA'],
[-33.429136,-70.559771,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-07 - HH 1880','HUARA HUARA? 1880','FLEMING','FIJA'],
[-33.428791,-70.55973,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-08 - HH CA','HUARA HUARA? & Carlos Alvarado','FLEMING','FIJA'],
[-33.428838,-70.560779,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-10 - CA EP','CARLOS ALVARADO & EL PILLAN','FLEMING','FIJA'],
[-33.428801,-70.560223,'RED VECINOS C-14 SUR (Huara-Huara)','RVC14S-HH-11 - CA 6715','CARLOS ALVARADO 6715','FLEMING','FIJA'],
[-33.428719,-70.553506,'ÑANCO CALEU','NCA-08 - C MCV (N)','Caleu & Manuel Claro Vial','FLEMING','FIJA'],
[-33.430638,-70.561315,'CIRCULO EL PILLAN #1','EP-01 - EP FB (N)','EL PILLAN ESQUINA FRANCISCO BILBAO','FLEMING','FIJA'],
[-33.430301,-70.561218,'CIRCULO EL PILLAN #1','EP-02 - EP 1963 (S)','EL PILLAN 1963','FLEMING','FIJA'],
[-33.42994,-70.561132,'CIRCULO EL PILLAN #1','EP-03 - EP 1941 (S)','EL PILLAN 1941','FLEMING','FIJA'],
[-33.429849,-70.561104,'CIRCULO EL PILLAN #1','EP-04 - EP 1941 (N)','EL PILLAN 1941','FLEMING','FIJA'],
[-33.429485,-70.561018,'CIRCULO EL PILLAN #1','EP-05 - EP 1921 (N)','EL PILLAN 1921','FLEMING','FIJA'],
[-33.429392,-70.560996,'CIRCULO EL PILLAN #1','EP-06 - EP 1921 (N)','EL PILLAN 1921','FLEMING','FIJA'],
[-33.429102,-70.560951,'CIRCULO EL PILLAN #1','EP-07 - EP 1881 (N)','EL PILLAN 1881','FLEMING','FIJA'],
[-33.428779,-70.560873,'CIRCULO EL PILLAN #1','EP-08-PTZ - EP CA','EL PILLAN CARLOS ALVARADO','FLEMING','PTZ'],
[-33.428783,-70.57466,'MANUEL BARRIOS PONIENTE','MBP-01-PTZ - MB 4441','MANUEL BARRIOS 4441','EL GOLF','PTZ'],
[-33.428802,-70.573837,'MANUEL BARRIOS PONIENTE','MBP-03 - MB 4513 (P)','MANUEL BARRIOS 4513','EL GOLF','FIJA'],
[-33.428759,-70.573301,'MANUEL BARRIOS PONIENTE','MBP-06 - MB 4607 (N)','MANUEL BARRIOS 4607','EL GOLF','FIJA'],
[-33.428749,-70.572998,'MANUEL BARRIOS PONIENTE','MBP-07 - MB 4674 (N)','MANUEL BARRIOS 4674','EL GOLF','FIJA'],
[-33.428685,-70.572896,'MANUEL BARRIOS PONIENTE','MBP-08 - MB 4678 (P)','MANUEL BARRIOS 4678','EL GOLF','FIJA'],
[-33.428663,-70.571873,'MANUEL BARRIOS PONIENTE','MBP-10 - MB 4841 (P)','MANUEL BARRIOS 4841','EL GOLF','FIJA'],
[-33.42861,-70.571703,'MANUEL BARRIOS PONIENTE','MBP-12 - MB 4855 (O)','MANUEL BARRIOS 4855','EL GOLF','FIJA'],
[-33.428632,-70.571391,'MANUEL BARRIOS PONIENTE','MBP-13 - MB 4916 (P)','MANUEL BARRIOS 4916','EL GOLF','FIJA'],
[-33.429609,-70.574433,'CARLOS ALVARADO PONIENTE','CAP-01-PTZ - CA 4475','Carlos Alvarado 4475','EL GOLF','PTZ'],
[-33.429584,-70.573748,'CARLOS ALVARADO PONIENTE','CAP-02 - CA 4536','Carlos Alvarado 4536','EL GOLF','FIJA'],
[-33.429546,-70.573499,'CARLOS ALVARADO PONIENTE','CAP-04 - CA 4576','Carlos Alvarado 4576','EL GOLF','FIJA'],
[-33.429483,-70.572598,'CARLOS ALVARADO PONIENTE','CAP-05 - CA 4740','Carlos Alvarado 4740','EL GOLF','FIJA'],
[-33.429438,-70.571643,'CARLOS ALVARADO PONIENTE','CAP-07 - CA 4888','Carlos Alvarado 4888','EL GOLF','FIJA'],
[-33.429408,-70.571227,'CARLOS ALVARADO PONIENTE','CAP-09 - CA 4944','Carlos Alvarado 4944','EL GOLF','FIJA'],
[-33.429384,-70.570712,'CARLOS ALVARADO PONIENTE','CAP-11 - CA 5024','Carlos Alvarado 5024','EL GOLF','FIJA'],
[-33.429367,-70.570442,'CARLOS ALVARADO PONIENTE','CAP-13 - CA 5080','Carlos Alvarado 5080','EL GOLF','FIJA'],
[-33.429403,-70.570182,'CARLOS ALVARADO PONIENTE','CAP-14-PTZ - CA SE','Carlos Alvarado esquina Sebastian Elcano','EL GOLF','PTZ'],
[-33.429927,-70.577601,'CIRCULO VECINOS LATADIA','CVL-01 - L 4196','LATADIA 4196','EL GOLF','FIJA'],
[-33.430183,-70.57718,'CIRCULO VECINOS LATADIA','CVL-02 - L 4233','LATADIA 4233','EL GOLF','FIJA'],
[-33.430401,-70.576775,'CIRCULO VECINOS LATADIA','CVL-04 - L 4223','LATADIA INTERIOR 4223','EL GOLF','FIJA'],
[-33.430574,-70.577065,'CIRCULO VECINOS LATADIA','CVL-05 - L 4211','LATADIA INTERIOR 4211','EL GOLF','FIJA'],
[-33.430539,-70.577373,'CIRCULO VECINOS LATADIA','CVL-07 - L 4203','LATADIA INTERIOR 4203','EL GOLF','FIJA'],
[-33.430418,-70.578003,'CIRCULO VECINOS LATADIA','CVL-08 - L 4209','LATADIA INTERIOR','EL GOLF','FIJA'],
[-33.430357,-70.577953,'CIRCULO VECINOS LATADIA','CVL-09 - PIL L','LATADIA 4243','EL GOLF','FIJA'],
[-33.430037,-70.577717,'CIRCULO VECINOS LATADIA','CVL-10-PTZ - L 4251','LATADIA 4251','EL GOLF','PTZ'],
[-33.429102,-70.545193,'LUIS STROZZI','LSI-08 - LS 1989','Luis Strozzi 1989','FLEMING','FIJA'],
[-33.428691,-70.545252,'LUIS STROZZI','LSI-05 - LS 1954','Luis Strozzi 1954','FLEMING','FIJA'],
[-33.429263,-70.545183,'LUIS STROZZI','LSI-09 - LS FB','Luis Strozzi & Av. Francisco Bilbao','FLEMING','FIJA'],
[-33.429413,-70.547439,'DUQUECO','D1-01 - D 1988','DUQUECO 1988','FLEMING','FIJA'],
[-33.429014,-70.547479,'DUQUECO','D1-02 - D 1942','DUQUECO 1942','FLEMING','FIJA'],
[-33.428818,-70.547509,'DUQUECO','D1-03 - D 1918','DUQUECO 1918','FLEMING','FIJA'],
[-33.428605,-70.547557,'DUQUECO','D1-04 - D 1906','DUQUECO 1906','FLEMING','FIJA'],
[-33.429405,-70.54686,'CIRCULO MARCELA PAZ','CMP-01 - MP 1986','Marcela Paz 1986','FLEMING','FIJA'],
[-33.428956,-70.54693,'CIRCULO MARCELA PAZ','CMP-02 - MP 1948','Marcela Paz 1948','FLEMING','FIJA'],
[-33.428668,-70.54698,'CIRCULO MARCELA PAZ','CMP-04 - MP 1918','Marcela Paz 1918','FLEMING','FIJA'],
[-33.428585,-70.546416,'CIRCULO DELIA MATE','CDL-03 - DL 1929 (N)','Delia Matte 1929','FLEMING','FIJA'],
[-33.428958,-70.546347,'CIRCULO DELIA MATE','CDL-05-PTZ - DL 1950','Delia Matte 1950','FLEMING','PTZ'],
[-33.429173,-70.546375,'CIRCULO DELIA MATE','CDL-06 - DL 1975 (S)','Delia Matte 1975','FLEMING','FIJA'],
[-33.429216,-70.546319,'CIRCULO DELIA MATE','CDL-07 - DL 1976 (N)','Delia Matte 1975','FLEMING','FIJA'],
[-33.428689,-70.544775,'CIRCULO DOMINGO SANTA CRUZ','DSC-03 - DSC 1956 (N)','Domingo Santa Cruz 1956','FLEMING','FIJA'],
[-33.429033,-70.544724,'CIRCULO DOMINGO SANTA CRUZ','DSC-05 - DSC 1988 (N)','Domingo Santa Cruz 1988','FLEMING','FIJA'],
[-33.429258,-70.54469,'CIRCULO DOMINGO SANTA CRUZ','DSC-07 - DSC FB (N)','Domingo Santa Cruz & Francisco Bilbao','FLEMING','FIJA'],
[-33.431206,-70.578645,'','067 BILBAO - LATADIA / LPR 1','Bilbao & Latadía','','LPR'],
[-33.431231,-70.574305,'','111 VESPUCIO - BILBAO / FIJA 1','Francisco Bilbao & Américo Vespucio','','FIJA'],
[-33.430863,-70.574788,'','294 VESPUCIO - BILBAO / FIJA 1','Vespucio Poniente & Bilbao','','FIJA'],
[-33.42909,-70.574719,'','RI 59 MANUEL BARRIOS / VESPUCIO / FISHEYE','MANUEL BARRIOS & VESPUCIO','','FISHEYE'],
[-33.431162,-70.578661,'','PI 125 FRANCISCO BILBAO - JUAN DE AUSTRIA / PTZ','Francisco Bilbao & Juan de Austria','','PTZ'],
[-33.430412,-70.574176,'','PI 211 COLEGIO SAN LUIS DE LAS CONDES / PTZ','VICTOR RAE 4420','','PTZ'],
[-33.43098,-70.56509,'','017 MANQUEHUE - BILBAO / PTZ','Manquehue Sur & Francisco Bilbao','','PTZ'],
[-33.43112,-70.57006,'','125 BILBAO - SEBASTIAN ELCANO / FIJA 1','Bilbao & Sebastián Elcano','','FIJA'],
[-33.429068,-70.564614,'','175 MANQUEHUE - CARLOS ALVARADO / PTZ','Manquehue & Carlos Alvarado','','PTZ'],
[-33.430741,-70.570046,'','244 SEBASTIAN ELCANO ORIENTE & BILBAO / FIJA','Sebastián Elcano & Francisco Bilbao','','FIJA'],
[-33.430077,-70.56487,'','245 MANQUEHUE & BILBAO / LPR 1','Manquehue Sur & Francisco Bilbao','','LPR'],
[-33.431031,-70.569571,'','RI 57 BILBAO / SEBASTIAN EL CANO / FISHEYE','BILBAO & SEBASTIAN EL CANO','','FISHEYE'],
[-33.4307,-70.55993,'','124 BILBAO - HUARAHUARA / PTZ','Bilbao & Huarahuara','','PTZ'],
[-33.42869,-70.53913,'','122 PADRE HURTADO - BILBAO / FIJA 1','Padre Hurtado Sur & Bilbao','','FIJA'],
[-33.428915,-70.541721,'','211 FRANCISCO BILBAO - IV CENTENARIO / FIJA 1','FRANCISCO BILBAO & IV CENTENARIO','','FIJA'],
[-33.43077,-70.56367,'','198 FRANCISCO BILBAO - HERNANDO DE MAGALLANES / FIJA 1','FRANCISCO BILBAO & HERNANDO DE MAGALLANES','','FIJA'],
[-33.43058,-70.563589,'','PI 205 COLEGIO KENDAL ENGLISH SCHOOL / PTZ','FRANCISCO BILBAO 6300','','PTZ'],
[-33.43024,-70.55412,'','012 BILBAO - TOMAS MORO / FIJA 1','Francisco Bilbao & Tomás Moro','','FIJA'],
[-33.42999,-70.55171,'','123 BILBAO - FLORENCIO BARRIOS / FIJA 1','Bilbao & Florencio Barrios','','FIJA'],
[-33.429776,-70.547426,'','194 FRANCISCO BILBAO - DUQUECO / FIJA 1','FRANCISCO BILBAO & DUQUECO','','FIJA'],
[-33.429471,-70.551494,'','246 FLORENCIO BARRIOS & BILBAO / LPR 1','Florencio Barrios & Francisco Bilbao','','LPR'],
[-33.429545,-70.548788,'','299 EDIFICIO BILBAO 8080 / PTZ ZOOM','Francisco Bilbao 8080','','PTZ'],
[-33.428861,-70.553722,'','PI 13 M CLARO VIAL - CALEU / SOS','Miguel Claro Vial & Caleu','','VIDEOPORTERO'],
[-33.429861,-70.548472,'','PI 21 BILBAO - DUQUECO / SOS','Plaza Bilbao & Duqueco','','VIDEOPORTERO'],
[-33.42925,-70.542972,'','PI 22 BILBAO - IV CENTENARIO / SOS','Plaza Bilbao & Enrique Bunster','','VIDEOPORTERO'],
[-33.42882,-70.587286,'TARRAGONA','TA-01 - MSF T','MARIANO SANCHEZ FONTECILLA & TARRAGONA?','EL GOLF','FIJA'],
[-33.42877,-70.586988,'TARRAGONA','TA-02 - T 3622','TARRAGONA? 3622?','EL GOLF','FIJA'],
[-33.42869,-70.586633,'TARRAGONA','TA-03 - T 3646','TARRAGONA? 3646?','EL GOLF','FIJA'],
[-33.428637,-70.586409,'TARRAGONA','TA-04 -T 3656','TARRAGONA? 3656','EL GOLF','FIJA'],
[-33.428581,-70.586184,'TARRAGONA','TA-06 - PTZ - T 3682','TARRAGONA? 3682?','EL GOLF','PTZ'],
[-33.429024,-70.581758,'CIRCULO DANIEL DE LA VEGA','DLV-01 - DLV 1754A','Daniel de la Vega 1754 A','EL GOLF','FIJA'],
[-33.428855,-70.581942,'CIRCULO DANIEL DE LA VEGA','DLV-02 - DLV 1754C','Daniel de la Vega 1754 C','EL GOLF','FIJA'],
[-33.428782,-70.582028,'CIRCULO DANIEL DE LA VEGA','DLV-03 - DLV 1726','Daniel de la Vega 1726','EL GOLF','FIJA'],
[-33.429921,-70.583189,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-01 - CD ILC (N)','Canciller Dollfuss & Isabel la Catolica','EL GOLF','FIJA'],
[-33.429701,-70.583348,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-02 - CD 1790 (N)','Canciller Dollfuss 1790','EL GOLF','FIJA'],
[-33.429247,-70.583931,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-03 - CD 1680 (S)','Canciller Dollfuss 1680','EL GOLF','FIJA'],
[-33.42912,-70.58409,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-04 - CD 1650 (S)','Canciller Dollfuss 1650','EL GOLF','FIJA'],
[-33.428933,-70.584328,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-05 - CD 1575 (S)','Canciller Dollfuss 1575','EL GOLF','FIJA'],
[-33.428812,-70.584485,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-06 CD 1530 (S)','Canciller Dollfuss 1530','EL GOLF','FIJA'],
[-33.428696,-70.58464,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-07 - CD A (S)','Canciller Dollfuss & Acapulco','EL GOLF','FIJA'],
[-33.428799,-70.584935,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-11 - A 3772 (P)','Acapulco 3772','EL GOLF','FIJA'],
[-33.428942,-70.585347,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-12 - A 3729 (O)','Acapulco 3729','EL GOLF','FIJA'],
[-33.429,-70.585557,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-13 - A 3711 (P)','Acapulco 3711','EL GOLF','FIJA'],
[-33.429062,-70.585768,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-14 - A 3696 (O)','Acapulco 3696','EL GOLF','FIJA'],
[-33.429156,-70.58613,'CENTRO DE SEGURIDAD CANCILLER DOLLFUSS','CC17-15 - A 3665 (SP)','Acapulco 3665','EL GOLF','FIJA'],
[-33.413823,-70.573806,'ANA MARIA CARRERA','AMC-06 - AMC 5155','ANA MARIA CARRERA 5155','EL GOLF','FIJA'],
[-33.4137,-70.573424,'ANA MARIA CARRERA','AMC-07 - AMC 5226','ANA MARIA CARRERA 5226','EL GOLF','FIJA'],
[-33.413182,-70.587526,'CIRCULO EDIFICIO EL TROVADOR - LA GIOCONDA','CETG-01 – G 4233','LA GIOCONDA 4233','EL GOLF','FIJA'],
[-33.413228,-70.587656,'CIRCULO EDIFICIO EL TROVADOR - LA GIOCONDA','CETG-03-PTZ – GM G','LA GIOCONDA & GOLDA MEIR','EL GOLF','PTZ'],
[-33.413642,-70.587494,'CIRCULO EDIFICIO EL TROVADOR - LA GIOCONDA','CETG-04 – GM 122','GOLDA MEIR 122','EL GOLF','FIJA'],
[-33.413694,-70.58719,'CIRCULO EDIFICIO EL TROVADOR - LA GIOCONDA','CETG-05 – T 4222','EL TROVADOR 4222','EL GOLF','FIJA'],
[-33.413668,-70.58703,'CIRCULO EDIFICIO EL TROVADOR - LA GIOCONDA','CETG-07 – T 4253','EL TROVADOR 4253','EL GOLF','FIJA'],
[-33.399186,-70.573449,'CERRO COLORADO KENNEDY','CCYK1-01-PTZ - PK 5853','PDTE. KENNEDY 5853','EL GOLF','PTZ'],
[-33.398998,-70.573077,'CERRO COLORADO KENNEDY','CCYK1-03 - PK 5933','PDTE. KENNEDY 5933','EL GOLF','FIJA'],
[-33.398904,-70.572826,'CERRO COLORADO KENNEDY','CCYK1-05 - PK 5947','PDTE. KENNEDY 5947','EL GOLF','FIJA'],
[-33.417643,-70.579625,'LA SERENA','LS-01 - LS 511','LA SERENA 511','EL GOLF','FIJA'],
[-33.418432,-70.579079,'LA SERENA','LS-03-PTZ - LS 640','LA SERENA 640','EL GOLF','PTZ'],
[-33.419347,-70.578373,'LA SERENA','LS-04 - LS 841','LA SERENA 841','EL GOLF','FIJA'],
[-33.417041,-70.580692,'FELIX DE AMESTI','FDA-08 - FDA 403','FELIX DE AMESTI 403','EL GOLF','FIJA'],
[-33.417111,-70.580654,'FELIX DE AMESTI','FDA-09 - FDA 432','FELIX DE AMESTI 432','EL GOLF','FIJA'],
[-33.417382,-70.580504,'FELIX DE AMESTI','FDA-10 - FDA 451','FELIX DE AMESTI 451','EL GOLF','FIJA'],
[-33.417615,-70.580364,'FELIX DE AMESTI','FDA-11 - FDA 477','FELIX DE AMESTI 477','EL GOLF','FIJA'],
[-33.417616,-70.580352,'FELIX DE AMESTI','FDA-12 - FDA 462','FELIX DE AMESTI 462','EL GOLF','FIJA'],
[-33.41692,-70.5792,'ALGECIRAS','A-01 - DI 4622','DEL INCA 4622','EL GOLF','FIJA'],
[-33.417254,-70.579042,'ALGECIRAS','A-02 - A 506','ALGECIRAS 506','EL GOLF','FIJA'],
[-33.417743,-70.578725,'ALGECIRAS','A-03 - A 567','ALGECIRAS 567','EL GOLF','FIJA'],
[-33.418109,-70.578462,'ALGECIRAS','A-05-PTZ - A 684','ALGECIRAS 684','EL GOLF','PTZ'],
[-33.41845,-70.578236,'ALGECIRAS','A-06 - A 778','ALGECIRAS 778','EL GOLF','FIJA'],
[-33.4188,-70.577956,'ALGECIRAS','A-08 - A 829','ALGECIRAS 829','EL GOLF','FIJA'],
[-33.416657,-70.57587,'PABLO EL VERONES','PEV-03 - PEV 647','PABLO EL VERONES 647','EL GOLF','FIJA'],
[-33.416937,-70.57567,'PABLO EL VERONES','PEV-04 - PEV 696','PABLO EL VERONES 696','EL GOLF','FIJA'],
[-33.417163,-70.575493,'PABLO EL VERONES','PEV-06-PTZ - PEV 773','PABLO EL VERONES 773','EL GOLF','PTZ'],
[-33.417248,-70.575426,'PABLO EL VERONES','PEV-08 - PEV 782','PABLO EL VERONES 782','EL GOLF','FIJA'],
[-33.417124,-70.575544,'PABLO EL VERONES','PEV-09 - PEV 773','Pablo El Veronés 773','EL GOLF','FIJA'],
[-33.417276,-70.575425,'PABLO EL VERONES','PEV-10 - PEV 782','Pablo El Veronés 782','EL GOLF','FIJA'],
[-33.417716,-70.575033,'PABLO EL VERONES','PEV-11 - PEV MZ','Pablo El Veronés & Martín de Zamora','EL GOLF','FIJA'],
[-33.416712,-70.572796,'SEBASTIAN ELCANO','SE-01 - SE 849 (N)','849 Sebastián Elcano','EL GOLF','FIJA'],
[-33.418901,-70.592052,'HENDAYA','H-01 - RS 3570','Renato Sanchez 3570','EL GOLF','FIJA'],
[-33.419417,-70.591886,'HENDAYA','H-02 - H 367','Hendaya 367','EL GOLF','FIJA'],
[-33.419414,-70.591885,'HENDAYA','H-03 - H 380','Hendaya 380','EL GOLF','FIJA'],
[-33.419609,-70.591818,'HENDAYA','H-04 - H 392','Hendaya 392','EL GOLF','FIJA'],
[-33.419686,-70.591801,'HENDAYA','H-05-PTZ - 395','Hendaya 395','EL GOLF','PTZ'],
[-33.419766,-70.591777,'HENDAYA','H-06 - H 402','Hendaya 402','EL GOLF','FIJA'],
[-33.419017,-70.581153,'ALBACETE Y CRUZ DEL SUR','AYCDS-01 - S 626','Soria 626','EL GOLF','FIJA'],
[-33.418601,-70.580616,'ALBACETE Y CRUZ DEL SUR','AYCDS-03 - A CDS','Albacete Esquina Cruz del Sur','EL GOLF','FIJA'],
[-33.419007,-70.580339,'ALBACETE Y CRUZ DEL SUR','AYCDS-04 - CDS 706','Cruz del Sur 706','EL GOLF','FIJA'],
[-33.419269,-70.580133,'ALBACETE Y CRUZ DEL SUR','AYCDS-06-PTZ - CDS 740','Cruz del Sur 740','EL GOLF','PTZ'],
[-33.419498,-70.579961,'ALBACETE Y CRUZ DEL SUR','AYCDS-07 - CDS 788','Cruz del Sur 788','EL GOLF','FIJA'],
[-33.419682,-70.579837,'ALBACETE Y CRUZ DEL SUR','AYCDS-08 - C 4515','Cuenca 4515','EL GOLF','FIJA'],
[-33.416755,-70.578772,'SAN PASCUAL','SP-01 - SP DI','San Pascual & Del Inca','EL GOLF','FIJA'],
[-33.417106,-70.578451,'SAN PASCUAL','SP-02 - SP 540','San Pascual 540','EL GOLF','FIJA'],
[-33.41741,-70.578241,'SAN PASCUAL','SP-03 - SP 601','San Pascual 601','EL GOLF','FIJA'],
[-33.417672,-70.578058,'SAN PASCUAL','SP-04 - SP 648','San Pascual 660','EL GOLF','FIJA'],
[-33.417757,-70.577997,'SAN PASCUAL','SP-05 - SP 687','San Pascual 687','EL GOLF','FIJA'],
[-33.417928,-70.577875,'SAN PASCUAL','SP-06 - SP 736','San Pascual 725','EL GOLF','FIJA'],
[-33.418017,-70.577812,'SAN PASCUAL','SP-07 - SP 750','San Pascual 750','EL GOLF','FIJA'],
[-33.41821,-70.577674,'SAN PASCUAL','SP-08 - SP 796','San Pascual 796','EL GOLF','FIJA'],
[-33.418309,-70.577602,'SAN PASCUAL','SP-09 - SP 851','San Pascual 851','EL GOLF','FIJA'],
[-33.418581,-70.577376,'SAN PASCUAL','SP-10 - SP 860','San Pascual 877','EL GOLF','FIJA'],
[-33.418672,-70.577197,'SAN PASCUAL','SP-11-PTZ - SP MDZ','San Pascual & Martín de Zamora','EL GOLF','PTZ'],
[-33.418035,-70.580161,'FELIX DE AMESTI 2','FDA2-01 - FDA 539','FELIX DE AMESTI 539','EL GOLF','FIJA'],
[-33.418387,-70.579943,'FELIX DE AMESTI 2','FDA2-02 - FDA 594','FELIX DE AMESTI 594','EL GOLF','FIJA'],
[-33.418734,-70.579718,'FELIX DE AMESTI 2','FDA2-04 - FDA 700','FELIX DE AMESTI 700','EL GOLF','FIJA'],
[-33.419204,-70.579385,'FELIX DE AMESTI 2','FDA2-05 - FDA 722','FELIX DE AMESTI 722','EL GOLF','FIJA'],
[-33.419328,-70.579458,'FELIX DE AMESTI 2','FDA2-07 - C 4542','CUENCA 4542','EL GOLF','FIJA'],
[-33.419299,-70.579312,'FELIX DE AMESTI 2','FDA2-08-PTZ - FDA C','FELIX DE AMESTI & CUENCA','EL GOLF','PTZ'],
[-33.419567,-70.579096,'FELIX DE AMESTI 2','FDA2-09 - FDA 776','FELIX DE AMESTI 776','EL GOLF','FIJA'],
[-33.418302,-70.576704,'NIBALDO CORREA','NC-01 - MDZ & NC','MARTIN DE ZAMORA & NIBALDO CORREA','EL GOLF','FIJA'],
[-33.417868,-70.577002,'NIBALDO CORREA','NC-02 - NC 808','NIBALDO CORREA 808','EL GOLF','FIJA'],
[-33.417786,-70.577082,'NIBALDO CORREA','NC-04 - NC 763','NIBALDO CORREA 763','EL GOLF','FIJA'],
[-33.417466,-70.577282,'NIBALDO CORREA','NC-05 - NC 710','NIBALDO CORREA 710','EL GOLF','FIJA'],
[-33.417213,-70.577454,'NIBALDO CORREA','NC-07-PTZ - NC 640','NIBALDO CORREA 640','EL GOLF','PTZ'],
[-33.416894,-70.577699,'NIBALDO CORREA','NC-09 - NC 547','NIBALDO CORREA 547','EL GOLF','FIJA'],
[-33.419544,-70.589646,'CIRCULO POLONIA','PA-02 – P 433','POLONIA 433','EL GOLF','FIJA'],
[-33.419208,-70.589738,'CIRCULO POLONIA','PA-04 – P 395','POLONIA 395','EL GOLF','FIJA'],
[-33.418849,-70.58985,'CIRCULO POLONIA','PA-07 – P 357','POLONIA 357','EL GOLF','FIJA'],
[-33.418833,-70.589806,'CIRCULO POLONIA','PA-08 – P 326','POLONIA 326','EL GOLF','FIJA'],
[-33.418096,-70.598649,'CIRCULO VECINAL 90','CV90-01 - V 90','VECINAL 90','EL GOLF','FIJA'],
[-33.418389,-70.598537,'CIRCULO VECINAL 90','CV90-03 - V 90','VECINAL 90','EL GOLF','FIJA'],
[-33.418324,-70.598252,'CIRCULO VECINAL 90','CV90-04 - N 2985','NAPOLEON 2985','EL GOLF','FIJA'],
[-33.418517,-70.598613,'CIRCULO VECINAL 90','CV90-05-PTZ - V N','NAPOLEON & VECINAL','EL GOLF','PTZ'],
[-33.421941,-70.594563,'MARNE Y UNAMUNO','MU-03 - U 560','Unamuno 560','EL GOLF','FIJA'],
[-33.421729,-70.594829,'MARNE Y UNAMUNO','MU-01 - U 547','Unamuno 547','EL GOLF','FIJA'],
[-33.421815,-70.594728,'MARNE Y UNAMUNO','MU-02 - U 550','Unamuno 550','EL GOLF','FIJA'],
[-33.422211,-70.594213,'MARNE Y UNAMUNO','MU-04 - U 607','Unamuno 607','EL GOLF','FIJA'],
[-33.422645,-70.593642,'MARNE Y UNAMUNO','MU-06 - U 691','Unamuno 691','EL GOLF','FIJA'],
[-33.42299,-70.593162,'MARNE Y UNAMUNO','MU-07 - U 779','Unamuno 779','EL GOLF','FIJA'],
[-33.42275,-70.594144,'MARNE Y UNAMUNO','MU-09 - M 2956','Marne 2956','EL GOLF','FIJA'],
[-33.422388,-70.593732,'MARNE Y UNAMUNO','MU-11 - M 3031','Marne 3031','EL GOLF','FIJA'],
[-33.422138,-70.593463,'MARNE Y UNAMUNO','MU-12 - M 3172','Marne 3172','EL GOLF','FIJA'],
[-33.421836,-70.593169,'MARNE Y UNAMUNO','MU-14 - SC 585','San Crescente 585','EL GOLF','FIJA'],
[-33.422479,-70.584054,'MALAGA','M-01 - M 897','MALAGA 897','EL GOLF','FIJA'],
[-33.42226,-70.584059,'MALAGA','M-02 - M 888','MALAGA 888','EL GOLF','FIJA'],
[-33.422181,-70.584148,'MALAGA','M-03 - M 859','MALAGA 859','EL GOLF','FIJA'],
[-33.421382,-70.584424,'MALAGA','M-05 - M 808','MALAGA 808','EL GOLF','FIJA'],
[-33.421362,-70.58452,'MALAGA','M-06 - M 782','MALAGA 749','EL GOLF','FIJA'],
[-33.421098,-70.5846,'MALAGA','M-07 - M 701','MALAGA 701','EL GOLF','FIJA'],
[-33.420873,-70.5846,'MALAGA','M-10 - M 782','MALAGA 720','EL GOLF','FIJA'],
[-33.420631,-70.584838,'MALAGA','M-11-PTZ - M 670','MALAGA 670','EL GOLF','PTZ'],
[-33.420553,-70.584856,'MALAGA','M-12 - M 661','MALAGA 661','EL GOLF','FIJA'],
[-33.420525,-70.584747,'MALAGA','M-13 - M R','MALAGA & RAPALLO','EL GOLF','FIJA'],
[-33.420119,-70.585006,'MALAGA','M-14 - M 557','MALAGA 557','EL GOLF','FIJA'],
[-33.420068,-70.585046,'MALAGA','M-16 - M 529','MALAGA 529','EL GOLF','FIJA'],
[-33.421468,-70.592275,'GALICIA','G-01 - G 547','GALICIA 547','EL GOLF','FIJA'],
[-33.42194,-70.59171,'GALICIA','G-03 - G 628','GALICIA 628','EL GOLF','FIJA'],
[-33.42202,-70.591599,'GALICIA','G-04 - G 662','GALICIA 662','EL GOLF','FIJA'],
[-33.422338,-70.591205,'GALICIA','G-05 - G 727','GALICIA 727','EL GOLF','FIJA'],
[-33.422564,-70.590919,'GALICIA','G-07 - G 788','GALICIA 788','EL GOLF','FIJA'],
[-33.422441,-70.592213,'GALICIA','G-08 - B 3326','BAZTAN 3326','EL GOLF','FIJA'],
[-33.422463,-70.59231,'GALICIA','G-09 - SC 644','SAN CRESCENTE 644','EL GOLF','FIJA'],
[-33.419842,-70.591753,'HENDAYA','H-07 - H 413','Hendaya 413','EL GOLF','FIJA'],
[-33.420143,-70.591661,'HENDAYA','H-08 - H 438','Hendaya 438','EL GOLF','FIJA'],
[-33.420468,-70.591549,'HENDAYA','H-09 - H 488','Hendaya 488','EL GOLF','FIJA'],
[-33.419903,-70.578822,'FELIX DE AMESTI 2','FDA2-11 - FDA 828','FELIX DE AMESTI 828','EL GOLF','FIJA'],
[-33.420249,-70.57851,'FELIX DE AMESTI 2','FDA2-13 - FDA MDZ','FELIX DE AMESTI & MARTIN DE ZAMORA','EL GOLF','FIJA'],
[-33.420159,-70.589434,'CIRCULO POLONIA','PA-01 – P PE','POLONIA & PRESIDENTE ERRAZURIZ','EL GOLF','FIJA'],
[-33.422252,-70.572913,'CIRCULO MARIA OLIVARES','CMO-01 - MO 1267','MARIA OLIVARES 1267','EL GOLF','FIJA'],
[-33.422341,-70.573084,'CIRCULO MARIA OLIVARES','CMO-03 - MO 1256','MARIA OLIVARES 1256','EL GOLF','FIJA'],
[-33.420719,-70.590267,'CIRCULO SAN GABRIEL','CSG-01 - PE GE','Presidente Errázuriz & Gertrudis Echenique','EL GOLF','FIJA'],
[-33.421241,-70.590261,'CIRCULO SAN GABRIEL','CSG-02 - GE 685','GERTRUDIZ ECHEÑIQUE 685','EL GOLF','FIJA'],
[-33.421155,-70.590229,'CIRCULO SAN GABRIEL','CSG-03 - GE 564','GERTRUDIZ ECHEÑIQUE 564','EL GOLF','FIJA'],
[-33.42151,-70.590185,'CIRCULO SAN GABRIEL','CSG-04 - GE 609','GERTRUDIZ ECHEÑIQUE 609','EL GOLF','FIJA'],
[-33.421518,-70.590107,'CIRCULO SAN GABRIEL','CSG-05 - GE 598','GERTRUDIZ ECHEÑIQUE 598','EL GOLF','FIJA'],
[-33.421715,-70.590079,'CIRCULO SAN GABRIEL','CSG-06-PTZ - GE 640','GERTRUDIZ ECHEÑIQUE 640','EL GOLF','PTZ'],
[-33.421807,-70.590159,'CIRCULO SAN GABRIEL','CSG-07 - GE N','GERTRUDIZ ECHEÑIQUE & NAVARRA','EL GOLF','FIJA'],
[-33.421925,-70.590198,'CIRCULO SAN GABRIEL','CSG-08 - SG 3693','SAN GABRIEL 3693','EL GOLF','FIJA'],
[-33.42211,-70.590339,'CIRCULO SAN GABRIEL','CSG-09 - SG H','SAN GABRIEL & HENDAYA','EL GOLF','FIJA'],
[-33.422205,-70.590432,'CIRCULO SAN GABRIEL','CSG-10 - SG 3534','SAN GABRIEL 3534','EL GOLF','FIJA'],
[-33.422054,-70.590426,'CIRCULO SAN GABRIEL','CSG-12 - H 663','HENDAYA 663','EL GOLF','FIJA'],
[-33.421967,-70.590538,'CIRCULO SAN GABRIEL','CSG-13 - H 672','HENDAYA 672','EL GOLF','FIJA'],
[-33.421595,-70.590929,'CIRCULO SAN GABRIEL','CSG-14 - H 624','HENDAYA 624','EL GOLF','FIJA'],
[-33.420912,-70.591328,'CIRCULO SAN GABRIEL','CSG-16 - PE 3575','PADRE ERRAZURIZ & HENDAYA','EL GOLF','FIJA'],
[-33.420713,-70.582578,'ALICANTE','AE-01 - P A','PORTOFINO & ALICANTE','EL GOLF','FIJA'],
[-33.421239,-70.582289,'ALICANTE','AE-02 - A 836','ALICANTE 836','EL GOLF','FIJA'],
[-33.421364,-70.582341,'ALICANTE','AE-03 - A 839','ALICANTE 839','EL GOLF','FIJA'],
[-33.421534,-70.582265,'ALICANTE','AE-04 - A 861','ALICANTE 861','EL GOLF','FIJA'],
[-33.421572,-70.582161,'ALICANTE','AE-05 - A 858','ALICANTE 858','EL GOLF','FIJA'],
[-33.421841,-70.582052,'ALICANTE','AE-06 - A 894','ALICANTE 894','EL GOLF','FIJA'],
[-33.422067,-70.582049,'ALICANTE','AE-07-PTZ - A 894','ALICANTE 894','EL GOLF','PTZ'],
[-33.42272,-70.591023,'CIRCULO SAN GABRIEL PONIENTE','CSGP-15 - SG 3427','SAN GABRIEL 3427','EL GOLF','FIJA'],
[-33.422715,-70.590898,'CIRCULO SAN GABRIEL PONIENTE','CSGP-16 - SG 3364','SAN GABRIEL 3364','EL GOLF','FIJA'],
[-33.410742,-70.5987,'CERRO SAN LUIS','CSL-01 - LP 2991','LAS PENAS 2991','EL GOLF','FIJA'],
[-33.411047,-70.597371,'CERRO SAN LUIS','CSL-02 - LP 3114','LAS PENAS 3114 C','EL GOLF','FIJA'],
[-33.415484,-70.581533,'FELIX DE AMESTI','FDA-01 - FDA 218','FELIX DE AMESTI 218','EL GOLF','FIJA'],
[-33.415833,-70.581349,'FELIX DE AMESTI','FDA-03 - FDA 255','FELIX DE AMESTI 255','EL GOLF','FIJA'],
[-33.416395,-70.581042,'FELIX DE AMESTI','FDA-05-PTZ - FDA 327','FELIZ DE AMESTI 327','EL GOLF','PTZ'],
[-33.415878,-70.57635,'PABLO EL VERONES','PEV-01 - D1 4852','DEL INCA 4852','EL GOLF','FIJA'],
[-33.416293,-70.576115,'PABLO EL VERONES','PEV-02 - PEV 555','PABLO EL VERONES 555','EL GOLF','FIJA'],
[-33.416291,-70.572964,'SEBASTIAN ELCANO','SE-02 - SE 756 (N)','756 Sebastián Elcano','EL GOLF','FIJA'],
[-33.415799,-70.57316,'SEBASTIAN ELCANO','SE-04 - SE 628 (O)','628 Sebastián Elcano','EL GOLF','FIJA'],
[-33.415712,-70.573201,'SEBASTIAN ELCANO','SE-05 - SE 609 (S)','609 Sebastián Elcano','EL GOLF','FIJA'],
[-33.415509,-70.573276,'SEBASTIAN ELCANO','SE-06 - SE 538 (P)','538 Sebastián Elcano','EL GOLF','FIJA'],
[-33.415332,-70.573349,'SEBASTIAN ELCANO','SE-07 - SE 487 (S)','487 Sebastián Elcano','EL GOLF','FIJA'],
[-33.415146,-70.573425,'SEBASTIAN ELCANO','SE-09 - SE 482 (O)','482 Sebastián Elcano','EL GOLF','FIJA'],
[-33.414106,-70.574713,'ANA MARIA CARRERA','AMC-01 - AMC ROH','ANA MARIA CARRERA & ROSA OHIGGINS','EL GOLF','FIJA'],
[-33.413964,-70.574253,'ANA MARIA CARRERA','AMC-02 - AMC 5090','ANA MARIA CARRERA 5090','EL GOLF','FIJA'],
[-33.413896,-70.574033,'ANA MARIA CARRERA','AMC-03 - AMC 5140','ANA MARIA CARRERA 5140','EL GOLF','FIJA'],
[-33.41642,-70.578002,'NIBALDO CORREA','NC-11 - NC & DI','DEL INCA & NIBALDO CORREA','EL GOLF','FIJA'],
[-33.415313,-70.602256,'CIRCULO EBRO','CEBRO-01 - E 2799','EBRO 2799','EL GOLF','FIJA'],
[-33.413908,-70.589927,'CIRCULO PARQUE LOS ANGELES','CPLA-01 - A 99','ALSACIA 99','EL GOLF','FIJA'],
[-33.414361,-70.590112,'CIRCULO PARQUE LOS ANGELES','CPLA-02 - A 100','ALSACIA 100','EL GOLF','FIJA'],
[-33.414476,-70.590097,'CIRCULO PARQUE LOS ANGELES','CPLA-03 - A 57','ALSACIA 57','EL GOLF','FIJA'],
[-33.414684,-70.590221,'CIRCULO PARQUE LOS ANGELES','CPLA-04 - A B','ALSACIA & BERNARDITA','EL GOLF','FIJA'],
[-33.414426,-70.590924,'CIRCULO PARQUE LOS ANGELES','CPLA-05 - NSDLA B','NUESTRA SRA DE LOS ANGELES & BERNARDITA','EL GOLF','FIJA'],
[-33.41395,-70.59076,'CIRCULO PARQUE LOS ANGELES','CPLA-07 - NSDLA 133','NUSTRA SRA DE LOS ANGELES 133','EL GOLF','FIJA'],
[-33.41471,-70.580529,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-01 - N 4631','NEVERIA 4631','EL GOLF','FIJA'],
[-33.414528,-70.580169,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-02-PTZ - SP N','SAN PASCUAL & NEVERIA','EL GOLF','PTZ'],
[-33.414836,-70.580048,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-04 - SN 215','San Pascual 215','EL GOLF','FIJA'],
[-33.414911,-70.58,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-05 - SN 228','San Pascual 228','EL GOLF','FIJA'],
[-33.414987,-70.579949,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-06 - SN 248','San Pascual 248','EL GOLF','FIJA'],
[-33.415217,-70.579789,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-07 - SN 275','San Pascual 275','EL GOLF','FIJA'],
[-33.415571,-70.579536,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-08 - SN 330','San Pascual 330','EL GOLF','FIJA'],
[-33.416346,-70.578998,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-09 - SN 410','San Pascual 410','EL GOLF','FIJA'],
[-33.415082,-70.57917,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-10 - EB 4693','Enrique Barrenechea 4693','EL GOLF','FIJA'],
[-33.416033,-70.579205,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-12- SB 375 (O)','SAN PASCUAL 375','EL GOLF','FIJA'],
[-33.416062,-70.579145,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-13 - PTZ - SP 397','SAN PASCUAL 397','EL GOLF','FIJA'],
[-33.415746,-70.578679,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-14 - T 4686 (SO)','TURENA 4686','EL GOLF','FIJA'],
[-33.415812,-70.578618,'CIRCULO SPYEB (SAN PASCUAL 209)','SPYEB-15 - T 4693 (NO)','TURENA 4693','EL GOLF','FIJA'],
[-33.414755,-70.572804,'CIRCULO JORGE VI 3C','JVI-14 - JVI DI','Del Inca & Jorge VI','EL GOLF','FIJA'],
[-33.411445,-70.596287,'CERRO SAN LUIS','CSL-04 - LP 3297','LAS PEÑAS 3297','EL GOLF','FIJA'],
[-33.41144,-70.598399,'CERRO SAN LUIS','CSL-06 - CDA 3051','CRISTAL DE ABELLI 3051','EL GOLF','FIJA'],
[-33.411216,-70.599177,'EL QUISCO','EQ1-01 - CDA 2998','CRISTAL DE ABELI 2998','EL GOLF','FIJA'],
[-33.411239,-70.599437,'EL QUISCO','EQ1-02 - CDA 2988','CRISTAL DE ABELI 2988','EL GOLF','FIJA'],
[-33.411587,-70.599303,'EL QUISCO','EQ1-03 - EQ 3001','EL QUISCO 3001','EL GOLF','FIJA'],
[-33.41193,-70.598733,'EL QUISCO','EQ1-05 - EQ 3046','EL QUISCO 3046','EL GOLF','FIJA'],
[-33.412039,-70.598549,'EL QUISCO','EQ1-06 - EQ 3052','EL QUISCO 3052','EL GOLF','FIJA'],
[-33.412154,-70.597813,'EL QUISCO','EQ1-08 - EQ 3140','EL QUISCO 3140','EL GOLF','FIJA'],
[-33.412177,-70.597619,'EL QUISCO','EQ1-09 - EQ 3140','EL QUISCO 3140','EL GOLF','FIJA'],
[-33.411559,-70.595758,'EL QUISCO','EQ2-01 - EQ 3311','EL QUISCO 3311','EL GOLF','FIJA'],
[-33.411751,-70.595214,'EL QUISCO','EQ2-02 - EQ 3397','EL QUISCO 3397','EL GOLF','FIJA'],
[-33.412009,-70.594902,'EL QUISCO','EQ2-03 - EQ 3438','EL QUISCO 3438','EL GOLF','FIJA'],
[-33.412067,-70.595588,'EL QUISCO','EQ2-04 - EQ 3408','EL QUISCO 3408','EL GOLF','FIJA'],
[-33.412051,-70.59619,'EL QUISCO','EQ2-06 - EQ 3298','EL QUISCO 3298','EL GOLF','FIJA'],
[-33.412139,-70.596997,'EL QUISCO','EQ2-07 - EQ 3180','EL QUISCO 3180','EL GOLF','FIJA'],
[-33.423508,-70.573045,'JOSE DE MORALEDA','JDM-01 - JDM 4894','José de Moraleda 4894','EL GOLF','FIJA'],
[-33.426207,-70.574524,'COOPERATIVA ROSSI','CR-01 - IC 4580','Isabel la Catolica 4580','EL GOLF','FIJA'],
[-33.425953,-70.574951,'COOPERATIVA ROSSI','CR-02 - IC JM','Isabel la Catolica & Jose de Moraleda','EL GOLF','FIJA'],
[-33.426,-70.575384,'COOPERATIVA ROSSI','CR-03 - IC 4472','Isabel la Catolica 4472','EL GOLF','FIJA'],
[-33.425887,-70.576081,'COOPERATIVA ROSSI','CR-04 - IC 4460','Isabel la Catolica 4460','EL GOLF','FIJA'],
[-33.426582,-70.575899,'COOPERATIVA ROSSI','CR-06 - AVS 1520','Americo Vespucio Sur 1520','EL GOLF','FIJA'],
[-33.426825,-70.575668,'COOPERATIVA ROSSI','CR-07 - AVS 1622','Americo Vespucio Sur 1622','EL GOLF','FIJA'],
[-33.427255,-70.574944,'COOPERATIVA ROSSI','CR-08 - JEM 4456','Juan Esteban Montero 4456','EL GOLF','FIJA'],
[-33.427212,-70.574348,'COOPERATIVA ROSSI','CR-09 - JEM 4560','Juan Esteban Montero 4560','EL GOLF','FIJA'],
[-33.424032,-70.575568,'FITZ ROY','FR1-01-PTZ - FR 1206','Fitz Roy 1206','EL GOLF','PTZ'],
[-33.42429,-70.575133,'FITZ ROY','FR1-03 - FR 1231','Fitz Roy 1231','EL GOLF','FIJA'],
[-33.424347,-70.575038,'FITZ ROY','FR1-04 - FR 1240','Fitz Roy 1240','EL GOLF','FIJA'],
[-33.424464,-70.574843,'FITZ ROY','FR1-05 - FR 1259','Fitz Roy 1259','EL GOLF','FIJA'],
[-33.424527,-70.574733,'FITZ ROY','FR1-07 - FR 1266','Fitz Roy 1266','EL GOLF','FIJA'],
[-33.424653,-70.574514,'FITZ ROY','FR1-08 - FR 1272','Fitz Roy 1272','EL GOLF','FIJA'],
[-33.42472,-70.574396,'FITZ ROY','FR1-10 - FR 1280','Fitz Roy 1280','EL GOLF','FIJA'],
[-33.424685,-70.573937,'FITZ ROY','FR1-11 - JDM 4751','Jose de Moraleda 4751','EL GOLF','FIJA'],
[-33.425107,-70.574248,'FITZ ROY','FR1-12 - JDM 4725','Jose de Moraleda 4725','EL GOLF','FIJA'],
[-33.424935,-70.574106,'FITZ ROY','FR1-14 - FR JDM','Fitz Roy & Jose de Moraleda','EL GOLF','FIJA'],
[-33.425052,-70.573848,'FITZ ROY','FR1-15 - FR 1413','Fitz Roy 1413','EL GOLF','FIJA'],
[-33.424154,-70.575362,'FITZ ROY','FR2-01 - FR 1216','FITZ ROY 1216','EL GOLF','FIJA'],
[-33.425283,-70.573449,'FITZ ROY','FR2-03 - FR 1424','Fitz Roy 1424','EL GOLF','FIJA'],
[-33.425453,-70.57316,'FITZ ROY','FR2-04 - FR 1432','Fitz Roy 1432','EL GOLF','FIJA'],
[-33.425155,-70.575139,'FITZ ROY','FR2-05 - FR 1436','Fitz Roy 1436','EL GOLF','FIJA'],
[-33.425566,-70.572969,'FITZ ROY','FR2-09 - FR 1455','Fitz Roy 1445','EL GOLF','FIJA'],
[-33.423479,-70.592556,'MARNE Y UNAMUNO','MU-15 - U 853','Unamuno 853','EL GOLF','FIJA'],
[-33.428493,-70.585837,'TARRAGONA','TA-07 - T 3703','TARRAGONA? 3703?','EL GOLF','FIJA'],
[-33.428368,-70.585471,'TARRAGONA','TA-09 - T 3741','TARRAGONA? 3741','EL GOLF','FIJA'],
[-33.42814,-70.585228,'TARRAGONA','TA-10 - T CD','TARRAGONA &? CANCILLER DOLLFUSS?','EL GOLF','FIJA'],
[-33.427899,-70.584901,'TARRAGONA','TA-11 - T A','TARRAGONA & ALCANTARA?','EL GOLF','FIJA'],
[-33.427942,-70.585477,'TARRAGONA','TA-13 - CD 1351','CANCILLER DOLLFUSS? 1351','EL GOLF','FIJA'],
[-33.427886,-70.585389,'TARRAGONA','TA-14 - T 3850','TARRAGONA 3850','EL GOLF','FIJA'],
[-33.428214,-70.585287,'TARRAGONA','TA-15 - CD 1445 (S)','CANCILLER DOLLFUSS 1445','EL GOLF','FIJA'],
[-33.42848,-70.584976,'TARRAGONA','TA-16 - CD 1457 (S)','CANCILLER DOLLFUSS 1457','EL GOLF','FIJA'],
[-33.423585,-70.588355,'CIRCULO MARTIN DE ZAMORA','CMZ-01 - MZ 3768','MARTIN DE ZAMORA 3768','EL GOLF','FIJA'],
[-33.423625,-70.588572,'CIRCULO MARTIN DE ZAMORA','CMZ-03-PTZ - MZ 3752','MARTIN DE ZAMORA 3752','EL GOLF','PTZ'],
[-33.424421,-70.592845,'CIRCULO SAN GABRIEL PONIENTE','CSGP-01 - MSF SG','MARIANO SANCHEZ FONTECILLA & SAN GABRIEL','EL GOLF','FIJA'],
[-33.424177,-70.592524,'CIRCULO SAN GABRIEL PONIENTE','CSGP-02 - SG 2922','SAN GABRIEL 2922','EL GOLF','FIJA'],
[-33.423852,-70.592299,'CIRCULO SAN GABRIEL PONIENTE','CSGP-03 - SG 3011','SAN GABRIEL 3011','EL GOLF','FIJA'],
[-33.423865,-70.592187,'CIRCULO SAN GABRIEL PONIENTE','CSGP-04 - SG 3087','SAN GABRIEL 3087','EL GOLF','FIJA'],
[-33.423764,-70.592074,'CIRCULO SAN GABRIEL PONIENTE','CSGP-05 - SG 3011','SAN GABRIEL 3011','EL GOLF','FIJA'],
[-33.423703,-70.592148,'CIRCULO SAN GABRIEL PONIENTE','CSGP-06 - U SG','UNAMUNO & SAN GABRIEL','EL GOLF','FIJA'],
[-33.423589,-70.591996,'CIRCULO SAN GABRIEL PONIENTE','CSGP-07 - SG 3135','SAN GABRIEL 3135','EL GOLF','FIJA'],
[-33.423576,-70.591861,'CIRCULO SAN GABRIEL PONIENTE','CSGP-08 - SG 3177','SAN GABRIEL 3177','EL GOLF','FIJA'],
[-33.423498,-70.591909,'CIRCULO SAN GABRIEL PONIENTE','CSGP-09-PTZ - SG 3094','SAN GABRIEL 3094','EL GOLF','PTZ'],
[-33.423244,-70.591596,'CIRCULO SAN GABRIEL PONIENTE','CSGP-10 - SG 3225','SAN GABRIEL 3225','EL GOLF','FIJA'],
[-33.423186,-70.591426,'CIRCULO SAN GABRIEL PONIENTE','CSGP-11 - SG L','SAN GABRIEL & LEON','EL GOLF','FIJA'],
[-33.423094,-70.591463,'CIRCULO SAN GABRIEL PONIENTE','CSGP-13 - SC 800','SAN CRESCENTE 800','EL GOLF','FIJA'],
[-33.428481,-70.582388,'CIRCULO DANIEL DE LA VEGA','DLV-04 - DLV 1698','Daniel de la Vega 1698','EL GOLF','FIJA'],
[-33.428542,-70.582566,'CIRCULO DANIEL DE LA VEGA','DLV-05 - DLV MRC','Mariscal Ramon Castilla & Daniel de la Vega','EL GOLF','FIJA'],
[-33.428288,-70.5826,'CIRCULO DANIEL DE LA VEGA','DLV-07 - DLV 1688','Daniel de la Vega 1688','EL GOLF','FIJA'],
[-33.426731,-70.580667,'CIRCULO FERNANDO DE ARAGON','FDAN-01 - FDA F (P)','Fernando De Aragon & Flandes','EL GOLF','FIJA'],
[-33.427006,-70.581281,'CIRCULO FERNANDO DE ARAGON','FDAN-02 - FDA 4190 (O)','Fernando De Aragon 4190','EL GOLF','FIJA'],
[-33.427046,-70.581384,'CIRCULO FERNANDO DE ARAGON','FDAN-03 - FDA 4181 (O)','Fernando De Aragon 4181','EL GOLF','FIJA'],
[-33.427074,-70.581606,'CIRCULO FERNANDO DE ARAGON','FDAN-04 - FDA 4171 (P)','Fernando De Aragon 4171','EL GOLF','FIJA'],
[-33.427055,-70.581706,'CIRCULO FERNANDO DE ARAGON','FDAN-05 - FDA 4172 (O)','Fernando De Aragon 4172','EL GOLF','FIJA'],
[-33.427124,-70.582025,'CIRCULO FERNANDO DE ARAGON','FDAN-06 - FDA 4163 (P)','Fernando De Aragon 4163','EL GOLF','FIJA'],
[-33.427255,-70.58242,'CIRCULO FERNANDO DE ARAGON','FDAN-09-PTZ - FDA 4148','Fernando De Aragon 4148','EL GOLF','PTZ'],
[-33.427395,-70.582475,'CIRCULO FERNANDO DE ARAGON','FDAN-10 - JDA 1449 (O)','Juan De Austria 1449','EL GOLF','FIJA'],
[-33.427409,-70.582413,'CIRCULO FERNANDO DE ARAGON','FDAN-11 - FDA 4155 (N)','Fernando De Aragon 4155','EL GOLF','FIJA'],
[-33.427912,-70.581933,'CIRCULO FERNANDO DE ARAGON','FDAN-14 - JDA 1539 (N)','Juan De Austria 1539','EL GOLF','FIJA'],
[-33.4315,-70.58093,'','126 BILBAO - ALCANTARA / FIJA 1','Bilbao & Alcantara','','FIJA'],
[-33.431403,-70.580734,'','RI 58 BILBAO / ALCANTARA / FISHEYE','BILBAO & ALCANTARA','','FISHEYE'],
[-33.429551,-70.583641,'','PI 210 COLEGIO SAN JUAN DE LAS CONDES / PTZ','CANCILLER DOLLFUSS 1801','','PTZ'],
[-33.430451,-70.585123,'','097 ISABEL LA CATOLICA - SANCHEZ FONTECILLA / LPR 1','Sánchez Fontecilla & Isabel La Católica','','LPR'],
[-33.431723,-70.584086,'','115 SANCHEZ FONTECILLA - BILBAO / FIJA 1','Mariano Sánchez Fontecilla & Francisco Bilbao','','FIJA'],
[-33.429265,-70.586696,'','PI 198 COLEGIO COYANCURA / PTZ','MARIANO SANCHEZ FONTECILLA 1552','','PTZ'],
[-33.41755,-70.59989,'','045 APOQUINDO EL BOSQUE / FIJA 1','Apoquindo & El Bosque Norte','','FIJA'],
[-33.417559,-70.599824,'','045 APOQUINDO EL BOSQUE / RF 01 EL BOSQUE A / PTZ','Apoquindo & El Bosque Norte','','PTZ'],
[-33.416877,-70.597449,'','054 APOQUINDO - AUGUSTO LEGUIA / FIJA 1','Apoquindo & Augusto Leguía','','FIJA'],
[-33.416766,-70.595785,'','056 APOQUINDO - SAN CRESCENTE / PTZ','Apoquindo & San Crescente','','PTZ'],
[-33.40869,-70.600436,'','066 KENNEDY - VITACURA / FIJA 1','Av. Vitacura & Calle Luz','','FIJA'],
[-33.413946,-70.603507,'','069 VITACURA - ISIDORA GOYENECHEA / FIJA 1','Av. Vitacura & Isidora Goyenechea','','FIJA'],
[-33.419511,-70.599506,'','075 EL BOSQUE - CALLAO / FIJA 1','El Bosque Central & Callao','','FIJA'],
[-33.414449,-70.594566,'','078 FOSTER - ISIDORA GOYENECHEA / FIJA 1','Isidora Goyenechea & Enrique Foster','','FIJA'],
[-33.412534,-70.597635,'','092 RIESCO - AUGUSTO LEGUIA / PTZ','Pdte. Riesco & Augusto Leguía','','PTZ'],
[-33.416816,-70.604894,'','100 TAJAMAR - VITACURA / FIJA 1','Tajamar & Vitacura','','FIJA'],
[-33.415837,-70.59623,'','109 CENTRO CIVICO / LPR','Centro Civico / Apoquindo','','LPR'],
[-33.414304,-70.597954,'','112 ISIDORA GOYENECHEA - AUGUSTO LEGUIA / PTZ','Isidora Goyenechea & Augusto Leguía Norte','','PTZ'],
[-33.421457,-70.5966,'','117 SANCHEZ FONTECILLA - ERRAZURIZ / FIJA 1','Mariano Sánchez Fontecilla & Presidente Errázuriz','','FIJA'],
[-33.41159,-70.60273,'','141 VITACURA - RIESCO / FIJA 1','Pdte Riesco & Vitacura','','FIJA'],
[-33.41468,-70.60554,'','145 ANDRES BELLO - COSTANERA SUR / PTZ','Andres Bello & Costanera Sur','','PTZ'],
[-33.41593,-70.60682,'','148 ANDRES BELLO - TAJAMAR / PTZ','Nueva Tajamar & Andres Bello','','PTZ'],
[-33.41807,-70.6013,'','152 APOQUINDO - TOBALABA / FIJA 1','Apoquindo & Tobalaba','','FIJA'],
[-33.41539,-70.60106,'','190 EL BOSQUE - SAN SEBASTIAN / FIJA 1','EL BOSQUE & SAN SEBASTIAN','','FIJA'],
[-33.41701,-70.60193,'','203 ENCOMENDEROS - ROGER DE FLOR / FIJA 1','ENCOMENDEROS & ROGER DE FLOR','','FIJA'],
[-33.41455,-70.596326,'','223 LA PASTORA - ISIDORA GOYENECHEA / FIJA 1','LA PASTORA & ISIDORA GOYENECHEA','','FIJA'],
[-33.414125,-70.600074,'','224 ISIDORA GOYENECHEA - SAN SEBASTIAN / FIJA 1','ISIDORA GOYENECHEA & SAN SEBASTIAN','','FIJA'],
[-33.413898,-70.602403,'','225 ISIDORA GOYENECHEA - LUZ / FIJA 1','ISIDORA GOYENECHEA & LUZ','','FIJA'],
[-33.416739,-70.600311,'','226 ROGER DE FLOR - EL BOSQUE / FIJA 1','ROGER DE FLOR & EL BOSQUE NORTE','','FIJA'],
[-33.411494,-70.603307,'','228 ANDRES BELLO - PRESIDENTE RIESCO / FIJA 1','ANDRES BELLO & PRESIDENTE RIESCO','','FIJA'],
[-33.41221,-70.599665,'','229 PRESIDENTE RIESCO - SAN SEBASTIAN / FIJA 1','PRESIDENTE RIESCO & SAN SEBASTIAN','','FIJA'],
[-33.415401,-70.604042,'','241 VITACURA & ZURICH / LPR 1','Vitacura & Zurich','','LPR'],
[-33.417341,-70.599257,'','243 APOQUINDO NORTE & EL BOSQUE / LPR 1','Apoquindo & El Bosque','','LPR'],
[-33.415785,-70.60273,'','251 ZURICH & EBRO / FIJA 1','Zurich & Ebro','','FIJA'],
[-33.416135,-70.594693,'','297 EDIFICIO APOQUINDO 3400 / PTZ ZOOM','Apoquindo 3400','','PTZ'],
[-33.41744,-70.59944,'','RI 04 APOQUINDO - EL BOSQUE / FISHEYE','APOQUINDO & EL BOSQUE','','FISHEYE'],
[-33.41706,-70.59756,'','RI 05 APOQUINDO - A. LEGUIA SUR / FISHEYE','APOQUINDO & A. LEGUIA SUR','','FISHEYE'],
[-33.41669,-70.59656,'','RI 06 APOQUINDO - A. LEGUIA NORTE / FISHEYE','APOQUINDO & A. LEGUIA NORTE','','FISHEYE'],
[-33.41644,-70.59431,'','RI 07 APOQUINDO - E. FOSTER / FISHEYE','APOQUINDO & E. FOSTER','','FISHEYE'],
[-33.414844,-70.598468,'','PI 32 CARMENCITA & DON CARLOS / SOS','Carmencita & Don carlos','','VIDEOPORTERO'],
[-33.413497,-70.596308,'','PI 120 GLAMIS & LA PASTORA / PTZ','Glamis & La Pastora','','PTZ'],
[-33.417699,-70.602121,'','PI 122 TAJAMAR & ENCOMENDEROS / PTZ','Tajamar & Encomenderos','','PTZ'],
[-33.415,-70.597893,'','PI 149 DON CARLOS & AUGUSTO LEGUIA / PTZ','Don Carlos & Augusto Leguia','','PTZ'],
[-33.40048,-70.57678,'','128 KENNEDY - ROSARIO NORTE / FIJA 1','Kennedy & Rosario Norte','','FIJA'],
[-33.40226,-70.57547,'','158 CERRO COLORADO - ROSARIO NORTE / PTZ','Cerro Colorado & Rosario Norte','','PTZ'],
[-33.399665,-70.574542,'','177 MARRIOT / PTZ','Av. Kennedy 5741','','PTZ'],
[-33.400059,-70.574348,'','298 EDIFICIO MARRIOT / PTZ ZOOM','Presidente Kennedy 5741','','PTZ'],
[-33.4013,-70.57867,'','RI 15 L.KENNEDY - P.ARAUCO / FISHEYE','Av. Pdte. Kennedy Lateral & Parque Araucano','','FISHEYE'],
[-33.40319,-70.57781,'','RI 16 CERRO COLORADO - A. DE CORDOVA / FISHEYE','CERRO COLORADO & A. DE CORDOVA','','FISHEYE'],
[-33.403,-70.574028,'','PI 15 PARQUE ARAUCANO CENTRAL / SOS','Parque Araucano Central','','VIDEOPORTERO'],
[-33.41124,-70.57596,'','030 APOQUINDO - LA GLORIA / PTZ','Apoquindo & La Gloria','','PTZ'],
[-33.403844,-70.573456,'','065 RIESCO - ROSARIO NORTE / PTZ','Av. Presidente Riesco & Rosario Norte','','PTZ'],
[-33.40484,-70.58199,'','121 ALONSO DE CORDOVA - CERRO COLORADO / FIJA 1','Alonso de Córdova & Cerro Colorado','','FIJA'],
[-33.40438,-70.58408,'','143 KENNEDY - ALONSO DE CORDOVA / FIJA 1','Kennedy & Alonso de Cordova','','FIJA'],
[-33.40668,-70.57307,'','193 ALONSO DE CORDOVA - LOS MILITARES / FIJA 1','ALONSO DE CÓRDOVA & LOS MILITARES','','FIJA'],
[-33.40556,-70.57913,'','205 PRESIDENTE RIESCO - ALONSO DE CORDOVA / FIJA 1','PRESIDENTE RIESCO & ALONSO DE CÓRDOVA','','FIJA'],
[-33.410719,-70.574329,'','234 APOQUINDO - JORGE IV / PTZ','APOQUINDO & JORGE IV','','PTZ'],
[-33.405192,-70.581774,'','247 ALONSO DE CORDOVA SUR & CERRO COLORADO / LPR 1','Alonso de Córdova 4471','','LPR'],
[-33.405326,-70.585993,'','254 AMÉRICO VESPUCIO NORTE & PRESIDENTE KENNEDY / FIJA 1','Américo Vespucio Norte & Presidente Kennedy','','FIJA'],
[-33.406879,-70.586659,'','255 AMÉRICO VESPUCIO NORTE & CERRO COLORADO / FIJA 1','Américo Vespucio Norte & Cerro Colorado','','FIJA'],
[-33.408602,-70.577331,'','261 LOS MILITARES & LA GLORIA / FIJA 1','Los Militares & La Gloria','','FIJA'],
[-33.412174,-70.578476,'','263 APOQUINDO & PUERTA DEL SOL / FIJA 1','Apoquindo & Puerta del Sol','','FIJA'],
[-33.410633,-70.573248,'','264 APOQUINDO & LUIS ZEGERS / FIJA 1','Apoquindo & Luis Zegers','','FIJA'],
[-33.410653,-70.579161,'','295 LOS MILITARES - ORINOCO / FIJA 1','Los Militares & Orinoco','','FIJA'],
[-33.41184,-70.57819,'','RI 12 APOQUINDO - ORINOCO / FISHEYE','APOQUINDO & ORINOCO','','FISHEYE'],
[-33.404056,-70.576778,'','PI 17 PARQUE ARAUCANO PONIENTE / SOS','Parque Araucano Poniente','','VIDEOPORTERO'],
[-33.411204,-70.575094,'','PI 49 COIMBRA & ROSA O\'HIGGINS / SOS','Coimbra & Rosa O\'higgins','','VIDEOPORTERO'],
[-33.404941,-70.578501,'','PI 164 DEPARTAMENTO DE TRANSITO / PTZ','PDTE RIESCO 5296','','PTZ'],
[-33.40704,-70.581401,'','PI 190 COLEGIO ALCAZAR DE LAS CONDES / PTZ','PRESIDENTE RIESCO 4902','','PTZ'],
[-33.41343,-70.58272,'','027 APOQUINDO - ESCUELA MILITAR NORTE / PTZ','Apoquindo & General Barceló','','PTZ'],
[-33.413653,-70.58266,'','046 APOQUINDO - ESCUELA MILITAR SUR / RF 05 FIJA 1','Apoquindo & Felix de amesti','','FIJA'],
[-33.414724,-70.585897,'','053 APOQUINDO - ASTURIAS / PTZ','Apoquindo & Asturias','','PTZ'],
[-33.424314,-70.583266,'','072 COLON - MALAGA / PTZ','Av. Cristobal Colón & Malaga','','PTZ'],
[-33.419697,-70.582303,'','104 VESPUCIO - RAPALLO / FIJA 1','A. Vespucio Sur & Rapallo','','FIJA'],
[-33.415982,-70.583668,'','105 VESPUCIO - NEVERIA / FIJA 1','A. Vespucio Sur & Nevería','','FIJA'],
[-33.410636,-70.586769,'','127 PDTE RIESCO - VESPUCIO / FIJA 1','Pdte Riesco & Vespucio','','FIJA'],
[-33.413588,-70.58466,'','142 VESPUCIO - LOS MILITARES / FIJA 1','Los Militares & Americo Vespucio','','FIJA'],
[-33.41882,-70.58231,'','164 VESPUCIO - PDTE ERRAZURIZ / FIJA 1','Vespucio & Presidente Errázuriz','','FIJA'],
[-33.425597,-70.588208,'','173 COLON - MARCO POLO / PTZ','Colón & Marco Polo','','PTZ'],
[-33.414805,-70.587055,'','191 APOQUINDO - GOLDA MEIR / FIJA 1','APOQUINDO & GOLDA MEIR','','FIJA'],
[-33.42496,-70.585738,'','214 CRISTOBAL COLON - ALCANTARA / FIJA 1','CRISTÓBAL COLÓN & ALCÁNTARA','','FIJA'],
[-33.417728,-70.585905,'','237 RENATO SANCHEZ - MALAGA / PTZ','RENATO SANCHEZ & MALAGA','','PTZ'],
[-33.418966,-70.584098,'','238 PRESIDENTE ERRAZURIZ - ASTURIAS / PTZ','PRESIDENTE ERRAZURIZ & ASTURIAS','','PTZ'],
[-33.423132,-70.586652,'','292 MARTIN DE ZAMORA & ALCANTARA / PTZ','MARTIN DE ZAMORA & ALCANTARA','','PTZ'],
[-33.41505,-70.58725,'','RI 08 APOQUINDO - MALAGA / FISHEYE','APOQUINDO & MALAGA','','FISHEYE'],
[-33.41469,-70.58669,'','RI 09 APOQUINDO - GOLDA MEIR / FISHEYE','APOQUINDO & GOLDA MEIR','','FISHEYE'],
[-33.41352,-70.58422,'','RI 11 LOS MILITARES - BARCELO / FISHEYE','LOS MILITARES & BARCELO','','FISHEYE'],
[-33.428061,-70.585189,'','PI 39 TARRAGONA & ALCANTARA / SOS','Tarragona & Alcantara','','VIDEOPORTERO'],
[-33.414184,-70.583637,'','PI 47 VESPUCIO & APOQUINDO / PTZ','Americo Vespucio Norte & Apoquindo','','PTZ'],
[-33.413585,-70.583606,'','PI 129 APOQUINDO SUBCENTRO (OREJA NORORIENTE) / PTZ','Apoquindo & Gral Francisco Barceló','','PTZ'],
[-33.414261,-70.588148,'','PI 166 JEAN MERMOZ / PTZ','JEAN MERMOZ 4115','','PTZ'],
[-33.419995,-70.586936,'','PI 172 COLEGIO VERBO DIVINO / PTZ','PDTE ERRÁZURIZ 4055','','PTZ'],
[-33.42114,-70.57645,'','154 COLON - FELIX DE AMESTI / PTZ','Colón & Felix de Amesti','','PTZ'],
[-33.420254,-70.578361,'','176 MARTIN DE ZAMORA - FELIX DE AMESTI / PTZ','Martin de Zamora & Felix de Amesti','','PTZ'],
[-33.413703,-70.577755,'','231 NEVERIA - PUERTA DEL SOL / PTZ','NEVERIA & PUERTA DEL SOL','','PTZ'],
[-33.421921,-70.580718,'','256 AMÉRICO VESPUCIO SUR & MARTÍN DE ZAMORA / FIJA 1','Américo Vespucio Sur & Martín de Zamora','','FIJA'],
[-33.415274,-70.574224,'','266 ROSA O\'HIGGINS & DEL INCA / FIJA 1','Rosa O\'Higgins & Del Inca','','FIJA'],
[-33.41319,-70.58156,'','RI 10 APOQUINDO - ESCUELA MILITAR PARADA 3 / FISHEYE','APOQUINDO & ESCUELA MILITAR','','FISHEYE'],
[-33.417836,-70.58143,'','PI 48 CRUZ DEL SUR & DEL INCA / SOS','Cruz del Sur & del Inca','','VIDEOPORTERO'],
[-33.413781,-70.574749,'','PI 215 COLEGIO MOUNIER / PTZ','ROSA O\'HIGGINS 298','','PTZ'],
[-33.41641,-70.59412,'','026 APOQUINDO - ENRIQUE FOSTER / PTZ','Apoquindo & Enrique Foster Sur','','PTZ'],
[-33.4159,-70.59165,'','028 APOQUINDO - GERTRUDIS ECHEÑIQUE / FIJA 1','Apoquindo & Gertrudis Echeñique','','FIJA'],
[-33.42118,-70.59343,'','044 SAN CRESCENTE - PDTE. ERRAZURIZ / LPR','San Crescente & Pdte. Errazuriz','','LPR'],
[-33.415202,-70.589327,'','055 APOQUINDO - LAS TORCAZAS / PTZ','Apoquindo & Las Torcazas','','PTZ'],
[-33.426244,-70.590717,'','073 COLON - SANCHEZ FONTECILLA / FIJA 1','Av. Cristobal Colón & Mariano Sánchez Fontecilla','','FIJA'],
[-33.420242,-70.588399,'','091 ERRAZURIZ - ALCANTARA / PTZ','Pdte. Errazuriz & Alcantara','','PTZ'],
[-33.41622,-70.594066,'','106 APOQUINDO - FOSTER/ FIJA','Enrique Foster & Apoquindo Norte','','FIJA'],
[-33.41639,-70.594105,'','106 APOQUINOD - FOSTER / RF 03 FOSTER A / PTZ','Enrique Foster & Apoquindo Sur','','PTZ'],
[-33.424493,-70.592689,'','116 SANCHEZ FONTECILLA - MARTIN DE ZAMORA / FIJA 1','Mariano Sánchez Fontecilla & Martín de Zamora','','FIJA'],
[-33.420547,-70.590365,'','118 ERRAZURIZ - GERTRUDIZ ECHEÑIQUE / PTZ','Presidente Errázuriz & Gertrudiz Echeñique','','PTZ'],
[-33.42773,-70.58861,'','144 SANCHEZ FONTECILLA - VATICANO / PTZ','Sanchez Fontecilla & Vaticano','','PTZ'],
[-33.41213,-70.59259,'','200 PRESIDENTE RIESCO - EL GOLF / FIJA 1','PRESIDENTE RIESCO & EL GOLF','','FIJA'],
[-33.414185,-70.593525,'','227 ISIDORA GOYENECHEA - MAGDALENA / FIJA 1','ISIDORA GOYENECHEA & MAGDALENA','','FIJA'],
[-33.418215,-70.588849,'','236 RENATO SANCHEZ - ALCANTARA / PTZ','RENATO SANCHEZ & ALCANTARA','','PTZ'],
[-33.412694,-70.588724,'','252 HAMLET & LAS TORCAZAS / FIJA 1','Hamlet & Las Torcazas','','FIJA'],
[-33.41869,-70.590882,'','253 GERTRUDIS ECHEÑIQUE & RENATO SÁNCHEZ / FIJA 1','Gertrudis Echeñique & Renato Sánchez','','FIJA'],
[-33.420261,-70.589371,'','PI 37 PDTE ERRAZURIZ & POLONIA / SOS','Presidente Errazuriz & Polonia','','VIDEOPORTERO'],
[-33.425435,-70.591556,'','PI 146 LA NIÑA - SANCHEZ FONTECILLA / PTZ','La niña & Sanchez Fontecilla','','PTZ'],
[-33.420455,-70.589129,'','PI 171 COLEGIO VILLA MARIA ACADEMY / PTZ','PDTE ERRÁZURIZ 3753','','PTZ'],
[-33.419263,-70.588568,'','PI 179 COLEGIO PRESIDENTE ERRAZURIZ / PTZ','ALCÁNTARA 445','','PTZ'],
[-33.419439,-70.588478,'','PI 209 COLEGIO SAIN PAUL MONTESSORI / PTZ','ALCÁNTARA 464','','PTZ'],
[-33.425952,-70.580754,'','076 FLANDES - VATICANO / PTZ','Flandes & Vaticano','','PTZ'],
[-33.428146,-70.574807,'','103 VESPUCIO - LATADIA / FIJA 1','A. Vespucio & Latadía','','FIJA'],
[-33.423541,-70.57904,'','110 VESPUCIO - COLON / FIJA 1','Américo Vespucio & Cristóbal Colon','','FIJA'],
[-33.427483,-70.578904,'','188 ISABEL LA CATOLICA -CARLOS V / PTZ','Isabel la Católica & Carlos V','','PTZ'],
[-33.426284,-70.573986,'','239 ISABEL LA CATOLICA #4601 / FIJA 1','ISABEL LA CATÓLICA 4601','','FIJA'],
[-33.422519,-70.583931,'','240 MARTÍN DE ZAMORA - MALAGA / PTZ','MARTÍN DE ZAMORA & MALAGA','','PTZ'],
[-33.425868,-70.576776,'','257 AMÉRICO VESPUCIO SUR & ISABEL LA CATÓLICA (PONIENTE) / FIJA 1','Américo Vespucio Sur & Isabel La Católica (poniente)','','FIJA'],
[-33.423374,-70.578832,'','RI 49 COLON - VESPUCIO / FISHEYE','COLON & VESPUCIO','','FISHEYE'],
[-33.423632,-70.578703,'','RI 50 VESPUCIO SUR - COLON / FISHEYE','VESPUCIO SUR & COLON','','FISHEYE'],
[-33.426883,-70.579043,'','PI 41 FDO DE ARAGON & CARLOS V / SOS','Fernando de Aragon & Carlos V','','VIDEOPORTERO'],
[-33.426145,-70.572864,'','PI 184 COLEGIO QUIMAY / PTZ','ISABEL LA CATOLICA 4774','','PTZ']
    ];

    // Compatibilidad con el formato anterior
    const DESTACAMENTOS_FALLBACK = CAMARAS_RAW;

    async function fetchCamaras() {
        // Si hay FeatureServer configurado, intentar fetch dinámico
        if (CONFIG.CAMARAS_FEATURESERVER) {
            try {
                const url = `${CONFIG.CAMARAS_FEATURESERVER}/query?where=1%3D1&outFields=*&f=json&returnGeometry=true&resultRecordCount=2000`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.features && data.features.length > 0) {
                    const isMerc = data.spatialReference?.wkid === 102100 || data.spatialReference?.wkid === 3857;
                    return data.features.map(f => {
                        let lat, lng;
                        if (isMerc) {
                            lng = (f.geometry.x / 20037508.34) * 180;
                            lat = (Math.atan(Math.exp((f.geometry.y / 20037508.34) * Math.PI)) * 360 / Math.PI) - 90;
                        } else { lng = f.geometry.x; lat = f.geometry.y; }
                        return { lat, lng,
                            nombre: f.attributes.nombre_csv || f.attributes.nombre_hik || f.attributes.Name || 'Cámara',
                            codigo: f.attributes.id_camara || f.attributes.id_centro || '',
                            dir: f.attributes.direccion || '',
                            destacamento: f.attributes.destacamen || '',
                            tipo: f.attributes.tipo_de_c || '',
                        };
                    });
                }
            } catch (e) { console.warn('[MapaIntegrado] FeatureServer fetch failed, using embedded data:', e); }
        }
        // Datos embebidos: 520 cámaras reales con coordenadas precisas
        return CAMARAS_RAW.map(c => ({
            lat: c[0], lng: c[1],
            nombre: c[2] || 'Cámara',
            codigo: c[3] || '',
            dir: c[4] || '',
            destacamento: c[5] || '',
            tipo: c[6] || '',
        }));
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  CARGA DE LEAFLET                                             ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function cargarLeaflet() {
        return new Promise((resolve, reject) => {
            if (window.L) { resolve(); return; }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = CONFIG.LEAFLET_CSS;
            document.head.appendChild(link);

            const script = document.createElement('script');
            script.src = CONFIG.LEAFLET_JS;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Leaflet load failed'));
            document.head.appendChild(script);
        });
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  UI: CONSTRUCCIÓN DE LA INTERFAZ                              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function construirUI() {
        // Ocultar contenido original
        const wrapper = document.getElementById('page-wrapper');
        if (wrapper) wrapper.style.display = 'none';
        const sidebar = document.querySelector('.navbar-default.navbar-static-side');
        if (sidebar) sidebar.style.display = 'none';

        const container = document.createElement('div');
        container.id = 'mapa-integrado-root';
        container.innerHTML = `
            <style>
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

                #mi-filters {
                    padding:6px 14px; display:flex; gap:4px; flex-wrap:wrap;
                    border-bottom:1px solid rgba(255,255,255,.06); flex-shrink:0;
                }
                .mi-fbtn {
                    background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08);
                    color:rgba(255,255,255,.5); padding:2px 8px; border-radius:5px;
                    font:500 9px -apple-system,sans-serif; cursor:pointer; transition:all .15s;
                    text-transform:uppercase; letter-spacing:.3px;
                }
                .mi-fbtn:hover { background:rgba(255,255,255,.1); color:#fff; }
                .mi-fbtn.on { background:rgba(37,99,235,.18); border-color:rgba(37,99,235,.35); color:#60a5fa; }

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
                .mi-card:hover { background:rgba(255,255,255,.04); }
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

                /* ═══ LEAFLET POPUP OVERRIDE ═══ */
                .leaflet-popup-content-wrapper {
                    background:rgba(15,17,23,.95)!important; backdrop-filter:blur(12px);
                    border:1px solid rgba(255,255,255,.1)!important; border-radius:8px!important;
                    color:#e2e4e9!important; box-shadow:0 8px 32px rgba(0,0,0,.5)!important;
                }
                .leaflet-popup-tip { background:rgba(15,17,23,.95)!important; }
                .leaflet-popup-content { margin:8px 12px!important; font:12px -apple-system,sans-serif!important; line-height:1.4!important; }
                .mi-popup-tipo { font-weight:700; font-size:13px; margin-bottom:3px; }
                .mi-popup-dir { color:rgba(255,255,255,.55); font-size:11px; margin-bottom:4px; }
                .mi-popup-meta { font-size:10px; color:rgba(255,255,255,.35); }
            </style>

            <!-- TOPBAR -->
            <div id="mi-topbar">
                <div class="left">
                    <button id="mi-back">← Volver</button>
                    <h1>🗺️ Mapa Integrado</h1>
                    <span class="mi-badge" id="mi-mode">Conectando...</span>
                </div>
                <div class="right">
                    <span class="mi-stat"><span class="mi-dot p"></span>Pend: <strong id="mi-cnt-p">0</strong></span>
                    <span class="mi-stat"><span class="mi-dot c"></span>Cerr: <strong id="mi-cnt-c">0</strong></span>
                    <span id="mi-refresh-info">
                        <span class="mi-spinner" id="mi-spinner"></span>
                        <span>⟳ <strong id="mi-countdown">--</strong>s</span>
                    </span>
                    <span id="mi-clock">--:--:--</span>
                </div>
            </div>

            <!-- MAPA -->
            <div id="mi-map" style="top:42px"></div>

            <!-- PANEL -->
            <div id="mi-panel">
                <div id="mi-panel-head">
                    <h3>⏰ Última Hora <span class="mi-badge" id="mi-proc-cnt">0</span></h3>
                </div>
                <div id="mi-filters"></div>
                <div id="mi-panel-body"></div>
            </div>
            <button id="mi-panel-toggle">◀</button>

            <!-- LEYENDA -->
            <div id="mi-legend">
                <h4>Leyenda</h4>
                ${CATEGORIAS.map(c => `<div class="mi-leg"><span class="mi-leg-d" style="background:${c.color}"></span>${c.nombre}</div>`).join('')}
                <div class="mi-leg"><span class="mi-leg-d" style="background:#06b6d4"></span>Cámaras</div>
            </div>
        `;

        document.body.appendChild(container);

        // Filtros
        const filtersEl = container.querySelector('#mi-filters');
        filtersEl.innerHTML = `<button class="mi-fbtn on" data-cat="all">Todos</button>` +
            CATEGORIAS.map(c => `<button class="mi-fbtn" data-cat="${c.id}">${c.icon} ${c.nombre}</button>`).join('');

        return container;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  APP CONTROLLER                                               ║
    // ╚═══════════════════════════════════════════════════════════════╝

    let map, procLayer, camLayer;
    let allProcs = [];
    let activeFilter = 'all';
    let procMarkers = new Map();
    let refreshTimer = null;
    let countdownVal = 0;
    let arcgisWindow = null;
    let gmapsWindow = null;

    async function iniciarMapa(container) {
        await cargarLeaflet();

        map = L.map('mi-map', {
            center: CONFIG.CENTER,
            zoom: CONFIG.ZOOM,
            zoomControl: false,
            attributionControl: false,
        });

        // Tile: OpenStreetMap estándar — calles legibles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(map);

        L.control.zoom({ position: 'topleft' }).addTo(map);

        procLayer = L.layerGroup().addTo(map);
        camLayer = L.layerGroup().addTo(map);

        // ── Cargar cámaras ──
        const camaras = await fetchCamaras();
        const tipoColor = { 'FIJA': '#06b6d4', 'PTZ': '#22d3ee', 'DOMO': '#0ea5e9', 'LPR': '#38bdf8' };
        camaras.forEach(cam => {
            const color = tipoColor[cam.tipo?.toUpperCase()] || '#06b6d4';
            L.circleMarker([cam.lat, cam.lng], {
                radius: 4, fillColor: color, fillOpacity: 0.55,
                color: '#0e7490', weight: 0.5,
            }).bindPopup(`
                <div>
                    <div class="mi-popup-tipo" style="color:${color}">📷 ${cam.nombre || 'Cámara'}</div>
                    ${cam.codigo ? `<div class="mi-popup-meta">ID: ${cam.codigo}</div>` : ''}
                    ${cam.dir ? `<div class="mi-popup-dir">📍 ${cam.dir}</div>` : ''}
                    ${cam.destacamento ? `<div class="mi-popup-meta">Dest: ${cam.destacamento} · ${cam.tipo || ''}</div>` : ''}
                </div>
            `).addTo(camLayer);
        });

        // ── Eventos UI ──
        container.querySelector('#mi-back').addEventListener('click', salir);
        container.querySelector('#mi-panel-toggle').addEventListener('click', () => {
            const panel = container.querySelector('#mi-panel');
            panel.classList.toggle('collapsed');
            container.querySelector('#mi-panel-toggle').textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
        });
        container.querySelectorAll('.mi-fbtn').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.mi-fbtn').forEach(b => b.classList.remove('on'));
                btn.classList.add('on');
                activeFilter = btn.dataset.cat;
                renderPanel(container);
            });
        });

        // ── Reloj ──
        setInterval(() => {
            const now = new Date();
            container.querySelector('#mi-clock').textContent = now.toLocaleTimeString('es-CL', { hour12: false });
        }, 1000);

        // ── Primera carga ──
        await refreshData(container);
        startRefreshCycle(container);
    }

    async function refreshData(container) {
        container.querySelector('#mi-spinner').classList.add('on');
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

        allProcs = procs;
        renderPanel(container);
        await renderMapProcs();
        container.querySelector('#mi-spinner').classList.remove('on');
    }

    function renderPanel(container) {
        const body = container.querySelector('#mi-panel-body');
        const filtered = activeFilter === 'all'
            ? allProcs
            : allProcs.filter(p => p.cat.id === activeFilter);

        const pend = filtered.filter(p => p.estado === 'PENDIENTE');
        const cerr = filtered.filter(p => p.estado === 'CERRADO');

        container.querySelector('#mi-proc-cnt').textContent = filtered.length;
        container.querySelector('#mi-cnt-p').textContent = allProcs.filter(p => p.estado === 'PENDIENTE').length;
        container.querySelector('#mi-cnt-c').textContent = allProcs.filter(p => p.estado === 'CERRADO').length;

        let html = '';
        if (pend.length) {
            html += `<div class="mi-sec">🔴 Pendientes (${pend.length})</div>`;
            html += pend.map(cardHTML).join('');
        }
        if (cerr.length) {
            html += `<div class="mi-sec">🔵 Cerrados (${cerr.length})</div>`;
            html += cerr.map(cardHTML).join('');
        }
        if (!filtered.length) {
            html = '<div style="padding:30px;text-align:center;color:rgba(255,255,255,.25);font-size:11px">Sin procedimientos en última hora</div>';
        }

        body.innerHTML = html;

        // Bind eventos
        body.querySelectorAll('.mi-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const entry = procMarkers.get(card.dataset.id);
                if (entry) {
                    map.setView(entry.coords, 17, { animate: true, duration: 0.5 });
                    setTimeout(() => entry.marker.openPopup(), 300);
                }
            });
        });
        body.querySelectorAll('.mi-btn-arc').forEach(btn => {
            btn.addEventListener('click', () => abrirEnArcGIS(btn.dataset.dir, btn.dataset.pid));
        });
        body.querySelectorAll('.mi-btn-gm').forEach(btn => {
            btn.addEventListener('click', () => abrirEnGMaps(btn.dataset.dir));
        });
    }

    function cardHTML(p) {
        const isPend = p.estado === 'PENDIENTE';
        const hora = p.fecha.match(/\d{2}:\d{2}/)?.[0] || p.fecha;
        const dirEsc = (p.dir || '').replace(/"/g, '&quot;');
        return `
            <div class="mi-card" data-id="${p.id}" style="border-left-color:${p.cat.color}">
                <div class="mi-card-top">
                    <span class="mi-card-tipo">${p.tipo}</span>
                    <span class="mi-card-est ${isPend ? 'p' : 'c'}">${p.estado}</span>
                </div>
                <div class="mi-card-meta">
                    <span>🕐 ${hora}</span>
                    <span>ID: ${p.id}</span>
                </div>
                ${p.dir ? `<div class="mi-card-dir">📍 ${p.dir}</div>` : ''}
                <div class="mi-card-btns">
                    <button class="mi-btn-arc" data-dir="${dirEsc}" data-pid="${p.id}">🗺️ ArcGIS</button>
                    <button class="mi-btn-gm" data-dir="${dirEsc}">📍 GMaps</button>
                </div>
            </div>`;
    }

    async function renderMapProcs() {
        procLayer.clearLayers();
        procMarkers.clear();

        const filtered = activeFilter === 'all'
            ? allProcs
            : allProcs.filter(p => p.cat.id === activeFilter);

        for (const p of filtered) {
            if (!p.dir) continue;
            const coords = await geocodificarEnCola(p.dir);
            if (!coords) continue;

            const isPend = p.estado === 'PENDIENTE';
            const marker = L.circleMarker(coords, {
                radius: isPend ? 8 : 5,
                fillColor: p.cat.color,
                fillOpacity: isPend ? 0.8 : 0.35,
                color: '#fff',
                weight: isPend ? 2 : 1,
            }).addTo(procLayer);

            marker.bindPopup(`
                <div>
                    <div class="mi-popup-tipo" style="color:${p.cat.color}">${p.tipo}</div>
                    <div class="mi-popup-dir">📍 ${p.dir}</div>
                    <div class="mi-popup-meta">
                        ${p.fecha} · ID: ${p.id}<br>
                        Estado: <strong style="color:${isPend ? '#f87171' : '#60a5fa'}">${p.estado}</strong>
                        ${p.desc ? `<br><em style="color:rgba(255,255,255,.3)">${p.desc}</em>` : ''}
                    </div>
                </div>
            `);

            procMarkers.set(p.id, { marker, coords, proc: p });
        }
    }

    // ── Navegación externa ──
    function abrirEnArcGIS(dir, procId) {
        if (!dir) return;
        const q = prepararDireccion(dir) + ', Las Condes';
        const url = `${CONFIG.ARCGIS_VISOR_URL}&find=${encodeURIComponent(q)}`;
        if (arcgisWindow && !arcgisWindow.closed) {
            arcgisWindow.location.href = url;
        } else {
            arcgisWindow = window.open(url, 'arcgis_visor');
        }
    }

    function abrirEnGMaps(dir) {
        if (!dir) return;
        const q = prepararDireccion(dir) + ', Las Condes, Santiago, Chile';
        const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
        if (gmapsWindow && !gmapsWindow.closed) {
            gmapsWindow.location.href = url;
        } else {
            gmapsWindow = window.open(url, 'gmaps_visor');
        }
    }

    // ── Refresh ──
    function getRefreshSec() {
        const p = allProcs.filter(x => x.estado === 'PENDIENTE').length;
        if (p === 0) return CONFIG.REFRESH[0];
        if (p <= 5) return CONFIG.REFRESH[5];
        if (p <= 15) return CONFIG.REFRESH[15];
        return CONFIG.REFRESH.max;
    }

    function startRefreshCycle(container) {
        if (refreshTimer) clearInterval(refreshTimer);
        countdownVal = getRefreshSec();
        const cdEl = container.querySelector('#mi-countdown');
        cdEl.textContent = countdownVal;

        refreshTimer = setInterval(() => {
            countdownVal--;
            cdEl.textContent = Math.max(0, countdownVal);
            if (countdownVal <= 0) {
                refreshData(container).then(() => {
                    countdownVal = getRefreshSec();
                });
            }
        }, 1000);
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  NAVEGACIÓN (hash-based)                                      ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function activar() {
        if (document.getElementById('mapa-integrado-root')) return; // ya activo
        console.log('[MapaIntegrado] ▶ Activando');
        const container = construirUI();
        iniciarMapa(container);
    }

    function salir() {
        const root = document.getElementById('mapa-integrado-root');
        if (root) root.remove();
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

        // Restaurar contenido original
        const wrapper = document.getElementById('page-wrapper');
        if (wrapper) wrapper.style.display = '';
        const sidebar = document.querySelector('.navbar-default.navbar-static-side');
        if (sidebar) sidebar.style.display = '';

        // Limpiar referencia
        if (map) { map.remove(); map = null; }
        procLayer = null; camLayer = null;
        allProcs = []; procMarkers.clear();

        // Quitar hash sin recargar
        history.pushState(null, '', window.location.pathname + window.location.search);
    }

    // ── Inyectar botón de acceso ──
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

    // ── Detección de hash ──
    function checkHash() {
        if (window.location.hash === CONFIG.HASH) {
            activar();
        }
    }

    window.addEventListener('hashchange', checkHash);

    // ── Init ──
    inyectarBoton();
    checkHash();

    console.log('[MapaIntegrado] ✅ Script cargado. Usa #mapa-integrado para activar.');

})();
