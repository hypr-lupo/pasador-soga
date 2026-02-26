// ==UserScript==
// @name         Sistema - Mascara
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Máscara: Coloreo + Panel Última Hora + ArcGIS + Google Maps. Modular, optimizado, extensible.
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2025-2026 Leonardo Navarro
// @license      MIT
// @match        https://seguridad.lascondes.cl/incidents*
// @match        https://seguridad.lascondes.cl/incident_maps*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/Sistema-Mascara.user.js
// @downloadURL  https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/Sistema-Mascara.user.js
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════
 * Mascara para Sistemas de Seguridad Pública
 * Copyright (c) 2026-2027 Leonardo Navarro
 * Licensed under MIT License
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  1. CONFIGURACIÓN GLOBAL                                      ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const CONFIG = {
        // Panel lateral
        HORAS_ATRAS: 1,
        MAX_PAGINAS: 15,
        DELAY_ENTRE_PAGINAS: 400,
        INTERVALO_ACTUALIZACION: 30000,
        INTERVALO_LIMPIEZA: 10000,
        PANEL_WIDTH: 500,

        // Columnas tabla (0-indexed)
        COL_FECHA: 1,
        COL_PROCEDIMIENTO: 2,
        COL_ID: 3,
        COL_ORIGEN: 4,
        COL_DESCRIPCION: 5,
        COL_DIRECCION: 6,

        // Storage
        STORAGE_PINNED_IDS: 'slc_pinned_incidents',
        STORAGE_PINNED_DATA: 'slc_pinned_data',
        STORAGE_IGNORED_IDS: 'slc_ignored_incidents',

        // ArcGIS
        ARCGIS_VISOR_URL: 'https://arcgismlc.lascondes.cl/portal/apps/webappviewer/index.html?id=118513d990134fcbb9196ac7884cfb8c',

        // Coloreo – polling
        POLLING_MS: 500,
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  2. CATEGORÍAS — fuente única de verdad                       ║
    // ║  Orden importa: primera coincidencia gana.                    ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const CATEGORIAS = [
        {
            id: 'homicidio',
            nombre: '☠️ Homicidio',
            color: 'rgba(153, 27, 27, 0.25)',
            border: '#991b1b',
            keywords: ['homicidio'],
        },
        {
            id: 'incendio_gas',
            nombre: '🔥 Incendio / Gas / Explosivos',
            color: 'rgba(220, 38, 38, 0.2)',
            border: '#dc2626',
            keywords: [
                'incendio con lesionados', 'incendio sin lesionados', 'incendio forestal',
                'quema de pastizales', 'amago de incendio', 'humo visible', 'humos visibles',
                'artefacto explosivo', 'escape de gas', 'emergencias de gas',
                'derrame de liquidos', 'elementos tóxicos',
            ],
        },
        {
            id: 'robo_hurto',
            nombre: '💰 Robos / Hurtos / Estafas',
            color: 'rgba(234, 88, 12, 0.2)',
            border: '#ea580c',
            keywords: ['hurtos', 'estafa', 'defraudaciones', 'microtráfico', 'llamada telefónica tipo estafa', 'robo a transeúnte'],
        },
        {
            id: 'violencia',
            nombre: '👊 Violencia / Agresión',
            color: 'rgba(249, 115, 22, 0.2)',
            border: '#f97316',
            keywords: [
                'agresión', 'acoso', 'actos deshonestos', 'disparos', 'riña',
                'violencia intrafamiliar', 'desorden, huelga', 'huelga y/o manifestación',
                'desorden', 'desalojo',
            ],
        },
        {
            id: 'detenidos',
            nombre: '🚔 Detenidos',
            color: 'rgba(217, 119, 6, 0.18)',
            border: '#d97706',
            keywords: [
                'detenidos por carabineros', 'detenidos por civiles',
                'detenidos por funcionarios municipales', 'detenidos por funcionarios policiales',
                'detenidos por pdi',
            ],
        },
        {
            id: 'accidente',
            nombre: '🚗 Accidentes de Tránsito',
            color: 'rgba(234, 179, 8, 0.2)',
            border: '#eab308',
            keywords: [
                'accidentes de tránsito', 'colisión', 'choque con lesionados',
                'choque sin lesionados', 'atropello', 'caida en vehículo',
                'vehículo en panne', 'solicitud de grúa',
            ],
        },
        {
            id: 'salud',
            nombre: '🏥 Salud / Lesionados',
            color: 'rgba(20, 184, 166, 0.18)',
            border: '#14b8a6',
            keywords: [
                'enfermo en interior', 'enfermo en vía', 'enfermos',
                'lesionado en interior', 'lesionado en vía', 'lesionados',
                'muerte natural', 'parturienta', 'oxígeno dependiente', 'ebrio en via',
            ],
        },
        {
            id: 'alarmas',
            nombre: '🚨 Alarmas / Pánico',
            color: 'rgba(219, 39, 119, 0.15)',
            border: '#db2777',
            keywords: [
                'alarma activada', 'alarma domicilio casa protegida', 'alarma pat',
                'alarma domicilio fono vacaciones', 'alarmas domiciliarias',
                'botón sos', 'botón de pánico',
            ],
        },
        {
            id: 'ruidos',
            nombre: '🔊 Ruidos Molestos',
            color: 'rgba(8, 145, 178, 0.18)',
            border: '#0891b2',
            keywords: ['ruidos molestos'],
        },
        {
            id: 'novedades',
            nombre: '📋 Novedades / Reportes',
            color: 'rgba(107, 114, 128, 0.15)',
            border: '#6b7280',
            keywords: [
                'novedades central', 'novedades climáticas', 'novedades cámaras',
                'novedades domicilio casa protegida', 'novedades domicilio fono vacaciones',
                'novedades globos', 'novedades instalaciones', 'novedades permisos',
                'novedades propaganda', 'novedades servicio carabineros',
                'mal tiempo novedades', 'reporte destacamentos',
                'reporte servicio especial', 'reporte servicio patrulleros',
            ],
        },
        {
            id: 'administrativo',
            nombre: '📝 Administrativo / Consultas',
            color: 'rgba(148, 163, 184, 0.12)',
            border: '#94a3b8',
            keywords: [
                'inscripcion o consulta casa protegida', 'agradecimientos', 'felicitaciones',
                'ayuda al vecino', 'consulta interna', 'consultas en general',
                'contigencia fv', 'corte de llamada', 'en creación', 'encuestas',
                'internos', 'llamada falsa', 'otros no clasificados', 'otros',
                'aseo en espacio público', 'repetición de servicio',
                'transferencia de llamada', 'solicitud de entrevista',
                'reclamo de vecino en contra del servicio o funcionarios',
                'supervisión a funcionario en terreno',
            ],
        },
        {
            id: 'preventivo',
            nombre: '🔍 Seguridad Preventiva',
            color: 'rgba(139, 92, 246, 0.18)',
            border: '#8b5cf6',
            keywords: [
                'alerta analítica', 'alerta de aforo', 'alerta de merodeo',
                'auto protegido', 'casa protegida ingresa', 'casa protegida',
                'fono vacaciones ingresa', 'fono vacaciones',
                'domicilio con puertas abiertas', 'domicilio marcado', 'marcas sospechosas',
                'detección de vehículo con sistema lector', 'hallazgo de vehículo con encargo',
                'encargo de vehículo', 'especies abandonadas',
                'vigilancia especial', 'sospechoso en vía pública',
                'vehículo abandonado', 'reporte brigada de halcones',
                'vehículo abierto o con indicios de robo',
                'reporte brigada de vigilancia aero-municipal',
            ],
        },
        {
            id: 'infraestructura',
            nombre: '🏗️ Infraestructura / Daños',
            color: 'rgba(161, 98, 7, 0.18)',
            border: '#a16207',
            keywords: [
                'cables cortados', 'baja altura', 'desnivel en acera', 'desnivel en calzada',
                'hoyo o hundimiento', 'luminaria en mal estado', 'desganche', 'árbol derribado',
                'graffiti', 'daños a mobiliario público', 'daños a móviles municipales',
                'daños a vehículo o propiedad', 'escombros en espacio',
                'matriz rota', 'pabellón patrio',
                'semáforo en mal estado', 'semaforo en mal estado',
            ],
        },
        {
            id: 'servicios_basicos',
            nombre: '💧 Servicios Básicos / Agua',
            color: 'rgba(59, 130, 246, 0.18)',
            border: '#3b82f6',
            keywords: [
                'corte de agua', 'corte de energía', 'cañeria rota', 'ausencia de medidor',
                'calles anegadas', 'domicilio anegado', 'paso nivel anegado',
                'canales de agua', 'grifo abierto', 'escurrimiento de aguas servidas',
                'material de arrastre', 'entrega manga plástica',
            ],
        },
        {
            id: 'orden_publico',
            nombre: '⚖️ Orden Público',
            color: 'rgba(99, 102, 241, 0.18)',
            border: '#6366f1',
            keywords: [
                'comercio ambulante', 'consumo de cannabis', 'alcohol en vía pública',
                'infracción por ordenanza', 'fiscalización estacionadores', 'limpia vidrios',
                'mendicidad', 'indigente', 'fumar en parques', 'no usar mascarilla',
                'vehículos mal estacionados', 'trabajos u ocupación vía pública',
            ],
        },
        {
            id: 'animales',
            nombre: '🐾 Animales',
            color: 'rgba(16, 185, 129, 0.18)',
            border: '#10b981',
            keywords: ['animales sueltos', 'encargo de mascota', 'perro suelto', 'plagas'],
        },
        {
            id: 'patrullaje',
            nombre: '🚶 Patrullaje / Turnos',
            color: 'rgba(229, 231, 235, 0.35)',
            border: '#d1d5db',
            keywords: [
                'patrullaje preventivo', 'inicio y/0 termino de turno',
                'carga de combustible', 'constancia de servicio',
            ],
        },
    ];

    // Lookup rápido: keyword → categoría (O(1) por keyword)
    const KEYWORD_MAP = new Map();
    const CATEGORIA_MAP = new Map();
    for (const cat of CATEGORIAS) {
        CATEGORIA_MAP.set(cat.id, cat);
        for (const kw of cat.keywords) {
            KEYWORD_MAP.set(kw.toLowerCase(), cat);
        }
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  3. UTILIDADES                                                ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const Utils = {
        parsearFecha(texto) {
            if (!texto) return null;
            const m = texto.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
            if (!m) return null;
            return new Date(m[3], m[2] - 1, m[1], m[4], m[5]);
        },

        dentroDeVentana(fecha, horas = CONFIG.HORAS_ATRAS) {
            return fecha ? fecha >= new Date(Date.now() - horas * 3600000) : false;
        },

        tiempoRelativo(fecha) {
            if (!fecha) return '';
            const min = Math.floor((Date.now() - fecha) / 60000);
            if (min < 1) return 'hace un momento';
            if (min < 60) return `hace ${min} min`;
            return `hace ${Math.floor(min / 60)}h ${min % 60}m`;
        },

        colorTiempo(fecha) {
            const min = Math.floor((Date.now() - fecha) / 60000);
            if (min < 10) return '#dc2626';
            if (min < 30) return '#f97316';
            return '#6b7280';
        },

        escapeHTML(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },

        escapeAttr(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
                     .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },

        formatearId(id) {
            if (!id) return '';
            const l = id.trim();
            return l.length > 4 ? l.slice(0, -4) + ' ' + l.slice(-4) : l;
        },

        // Dirección → query para ArcGIS
        prepararDireccion(dir) {
            if (!dir) return '';
            const d = dir.trim();
            // "CALLE, 1234 (CRUCE)" → "CALLE & CRUCE, Las Condes"
            const a = d.match(/^(.+?),\s*\d+\s*\((.+?)\)\s*$/);
            if (a) return `${a[1].trim()} & ${a[2].trim()}, Las Condes`;
            // "CALLE (CRUCE)" → "CALLE & CRUCE, Las Condes"
            const b = d.match(/^(.+?)\s*\((.+?)\)\s*$/);
            if (b) return `${b[1].trim()} & ${b[2].trim()}, Las Condes`;
            // "CALLE, 1234" → "CALLE 1234, Las Condes"
            const c = d.match(/^(.+?),\s*(\d+)\s*$/);
            if (c) return `${c[1].trim()} ${c[2]}, Las Condes`;
            return `${d}, Las Condes`;
        },

        clasificarEstado(t) {
            if (!t) return { texto: '', clase: '' };
            const u = t.toUpperCase().trim();
            const mapa = {
                CERRADO: 'estado-cerrado', PENDIENTE: 'estado-pendiente',
                ASIGNADO: 'estado-asignado', 'EN DESPLAZAMIENTO': 'estado-desplazamiento',
                'EN ATENCIÓN': 'estado-atencion', ATENDIDO: 'estado-atendido',
            };
            return { texto: u, clase: mapa[u] || 'estado-otro' };
        },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  4. CLASIFICADOR — búsqueda O(K) donde K = keywords totales  ║
    // ║  Usa el KEYWORD_MAP para match rápido por inclusión.          ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function clasificar(texto) {
        if (!texto) return null;
        const lower = texto.toLowerCase().trim();
        // Iterar categorías en orden (prioridad) y buscar inclusión
        for (const cat of CATEGORIAS) {
            for (const kw of cat.keywords) {
                if (lower.includes(kw)) return cat;
            }
        }
        return null;
    }

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  5. MÓDULO: COLOREO DE TABLA                                  ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const Coloreo = {
        _cssInjected: false,

        inyectarCSS() {
            if (this._cssInjected || document.getElementById('seg-coloreo-css')) return;
            const style = document.createElement('style');
            style.id = 'seg-coloreo-css';
            style.textContent = `
                table tbody tr { transition: background-color .2s ease; position: relative; }
                table tbody tr:hover { filter: brightness(1.12) !important; }
                table tbody tr[data-cat] { font-weight: 500; }
                table tbody tr[data-cat]:hover .cat-tip { display: block; }
                .cat-tip {
                    display: none; position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
                    background: rgba(0,0,0,.9); color: #fff; padding: 4px 10px; border-radius: 4px;
                    font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
                    pointer-events: none; z-index: 1000; white-space: nowrap;
                    box-shadow: 0 2px 8px rgba(0,0,0,.3);
                }
                ${CATEGORIAS.map(c => `
                table tbody tr[data-cat="${c.id}"] {
                    background-color: ${c.color} !important;
                    border-left: 4px solid ${c.border};
                    position: relative;
                }`).join('\n')}
            `;
            document.head.appendChild(style);
            this._cssInjected = true;
        },

        procesarFila(fila) {
            if (fila.dataset.segProcesada) return;
            fila.dataset.segProcesada = '1';

            const celdas = fila.querySelectorAll('td');
            for (const celda of celdas) {
                const cat = clasificar(celda.textContent);
                if (cat) {
                    fila.setAttribute('data-cat', cat.id);
                    if (!fila.querySelector('.cat-tip')) {
                        const tip = document.createElement('span');
                        tip.className = 'cat-tip';
                        tip.textContent = cat.nombre;
                        fila.appendChild(tip);
                    }
                    return;
                }
            }
        },

        procesarTabla() {
            const filas = document.querySelectorAll('table tbody tr:not([data-seg-procesada])');
            filas.forEach(f => this.procesarFila(f));
        },

        limpiarYReprocesar() {
            document.querySelectorAll('tr[data-seg-procesada]').forEach(tr => {
                delete tr.dataset.segProcesada;
                tr.removeAttribute('data-cat');
                const tip = tr.querySelector('.cat-tip');
                if (tip) tip.remove();
            });
            this.procesarTabla();
        },

        init() {
            this.inyectarCSS();
            this.procesarTabla();
        },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  6. MÓDULO: PANEL LATERAL ÚLTIMA HORA                         ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const Panel = {
        procedimientos: new Map(),
        cargando: false,
        visible: !/\/incidents\/\d/.test(location.pathname),
        arcgisWindow: null,

        // ── Storage ──
        _loadPinnedIds() {
            try { return new Set(JSON.parse(localStorage.getItem(CONFIG.STORAGE_PINNED_IDS) || '[]')); }
            catch { return new Set(); }
        },
        _savePinnedIds(s) {
            try { localStorage.setItem(CONFIG.STORAGE_PINNED_IDS, JSON.stringify([...s])); } catch {}
        },
        _loadPinnedData() {
            try {
                const raw = JSON.parse(localStorage.getItem(CONFIG.STORAGE_PINNED_DATA) || '{}');
                const m = new Map();
                for (const [id, p] of Object.entries(raw)) {
                    p.fecha = new Date(p.fecha);
                    p.pinned = true;
                    m.set(id, p);
                }
                return m;
            } catch { return new Map(); }
        },
        _savePinnedData() {
            try {
                const obj = {};
                for (const [id, p] of this.procedimientos) {
                    if (p.pinned) obj[id] = { ...p, fecha: p.fecha.toISOString() };
                }
                localStorage.setItem(CONFIG.STORAGE_PINNED_DATA, JSON.stringify(obj));
            } catch {}
        },

        togglePin(id) {
            const pins = this._loadPinnedIds();
            pins.has(id) ? pins.delete(id) : pins.add(id);
            this._savePinnedIds(pins);
            const proc = this.procedimientos.get(id);
            if (proc) proc.pinned = pins.has(id);
            this._savePinnedData();
            this.render();
        },

        // ── Ignorados ──
        _loadIgnoredIds() {
            try { return new Set(JSON.parse(localStorage.getItem(CONFIG.STORAGE_IGNORED_IDS) || '[]')); }
            catch { return new Set(); }
        },
        _saveIgnoredIds(s) {
            try { localStorage.setItem(CONFIG.STORAGE_IGNORED_IDS, JSON.stringify([...s])); } catch {}
        },

        toggleIgnore(id) {
            const ignored = this._loadIgnoredIds();
            ignored.has(id) ? ignored.delete(id) : ignored.add(id);
            this._saveIgnoredIds(ignored);
            const proc = this.procedimientos.get(id);
            if (proc) proc.ignored = ignored.has(id);
            this.render();
        },

        // ── ArcGIS ──
        abrirEnArcGIS(dir, procId) {
            if (!dir) return;
            const q = Utils.prepararDireccion(dir);
            const url = `${CONFIG.ARCGIS_VISOR_URL}&find=${encodeURIComponent(q)}`;
            if (this.arcgisWindow && !this.arcgisWindow.closed) {
                this.arcgisWindow.location.href = url;
            } else {
                this.arcgisWindow = window.open(url, 'arcgis_visor');
            }
            window.focus();
        },

        // ── Google Maps ──
        gmapsWindow: null,
        abrirEnGMaps(dir, procId) {
            if (!dir) return;
            const q = Utils.prepararDireccion(dir);
            const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
            if (this.gmapsWindow && !this.gmapsWindow.closed) {
                this.gmapsWindow.location.href = url;
            } else {
                this.gmapsWindow = window.open(url, 'gmaps_visor');
            }
            window.focus();
        },

        // ── Scraping ──
        _extraerDeHTML(html) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const filas = doc.querySelectorAll('table tbody tr');
            const resultados = [];
            let hayRecientes = false;

            for (const fila of filas) {
                const celdas = fila.querySelectorAll('td');
                if (celdas.length < 7) continue;

                const fechaTexto = celdas[CONFIG.COL_FECHA]?.textContent?.trim();
                const fecha = Utils.parsearFecha(fechaTexto);
                if (!fecha) continue;

                const tipo = celdas[CONFIG.COL_PROCEDIMIENTO]?.textContent?.trim() || '';
                const id = celdas[CONFIG.COL_ID]?.textContent?.trim() || '';
                const origen = celdas[CONFIG.COL_ORIGEN]?.textContent?.trim() || '';
                const desc = celdas[CONFIG.COL_DESCRIPCION]?.textContent?.trim() || '';
                const dir = celdas[CONFIG.COL_DIRECCION]?.textContent?.trim() || '';

                // Link "Más Información"
                let link = '';
                const linkEl = fila.querySelector('a[title="Más Información"], a[title="MÃ¡s InformaciÃ³n"]');
                if (linkEl) {
                    link = linkEl.getAttribute('href') || '';
                } else {
                    for (const a of fila.querySelectorAll('a[href*="/incidents/"]')) {
                        const href = a.getAttribute('href') || '';
                        if (!href.includes('/refresh') && !href.includes('.pdf')) { link = href; break; }
                    }
                }

                // Estado (último badge)
                let estado = '';
                const badges = fila.querySelectorAll('.badge');
                if (badges.length) estado = badges[badges.length - 1].textContent.trim();

                if (Utils.dentroDeVentana(fecha)) {
                    hayRecientes = true;
                    resultados.push({ fecha, fechaTexto, tipo, id, origen, desc, dir, link, estado });
                }
            }
            return { resultados, seguirBuscando: hayRecientes && filas.length > 0 };
        },

        async scrapear() {
            if (this.cargando) return;
            this.cargando = true;
            this._indicador('Actualizando...');

            const pins = this._loadPinnedIds();
            const ignored = this._loadIgnoredIds();
            const nuevos = new Map();

            for (let pag = 1; pag <= CONFIG.MAX_PAGINAS; pag++) {
                try {
                    const r = await fetch(`/incidents?_=${Date.now()}&page=${pag}`, {
                        headers: { Accept: 'text/html, application/xhtml+xml', 'Turbolinks-Referrer': location.href },
                        credentials: 'same-origin',
                    });
                    if (!r.ok) break;
                    const { resultados, seguirBuscando } = this._extraerDeHTML(await r.text());
                    for (const proc of resultados) {
                        if (!nuevos.has(proc.id)) {
                            proc.pinned = pins.has(proc.id);
                            proc.ignored = ignored.has(proc.id);
                            nuevos.set(proc.id, proc);
                        }
                    }
                    this._indicador(`Escaneando pág. ${pag}...`);
                    if (!seguirBuscando) break;
                    if (pag < CONFIG.MAX_PAGINAS) await new Promise(r => setTimeout(r, CONFIG.DELAY_ENTRE_PAGINAS));
                } catch (err) {
                    console.error(`❌ Error pág ${pag}:`, err);
                    break;
                }
            }

            // Restaurar fijados persistentes expirados
            const pinnedData = this._loadPinnedData();
            for (const [id, proc] of pinnedData) {
                if (pins.has(id) && !nuevos.has(id)) nuevos.set(id, proc);
            }
            for (const [id, proc] of nuevos) {
                if (pins.has(id)) proc.pinned = true;
                if (ignored.has(id)) proc.ignored = true;
            }

            this.procedimientos = nuevos;
            this.cargando = false;
            this._savePinnedData();
            this.render();
            this._programarSiguienteScrape();
        },

        // ── Limpieza ──
        limpiarExpirados() {
            let changed = false;
            for (const [id, proc] of this.procedimientos) {
                if (!proc.pinned && !Utils.dentroDeVentana(proc.fecha)) {
                    this.procedimientos.delete(id);
                    changed = true;
                }
            }
            if (changed) this.render();
            this._actualizarTiempos();
        },

        _actualizarTiempos() {
            for (const [id, proc] of this.procedimientos) {
                const el = document.getElementById(`seg-t-${CSS.escape(id)}`);
                if (el) {
                    el.textContent = Utils.tiempoRelativo(proc.fecha);
                    el.style.color = Utils.colorTiempo(proc.fecha);
                }
            }
        },

        _indicador(txt) {
            const el = document.getElementById('seg-indicador');
            if (el) el.textContent = txt;
        },

        // ── CSS ──
        _cssInjected: false,
        inyectarCSS() {
            if (this._cssInjected || document.getElementById('seg-panel-css')) return;
            const W = CONFIG.PANEL_WIDTH;
            const style = document.createElement('style');
            style.id = 'seg-panel-css';
            style.textContent = `
                #seg-panel {
                    position:fixed;top:0;right:0;width:${W}px;max-height:100vh;
                    background:#fff;border-left:3px solid #2563eb;
                    box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:99999;
                    display:flex;flex-direction:column;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    font-size:13px;transition:transform .3s ease;
                }
                #seg-panel.oculto{transform:translateX(100%)}
                #seg-header{background:linear-gradient(135deg,#1e40af,#2563eb);color:#fff;padding:10px 14px;flex-shrink:0}
                #seg-header-top{display:flex;align-items:center;justify-content:space-between}
                #seg-header h3{margin:0;font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px}
                #seg-cnt{background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700}
                #seg-estados{display:flex;gap:10px;margin-top:5px;font-size:11px;opacity:.85}
                #seg-estados span{display:flex;align-items:center;gap:4px}
                .seg-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
                .seg-dot.pendiente{background:#fca5a5}.seg-dot.cerrado{background:#93c5fd}
                #seg-indicador{font-size:10px;opacity:.7;font-style:italic;margin-top:3px}
                #seg-acciones{display:flex;gap:6px}
                #seg-acciones button{background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;transition:background .2s}
                #seg-acciones button:hover{background:rgba(255,255,255,.35)}
                #seg-body{overflow-y:auto;flex:1}
                .seg-sec{padding:6px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:#f1f5f9;color:#475569;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:1}
                .seg-row{display:flex;align-items:flex-start;padding:9px 12px;border-bottom:1px solid #f1f5f9;gap:8px;transition:background .2s;max-height:350px}
                .seg-row:hover{background:#f8fafc}
                .seg-row.pinned{background:#fffbeb;border-left:3px solid #f59e0b}
                .seg-row.ignored{opacity:.45;order:999}
                .seg-row.ignored:hover{opacity:.7}
                .seg-side{display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:center}
                .seg-pin{cursor:pointer;font-size:16px;padding:2px;border-radius:3px;transition:transform .2s;user-select:none}
                .seg-pin:hover{transform:scale(1.3)}
                .seg-pin.on{color:#f59e0b}.seg-pin.off{color:#cbd5e1}
                .seg-ignore{cursor:pointer;font-size:13px;padding:1px;border-radius:3px;transition:transform .2s,opacity .2s;user-select:none;opacity:.4}
                .seg-ignore:hover{transform:scale(1.2);opacity:.8}
                .seg-ignore.on{opacity:.9;color:#94a3b8}
                .seg-content{flex:1;min-width:0}
                .seg-tipo{font-weight:600;color:#1e293b;font-size:12.5px;line-height:1.3}
                .seg-estado{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.3px;margin-left:6px;vertical-align:middle}
                .estado-pendiente{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5}
                .estado-cerrado{background:#eff6ff;color:#2563eb;border:1px solid #93c5fd}
                .estado-asignado{background:#fefce8;color:#ca8a04;border:1px solid #fde047}
                .estado-desplazamiento{background:#f0fdf4;color:#16a34a;border:1px solid #86efac}
                .estado-atencion{background:#faf5ff;color:#9333ea;border:1px solid #c084fc}
                .estado-atendido{background:#f0fdfa;color:#0d9488;border:1px solid #5eead4}
                .estado-otro{background:#f8fafc;color:#64748b;border:1px solid #cbd5e1}
                .seg-meta{display:flex;gap:8px;margin-top:3px;font-size:11px;color:#64748b;flex-wrap:wrap}
                .seg-meta span{display:flex;align-items:center;gap:2px}
                .seg-id-copy{color:#2563eb;text-decoration:none;cursor:pointer;border-bottom:1px dashed #93c5fd;transition:color .2s}
                .seg-id-copy:hover{color:#1d4ed8}
                .seg-id-copy.copied{color:#16a34a;border-bottom-color:#86efac}
                .seg-desc{margin-top:4px;font-size:12.5px;color:#475569;line-height:1.45;max-height:80px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:5px 7px;border-radius:3px;border-left:2px solid #e2e8f0}
                .seg-desc::-webkit-scrollbar{width:4px}.seg-desc::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:2px}
                .seg-dir{margin-top:3px;font-size:11px;color:#334155;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
                .seg-dir-text{font-weight:500}
                .seg-btn-gis{display:inline-flex;align-items:center;gap:2px;background:#10b981;color:#fff;border:none;padding:2px 7px;border-radius:3px;font-size:10px;cursor:pointer;font-weight:600;transition:background .2s;white-space:nowrap}
                .seg-btn-gis:hover{background:#059669}
                .seg-btn-gmaps{display:inline-flex;align-items:center;gap:2px;background:#4285f4;color:#fff;border:none;padding:2px 7px;border-radius:3px;font-size:10px;cursor:pointer;font-weight:600;transition:background .2s;white-space:nowrap}
                .seg-btn-gmaps:hover{background:#3367d6}
                .seg-cat-bar{width:4px;border-radius:2px;flex-shrink:0;align-self:stretch;min-height:20px}
                .seg-toolbar{display:flex;gap:6px;margin-top:5px;align-items:center;padding-top:4px;border-top:1px solid rgba(0,0,0,.06)}
                .seg-time{font-size:11px;font-weight:700;white-space:nowrap;flex-shrink:0;text-align:right;min-width:70px}
                .seg-link{color:#2563eb;text-decoration:none;font-size:11px}
                .seg-link:hover{text-decoration:underline}
                .seg-empty{padding:30px;text-align:center;color:#94a3b8;font-style:italic;font-size:13px}
                #seg-toggle{position:fixed;top:50%;right:0;transform:translateY(-50%);background:linear-gradient(135deg,#1e40af,#2563eb);color:#fff;border:none;border-radius:8px 0 0 8px;padding:12px 6px;cursor:pointer;font-size:14px;z-index:100000;box-shadow:-2px 2px 8px rgba(0,0,0,.2);writing-mode:vertical-lr;text-orientation:mixed;letter-spacing:1px;font-weight:700;transition:right .3s ease}
                #seg-toggle:hover{background:linear-gradient(135deg,#1e3a8a,#1d4ed8)}
                #seg-toggle.open{right:${W}px}
                #seg-badge{display:inline-block;background:#ef4444;color:#fff;border-radius:50%;width:20px;height:20px;line-height:20px;text-align:center;font-size:10px;writing-mode:horizontal-tb;margin-bottom:4px}
            `;
            document.head.appendChild(style);
            this._cssInjected = true;
        },

        // ── Renderizado ──
        _renderFila(proc) {
            const { texto: et, clase: ec } = Utils.clasificarEstado(proc.estado);
            const sid = Utils.escapeAttr(proc.id);
            const estadoHTML = et ? `<span class="seg-estado ${ec}">${et}</span>` : '';
            const descHTML = proc.desc ? `<div class="seg-desc">${Utils.escapeHTML(proc.desc.substring(0, 300))}</div>` : '';
            const cat = clasificar(proc.tipo);
            const estadoUpper = (proc.estado || '').toUpperCase().trim();
            const catBarHTML = estadoUpper === 'PENDIENTE'
                ? `<div class="seg-cat-bar" style="background:#dc2626" title="PENDIENTE"></div>`
                : `<div class="seg-cat-bar" style="background:transparent" title="${estadoUpper}"></div>`;
            const dirHTML = proc.dir ? `<div class="seg-dir">📍 <span class="seg-dir-text">${Utils.escapeHTML(proc.dir)}</span></div>` : '';

            let rowClass = 'seg-row';
            if (proc.pinned) rowClass += ' pinned';
            if (proc.ignored) rowClass += ' ignored';
            const rowBg = cat ? `background:${cat.color};` : '';

            return `
                <div class="${rowClass}" id="seg-r-${sid}" style="${rowBg}">
                    ${catBarHTML}
                    <div class="seg-side">
                        <span class="seg-pin ${proc.pinned ? 'on' : 'off'}" data-id="${sid}" title="${proc.pinned ? 'Desfijar' : 'Fijar'}">${proc.pinned ? '📌' : '📍'}</span>
                        <span class="seg-ignore ${proc.ignored ? 'on' : ''}" data-id="${sid}" title="${proc.ignored ? 'Mostrar' : 'Ignorar'}">👁${proc.ignored ? '‍🗨' : ''}</span>
                    </div>
                    <div class="seg-content">
                        <div class="seg-tipo">${Utils.escapeHTML(proc.tipo)} ${estadoHTML}</div>
                        <div class="seg-meta">
                            <span><a href="#" class="seg-id-copy" data-rawid="${Utils.escapeAttr(proc.id)}" title="Copiar ID">🆔 ${Utils.escapeHTML(Utils.formatearId(proc.id))}</a></span>
                            <span>📡 ${Utils.escapeHTML(proc.origen || '')}</span>
                        </div>
                        ${dirHTML}${descHTML}
                        <div class="seg-toolbar">
                            ${proc.link ? `<a class="seg-link" href="${Utils.escapeAttr(proc.link)}" target="_blank">Ver detalle →</a>` : ''}
                            ${proc.dir ? `<button class="seg-btn-gis" data-dir="${Utils.escapeAttr(proc.dir)}" data-pid="${sid}" title="Buscar en ArcGIS">🗺️ ArcGIS</button>
                            <button class="seg-btn-gmaps" data-dir="${Utils.escapeAttr(proc.dir)}" data-pid="${sid}" title="Buscar en Google Maps">📍 GMaps</button>` : ''}
                        </div>
                    </div>
                    <div class="seg-time" id="seg-t-${sid}">${Utils.tiempoRelativo(proc.fecha)}</div>
                </div>`;
        },

        render() {
            if (!document.getElementById('seg-panel')) this._crearPanel();
            const body = document.getElementById('seg-body');
            if (!body) return;

            const todos = [...this.procedimientos.values()];
            const fijados = todos.filter(p => p.pinned).sort((a, b) => {
                if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
                return b.fecha - a.fecha;
            });
            const normales = todos.filter(p => !p.pinned).sort((a, b) => {
                if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
                return b.fecha - a.fecha;
            });

            let html = '';
            if (fijados.length) {
                html += `<div class="seg-sec">📌 Fijados (${fijados.length})</div>`;
                html += fijados.map(p => this._renderFila(p)).join('');
            }
            if (normales.length) {
                html += `<div class="seg-sec">🕐 Última hora (${normales.length})</div>`;
                html += normales.map(p => this._renderFila(p)).join('');
            }
            if (!todos.length) html = '<div class="seg-empty">Sin procedimientos en la última hora</div>';

            body.innerHTML = html;

            // Contadores
            const cnt = document.getElementById('seg-cnt');
            if (cnt) cnt.textContent = todos.length;

            const recientes = todos.filter(p => Utils.dentroDeVentana(p.fecha));
            const nPend = recientes.filter(p => p.estado?.toUpperCase().trim() === 'PENDIENTE').length;
            const nCerr = recientes.filter(p => p.estado?.toUpperCase().trim() === 'CERRADO').length;
            const elP = document.getElementById('seg-cnt-pend');
            const elC = document.getElementById('seg-cnt-cerr');
            if (elP) elP.textContent = nPend;
            if (elC) elC.textContent = nCerr;

            // Badge
            const badge = document.getElementById('seg-badge');
            if (badge) { badge.textContent = todos.length; badge.style.display = todos.length ? 'inline-block' : 'none'; }

            // Bind events
            body.querySelectorAll('.seg-pin').forEach(el =>
                el.addEventListener('click', () => this.togglePin(el.dataset.id)));
            body.querySelectorAll('.seg-ignore').forEach(el =>
                el.addEventListener('click', () => this.toggleIgnore(el.dataset.id)));
            body.querySelectorAll('.seg-btn-gis').forEach(el =>
                el.addEventListener('click', () => this.abrirEnArcGIS(el.dataset.dir, el.dataset.pid)));
            body.querySelectorAll('.seg-btn-gmaps').forEach(el =>
                el.addEventListener('click', () => this.abrirEnGMaps(el.dataset.dir, el.dataset.pid)));
            body.querySelectorAll('.seg-id-copy').forEach(el =>
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    const rawId = el.dataset.rawid.replace(/\s/g, '');
                    navigator.clipboard.writeText(rawId).then(() => {
                        el.classList.add('copied');
                        const orig = el.textContent;
                        el.textContent = '✅ Copiado';
                        setTimeout(() => { el.textContent = orig; el.classList.remove('copied'); }, 1200);
                    }).catch(() => {});
                }));

            this._actualizarTiempos();
        },

        _crearPanel() {
            const panel = document.createElement('div');
            panel.id = 'seg-panel';
            if (!this.visible) panel.classList.add('oculto');
            panel.innerHTML = `
                <div id="seg-header">
                    <div id="seg-header-top">
                        <h3>🕐 Última Hora <span id="seg-cnt">0</span></h3>
                        <div id="seg-acciones">
                            <button id="seg-btn-refresh" title="Actualizar ahora">🔄</button>
                            <button id="seg-btn-close" title="Cerrar panel">✕</button>
                        </div>
                    </div>
                    <div id="seg-estados">
                        <span><span class="seg-dot pendiente"></span> Pendientes: <b id="seg-cnt-pend">0</b></span>
                        <span><span class="seg-dot cerrado"></span> Cerrados: <b id="seg-cnt-cerr">0</b></span>
                    </div>
                    <div id="seg-indicador">Iniciando...</div>
                </div>
                <div id="seg-body"><div class="seg-empty">Cargando procedimientos...</div></div>`;
            document.body.appendChild(panel);

            const toggle = document.createElement('button');
            toggle.id = 'seg-toggle';
            toggle.innerHTML = `<span id="seg-badge" style="display:none">0</span> 🕐 ÚLTIMA HORA`;
            toggle.classList.toggle('open', this.visible);
            document.body.appendChild(toggle);

            document.getElementById('seg-btn-close').addEventListener('click', () => {
                this.visible = false;
                panel.classList.add('oculto');
                toggle.classList.remove('open');
            });
            toggle.addEventListener('click', () => {
                this.visible = !this.visible;
                panel.classList.toggle('oculto', !this.visible);
                toggle.classList.toggle('open', this.visible);
            });
            document.getElementById('seg-btn-refresh').addEventListener('click', () => this.scrapear());
        },

        // ── Intervalo dinámico según pendientes ──
        _scrapeTimer: null,
        _calcularIntervalo() {
            const pendientes = [...this.procedimientos.values()]
                .filter(p => p.estado?.toUpperCase().trim() === 'PENDIENTE').length;
            if (pendientes >= 20) return 15000;
            if (pendientes >= 10) return 30000;
            return 45000;
        },
        _programarSiguienteScrape() {
            if (this._scrapeTimer) clearTimeout(this._scrapeTimer);
            const ms = this._calcularIntervalo();
            this._scrapeTimer = setTimeout(() => this.scrapear(), ms);
        },

        init() {
            this.inyectarCSS();
            this._crearPanel();
            this.scrapear();
            setInterval(() => this.limpiarExpirados(), CONFIG.INTERVALO_LIMPIEZA);
        },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  7. MÓDULO: DETECCIÓN DE CAMBIOS (unificado)                  ║
    // ║  Un solo sistema para polling, AJAX, URL, visibilidad.        ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const Watcher = {
        _lastUrl: location.href,

        // Callback cuando hay filas nuevas en la tabla
        onNuevasFilas() {
            Coloreo.procesarTabla();
        },

        // Callback cuando la página cambia completamente (paginación SPA)
        onCambioPagina() {
            Coloreo.limpiarYReprocesar();
        },

        iniciarPolling() {
            setInterval(() => {
                if (document.querySelector('table tbody tr:not([data-seg-procesada])')) {
                    this.onNuevasFilas();
                }
            }, CONFIG.POLLING_MS);
        },

        interceptarAJAX() {
            const self = this;
            const origFetch = window.fetch;
            window.fetch = function (...args) {
                return origFetch.apply(this, args).then(resp => {
                    setTimeout(() => self.onNuevasFilas(), 300);
                    setTimeout(() => self.onNuevasFilas(), 800);
                    return resp;
                });
            };

            const origXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (...args) {
                this.addEventListener('load', () => {
                    setTimeout(() => self.onNuevasFilas(), 300);
                    setTimeout(() => self.onNuevasFilas(), 800);
                });
                return origXHROpen.apply(this, args);
            };
        },

        monitorearURL() {
            const self = this;
            const check = () => {
                if (location.href !== self._lastUrl) {
                    self._lastUrl = location.href;
                    setTimeout(() => self.onCambioPagina(), 500);
                    setTimeout(() => self.onNuevasFilas(), 1000);
                }
            };

            const origPush = history.pushState;
            const origReplace = history.replaceState;
            history.pushState = function (...a) { origPush.apply(this, a); check(); };
            history.replaceState = function (...a) { origReplace.apply(this, a); check(); };
            window.addEventListener('popstate', check);
            window.addEventListener('hashchange', check);
        },

        monitorearVisibilidad() {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    Coloreo.inyectarCSS();
                    Panel.inyectarCSS();
                    setTimeout(() => Coloreo.limpiarYReprocesar(), 200);
                }
            });

            window.addEventListener('focus', () => {
                if (document.querySelector('table tbody tr:not([data-seg-procesada])')) {
                    this.onNuevasFilas();
                }
            });
        },

        interceptarPaginacion() {
            document.addEventListener('click', (e) => {
                if (e.target.closest('a[href*="page"], .pagination a, [class*="page"]')) {
                    setTimeout(() => this.onNuevasFilas(), 300);
                    setTimeout(() => this.onNuevasFilas(), 600);
                    setTimeout(() => this.onCambioPagina(), 1200);
                }
            }, true);
        },

        init() {
            this.iniciarPolling();
            this.interceptarAJAX();
            this.monitorearURL();
            this.monitorearVisibilidad();
            this.interceptarPaginacion();
        },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  8. MÓDULO: PANEL DE MAPA                                     ║
    // ║  En /incident_maps muestra lista de procedimientos del mapa.  ║
    // ║  Panel cerrado al cargar. Al abrir, fetch progresivo.         ║
    // ║  Click en fila → toggle InfoWindow del marcador.              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    const MapPanel = {
        _marcadores: [],       // datos crudos del JSON de ModelMap
        _procedimientos: [],   // datos enriquecidos tras fetch
        _cargado: false,
        _cargando: false,
        _panelCreado: false,
        _activeMarkerIdx: null, // índice del marcador con InfoWindow abierta
        _arcgisWin: null,
        _gmapsWin: null,
        visible: false,

        esMapPage() {
            return location.pathname.startsWith('/incident_maps');
        },

        // ── Detectar si la página tiene filtro aplicado ──
        _tieneFiltro() {
            return location.search.includes('incident_report') || location.search.includes('date_range');
        },

        // ── Mostrar confirmación cuando no hay filtro ──
        _mostrarConfirmacion() {
            const body = document.getElementById('seg-map-body');
            if (!body) return;
            body.innerHTML = `
                <div style="padding:20px;text-align:center">
                    <div style="font-size:28px;margin-bottom:10px">⚠️</div>
                    <div style="font-weight:600;color:#1e293b;margin-bottom:8px">Sin filtro detectado</div>
                    <div style="font-size:12px;color:#64748b;margin-bottom:16px;line-height:1.5">
                        La página del mapa no tiene filtro aplicado.<br>
                        Cargar todos los procedimientos puede ser lento.
                    </div>
                    <button id="seg-map-btn-confirm" style="background:#059669;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;transition:background .2s">
                        Cargar de todas formas
                    </button>
                </div>`;
            document.getElementById('seg-map-btn-confirm').addEventListener('click', () => {
                this._cargarProcedimientos();
            });
        },

        // ── Inicio de carga con verificación de filtro ──
        _iniciarCarga() {
            if (this._cargado || this._cargando) return;
            if (this._tieneFiltro()) {
                this._cargarProcedimientos();
            } else {
                this._mostrarConfirmacion();
            }
        },

        // ── Parsear JSON de ModelMap desde el script tag ──
        _parsearMarcadores() {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const m = s.textContent.match(/new\s+ModelMap\s*\(\s*'(.*?)'\s*\)/s);
                if (m) {
                    try {
                        // El JSON viene con \" escapado dentro de comillas simples
                        const jsonStr = m[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
                        this._marcadores = JSON.parse(jsonStr);
                        return true;
                    } catch (e) {
                        console.error('❌ Error parseando ModelMap JSON:', e);
                    }
                }
            }
            // Fallback: intentar capturar con regex más permisivo
            for (const s of scripts) {
                const m = s.textContent.match(/new\s+ModelMap\s*\(\s*'(\[[\s\S]*?\])'\s*\)/);
                if (m) {
                    try {
                        const jsonStr = m[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
                        this._marcadores = JSON.parse(jsonStr);
                        return true;
                    } catch (e) {
                        console.error('❌ Error parseando ModelMap JSON (fallback):', e);
                    }
                }
            }
            return false;
        },

        // ── Acceso seguro a mmap (variable global de la página) ──
        _getMmap() {
            return window.mmap || (typeof unsafeWindow !== 'undefined' ? unsafeWindow.mmap : null);
        },

        // ── Abrir InfoWindow directamente via fetch de url_info ──
        async _abrirInfoWindow(proc) {
            const marcador = this._marcadores.find(m => m.id === proc.mapId);
            if (!marcador) return false;
            try {
                const r = await fetch(marcador.url_info, { credentials: 'same-origin' });
                if (!r.ok) return false;
                const html = await r.text();
                const mm = this._getMmap();
                if (!mm || !mm.map) return false;
                const latLng = new google.maps.LatLng(parseFloat(proc.lat), parseFloat(proc.lng));

                // polyinfo puede no existir aún — crear si es necesario
                if (!mm.polyinfo) {
                    mm.polyinfo = new google.maps.InfoWindow();
                }
                // Desactivar auto-pan de Google Maps para evitar doble movimiento
                mm.polyinfo.setOptions({ disableAutoPan: true });
                mm.polyinfo.setContent(html);
                mm.polyinfo.setPosition(latLng);
                mm.polyinfo.open(mm.map);

                // Un solo movimiento: punto centrado con offset para panel + popup
                const bounds = mm.map.getBounds();
                if (bounds) {
                    const ne = bounds.getNorthEast();
                    const sw = bounds.getSouthWest();
                    const mapDiv = mm.map.getDiv();
                    const lngPerPx = (ne.lng() - sw.lng()) / mapDiv.offsetWidth;
                    const latPerPx = (ne.lat() - sw.lat()) / mapDiv.offsetHeight;
                    const offsetLng = this.visible ? lngPerPx * (CONFIG.PANEL_WIDTH / 2) : 0;
                    const offsetLat = latPerPx * -300;
                    const destino = new google.maps.LatLng(
                        latLng.lat() - offsetLat,
                        latLng.lng() + offsetLng
                    );
                    mm.map.panTo(destino);
                } else {
                    mm.map.panTo(latLng);
                }

                return true;
            } catch(e) { console.error('❌ _abrirInfoWindow error:', e); return false; }
        },

        // ── Cerrar InfoWindow abierta ──
        _cerrarInfoWindow() {
            // Cerrar via API
            const mm = this._getMmap();
            if (mm && mm.polyinfo) {
                try { mm.polyinfo.close(); } catch {}
            }
            // Fallback: cerrar via botón del DOM (cubre popups abiertos desde el mapa directamente)
            const closeBtn = document.querySelector('.gm-ui-hover-effect[title="Cerrar"], .gm-ui-hover-effect[aria-label="Cerrar"]');
            if (closeBtn) closeBtn.click();
        },

        // ── Toggle marcador desde fila del panel ──
        async _toggleMarker(idx) {
            const proc = this._procedimientos[idx];
            if (!proc) return;

            if (this._activeMarkerIdx === idx) {
                this._cerrarInfoWindow();
                this._activeMarkerIdx = null;
                this._updateActiveRow(null);
                return;
            }

            this._cerrarInfoWindow();
            await this._abrirInfoWindow(proc);
            this._activeMarkerIdx = idx;
            this._updateActiveRow(idx);
        },

        _updateActiveRow(activeIdx) {
            document.querySelectorAll('#seg-map-body .seg-row[data-map-idx]').forEach(row => {
                const rowIdx = parseInt(row.dataset.mapIdx, 10);
                row.classList.toggle('seg-row-active', rowIdx === activeIdx);
            });
        },

        // ── Extraer datos del HTML del popup (url_info) ──
        _parsearPopup(html) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const heading = doc.querySelector('.panel-heading');
            let tipo = '', estado = '';
            if (heading) {
                const badge = heading.querySelector('.badge');
                estado = badge ? badge.textContent.trim() : '';
                tipo = heading.textContent.replace(badge ? badge.textContent : '', '').replace('|', '').trim();
            }
            const ps = doc.querySelectorAll('.panel-body p');
            let id = '', fecha = '', dir = '', desc = '';
            for (const p of ps) {
                const strong = p.querySelector('strong');
                if (!strong) continue;
                const label = strong.textContent.trim().toLowerCase();
                const value = p.textContent.replace(strong.textContent, '').trim();
                if (label.includes('identificador')) id = value;
                else if (label.includes('fecha de recepción') || label.includes('fecha de recepcion')) fecha = value;
                else if (label.includes('fecha') && !fecha && value) fecha = value;
                else if (label.includes('dirección')) dir = value;
                else if (label.includes('descripción')) desc = value;
            }
            // Link "Ver Procedimiento"
            const linkEl = doc.querySelector('a[href*="/incidents/"]');
            const link = linkEl ? linkEl.getAttribute('href') : '';

            return { tipo, estado, id, fecha, dir, desc: desc.substring(0, 300), link };
        },

        // ── Fetch progresivo de url_info ──
        async _cargarProcedimientos() {
            if (this._cargando || this._cargado) return;
            this._cargando = true;

            if (!this._parsearMarcadores()) {
                this._indicador('❌ No se encontraron marcadores');
                this._cargando = false;
                return;
            }

            const total = this._marcadores.length;
            this._indicador(`Cargando 0/${total}...`);
            this._procedimientos = [];

            const BATCH = 3;     // requests en paralelo
            const DELAY = 200;   // ms entre lotes

            for (let i = 0; i < total; i += BATCH) {
                const lote = this._marcadores.slice(i, i + BATCH);
                const promesas = lote.map(async (m) => {
                    try {
                        const r = await fetch(m.url_info, { credentials: 'same-origin' });
                        if (!r.ok) return null;
                        const html = await r.text();
                        const datos = this._parsearPopup(html);
                        return { ...datos, lat: m.lat, lng: m.lng, color: m.color, mapId: m.id };
                    } catch { return null; }
                });
                const resultados = await Promise.all(promesas);
                for (const r of resultados) {
                    if (r) this._procedimientos.push(r);
                }
                this._indicador(`Cargando ${Math.min(i + BATCH, total)}/${total}...`);
                this._renderLista();
                if (i + BATCH < total) await new Promise(r => setTimeout(r, DELAY));
            }

            this._cargado = true;
            this._cargando = false;
            this._indicador(`${this._procedimientos.length} procedimientos`);
            this._renderLista();
        },

        _indicador(txt) {
            const el = document.getElementById('seg-map-indicador');
            if (el) el.textContent = txt;
        },

        // ── Renderizar fila ──
        _renderFila(proc, idx) {
            const cat = clasificar(proc.tipo);
            const estadoUpper = (proc.estado || '').toUpperCase().trim();
            const { texto: et, clase: ec } = Utils.clasificarEstado(proc.estado);
            const estadoHTML = et ? `<span class="seg-estado ${ec}">${et}</span>` : '';
            const rowBg = cat ? `background:${cat.color};` : '';
            const barHTML = estadoUpper === 'PENDIENTE'
                ? `<div class="seg-cat-bar" style="background:#dc2626" title="PENDIENTE"></div>`
                : `<div class="seg-cat-bar" style="background:transparent"></div>`;
            const sid = Utils.escapeAttr(proc.id);
            const dirHTML = proc.dir ? `
                <div class="seg-dir" style="font-size:12.5px;margin-top:4px">
                    📍 <span class="seg-dir-text" style="font-size:13px;font-weight:600">${Utils.escapeHTML(proc.dir)}</span>
                </div>` : '';
            const isActive = this._activeMarkerIdx === idx;
            const isIgnored = proc._ignored;

            return `<div class="seg-row${isActive ? ' seg-row-active' : ''}${isIgnored ? ' ignored' : ''}" data-map-idx="${idx}" style="${rowBg}cursor:pointer;">
                ${barHTML}
                <div class="seg-content" style="flex:1;min-width:0">
                    <div class="seg-tipo">${Utils.escapeHTML(proc.tipo)} ${estadoHTML}</div>
                    <div class="seg-meta">
                        <span><a href="#" class="seg-id-copy seg-map-id-copy" data-rawid="${sid}" title="Copiar ID" onclick="event.stopPropagation()">🆔 ${Utils.escapeHTML(Utils.formatearId(proc.id))}</a></span>
                        <span>📅 ${Utils.escapeHTML(proc.fecha || '')}</span>
                    </div>
                    ${dirHTML}
                    <div class="seg-toolbar" onclick="event.stopPropagation()">
                        ${proc.link ? `<a class="seg-link" href="${Utils.escapeAttr(proc.link)}" target="_blank">Ver detalle →</a>` : ''}
                        ${proc.dir ? `<button class="seg-btn-gis seg-map-gis" data-dir="${Utils.escapeAttr(proc.dir)}" title="ArcGIS">🗺️ ArcGIS</button>
                        <button class="seg-btn-gmaps seg-map-gmaps" data-dir="${Utils.escapeAttr(proc.dir)}" title="GMaps">📍 GMaps</button>` : ''}
                        <span class="seg-map-ignore" data-map-idx="${idx}" title="${isIgnored ? 'Mostrar' : 'Ignorar'}" style="margin-left:auto;cursor:pointer;opacity:${isIgnored ? '.9' : '.4'};font-size:13px">👁${isIgnored ? '‍🗨' : ''}</span>
                    </div>
                </div>
            </div>`;
        },

        _renderLista() {
            const body = document.getElementById('seg-map-body');
            if (!body) return;

            if (!this._procedimientos.length) {
                body.innerHTML = '<div class="seg-empty">Sin procedimientos</div>';
                return;
            }

            // Separar: pendientes, otros, ignorados
            const indexed = this._procedimientos.map((p, i) => ({ p, i }));
            const ignorados = indexed.filter(x => x.p._ignored);
            const visibles = indexed.filter(x => !x.p._ignored);
            const pendientes = visibles.filter(x => x.p.estado?.toUpperCase().trim() === 'PENDIENTE');
            const otros = visibles.filter(x => x.p.estado?.toUpperCase().trim() !== 'PENDIENTE');

            let html = '';
            if (pendientes.length) {
                html += `<div class="seg-sec">🔴 Pendientes (${pendientes.length})</div>`;
                html += pendientes.map(x => this._renderFila(x.p, x.i)).join('');
            }
            if (otros.length) {
                html += `<div class="seg-sec">📋 Otros (${otros.length})</div>`;
                html += otros.map(x => this._renderFila(x.p, x.i)).join('');
            }
            if (ignorados.length) {
                html += `<div class="seg-sec">👁 Ignorados (${ignorados.length})</div>`;
                html += ignorados.map(x => this._renderFila(x.p, x.i)).join('');
            }

            body.innerHTML = html;

            // Actualizar contador
            const cnt = document.getElementById('seg-map-cnt');
            if (cnt) cnt.textContent = ignorados.length ? `${visibles.length}/${this._procedimientos.length}` : this._procedimientos.length;

            // Bind clicks — filas
            body.querySelectorAll('.seg-row[data-map-idx]').forEach(row => {
                row.addEventListener('click', () => {
                    const idx = parseInt(row.dataset.mapIdx, 10);
                    this._toggleMarker(idx);
                });
            });
            // Bind — copiar ID
            body.querySelectorAll('.seg-map-id-copy').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    const rawId = el.dataset.rawid.replace(/\s/g, '');
                    navigator.clipboard.writeText(rawId).then(() => {
                        el.classList.add('copied');
                        const orig = el.textContent;
                        el.textContent = '✅ Copiado';
                        setTimeout(() => { el.textContent = orig; el.classList.remove('copied'); }, 1200);
                    }).catch(() => {});
                });
            });
            // Bind — ArcGIS (nueva pestaña)
            body.querySelectorAll('.seg-map-gis').forEach(el => {
                el.addEventListener('click', () => {
                    const q = Utils.prepararDireccion(el.dataset.dir);
                    const url = `${CONFIG.ARCGIS_VISOR_URL}&find=${encodeURIComponent(q)}`;
                    window.open(url, '_blank');
                });
            });
            // Bind — Google Maps (nueva pestaña)
            body.querySelectorAll('.seg-map-gmaps').forEach(el => {
                el.addEventListener('click', () => {
                    const q = Utils.prepararDireccion(el.dataset.dir);
                    const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
                    window.open(url, '_blank');
                });
            });
            // Bind — Ignorar
            body.querySelectorAll('.seg-map-ignore').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(el.dataset.mapIdx, 10);
                    const proc = this._procedimientos[idx];
                    if (proc) {
                        proc._ignored = !proc._ignored;
                        this._renderLista();
                    }
                });
            });
        },

        // ── CSS ──
        _cssInjected: false,
        inyectarCSS() {
            if (this._cssInjected || document.getElementById('seg-map-panel-css')) return;
            const W = CONFIG.PANEL_WIDTH;
            const style = document.createElement('style');
            style.id = 'seg-map-panel-css';
            style.textContent = `
                #seg-map-panel {
                    position:fixed;top:0;right:0;width:${W}px;max-height:100vh;
                    background:#fff;border-left:3px solid #059669;
                    box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:99999;
                    display:flex;flex-direction:column;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    font-size:13px;transition:transform .3s ease;
                }
                #seg-map-panel.oculto{transform:translateX(100%)}
                #seg-map-header{background:linear-gradient(135deg,#065f46,#059669);color:#fff;padding:10px 14px;flex-shrink:0}
                #seg-map-header-top{display:flex;align-items:center;justify-content:space-between}
                #seg-map-header h3{margin:0;font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px}
                #seg-map-cnt{background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700}
                #seg-map-indicador{font-size:10px;opacity:.7;font-style:italic;margin-top:3px}
                #seg-map-acciones{display:flex;gap:6px}
                #seg-map-acciones button{background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;transition:background .2s}
                #seg-map-acciones button:hover{background:rgba(255,255,255,.35)}
                #seg-map-body{overflow-y:auto;flex:1;background:#fff}
                .seg-row-active{outline:2px solid #059669;outline-offset:-2px;background:#ecfdf5 !important}
                #seg-map-toggle{position:fixed;top:50%;right:0;transform:translateY(-50%);background:linear-gradient(135deg,#065f46,#059669);color:#fff;border:none;border-radius:8px 0 0 8px;padding:12px 6px;cursor:pointer;font-size:14px;z-index:100000;box-shadow:-2px 2px 8px rgba(0,0,0,.2);writing-mode:vertical-lr;text-orientation:mixed;letter-spacing:1px;font-weight:700;transition:right .3s ease}
                #seg-map-toggle:hover{background:linear-gradient(135deg,#064e3b,#047857)}
                #seg-map-toggle.open{right:${W}px}
            `;
            document.head.appendChild(style);
            // Reusar CSS del panel de incidents para filas, estados, etc.
            Panel.inyectarCSS();
            this._cssInjected = true;
        },

        _crearPanel() {
            if (this._panelCreado) return;
            this._panelCreado = true;

            const panel = document.createElement('div');
            panel.id = 'seg-map-panel';
            panel.classList.add('oculto');
            panel.innerHTML = `
                <div id="seg-map-header">
                    <div id="seg-map-header-top">
                        <h3>🗺️ Procedimientos en Mapa <span id="seg-map-cnt">0</span></h3>
                        <div id="seg-map-acciones">
                            <button id="seg-map-btn-reload" title="Recargar lista">🔄</button>
                            <button id="seg-map-btn-close" title="Cerrar panel">✕</button>
                        </div>
                    </div>
                    <div id="seg-map-indicador">Click para cargar procedimientos</div>
                </div>
                <div id="seg-map-body"><div class="seg-empty">Abra el panel para cargar</div></div>`;
            document.body.appendChild(panel);

            const toggle = document.createElement('button');
            toggle.id = 'seg-map-toggle';
            toggle.textContent = '🗺️ MAPA';
            document.body.appendChild(toggle);

            // Toggle panel
            toggle.addEventListener('click', () => {
                this.visible = !this.visible;
                panel.classList.toggle('oculto', !this.visible);
                toggle.classList.toggle('open', this.visible);
                // Primera apertura → verificar filtro y cargar
                if (this.visible && !this._cargado && !this._cargando) {
                    this._iniciarCarga();
                }
            });

            document.getElementById('seg-map-btn-close').addEventListener('click', () => {
                this.visible = false;
                panel.classList.add('oculto');
                toggle.classList.remove('open');
            });

            // Recargar fuerza un re-fetch
            document.getElementById('seg-map-btn-reload').addEventListener('click', () => {
                this._cargado = false;
                this._cargando = false;
                this._procedimientos = [];
                this._activeMarkerIdx = null;
                this._cargarProcedimientos();
            });
        },

        init() {
            if (!this.esMapPage()) return;
            this.inyectarCSS();
            this._crearPanel();
            console.log('🗺️ MapPanel listo (panel cerrado, click para cargar)');
        },
    };

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║  9. INICIALIZACIÓN                                            ║
    // ╚═══════════════════════════════════════════════════════════════╝

    function init() {
        console.log('🎭 Máscara v3.0');

        const esMapPage = location.pathname.startsWith('/incident_maps');

        // Coloreo + Watcher + Panel solo en /incidents (sin #mapa-integrado)
        if (!esMapPage) {
            const esMapaIntegrado = location.hash === '#mapa-integrado';

            const esperarTabla = setInterval(() => {
                if (document.querySelector('table tbody')) {
                    clearInterval(esperarTabla);
                    Coloreo.init();
                    Watcher.init();
                    console.log('✅ Coloreo + Watcher activos');
                }
            }, 500);
            setTimeout(() => clearInterval(esperarTabla), 15000);

            if (!esMapaIntegrado) {
                Panel.init();
                console.log('✅ Panel Última Hora activo');
            } else {
                console.log('ℹ️ #mapa-integrado detectado — Panel Última Hora desactivado');
            }
        }

        // MapPanel solo en /incident_maps
        if (esMapPage) {
            MapPanel.init();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
