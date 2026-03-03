// ==UserScript==
// @name         VSaaS - Mobile Dashboard
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Dashboard móvil de respaldo para gestión de eventos VSaaS
// @author       Leonardo Navarro (hypr-lupo)
// @copyright    2026 Leonardo Navarro
// @license      MIT
// @match        https://suite.vsaas.ai/*
// @match        https://suite-back.vsaas.ai/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════
 * VSaaS Mobile Dashboard v1.0
 * Dashboard móvil de respaldo — gestión de eventos
 * Copyright (c) 2026 Leonardo Navarro
 * Licensed under MIT License
 * ═══════════════════════════════════════════════════════════════════
 *
 * FUNCIONALIDADES:
 *  - Lista de eventos touch-friendly con prioridad, tipo, cámara, estado
 *  - Vista detalle con imagen de la alerta (carrusel)
 *  - Selector de estados (12 estados con colores)
 *  - Comentarios predefinidos + texto libre + enviar
 *  - Auto-refresh configurable
 *  - Activación automática en viewport < 768px o toggle manual
 *
 * ARQUITECTURA:
 *  Corre en suite.vsaas.ai (mismo origen → sin CORS)
 *  Extrae datos del DOM/Angular scope de la app existente
 *  Interactúa con widgets nativos (select2, formularios) para
 *  cambios de estado y comentarios
 */

(function () {
    'use strict';

    // ═════════════════════════════════════════════════════════════
    // CONFIGURACIÓN
    // ═════════════════════════════════════════════════════════════

    const CONFIG = {
        AUTO_ACTIVATE_WIDTH: 768,
        REFRESH_INTERVAL: 8000,
        REFRESH_FAST: 4000,
        IMG_LOAD_TIMEOUT: 10000,
        POLL_DOM_INTERVAL: 2000,
        ACTIVATION_KEY: 'vsaas-mobile-active',
        DEBUG: false,
    };

    const log = CONFIG.DEBUG
        ? (...a) => console.log('[MobileDash]', ...a)
        : () => {};

    // ═════════════════════════════════════════════════════════════
    // ESTADOS (extraídos del dropdown VSaaS)
    // ═════════════════════════════════════════════════════════════

    const ESTADOS = [
        { id: '-2', label: '-2) SIN NOVEDAD',       short: 'S.NOV',    bg: '#2eb050', color: '#fff', border: '#2eb050' },
        { id: '-3', label: '-3) HIKCENTRAL',         short: 'HIKC',     bg: '#ff0000', color: '#fff', border: '#000'    },
        { id: '-4', label: '-4) CERRADO',            short: 'CERR',     bg: '#0000ff', color: '#fff', border: '#3170a6' },
        { id: '-5', label: '-5) F.POSITIVO',         short: 'F.POS',    bg: '#000000', color: '#fff', border: '#d9d9d9' },
        { id: '-6', label: '-6) ANALITICA MOVIDA',   short: 'A.MOV',    bg: '#ff9900', color: '#000', border: '#783f04' },
        { id: '-8', label: '-8) REPETICION',         short: 'REPET',    bg: '#8e7cc3', color: '#fff', border: '#366092' },
        { id: '1',  label: '1) SIN GESTION',         short: 'S.GES',    bg: '#e06666', color: '#fff', border: '#fefefe' },
        { id: '10', label: '10) P.EXITO',            short: 'P.EXI',    bg: '#ff6666', color: '#fff', border: '#ff3333' },
        { id: '11', label: '11 ) DESFASADO',         short: 'DESF',     bg: '#57889c', color: '#fff', border: '#57889c' },
        { id: '12', label: '12 ) Nombre Cambiado',   short: 'N.CAM',    bg: '#073763', color: '#fff', border: '#073763' },
        { id: '13', label: '13) CECOCO',             short: 'CECOC',    bg: '#cc99ff', color: '#000', border: '#9933cc' },
        { id: 'aj', label: 'Ajuste Analítica',       short: 'AJ.AN',    bg: '#00ff00', color: '#000', border: '#000'    },
    ];

    const COMENTARIOS = [
        'CECOCO', 'CERRADO', 'FALSOPOS', 'HIKCENTRAL', 'MOTOCHORRO',
        'MOVIDA', 'PATRULLERO', 'REPARTIDOR', 'REPETICION', 'SINNOVEDAD',
    ];

    // ═════════════════════════════════════════════════════════════
    // ESTADO GLOBAL
    // ═════════════════════════════════════════════════════════════

    const state = {
        active: false,
        events: [],
        selectedIdx: -1,
        selectedEvent: null,
        view: 'list',         // 'list' | 'detail'
        refreshTimer: null,
        imgSlide: 0,
        imgTotal: 0,
        loading: false,
        lastRefresh: null,
        destacamento: '',
    };

    // ═════════════════════════════════════════════════════════════
    // CSS — MOBILE-FIRST DARK THEME
    // ═════════════════════════════════════════════════════════════

    const MOBILE_CSS = `
/* ── OVERLAY CONTAINER ── */
#vmd-root {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 999999;
    background: #1a1d23;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 15px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
    touch-action: pan-y;
}

#vmd-root * { box-sizing: border-box; margin: 0; padding: 0; }

/* ── HEADER ── */
.vmd-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #12141a;
    border-bottom: 1px solid #2a2d35;
    min-height: 52px;
    flex-shrink: 0;
}
.vmd-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
}
.vmd-back-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 40px; height: 40px;
    border: none;
    background: #2a2d35;
    color: #8ab4f8;
    border-radius: 8px;
    font-size: 20px;
    cursor: pointer;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
}
.vmd-back-btn:active { background: #3a3d45; }
.vmd-detail-active .vmd-back-btn { display: flex; }
.vmd-detail-active .vmd-dest-name { display: none; }

.vmd-dest-name {
    font-weight: 700;
    font-size: 16px;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vmd-camera-code {
    display: none;
    font-weight: 700;
    font-size: 15px;
    color: #8ab4f8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vmd-detail-active .vmd-camera-code { display: block; }

.vmd-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.vmd-badge {
    background: #e06666;
    color: #fff;
    font-weight: 700;
    font-size: 13px;
    padding: 3px 9px;
    border-radius: 12px;
    min-width: 28px;
    text-align: center;
}
.vmd-refresh-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px; height: 40px;
    border: none;
    background: transparent;
    color: #8ab4f8;
    font-size: 20px;
    cursor: pointer;
    border-radius: 8px;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.3s;
}
.vmd-refresh-btn:active { background: #2a2d35; }
.vmd-refresh-btn.spinning { animation: vmd-spin 0.8s linear; }
@keyframes vmd-spin { to { transform: rotate(360deg); } }

.vmd-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px; height: 40px;
    border: none;
    background: #3a2020;
    color: #ff6b6b;
    font-size: 16px;
    cursor: pointer;
    border-radius: 8px;
    -webkit-tap-highlight-color: transparent;
}
.vmd-close-btn:active { background: #4a2020; }

/* ── LIST VIEW ── */
.vmd-list {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 6px;
}
.vmd-event-card {
    display: flex;
    align-items: stretch;
    background: #22252d;
    border-radius: 10px;
    margin-bottom: 6px;
    overflow: hidden;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    border: 2px solid transparent;
    transition: border-color 0.15s;
    min-height: 72px;
}
.vmd-event-card:active { border-color: #8ab4f8; }
.vmd-event-card.unread { border-left: 4px solid #e06666; }

.vmd-priority-strip {
    width: 6px;
    flex-shrink: 0;
    border-radius: 10px 0 0 10px;
}
.vmd-card-body {
    flex: 1;
    padding: 10px 12px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
}
.vmd-card-row1 {
    display: flex;
    align-items: center;
    gap: 8px;
}
.vmd-card-type {
    font-weight: 600;
    font-size: 14px;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
}
.vmd-card-time {
    font-size: 13px;
    color: #888;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
}
.vmd-card-row2 {
    display: flex;
    align-items: center;
    gap: 8px;
}
.vmd-card-camera {
    font-size: 13px;
    color: #aaa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
}
.vmd-card-state {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
    text-transform: uppercase;
}

/* ── DETAIL VIEW ── */
.vmd-detail {
    display: none;
    flex-direction: column;
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}
.vmd-detail-active .vmd-list { display: none; }
.vmd-detail-active .vmd-detail { display: flex; }

/* Image viewer */
.vmd-img-container {
    position: relative;
    width: 100%;
    background: #000;
    min-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}
.vmd-img-container img {
    width: 100%;
    height: auto;
    display: block;
    max-height: 45vh;
    object-fit: contain;
}
.vmd-img-placeholder {
    color: #555;
    font-size: 14px;
    padding: 40px;
    text-align: center;
}
.vmd-img-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 48px; height: 48px;
    border: none;
    background: rgba(0,0,0,0.6);
    color: #fff;
    font-size: 24px;
    border-radius: 50%;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
}
.vmd-img-nav:active { background: rgba(255,255,255,0.2); }
.vmd-img-prev { left: 8px; }
.vmd-img-next { right: 8px; }
.vmd-img-counter {
    position: absolute;
    bottom: 8px;
    right: 10px;
    background: rgba(0,0,0,0.7);
    color: #ccc;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
}

/* ── DETAIL BODY ── */
.vmd-detail-body {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.vmd-detail-info {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    font-size: 13px;
}
.vmd-detail-label {
    color: #888;
    font-weight: 500;
}
.vmd-detail-value {
    color: #e0e0e0;
    font-weight: 500;
}

/* States grid */
.vmd-section-title {
    font-size: 13px;
    color: #888;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 2px;
}
.vmd-states-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
}
.vmd-state-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 4px;
    border: 2px solid transparent;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    text-align: center;
    min-height: 44px;
    transition: opacity 0.15s, transform 0.1s;
    text-transform: uppercase;
    line-height: 1.2;
}
.vmd-state-btn:active { transform: scale(0.95); }
.vmd-state-btn.active {
    border-color: #fff;
    box-shadow: 0 0 0 1px #fff, 0 0 12px rgba(255,255,255,0.2);
}

/* Comments */
.vmd-comments-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.vmd-comment-btn {
    padding: 10px 14px;
    background: #2a2d35;
    border: 1px solid #3a3d45;
    color: #ccc;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.15s;
    min-height: 44px;
    display: flex;
    align-items: center;
}
.vmd-comment-btn:active { background: #3a3d45; }
.vmd-comment-btn.selected {
    background: #1a3a5c;
    border-color: #8ab4f8;
    color: #8ab4f8;
}

.vmd-comment-input-row {
    display: flex;
    gap: 8px;
}
.vmd-comment-textarea {
    flex: 1;
    background: #2a2d35;
    border: 1px solid #3a3d45;
    color: #e0e0e0;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 14px;
    resize: none;
    min-height: 44px;
    font-family: inherit;
    outline: none;
}
.vmd-comment-textarea:focus {
    border-color: #8ab4f8;
}
.vmd-send-btn {
    padding: 10px 20px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    min-width: 80px;
    min-height: 44px;
}
.vmd-send-btn:active { background: #1557b0; }
.vmd-send-btn:disabled {
    background: #2a2d35;
    color: #555;
    cursor: not-allowed;
}

/* Last comment */
.vmd-last-comment {
    background: #22252d;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    border-left: 3px solid #3a3d45;
}
.vmd-last-comment-user {
    color: #8ab4f8;
    font-weight: 600;
}
.vmd-last-comment-time {
    color: #666;
    font-size: 12px;
    margin-left: 6px;
}
.vmd-last-comment-text {
    color: #bbb;
    margin-top: 4px;
    line-height: 1.4;
}

/* ── TOGGLE FAB ── */
#vmd-fab {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999998;
    width: 56px; height: 56px;
    border-radius: 50%;
    background: #1a73e8;
    color: #fff;
    border: none;
    font-size: 24px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
}
#vmd-fab:active { background: #1557b0; transform: scale(0.95); }
#vmd-fab.vmd-hidden { display: none; }

/* ── TOAST ── */
.vmd-toast {
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 1000000;
    pointer-events: none;
    animation: vmd-fade 2s ease forwards;
    white-space: nowrap;
}
.vmd-toast.error { background: #c62828; }
.vmd-toast.success { background: #2e7d32; }
@keyframes vmd-fade {
    0%, 70% { opacity: 1; }
    100% { opacity: 0; }
}

/* ── LOADING ── */
.vmd-loading-bar {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, transparent, #8ab4f8, transparent);
    animation: vmd-loading 1.2s ease-in-out infinite;
    z-index: 10;
}
@keyframes vmd-loading {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

/* ── EMPTY STATE ── */
.vmd-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: #555;
    text-align: center;
    flex: 1;
}
.vmd-empty-icon { font-size: 48px; margin-bottom: 12px; }
.vmd-empty-text { font-size: 15px; }

/* ── STATUS BAR ── */
.vmd-status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    background: #12141a;
    border-top: 1px solid #2a2d35;
    font-size: 12px;
    color: #555;
    flex-shrink: 0;
    min-height: 32px;
}
.vmd-status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
}
.vmd-status-dot.live { background: #4caf50; }
.vmd-status-dot.stale { background: #ff9800; }
`;

    // ═════════════════════════════════════════════════════════════
    // UTILIDADES DOM
    // ═════════════════════════════════════════════════════════════

    function $(sel, ctx = document) { return ctx.querySelector(sel); }
    function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

    /** Obtener scope Angular de un elemento */
    function ngScope(el) {
        try {
            if (window.angular) {
                const scope = window.angular.element(el).scope();
                return scope;
            }
        } catch (e) { log('ngScope error', e); }
        return null;
    }

    /** Obtener controller Angular */
    function ngCtrl(el) {
        try {
            if (window.angular) {
                return window.angular.element(el).controller();
            }
        } catch (e) { log('ngCtrl error', e); }
        return null;
    }

    /** Simular click nativo para Angular */
    function nativeClick(el) {
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    function toast(msg, type = '') {
        const t = document.createElement('div');
        t.className = `vmd-toast ${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }

    function sanitize(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    // ═════════════════════════════════════════════════════════════
    // EXTRACCIÓN DE DATOS
    // ═════════════════════════════════════════════════════════════

    /**
     * Extraer lista de eventos desde ag-Grid rows.
     * Cada row tiene celdas: Prioridad | Tipo | Cámara | Fecha | Estado | Star | Hide
     */
    function scrapeEvents() {
        const rows = $$('.ag-center-cols-container .ag-row');
        const events = [];

        for (const row of rows) {
            const cells = $$('.ag-cell', row);
            if (cells.length < 5) continue;

            // Celda 0: Prioridad
            const prioEl = $('[title]', cells[0]);
            const prioText = prioEl?.getAttribute('title') || '';
            const prioIcon = $('span.fas, span.fa', cells[0]);
            const prioColor = prioIcon?.style?.color || '#888';

            // Celda 1: Tipo evento
            const tipo = $('[title]', cells[1])?.getAttribute('title') || cells[1]?.textContent?.trim() || '';

            // Celda 2: Cámara / ubicación
            const camEl = $('[title]', cells[2]);
            const camera = camEl?.getAttribute('title') || cells[2]?.textContent?.trim() || '';

            // Celda 3: Fecha
            const fecha = $('[title]', cells[3])?.getAttribute('title') ||
                          cells[3]?.textContent?.trim() || '';

            // Celda 4: Estado
            const estadoEl = $('.label.event-state', cells[4]);
            const estadoText = estadoEl?.getAttribute('title') || estadoEl?.textContent?.trim() || '';
            const estadoBg = estadoEl?.style?.background || estadoEl?.style?.backgroundColor || '#888';
            const estadoColor = estadoEl?.style?.color || '#fff';

            // Row ID
            const rowId = row.getAttribute('row-id') || '';
            const rowIdx = parseInt(row.getAttribute('row-index') || '0', 10);
            const isUnread = row.classList.contains('unread');

            events.push({
                rowId, rowIdx, isUnread,
                prioText, prioColor,
                tipo, camera, fecha,
                estadoText, estadoBg, estadoColor,
                rowEl: row,
            });
        }

        // Ordenar por row-index
        events.sort((a, b) => a.rowIdx - b.rowIdx);
        return events;
    }

    /** Extraer nombre del destacamento desde breadcrumbs o título */
    function scrapeDestacamento() {
        // Intentar breadcrumb
        const crumbs = $$('.breadcrumb a.ng-binding, .breadcrumb span.ng-binding');
        for (const c of crumbs) {
            const t = c.textContent?.trim();
            if (t && t.includes('DESTACAMENTO')) return t.replace('DESTACAMENTO ', '');
        }
        // Intentar navegación
        const nav = $('event-dashboard-management');
        if (nav) {
            const scope = ngScope(nav);
            if (scope?.ctrl?.dashboard?.name) return scope.ctrl.dashboard.name;
        }
        return document.title.split('|')[0]?.trim() || 'VSaaS';
    }

    /**
     * Obtener datos del evento seleccionado desde el panel derecho.
     * Retorna { imgSrc, imgSlides, imgTotal, lastComment, currentState }
     */
    function scrapeEventDetail() {
        const detail = $('event-details');
        if (!detail) return null;

        // Imagen actual
        const img = $('background-image img', detail);
        const imgSrc = img?.getAttribute('src') || null;

        // Slide info
        const slideText = $('.carousel-controls .ng-binding', detail)?.textContent?.trim() || '';
        const slideMatch = slideText.match(/(\d+)\s*\/\s*(\d+)/);
        const imgSlide = slideMatch ? parseInt(slideMatch[1]) : 1;
        const imgTotal = slideMatch ? parseInt(slideMatch[2]) : 1;

        // Nombre cámara desde h3
        const h3 = $('h3.ng-binding', detail);
        const cameraTitle = h3?.getAttribute('title') || h3?.textContent?.trim() || '';

        // Estado actual
        const stateLabel = $('event-state-select .label.event-state', detail);
        const currentState = stateLabel?.getAttribute('title') || stateLabel?.textContent?.trim() || '';

        // Último comentario
        const commentEl = $('event-comment-display', detail);
        let lastComment = null;
        if (commentEl) {
            const user = $('label.ng-binding', commentEl)?.textContent?.trim() || '';
            const time = $('small.ng-binding', commentEl)?.textContent?.trim() || '';
            const text = $('p.ng-binding', commentEl)?.textContent?.trim() || '';
            const tag = $('.tag .ng-binding', commentEl)?.textContent?.trim() || '';
            lastComment = { user, time, text, tag };
        }

        // ID del evento
        const idLink = $('td[data-label="Id"] a.ng-binding', detail);
        const eventId = idLink?.textContent?.trim() || '';

        // Fecha
        const infoRows = $$('table tr', detail);
        let eventDate = '';
        let priority = '';
        for (const tr of infoRows) {
            const label = $('td:first-child', tr)?.textContent?.trim();
            const value = $('td:last-child', tr)?.textContent?.trim();
            if (label === 'Fecha') eventDate = value;
            if (label === 'Prioridad') priority = value;
        }

        return {
            imgSrc, imgSlide, imgTotal,
            cameraTitle, currentState,
            lastComment, eventId,
            eventDate, priority,
        };
    }

    // ═════════════════════════════════════════════════════════════
    // ACCIONES (interacción con DOM nativo)
    // ═════════════════════════════════════════════════════════════

    /** Seleccionar un evento en la ag-Grid (click en la row) */
    function selectEventInGrid(rowIdx) {
        const rows = $$('.ag-center-cols-container .ag-row');
        const targetRow = rows.find(r => parseInt(r.getAttribute('row-index')) === rowIdx);
        if (targetRow) {
            nativeClick(targetRow);
            log('Clicked row', rowIdx);
            return true;
        }
        return false;
    }

    /**
     * Cambiar estado del evento abriendo el select2 y clickeando la opción.
     * Usa el patrón de SOGA para interactuar con el dropdown nativo.
     */
    async function changeState(stateLabel) {
        const selector = $('event-state-select .ui-select-container');
        if (!selector) { toast('Selector no encontrado', 'error'); return false; }

        // Abrir dropdown
        const toggle = $('a.select2-choice, .ui-select-match', selector);
        nativeClick(toggle);
        await new Promise(r => setTimeout(r, 300));

        // Buscar dropdown visible
        const dropdown = $('event-state-select .ui-select-dropdown:not(.select2-display-none)')
            || $('body > .ui-select-dropdown:not(.select2-display-none)');

        if (!dropdown) {
            log('Dropdown no abrió');
            toast('No se pudo abrir selector', 'error');
            return false;
        }

        // Buscar opción por title
        const options = $$('.ui-select-choices-row', dropdown);
        let target = null;
        for (const opt of options) {
            const label = $('[title]', opt);
            if (label?.getAttribute('title') === stateLabel) {
                target = opt;
                break;
            }
        }

        if (!target) {
            // Cerrar dropdown
            document.body.click();
            toast(`Estado "${stateLabel}" no encontrado`, 'error');
            return false;
        }

        nativeClick(target);
        await new Promise(r => setTimeout(r, 200));
        toast(`Estado → ${stateLabel}`, 'success');
        return true;
    }

    /** Seleccionar un comentario predefinido */
    async function selectQuickComment(text) {
        const labels = $$('.label-default-comment');
        for (const label of labels) {
            if (label.textContent.trim() === text) {
                nativeClick(label);
                await new Promise(r => setTimeout(r, 150));
                return true;
            }
        }
        return false;
    }

    /** Escribir texto en el textarea de comentarios */
    function setCommentText(text) {
        const textarea = $('textarea[ng-model="ctrl.comment.content"]');
        if (!textarea) return false;

        const scope = ngScope(textarea);
        if (scope) {
            // Angular way
            textarea.value = text;
            const ngModel = window.angular?.element(textarea).controller('ngModel');
            if (ngModel) {
                ngModel.$setViewValue(text);
                ngModel.$render();
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // Fallback
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    }

    /** Enviar comentario clickeando el botón Enviar */
    async function submitComment() {
        const btn = $('button[ng-click*="addComment"]');
        if (!btn || btn.disabled) {
            toast('Botón enviar no disponible', 'error');
            return false;
        }
        nativeClick(btn);
        await new Promise(r => setTimeout(r, 300));
        toast('Comentario enviado', 'success');
        return true;
    }

    /** Navegar slides del carrusel */
    function navigateSlide(direction) {
        const sel = direction > 0 ? 'a.next' : 'a.prev';
        const btn = $(sel);
        if (btn && !btn.classList.contains('disabled')) {
            nativeClick(btn);
            return true;
        }
        return false;
    }

    // ═════════════════════════════════════════════════════════════
    // RENDER
    // ═════════════════════════════════════════════════════════════

    let root = null;
    let fab = null;

    function renderFAB() {
        if (fab) return;
        fab = document.createElement('button');
        fab.id = 'vmd-fab';
        fab.innerHTML = '📱';
        fab.title = 'Dashboard Móvil';
        fab.addEventListener('click', () => {
            if (state.active) deactivate();
            else activate();
        });
        document.body.appendChild(fab);
    }

    function renderRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'vmd-root';
        root.innerHTML = `
            <div class="vmd-header">
                <div class="vmd-header-left">
                    <button class="vmd-back-btn" id="vmd-back">◂</button>
                    <span class="vmd-dest-name"></span>
                    <span class="vmd-camera-code"></span>
                </div>
                <div class="vmd-header-right">
                    <span class="vmd-badge" id="vmd-count">0</span>
                    <button class="vmd-refresh-btn" id="vmd-refresh" title="Refrescar">⟳</button>
                    <button class="vmd-close-btn" id="vmd-close" title="Cerrar Mobile">✕</button>
                </div>
            </div>
            <div class="vmd-list" id="vmd-list"></div>
            <div class="vmd-detail" id="vmd-detail">
                <div class="vmd-img-container" id="vmd-img-wrap">
                    <div class="vmd-img-placeholder">Cargando imagen...</div>
                </div>
                <div class="vmd-detail-body" id="vmd-detail-body"></div>
            </div>
            <div class="vmd-status-bar">
                <span><span class="vmd-status-dot live" id="vmd-dot"></span>
                <span id="vmd-status-text">Conectado</span></span>
                <span id="vmd-last-update">—</span>
            </div>
        `;
        document.body.appendChild(root);

        // Event handlers
        $('#vmd-back', root).addEventListener('click', goBackToList);
        $('#vmd-refresh', root).addEventListener('click', manualRefresh);
        $('#vmd-close', root).addEventListener('click', deactivate);
    }

    function renderEventList() {
        const list = $('#vmd-list', root);
        if (!list) return;

        state.events = scrapeEvents();
        state.destacamento = scrapeDestacamento();

        // Update header
        $('.vmd-dest-name', root).textContent = state.destacamento;
        $('#vmd-count', root).textContent = state.events.length;

        if (state.events.length === 0) {
            list.innerHTML = `
                <div class="vmd-empty">
                    <div class="vmd-empty-icon">📋</div>
                    <div class="vmd-empty-text">Sin eventos pendientes</div>
                </div>`;
            return;
        }

        list.innerHTML = state.events.map((ev, i) => `
            <div class="vmd-event-card ${ev.isUnread ? 'unread' : ''}"
                 data-idx="${i}" data-rowidx="${ev.rowIdx}">
                <div class="vmd-priority-strip" style="background:${sanitize(ev.prioColor)}"></div>
                <div class="vmd-card-body">
                    <div class="vmd-card-row1">
                        <span class="vmd-card-type">${sanitize(ev.tipo)}</span>
                        <span class="vmd-card-time">${sanitize(ev.fecha)}</span>
                    </div>
                    <div class="vmd-card-row2">
                        <span class="vmd-card-camera">${sanitize(ev.camera)}</span>
                        <span class="vmd-card-state"
                              style="background:${sanitize(ev.estadoBg)};color:${sanitize(ev.estadoColor)}"
                        >${sanitize(ev.estadoText)}</span>
                    </div>
                </div>
            </div>
        `).join('');

        // Click handlers
        $$('.vmd-event-card', list).forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx);
                const rowIdx = parseInt(card.dataset.rowidx);
                openEventDetail(idx, rowIdx);
            });
        });

        // Update status
        state.lastRefresh = new Date();
        updateStatus();
    }

    async function openEventDetail(idx, rowIdx) {
        state.selectedIdx = idx;
        state.view = 'detail';
        root.classList.add('vmd-detail-active');

        const ev = state.events[idx];
        if (!ev) return;

        // Click en la fila original para cargar el detalle
        selectEventInGrid(rowIdx);

        // Header
        const code = ev.camera.split('|').pop()?.trim() || ev.camera;
        $('.vmd-camera-code', root).textContent = `${ev.tipo} — ${code}`;

        // Mostrar loading
        const imgWrap = $('#vmd-img-wrap', root);
        imgWrap.innerHTML = '<div class="vmd-loading-bar"></div><div class="vmd-img-placeholder">Cargando imagen...</div>';
        $('#vmd-detail-body', root).innerHTML = '';

        // Esperar a que el panel se cargue
        await waitForDetail();

        // Leer datos del panel
        renderDetailContent();
    }

    function waitForDetail(timeout = 5000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const img = $('background-image img');
                const detail = $('event-details');
                if ((img && img.src) || (Date.now() - start > timeout)) {
                    setTimeout(resolve, 300); // Extra delay for render
                    return;
                }
                if (detail && (Date.now() - start > 2000)) {
                    setTimeout(resolve, 200);
                    return;
                }
                setTimeout(check, 250);
            };
            check();
        });
    }

    function renderDetailContent() {
        const data = scrapeEventDetail();
        if (!data) {
            $('#vmd-detail-body', root).innerHTML =
                '<div class="vmd-empty"><div class="vmd-empty-text">No se pudo cargar el detalle</div></div>';
            return;
        }

        // ── Imagen ──
        const imgWrap = $('#vmd-img-wrap', root);
        if (data.imgSrc) {
            imgWrap.innerHTML = `
                <img src="${sanitize(data.imgSrc)}" alt="Alerta">
                ${data.imgTotal > 1 ? `
                    <button class="vmd-img-nav vmd-img-prev" id="vmd-prev">◂</button>
                    <button class="vmd-img-nav vmd-img-next" id="vmd-next">▸</button>
                ` : ''}
                <span class="vmd-img-counter">${data.imgSlide} / ${data.imgTotal}</span>
            `;
            // Nav handlers
            if (data.imgTotal > 1) {
                $('#vmd-prev', imgWrap)?.addEventListener('click', async () => {
                    navigateSlide(-1);
                    await new Promise(r => setTimeout(r, 600));
                    renderDetailContent();
                });
                $('#vmd-next', imgWrap)?.addEventListener('click', async () => {
                    navigateSlide(1);
                    await new Promise(r => setTimeout(r, 600));
                    renderDetailContent();
                });
            }
        } else {
            imgWrap.innerHTML = '<div class="vmd-img-placeholder">Sin imagen disponible</div>';
        }

        // ── Detail body ──
        const body = $('#vmd-detail-body', root);

        // Info table
        const ev = state.events[state.selectedIdx];
        const currentStateDef = ESTADOS.find(e => e.label === data.currentState);

        let html = `
            <div class="vmd-detail-info">
                <span class="vmd-detail-label">Tipo</span>
                <span class="vmd-detail-value">${sanitize(ev?.tipo || '')}</span>
                <span class="vmd-detail-label">Cámara</span>
                <span class="vmd-detail-value">${sanitize(data.cameraTitle || ev?.camera || '')}</span>
                <span class="vmd-detail-label">Fecha</span>
                <span class="vmd-detail-value">${sanitize(data.eventDate || ev?.fecha || '')}</span>
                <span class="vmd-detail-label">Estado</span>
                <span class="vmd-detail-value">
                    <span class="vmd-card-state"
                          style="background:${currentStateDef?.bg || ev?.estadoBg || '#888'};
                                 color:${currentStateDef?.color || '#fff'}"
                    >${sanitize(data.currentState || ev?.estadoText || '')}</span>
                </span>
            </div>
        `;

        // ── Estados ──
        html += `
            <div>
                <div class="vmd-section-title">Cambiar estado</div>
                <div class="vmd-states-grid">
                    ${ESTADOS.map(st => `
                        <button class="vmd-state-btn ${st.label === data.currentState ? 'active' : ''}"
                                data-state="${sanitize(st.label)}"
                                style="background:${st.bg};color:${st.color};border-color:${st.border}">
                            ${sanitize(st.short)}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        // ── Comentarios rápidos ──
        html += `
            <div>
                <div class="vmd-section-title">Comentario rápido</div>
                <div class="vmd-comments-grid">
                    ${COMENTARIOS.map(c => `
                        <button class="vmd-comment-btn" data-comment="${sanitize(c)}">${sanitize(c)}</button>
                    `).join('')}
                </div>
            </div>
            <div class="vmd-comment-input-row">
                <textarea class="vmd-comment-textarea" placeholder="Comentario libre..." rows="2"
                          maxlength="300"></textarea>
                <button class="vmd-send-btn" id="vmd-send" disabled>Enviar</button>
            </div>
        `;

        // ── Último comentario ──
        if (data.lastComment) {
            html += `
                <div class="vmd-last-comment">
                    <span class="vmd-last-comment-user">${sanitize(data.lastComment.user)}</span>
                    <span class="vmd-last-comment-time">${sanitize(data.lastComment.time)}</span>
                    ${data.lastComment.tag ? `<span class="vmd-card-state" style="background:#2a2d35;color:#8ab4f8;margin-left:8px;font-size:11px">${sanitize(data.lastComment.tag)}</span>` : ''}
                    <div class="vmd-last-comment-text">${sanitize(data.lastComment.text)}</div>
                </div>
            `;
        }

        body.innerHTML = html;

        // ── Handlers estados ──
        $$('.vmd-state-btn', body).forEach(btn => {
            btn.addEventListener('click', async () => {
                const stateLabel = btn.dataset.state;
                btn.style.opacity = '0.5';
                const ok = await changeState(stateLabel);
                if (ok) {
                    await new Promise(r => setTimeout(r, 500));
                    renderDetailContent();
                } else {
                    btn.style.opacity = '1';
                }
            });
        });

        // ── Handlers comentarios rápidos ──
        let selectedComment = null;
        $$('.vmd-comment-btn', body).forEach(btn => {
            btn.addEventListener('click', async () => {
                // Deseleccionar previo
                $$('.vmd-comment-btn.selected', body).forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedComment = btn.dataset.comment;

                // Aplicar al DOM nativo
                await selectQuickComment(selectedComment);

                // Actualizar textarea visual
                const ta = $('.vmd-comment-textarea', body);
                if (ta) ta.value = selectedComment;

                // Habilitar enviar
                const sendBtn = $('#vmd-send', body);
                if (sendBtn) sendBtn.disabled = false;
            });
        });

        // ── Textarea libre ──
        const textarea = $('.vmd-comment-textarea', body);
        const sendBtn = $('#vmd-send', body);
        if (textarea && sendBtn) {
            textarea.addEventListener('input', () => {
                const hasText = textarea.value.trim().length > 0;
                sendBtn.disabled = !hasText;
                if (hasText) {
                    // Deseleccionar quick comments
                    $$('.vmd-comment-btn.selected', body).forEach(b => b.classList.remove('selected'));
                    selectedComment = null;
                    // Aplicar al DOM nativo
                    setCommentText(textarea.value.trim());
                }
            });

            sendBtn.addEventListener('click', async () => {
                sendBtn.disabled = true;
                sendBtn.textContent = '...';

                // Si hay quick comment seleccionado, usarlo
                if (selectedComment) {
                    await selectQuickComment(selectedComment);
                } else {
                    setCommentText(textarea.value.trim());
                }

                await new Promise(r => setTimeout(r, 200));
                const ok = await submitComment();

                sendBtn.textContent = 'Enviar';
                if (ok) {
                    textarea.value = '';
                    selectedComment = null;
                    $$('.vmd-comment-btn.selected', body).forEach(b => b.classList.remove('selected'));
                    await new Promise(r => setTimeout(r, 800));
                    renderDetailContent();
                }
            });
        }
    }

    function goBackToList() {
        state.view = 'list';
        state.selectedIdx = -1;
        root.classList.remove('vmd-detail-active');
        renderEventList();
    }

    function updateStatus() {
        const dot = $('#vmd-dot', root);
        const text = $('#vmd-status-text', root);
        const ts = $('#vmd-last-update', root);

        if (state.lastRefresh) {
            dot.className = 'vmd-status-dot live';
            text.textContent = 'Conectado';
            const t = state.lastRefresh;
            ts.textContent = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
        }
    }

    function manualRefresh() {
        const btn = $('#vmd-refresh', root);
        btn.classList.add('spinning');
        setTimeout(() => btn.classList.remove('spinning'), 800);

        if (state.view === 'list') {
            renderEventList();
        } else {
            renderDetailContent();
        }
    }

    // ═════════════════════════════════════════════════════════════
    // AUTO-REFRESH
    // ═════════════════════════════════════════════════════════════

    function startRefresh() {
        stopRefresh();
        state.refreshTimer = setInterval(() => {
            if (!state.active) return;
            if (state.view === 'list') {
                renderEventList();
            }
            // En detail view no auto-refresh para no interrumpir al operador
        }, CONFIG.REFRESH_INTERVAL);
    }

    function stopRefresh() {
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
            state.refreshTimer = null;
        }
    }

    // ═════════════════════════════════════════════════════════════
    // ACTIVACIÓN / DESACTIVACIÓN
    // ═════════════════════════════════════════════════════════════

    function activate() {
        state.active = true;
        GM_addStyle(MOBILE_CSS);
        renderRoot();
        root.style.display = 'flex';
        fab.classList.add('vmd-hidden');
        state.view = 'list';
        root.classList.remove('vmd-detail-active');
        renderEventList();
        startRefresh();
        log('Activado');
    }

    function deactivate() {
        state.active = false;
        stopRefresh();
        if (root) root.style.display = 'none';
        if (fab) fab.classList.remove('vmd-hidden');
        state.view = 'list';
        state.selectedIdx = -1;
        log('Desactivado');
    }

    // ═════════════════════════════════════════════════════════════
    // INIT
    // ═════════════════════════════════════════════════════════════

    function init() {
        // Solo activar en la página del dashboard de eventos
        if (!location.href.includes('/events/dashboard/')) {
            log('No es dashboard de eventos, skip');
            return;
        }

        // Esperar a que ag-Grid tenga rows
        const waitGrid = () => {
            if ($('.ag-center-cols-container .ag-row')) {
                log('ag-Grid detectado, inicializando...');
                setup();
            } else {
                setTimeout(waitGrid, 1000);
            }
        };
        waitGrid();
    }

    function setup() {
        renderFAB();

        // Auto-activar en móvil
        if (window.innerWidth <= CONFIG.AUTO_ACTIVATE_WIDTH) {
            setTimeout(activate, 500);
        }

        // Escuchar cambios de tamaño
        window.addEventListener('resize', () => {
            if (window.innerWidth <= CONFIG.AUTO_ACTIVATE_WIDTH && !state.active) {
                activate();
            }
        });

        log('✅ Mobile Dashboard listo');
    }

    // Esperar a que la página esté lista
    if (document.readyState === 'complete') {
        setTimeout(init, 1500);
    } else {
        window.addEventListener('load', () => setTimeout(init, 1500));
    }

})();