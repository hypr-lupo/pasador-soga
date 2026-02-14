// ==UserScript==
// @name         SOGA VSaaS
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Script Optimizador de Gestión Automatizada.
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2026-2027 Leonardo Navarro
// @license      MIT
// @match        https://suite.vsaas.ai/*
// @match        https://suite-back.vsaas.ai/*
// @grant        none
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════
 * SOGA - Script Optimizador de Gestión de Alertas
 * Copyright (c) 2026-2027 Leonardo Navarro
 *
 * Licensed under MIT License
 *
 *   SOLO PARA CIRCUNSTANCIAS ESPECIALES
 *   NO PROBADO CON EL PASADOR
 *
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════
    // CONFIGURACIÓN DE ESTADOS
    // ═══════════════════════════════════════════════════

    const ESTADOS = {
        s: { codigo: '-2)', nombre: 'SIN NOVEDAD', comentarioPrevio: null },
        f: { codigo: '-5)', nombre: 'F.POSITIVO', comentarioPrevio: 'FALSOPOS' }
    };

    const ESTADO_Q = {
        desdeHik: { codigo: '-4)', nombre: 'CERRADO', comentario: 'CERRADO', enviarComentario: false },
        default:  { codigo: '-3)', nombre: 'HIKCENTRAL', comentario: 'HIKCENTRAL', enviarComentario: true }
    };

    let comentarioPendiente = null;
    let componenteCache = null;
    let ultimaBusqueda = 0;

    // ═══════════════════════════════════════════════════
    // UTILIDADES DOM
    // ═══════════════════════════════════════════════════

    function isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    function isDropdownOpen() {
        const el = document.activeElement;
        if (!el) return false;
        const c = el.closest('.ui-select-container, .select2-container');
        if (!c) return false;
        return c.classList.contains('open') ||
               c.classList.contains('ui-select-open') ||
               c.classList.contains('select2-container--open') ||
               c.getAttribute('aria-expanded') === 'true';
    }

    // Liberar foco tras click en dropdown
    document.addEventListener('click', () => {
        requestAnimationFrame(() => {
            const el = document.activeElement;
            if (el?.closest('.ui-select-container, .select2-container')) {
                el.blur();
                document.body.focus();
            }
        });
    }, true);

    // ═══════════════════════════════════════════════════
    // COMPONENTE DE ESTADO (con cache)
    // ═══════════════════════════════════════════════════

    function obtenerComponente() {
        const ahora = Date.now();
        if (componenteCache && (ahora - ultimaBusqueda) < 5000 && document.contains(componenteCache)) {
            return componenteCache;
        }
        componenteCache = document.querySelector('event-state-select');
        ultimaBusqueda = ahora;
        return componenteCache;
    }

    // ═══════════════════════════════════════════════════
    // ACCIONES DOM
    // ═══════════════════════════════════════════════════

    function ejecutarClick(el) {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        el.click();
    }

    function buscarOpcion(dropdown, config) {
        for (const op of dropdown.querySelectorAll('.ui-select-choices-row')) {
            const txt = op.textContent;
            if (txt.indexOf(config.codigo) === 0 || txt.indexOf(config.nombre) !== -1) return op;
        }
        return null;
    }

    async function abrirDropdownYSeleccionar(componente, config) {
        const boton = componente.querySelector('.select2-choice');
        if (!boton) { console.error('[SOGA] ✗ Botón dropdown no encontrado'); return false; }

        boton.click();

        let dropdown = null;
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 60));
            dropdown = document.querySelector('.ui-select-dropdown:not(.select2-display-none)');
            if (dropdown) break;
        }

        if (!dropdown) { console.error('[SOGA] ✗ Dropdown no visible'); return false; }

        const opcion = buscarOpcion(dropdown, config);
        if (!opcion) {
            console.error(`[SOGA] ✗ Opción "${config.nombre}" no encontrada`);
            document.body.click();
            return false;
        }

        ejecutarClick(opcion);
        return true;
    }

    // ═══════════════════════════════════════════════════
    // COMENTARIOS
    // ═══════════════════════════════════════════════════

    async function seleccionarComentario(texto) {
        for (const label of document.querySelectorAll('.label-default-comment')) {
            if (label.textContent.trim() === texto) {
                ejecutarClick(label);
                await new Promise(r => setTimeout(r, 100));
                console.log(`[SOGA] ✓ Comentario "${texto}" seleccionado`);
                return true;
            }
        }
        console.error(`[SOGA] ✗ Comentario "${texto}" no encontrado`);
        return false;
    }

    async function enviarComentario() {
        const btn = document.querySelector('.input-group-btn button[ng-click*="addComment"]');
        if (!btn || btn.disabled) {
            console.warn('[SOGA] ⚠ Botón enviar no disponible');
            return false;
        }
        ejecutarClick(btn);
        await new Promise(r => setTimeout(r, 100));
        console.log('[SOGA] ✓ Comentario enviado');
        return true;
    }

    // ═══════════════════════════════════════════════════
    // LISTENER POPUP (para F → FALSOPOS)
    // ═══════════════════════════════════════════════════

    document.addEventListener('click', function(e) {
        let target = e.target;
        for (let i = 0; i < 3 && target; i++, target = target.parentElement) {
            if (target.classList?.contains('btn-danger') &&
                target.getAttribute('ng-click')?.includes('hideEvent') &&
                comentarioPendiente) {
                setTimeout(async () => {
                    const ok = await seleccionarComentario(comentarioPendiente);
                    if (ok) await enviarComentario();
                    comentarioPendiente = null;
                }, 300);
                return;
            }
        }
    }, true);

    // ═══════════════════════════════════════════════════
    // CAMBIAR ESTADO (S / F)
    // ═══════════════════════════════════════════════════

    async function cambiarEstado(config) {
        const componente = obtenerComponente();
        if (!componente) { console.warn('[SOGA] ✗ Selecciona una alerta'); return; }

        const actual = componente.querySelector('.select2-chosen')?.textContent;
        if (actual?.includes(config.nombre)) {
            console.log(`[SOGA] ✓ Ya está en ${config.nombre}`);
            return;
        }

        // Comentario previo (ej: FALSOPOS antes de F.POSITIVO)
        if (config.comentarioPrevio) {
            await seleccionarComentario(config.comentarioPrevio);
        }

        const ok = await abrirDropdownYSeleccionar(componente, config);

        if (ok && config.codigo === '-5)') {
            comentarioPendiente = config.comentarioPrevio;
            console.log('[SOGA] ⏳ Popup aparecerá → Presiona "Aceptar"');
        }

        if (ok) console.log(`[SOGA] ✓ Estado → ${config.nombre}`);
    }

    // ═══════════════════════════════════════════════════
    // CICLO Q (HIKCENTRAL ↔ CERRADO)
    // ═══════════════════════════════════════════════════

    async function ciclarEstadoQ() {
        // Detectar estado actual
        let estadoTexto = '';
        const span = document.querySelector('.label.event-state.ng-binding');
        if (span) {
            estadoTexto = span.textContent?.trim() || span.getAttribute('title')?.trim() || '';
        }

        const componente = obtenerComponente();
        if (!estadoTexto && componente) {
            estadoTexto = componente.querySelector('.select2-chosen')?.textContent?.trim() || '';
        }

        console.log(`[SOGA Q] Estado actual: "${estadoTexto}"`);

        const esHik = estadoTexto.includes('HIKCENTRAL');
        const accion = esHik ? ESTADO_Q.desdeHik : ESTADO_Q.default;

        console.log(`[SOGA Q] → ${accion.nombre}`);

        // Comentario
        if (accion.comentario) {
            const ok = await seleccionarComentario(accion.comentario);
            if (!ok) return;

            if (accion.enviarComentario) {
                const enviado = await enviarComentario();
                if (!enviado) return;
            }
        }

        if (!componente) { console.warn('[SOGA Q] ✗ Componente no encontrado'); return; }

        const ok = await abrirDropdownYSeleccionar(componente, accion);
        if (ok) console.log(`[SOGA Q] ✓ Estado → ${accion.nombre}`);
    }

    // ═══════════════════════════════════════════════════
    // LISTENER DE TECLADO (solo S/F/Q)
    // ═══════════════════════════════════════════════════

    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
        if (isInputFocused() || isDropdownOpen()) return;

        const key = e.key.toLowerCase();

        if (key === 's' || key === 'f') {
            e.preventDefault();
            e.stopPropagation();
            cambiarEstado(ESTADOS[key]);
        } else if (key === 'q') {
            e.preventDefault();
            e.stopPropagation();
            ciclarEstadoQ();
        }
    }, { capture: true, passive: false });

    // ═══════════════════════════════════════════════════
    // INICIALIZACIÓN
    // ═══════════════════════════════════════════════════

    console.log('%c[SOGA] 🪢 v3.0 ACTIVO ✓', 'color: #4CAF50; font-weight: bold; font-size: 14px');
    console.log('[SOGA] S → SIN NOVEDAD | F → F.POSITIVO | Q → HIKCENTRAL ↔ CERRADO');
    console.log('[SOGA] Módulo de estados únicamente (CCC en PASADOR)');

})();
