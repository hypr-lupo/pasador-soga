// ==UserScript==
// @name         Pasador VSaaS - ArcGIS
// @namespace    http://tampermonkey.net/
// @version      2.5
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
// @updateURL    https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/Pasador%20VSaaS%20-%20ArcGIS.user.js
// @downloadURL  https://github.com/hypr-lupo/pasador-soga/raw/refs/heads/main/Pasador%20VSaaS%20-%20ArcGIS.user.js
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════
 * PASADOR v2.5 - Puente VSaaS ↔ ArcGIS + QoL
 * Copyright (c) 2026-2027 Leonardo Navarro
 * Licensed under MIT License
 *
 * v2.5 - Robustecimiento:
 *   - Observer auto-reconectable (detecta nodos huérfanos)
 *   - Centinela DOM: vigila destrucción/recreación del h3 por Angular
 *   - Polling de respaldo cada 2s como fallback del observer
 *   - Heartbeat: título se recalcula periódicamente
 *   - Ctrl+Q con triple fallback (clipboard → DOM → estado)
 *   - Observer escucha cambios en atributo title del h3
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    const CONFIG = {
        ARCGIS_URL: 'https://arcgismlc.lascondes.cl/portal/apps/webappviewer/index.html?id=118513d990134fcbb9196ac7884cfb8c',
        FEATURESERVER_URL: 'https://arcgismlc.lascondes.cl/server/rest/services/Hosted/C%C3%A1maras_al_10_de_febrero_2026/FeatureServer/0/query',
        ZOOM_LEVEL: 18,
        COOLDOWN: 5000,
        EXPIRY: 120000,
        POLL_INTERVAL: 2000,
        HEARTBEAT: 5000,
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
    // MÓDULO VSAAS (WAD + Clipboard + Título + Ctrl+Q)
    // =================================================================
    if (SITE.isVSaaS) {
        log('✅ VSaaS detectado');

        // Liberar foco de select2 tras clicks
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

        // ─── DESTACAMENTOS ───

        const DESTACAMENTOS = new Map([
            ['SAN CARLOS',       'CS3 - San Carlos'],
            ['ERRAZURIZ',        'CS2 - Errázuriz'],
            ['FLEMING',          'CS4 - Fleming'],
            ['APOQUINDO',        'CS5 - Apoquindo'],
            ['QUINCHAMALI',      'CS1 - Quinchamalí'],
            ['CENTRO CIVICO',    'CS6 - El Golf'],
            ['EL GOLF',          'CS6 - El Golf'],
            ['ANALITICA GENERAL','ANAL GENERAL']
        ]);

        // ─── ESTADO CENTRAL ───

        const state = {
            codigo: null,
            destacamento: null,
            h3Ref: null,       // nodo h3 actualmente observado
            observer: null     // MutationObserver activo
        };

        // ─── LECTURA FRESCA DEL DOM (nunca cacheada) ───

        function codigoDesdeDom() {
            const h3 = document.querySelector('h3.ng-binding');
            return extraerCodigo(h3?.getAttribute('title') || h3?.innerText);
        }

        function obtenerDestacamento() {
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

        function actualizarTitulo() {
            const partes = [];
            if (state.destacamento) partes.push(state.destacamento);
            if (state.codigo) partes.push(state.codigo);
            const titulo = partes.length ? partes.join(' | ') : 'VSaaS';
            if (document.title !== titulo) document.title = titulo;
        }

        // ─── NÚCLEO: detectarCambios() ───
        // Usado por observer, polling y heartbeat — lógica unificada

        function detectarCambios() {
            let cambio = false;

            const codigo = codigoDesdeDom();
            if (codigo && codigo !== state.codigo) {
                state.codigo = codigo;
                GM_setClipboard(codigo);
                log('📋 Código copiado:', codigo);
                cambio = true;
            }

            const dest = obtenerDestacamento();
            if (dest && dest !== state.destacamento) {
                state.destacamento = dest;
                log('🏢 Destacamento:', dest);
                cambio = true;
            }

            if (cambio) actualizarTitulo();
            return cambio;
        }

        // ─── OBSERVER AUTO-RECONECTABLE ───

        function desconectarObserver() {
            if (state.observer) {
                state.observer.disconnect();
                state.observer = null;
                state.h3Ref = null;
            }
        }

        function conectarObserver() {
            const h3 = document.querySelector('h3.ng-binding');
            if (!h3) return false;

            // Ya observando este nodo y sigue en el DOM
            if (state.h3Ref === h3 && document.contains(h3) && state.observer) {
                return true;
            }

            desconectarObserver();
            state.h3Ref = h3;

            state.observer = new MutationObserver(() => {
                // Si Angular destruyó el nodo, desconectar limpiamente
                if (!document.contains(h3)) {
                    log('⚠️ h3 huérfano, desconectando observer');
                    desconectarObserver();
                    return;
                }
                detectarCambios();
            });

            // CLAVE: escuchar también cambios en atributo 'title'
            state.observer.observe(h3, {
                childList: true,
                characterData: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['title']
            });

            log('👁️ Observer conectado');
            detectarCambios(); // detección inmediata al conectar
            return true;
        }

        // ─── CENTINELA: vigila destrucción/recreación del h3 ───

        function iniciarCentinela() {
            new MutationObserver(() => {
                if (!state.observer || !state.h3Ref || !document.contains(state.h3Ref)) {
                    if (conectarObserver()) {
                        log('🔄 Centinela reconectó observer');
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        }

        // ─── POLLING DE RESPALDO (cada 2s) ───

        function iniciarPolling() {
            setInterval(() => detectarCambios(), CONFIG.POLL_INTERVAL);
        }

        // ─── HEARTBEAT: verifica salud + recalcula título (cada 5s) ───

        function iniciarHeartbeat() {
            setInterval(() => {
                if (!state.observer || !state.h3Ref || !document.contains(state.h3Ref)) {
                    conectarObserver();
                }
                actualizarTitulo();
            }, CONFIG.HEARTBEAT);
        }

        // ─── NAVEGACIÓN WAD ───

        function abrirImagenAlerta() {
            const link = document.querySelector('a[href*="/api/sensors/"][href*="/download/"][target="_blank"]');
            if (link) { link.click(); log('W → Imagen abierta'); }
        }

        function navegarImagen(dir) {
            const flecha = document.querySelector(dir === 'left' ? 'a.prev' : 'a.next');
            if (flecha && !flecha.classList.contains('disabled')) {
                flecha.click();
                log(`${dir === 'left' ? 'A' : 'D'} → ${dir === 'left' ? 'anterior' : 'siguiente'}`);
            }
        }

        // ─── MACRO Ctrl+Q → ARCGIS ───

        async function macroCtrlQ() {
            log('🎹 Ctrl+Q activado');
            let codigo = null;

            // 1. Portapapeles (compatibilidad con SOGA)
            try {
                codigo = extraerCodigo(await navigator.clipboard.readText());
                if (codigo) log('✓ Desde portapapeles:', codigo);
            } catch { /* sin permisos */ }

            // 2. DOM directo
            if (!codigo) {
                codigo = codigoDesdeDom();
                if (codigo) {
                    log('✓ Desde DOM:', codigo);
                    GM_setClipboard(codigo);
                }
            }

            // 3. Estado interno (último código detectado)
            if (!codigo && state.codigo) {
                codigo = state.codigo;
                log('✓ Desde estado:', codigo);
            }

            if (!codigo) {
                crearNotif('❌ No hay código de cámara', true);
                return;
            }

            const ahora = Date.now();
            const ultimo = GM_getValue('lastArcGISOpened', 0);

            if (ahora - ultimo < CONFIG.COOLDOWN) {
                GM_setValue('pendingCamera', { codigo, timestamp: ahora });
                crearNotif('⚠️ ArcGIS abierto - ' + codigo, true);
                return;
            }

            GM_setValue('pendingCamera', { codigo, timestamp: ahora });
            GM_setValue('lastArcGISOpened', ahora);
            crearNotif('🚀 Buscando: ' + codigo, false);
            GM_openInTab(CONFIG.ARCGIS_URL, { active: false, insert: true });
        }

        // ─── LISTENER UNIFICADO DE TECLADO ───

        const WAD_HANDLERS = {
            w: () => abrirImagenAlerta(),
            a: () => navegarImagen('left'),
            d: () => navegarImagen('right')
        };

        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;

            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

            if (el?.closest('.ui-select-container, .select2-container')) {
                el.blur();
                document.body.focus();
            }

            if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
                e.preventDefault();
                e.stopPropagation();
                macroCtrlQ();
                return;
            }

            if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

            const handler = WAD_HANDLERS[e.key.toLowerCase()];
            if (handler) {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }
        }, { capture: true, passive: false });

        // ─── INICIALIZACIÓN: 4 capas de resiliencia ───

        conectarObserver();     // Capa 1: Observer directo
        iniciarCentinela();     // Capa 2: Vigila DOM por reconexión
        iniciarPolling();       // Capa 3: Fallback cada 2s
        iniciarHeartbeat();     // Capa 4: Verificación de salud cada 5s

        console.log('%c[PASADOR] 📌 v2.5 ACTIVO ✓', 'color: #2196F3; font-weight: bold; font-size: 14px');
        console.log('[PASADOR] W → Imagen | A/D → Navegar | Ctrl+Q → ArcGIS');
        console.log('[PASADOR] 🛡️ Observer + Centinela + Polling + Heartbeat');
    }

    // =================================================================
    // MÓDULO ARCGIS - PUENTE + INYECCIÓN (sin cambios funcionales)
    // =================================================================
    if (SITE.isArcGIS) {
        log('🗺️ ArcGIS detectado');

        document.title = '⏳ Cargando ubicación...';

        const titleEl = document.querySelector('title');
        if (titleEl) {
            new MutationObserver(() => {
                if (document.title.includes('Cámaras 202')) {
                    document.title = '⏳ Cargando ubicación...';
                }
            }).observe(titleEl, { childList: true, characterData: true, subtree: true });
        }

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

        function arcgisInjected(featureServerUrl, zoomLevel) {
            var tituloDeseado = '⏳ Cargando ubicación...';
            var observerActivo = true;

            function log() {
                var args = Array.prototype.slice.call(arguments);
                console.log.apply(console, ['[ArcGIS-Injected]'].concat(args));
            }

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

        const s = document.createElement('script');
        s.textContent = '(' + arcgisInjected.toString() + ')(' +
            JSON.stringify(CONFIG.FEATURESERVER_URL) + ',' + CONFIG.ZOOM_LEVEL + ')';
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        log('✅ Script inyectado');
    }

})();