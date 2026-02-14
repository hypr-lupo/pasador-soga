// ==UserScript==
// @name         Pasador VSaaS - ArcGIS
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Navegación WAD (W/A/D) + Clipboard + Título + Ctrl+Q ArcGIS
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2026-2027 Leonardo Navarro
// @license      MIT
// @match        https://suite.vsaas.ai/*
// @match        https://suite-back.vsaas.ai/*
// @match        https://arcgismlc.lascondes.cl/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/hypr-lupo/pasador-soga/main/Pasador%20VSaaS%20-%20ArcGIS.user.js
// @downloadURL  https://raw.githubusercontent.com/hypr-lupo/pasador-soga/main/Pasador%20VSaaS%20-%20ArcGIS.user.js
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════
 * PASADOR - Puente VSaaS ↔ ArcGIS + QoL
 * Copyright (c) 2026-2027 Leonardo Navarro
 *
 * Licensed under MIT License
 *
 * Funcionalidades de calidad de vida instaladas, F5 en el VSaaS.
 *
 * INSTRUCCIONES para el pasador:
 * Verificar ArcGis logeado
 * Instalar Tampermonkey, otorgar Permitir secuencias en Administrar extensión, F5 en el VSaaS.
 * seleccionar alerta y presionar Ctrl-Q ;)
 *
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════
    // CONFIGURACIÓN
    // ═══════════════════════════════════════════════════

    const CONFIG = {
        ARCGIS_URL: 'https://arcgismlc.lascondes.cl/portal/apps/webappviewer/index.html?id=118513d990134fcbb9196ac7884cfb8c',
        FEATURESERVER_URL: 'https://arcgismlc.lascondes.cl/server/rest/services/Hosted/C%C3%A1maras_al_10_de_febrero_2026/FeatureServer/0/query',
        ZOOM_LEVEL: 18,
        COOLDOWN: 5000,
        EXPIRY: 120000,
        DEBUG: true
    };

    const CODIGO_RE = /\b([A-Z0-9]{2,10}-\d{1,3})\b/;

    const SITE = {
        isVSaaS: location.hostname.includes('vsaas.ai'),
        isArcGIS: location.hostname.includes('arcgismlc.lascondes.cl')
    };

    const log = CONFIG.DEBUG
        ? (...a) => console.log('[PASADOR]', ...a)
        : () => {};

    // ═══════════════════════════════════════════════════
    // UTILIDADES COMPARTIDAS
    // ═══════════════════════════════════════════════════

    function extraerCodigo(texto) {
        return texto?.match(CODIGO_RE)?.[1] ?? null;
    }

    function crearNotif(mensaje, error) {
        const div = document.createElement('div');
        div.innerHTML = `<div style="position:fixed;top:20px;right:20px;background:${error ? '#ff4444' : '#4CAF50'};color:#fff;padding:15px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:999999;font:bold 14px Arial,sans-serif">${mensaje}</div>`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), error ? 3000 : 4000);
    }

    // =================================================================
    // MÓDULO VSAAS (WAD + Ctrl+Q)
    // =================================================================
    if (SITE.isVSaaS) {
        log('✅ VSaaS detectado');

        // Liberar foco de select2 tras clicks (post-interacción, no durante)
        document.addEventListener('click', () => {
            setTimeout(() => {
                const el = document.activeElement;
                if (el?.closest('.ui-select-container, .select2-container') &&
                    !document.querySelector('.ui-select-dropdown:not(.select2-display-none)')) {
                    el.blur();
                    document.body.focus();
                }
            }, 150);
        }, true);

        // ─────────────────────────────────────────────
        // DESTACAMENTOS
        // ─────────────────────────────────────────────

        const DESTACAMENTOS = new Map([
            ['SAN CARLOS',       'CS3 - San Carlos'],
            ['ERRAZURIZ',        'CS2 - Errázuriz'],
            ['FLEMING',          'CS4 - Fleming'],
            ['APOQUINDO',        'CS5 - Apoquindo'],
            ['QUINCHAMALI',      'CS1 - Quinchamalí'],
            ['CENTRO CIVICO',    'CS6 - El Golf'],
            ['EL GOLF',          'CS6 - El Golf'],
            ['ANALITICA GENERAL','GENERAL']
        ]);

        let ultimoCodigo = null;
        let ultimoDestacamento = null;
        let observerActivo = false;

        // ─────────────────────────────────────────────
        // EXTRAER CÓDIGO DESDE H3
        // ─────────────────────────────────────────────

        function codigoDesdeDom() {
            const h3 = document.querySelector('h3.ng-binding');
            return extraerCodigo(h3?.getAttribute('title') || h3?.innerText);
        }

        // ─────────────────────────────────────────────
        // OBTENER DESTACAMENTO
        // ─────────────────────────────────────────────

        function obtenerDestacamento() {
            if (ultimoDestacamento) return ultimoDestacamento;

            for (const a of document.querySelectorAll('a.ng-binding')) {
                const texto = a.innerText
                    ?.normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toUpperCase()
                    .trim();
                if (!texto) continue;

                for (const [clave, valor] of DESTACAMENTOS) {
                    if (texto.includes(clave)) return valor;
                }
            }
            return null;
        }

        // ─────────────────────────────────────────────
        // TÍTULO DE PESTAÑA
        // ─────────────────────────────────────────────

        function actualizarTitulo() {
            const partes = [];
            if (ultimoDestacamento) partes.push(ultimoDestacamento);
            if (ultimoCodigo) partes.push(ultimoCodigo);
            document.title = partes.length ? partes.join(' | ') : 'VSaaS';
        }

        // ─────────────────────────────────────────────
        // OBSERVAR CAMBIO DE ALERTA (MutationObserver)
        // ─────────────────────────────────────────────

        function observarH3(h3) {
            if (observerActivo) return;
            observerActivo = true;

            new MutationObserver(() => {
                let cambio = false;

                const codigo = extraerCodigo(h3.getAttribute('title') || h3.innerText);
                if (codigo && codigo !== ultimoCodigo) {
                    ultimoCodigo = codigo;
                    GM_setClipboard(codigo);
                    log('Código copiado:', codigo);
                    cambio = true;
                }

                const dest = obtenerDestacamento();
                if (dest && dest !== ultimoDestacamento) {
                    ultimoDestacamento = dest;
                    log('Destacamento:', dest);
                    cambio = true;
                }

                if (cambio) actualizarTitulo();
            }).observe(h3, { childList: true, characterData: true, subtree: true });
        }

        // ─────────────────────────────────────────────
        // NAVEGACIÓN CCC: W / A / D
        // ─────────────────────────────────────────────

        function abrirImagenAlerta() {
            const link = document.querySelector('a[href*="/api/sensors/"][href*="/download/"][target="_blank"]');
            if (link) { link.click(); log('W → Imagen abierta'); }
        }

        function navegarImagen(dir) {
            const flecha = document.querySelector(dir === 'left' ? 'a.prev' : 'a.next');
            if (flecha && !flecha.classList.contains('disabled')) {
                flecha.click();
                log(`${dir === 'left' ? 'A' : 'D'} → Imagen ${dir === 'left' ? 'anterior' : 'siguiente'}`);
            }
        }

        // ─────────────────────────────────────────────
        // MACRO Ctrl+Q → ARCGIS
        // ─────────────────────────────────────────────

        async function macroCtrlQ() {
            log('🎹 Ctrl+Q activado');

            let codigo = null;

            // 1. Prioridad: portapapeles (compatibilidad con SOGA activo)
            try {
                codigo = extraerCodigo(await navigator.clipboard.readText());
                if (codigo) log('✓ Código desde portapapeles:', codigo);
            } catch { /* sin permisos */ }

            // 2. Fallback: DOM
            if (!codigo) {
                codigo = codigoDesdeDom();
                if (codigo) {
                    log('✓ Código desde DOM:', codigo);
                    GM_setClipboard(codigo);
                }
            }

            if (!codigo) {
                crearNotif('❌ No hay código de cámara', true);
                return;
            }

            const ahora = Date.now();
            const ultimo = GM_getValue('lastArcGISOpened', 0);

            if (ahora - ultimo < CONFIG.COOLDOWN) {
                log('⚠️ ArcGIS abierto recientemente');
                GM_setValue('pendingCamera', { codigo, timestamp: ahora });
                crearNotif('⚠️ ArcGIS abierto - ' + codigo, true);
                return;
            }

            GM_setValue('pendingCamera', { codigo, timestamp: ahora });
            GM_setValue('lastArcGISOpened', ahora);

            crearNotif('🚀 Buscando: ' + codigo, false);
            log('🌐 Abriendo ArcGIS...');
            GM_openInTab(CONFIG.ARCGIS_URL, { active: false, insert: true });
        }

        // ─────────────────────────────────────────────
        // LISTENER UNIFICADO DE TECLADO (VSaaS)
        // ─────────────────────────────────────────────

        const CCC_HANDLERS = {
            w: () => abrirImagenAlerta(),
            a: () => navegarImagen('left'),
            d: () => navegarImagen('right')
        };

        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;

            // Si el foco está en un input/textarea real, no interceptar
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

            // Si el foco quedó atrapado en select2 (dropdown cerrado), liberarlo
            if (el?.closest('.ui-select-container, .select2-container')) {
                el.blur();
                document.body.focus();
            }

            // Ctrl+Q → ArcGIS
            if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
                e.preventDefault();
                e.stopPropagation();
                macroCtrlQ();
                return;
            }

            // W/A/D → sin modificadores
            if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

            const handler = CCC_HANDLERS[e.key.toLowerCase()];
            if (handler) {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }
        }, { capture: true, passive: false });

        // ─────────────────────────────────────────────
        // INICIALIZACIÓN VSaaS
        // ─────────────────────────────────────────────

        function waitForEl(sel) {
            return new Promise((resolve, reject) => {
                const el = document.querySelector(sel);
                if (el) return resolve(el);

                const obs = new MutationObserver((_, o) => {
                    const found = document.querySelector(sel);
                    if (found) { o.disconnect(); resolve(found); }
                });
                obs.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + sel)); }, 30000);
            });
        }

        waitForEl('h3.ng-binding')
            .then(h3 => observarH3(h3))
            .catch(err => console.warn('[PASADOR]', err.message));

        console.log('%c[PASADOR] 📌 v2.0 ACTIVO ✓', 'color: #2196F3; font-weight: bold; font-size: 14px');
        console.log('[PASADOR] W → Imagen | A/D → Navegar | Ctrl+Q → ArcGIS');
    }

    // =================================================================
    // MÓDULO ARCGIS - PUENTE + INYECCIÓN
    // =================================================================
    if (SITE.isArcGIS) {
        log('🗺️ ArcGIS detectado');

        // Título provisional
        document.title = '⏳ Cargando ubicación...';

        // Observer para mantener título
        const titleEl = document.querySelector('title');
        if (titleEl) {
            new MutationObserver(() => {
                if (document.title.includes('Cámaras 202')) {
                    document.title = '⏳ Cargando ubicación...';
                }
            }).observe(titleEl, { childList: true, characterData: true, subtree: true });
        }

        // Data bridge
        const pendiente = GM_getValue('pendingCamera', null);
        if (pendiente?.codigo) {
            const edad = Date.now() - pendiente.timestamp;
            if (edad < CONFIG.EXPIRY) {
                log('✓ Código válido:', pendiente.codigo);
                const bridge = document.createElement('div');
                bridge.id = 'arcgis-camera-data';
                bridge.style.display = 'none';
                bridge.dataset.cameraCode = pendiente.codigo;
                bridge.dataset.timestamp = pendiente.timestamp;
                document.body.appendChild(bridge);
            } else {
                log('⏰ Código expirado');
                GM_setValue('pendingCamera', null);
            }
        }

        // ─────────────────────────────────────────────
        // SCRIPT INYECTADO (contexto de página)
        // ─────────────────────────────────────────────

        function arcgisInjected(featureServerUrl, zoomLevel) {
            var tituloDeseado = '⏳ Cargando ubicación...';
            var observerActivo = true;

            function log() {
                var args = Array.prototype.slice.call(arguments);
                console.log.apply(console, ['[ArcGIS-Injected]'].concat(args));
            }

            // Observer del título
            document.title = tituloDeseado;
            var titleObs = new MutationObserver(function() {
                if (observerActivo && document.title !== tituloDeseado) {
                    document.title = tituloDeseado;
                }
            });
            var titleEl = document.querySelector('title');
            if (titleEl) titleObs.observe(titleEl, { childList: true, characterData: true, subtree: true });

            function setTitulo(titulo, final) {
                tituloDeseado = titulo;
                document.title = titulo;
                if (final) observerActivo = false;
            }

            function esperarMapaListo(cb) {
                var intentos = 0;
                var check = setInterval(function() {
                    if (++intentos > 40) { clearInterval(check); log('❌ Timeout mapa'); return; }
                    if (window._viewerMap && window._viewerMap.loaded && window.esri) {
                        clearInterval(check);
                        log('✅ Mapa listo');
                        cb();
                    }
                }, 500);
            }

            function obtenerToken() {
                try {
                    var creds = window.esri && window.esri.id && window.esri.id.credentials;
                    if (!creds) return null;
                    for (var i = 0; i < creds.length; i++) {
                        if (creds[i].server && creds[i].server.indexOf('arcgismlc.lascondes.cl/server') !== -1) {
                            return creds[i].token;
                        }
                    }
                } catch (e) { log('❌ Error token:', e); }
                return null;
            }

            function buscarCamara(codigo) {
                log('🔍 BÚSQUEDA:', codigo);

                var token = obtenerToken();
                if (!token) { mostrarNotif('❌ Sin token', true); return; }

                var params = new URLSearchParams({
                    where: "id_cámara LIKE '" + codigo + "%' OR id_cámara = '" + codigo + "'",
                    returnGeometry: 'true',
                    outFields: '*',
                    outSR: '102100',
                    f: 'json',
                    token: token
                });

                fetch(featureServerUrl + '?' + params)
                    .then(function(r) { return r.json(); })
                    .then(function(data) {
                        if (data.error) throw new Error(data.error.message);
                        if (!data.features || !data.features.length) {
                            setTitulo('❌ ' + codigo + ' - No encontrada', true);
                            mostrarNotif('⚠️ "' + codigo + '" no encontrada', true);
                            return;
                        }

                        // Buscar coincidencia exacta
                        var feature = data.features[0];
                        for (var i = 0; i < data.features.length; i++) {
                            var id = data.features[i].attributes.id_cámara || '';
                            if (id === codigo || id.indexOf(codigo + ' ') === 0 || id.indexOf(codigo + '-') === 0) {
                                feature = data.features[i];
                                break;
                            }
                        }

                        var attrs = feature.attributes;
                        var geom = feature.geometry;

                        var titulo = attrs.direccion
                            ? codigo + ' - ' + attrs.direccion
                            : attrs.id_cámara || codigo;
                        setTitulo(titulo, true);

                        centrarYResaltar(geom.x, geom.y, attrs);

                        var bridge = document.getElementById('arcgis-camera-data');
                        if (bridge) bridge.remove();

                        mostrarNotif('✅ ' + attrs.id_cámara + '<br>' + (attrs.direccion || ''), false);
                        log('✅ COMPLETADO');
                    })
                    .catch(function(err) {
                        setTitulo('⚠️ ' + codigo + ' - Error', true);
                        mostrarNotif('❌ ' + err.message, true);
                    });
            }

            function centrarYResaltar(x, y, attrs) {
                try {
                    var pt = new window.esri.geometry.Point(x, y, new window.esri.SpatialReference({ wkid: 102100 }));
                    window._viewerMap.centerAndZoom(pt, zoomLevel);

                    setTimeout(function() {
                        window._viewerMap.graphics.clear();
                        var sym = new window.esri.symbol.SimpleMarkerSymbol(
                            window.esri.symbol.SimpleMarkerSymbol.STYLE_CIRCLE, 40,
                            new window.esri.symbol.SimpleLineSymbol(
                                window.esri.symbol.SimpleLineSymbol.STYLE_SOLID,
                                new window.esri.Color([0, 255, 255, 1]), 4
                            ),
                            new window.esri.Color([0, 255, 255, 0.4])
                        );
                        window._viewerMap.graphics.add(new window.esri.Graphic(pt, sym, attrs));
                        log('✅ Cámara resaltada');
                    }, 500);
                } catch (e) { log('❌ Error centrando:', e); }
            }

            function mostrarNotif(msg, error) {
                var d = document.createElement('div');
                d.innerHTML = '<div style="position:fixed;top:20px;right:20px;background:' + (error ? '#ff4444' : '#4CAF50') + ';color:#fff;padding:15px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:999999;font:14px Arial,sans-serif"><strong>🗺️ ArcGIS</strong><br>' + msg + '</div>';
                document.body.appendChild(d);
                setTimeout(function() { d.remove(); }, 4000);
            }

            // Verificar código pendiente
            var bridge = document.getElementById('arcgis-camera-data');
            if (!bridge) { setTitulo('Portal de ArcGIS', true); return; }

            var codigo = bridge.dataset.cameraCode;
            var ts = parseInt(bridge.dataset.timestamp);

            if (codigo && (Date.now() - ts) < 120000) {
                setTitulo('⏳ Cargando ' + codigo + '...');
                esperarMapaListo(function() {
                    setTitulo('🔍 Buscando ' + codigo + '...');
                    setTimeout(function() { buscarCamara(codigo); }, 2000);
                });
            } else {
                bridge.remove();
                setTitulo('Portal de ArcGIS', true);
            }

            // Atajo manual Ctrl+Shift+Q en ArcGIS
            document.addEventListener('keydown', function(e) {
                if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
                    navigator.clipboard.readText().then(function(texto) {
                        var match = texto.match(/\b([A-Z0-9]{2,10}-\d{1,3})\b/);
                        if (match) {
                            setTitulo('🔍 ' + match[1] + '...', false);
                            observerActivo = true;
                            esperarMapaListo(function() { buscarCamara(match[1]); });
                        } else {
                            mostrarNotif('No hay código válido en portapapeles', true);
                        }
                    });
                }
            });

            log('✅ Módulo inicializado');
        }

        // Inyectar
        const s = document.createElement('script');
        s.textContent = '(' + arcgisInjected.toString() + ')(' +
            JSON.stringify(CONFIG.FEATURESERVER_URL) + ',' + CONFIG.ZOOM_LEVEL + ')';
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        log('✅ Script inyectado');
    }

})();
