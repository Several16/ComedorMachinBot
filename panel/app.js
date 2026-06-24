/* ═══════════════════════════════════════════════════════════════
   ComedorMachinBot — Premium Dashboard Application
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────
    const CONFIG = {
        WORKERS_REFRESH_INTERVAL: 30, // seconds
        HISTORY_REFRESH_INTERVAL: 60, // seconds
        STATS_REFRESH_INTERVAL: 45,   // seconds
        TIMEZONE: 'America/Lima',
        TOAST_DURATION: 4000,
        COUNTER_ANIMATION_DURATION: 800,
    };

    // ── State ──────────────────────────────────────────────────
    const state = {
        panelKey: localStorage.getItem('PANEL_KEY') || '',
        workers: [],
        accounts: [],
        history: [],
        stats: {},
        timers: {
            workers: CONFIG.WORKERS_REFRESH_INTERVAL,
            history: CONFIG.HISTORY_REFRESH_INTERVAL,
        },
        intervals: {},
        connected: false,
        startTime: Date.now(),
        accountsPage: 1,
        accountsPerPage: 10,
        searchQuery: '',
        groupFilter: '',
    };

    // ── DOM References ─────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const DOM = {
        authOverlay: $('#authOverlay'),
        authForm: $('#authForm'),
        authKeyInput: $('#authKeyInput'),
        confirmModal: $('#confirmModal'),
        modalIcon: $('#modalIcon'),
        modalTitle: $('#modalTitle'),
        modalMessage: $('#modalMessage'),
        modalCancel: $('#modalCancel'),
        modalConfirm: $('#modalConfirm'),
        transferModal: $('#transferModal'),
        transferTargetUser: $('#transferTargetUser'),
        transferModalCancel: $('#transferModalCancel'),
        transferModalConfirm: $('#transferModalConfirm'),
        toastContainer: $('#toastContainer'),
        currentTime: $('#currentTime'),
        connectionStatus: $('#connectionStatus'),
        logoutBtn: $('#logoutBtn'),
        workersGrid: $('#workersGrid'),
        workersTimer: $('#workersTimer'),
        refreshWorkersBtn: $('#refreshWorkersBtn'),
        statsGrid: $('#statsGrid'),
        statAccounts: $('#statAccounts'),
        statSuccessRate: $('#statSuccessRate'),
        statCupos: $('#statCupos'),
        statJobs: $('#statJobs'),
        addAccountForm: $('#addAccountForm'),
        inputDni: $('#inputDni'),
        inputCode: $('#inputCode'),
        inputName: $('#inputName'),
        inputGroup: $('#inputGroup'),
        inputUser: $('#inputUser'),
        bulkImportBtn: $('#bulkImportBtn'),
        bulkImportText: $('#bulkImportText'),
        accountsBody: $('#accountsBody'),
        accountsCount: $('#accountsCount'),
        searchAccountInput: $('#searchAccountInput'),
        searchScheduleInput: $('#searchScheduleInput'),
        groupFilterSelect: $('#groupFilterSelect'),
        prevPageBtn: $('#prevPageBtn'),
        nextPageBtn: $('#nextPageBtn'),
        pageIndicator: $('#pageIndicator'),
        historyList: $('#historyList'),
        historyTimer: $('#historyTimer'),
        refreshHistoryBtn: $('#refreshHistoryBtn'),
        executeBtn: $('#executeBtn'),
        cronExpression: $('#cronExpression'),
        nextExecution: $('#nextExecution'),
        healthCheckBtn: $('#healthCheckBtn'),
        systemUptime: $('#systemUptime'),
        // Group Popover
        groupPopover: $('#groupPopover'),
        popoverGroupList: $('#popoverGroupList'),
        popoverNewGroup: $('#popoverNewGroup'),
        popoverSaveBtn: $('#popoverSaveBtn'),
    };

    // ── API Helper ─────────────────────────────────────────────
    async function api(method, path, body = null) {
        const opts = {
            method,
            headers: {
                'x-admin-key': state.panelKey,
                'Content-Type': 'application/json',
            },
        };
        if (body) opts.body = JSON.stringify(body);

        try {
            const res = await fetch(path, opts);
            if (res.status === 401 || res.status === 403) {
                showAuthOverlay();
                throw new Error('Unauthorized');
            }
            const data = await res.json();
            setConnected(true);
            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            if (err.message !== 'Unauthorized') {
                setConnected(false);
            }
            throw err;
        }
    }

    // ── Auth ───────────────────────────────────────────────────
    function showAuthOverlay() {
        DOM.authOverlay.classList.remove('hidden');
        DOM.authKeyInput.value = '';
        DOM.authKeyInput.focus();
    }

    function hideAuthOverlay() {
        DOM.authOverlay.classList.add('hidden');
    }

    function initAuth() {
        if (!state.panelKey) {
            showAuthOverlay();
        } else {
            hideAuthOverlay();
            initDashboard();
        }

        DOM.authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const key = DOM.authKeyInput.value.trim();
            if (!key) return;

            state.panelKey = key;
            localStorage.setItem('PANEL_KEY', key);

            try {
                await api('GET', '/api/dashboard/stats');
                hideAuthOverlay();
                toast('success', 'Conectado', 'Autenticación exitosa');
                initDashboard();
            } catch {
                localStorage.removeItem('PANEL_KEY');
                state.panelKey = '';
                toast('error', 'Error', 'Clave inválida');
                showAuthOverlay();
            }
        });

        DOM.logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('PANEL_KEY');
            state.panelKey = '';
            clearAllIntervals();
            showAuthOverlay();
        });
    }

    // ── Connection Status ──────────────────────────────────────
    function setConnected(status) {
        state.connected = status;
        const el = DOM.connectionStatus;
        const txt = el.querySelector('.status-text');
        if (status) {
            el.classList.remove('offline');
            txt.textContent = 'Conectado';
        } else {
            el.classList.add('offline');
            txt.textContent = 'Desconectado';
        }
    }

    // ── Clock ──────────────────────────────────────────────────
    function updateClock() {
        const now = new Date();
        DOM.currentTime.textContent = now.toLocaleTimeString('es-PE', {
            timeZone: CONFIG.TIMEZONE,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    function updateUptime() {
        const diff = Math.floor((Date.now() - state.startTime) / 1000);
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        const s = diff % 60;
        DOM.systemUptime.textContent = `${h}h ${m}m ${s}s`;
    }

    // ── Toast Notifications ────────────────────────────────────
    function toast(type, title, message) {
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `
            <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
            <div class="toast-body">
                <div class="toast-title">${escapeHtml(title)}</div>
                <div class="toast-message">${escapeHtml(message)}</div>
            </div>
        `;
        el.addEventListener('click', () => el.remove());
        DOM.toastContainer.appendChild(el);

        setTimeout(() => {
            if (el.parentNode) el.remove();
        }, CONFIG.TOAST_DURATION);
    }

    // ── Confirmation Modal ─────────────────────────────────────
    function confirm(icon, title, message, btnClass = 'btn-danger') {
        return new Promise((resolve) => {
            DOM.modalIcon.textContent = icon;
            DOM.modalTitle.textContent = title;
            DOM.modalMessage.textContent = message;
            DOM.modalConfirm.className = `btn ${btnClass}`;
            DOM.confirmModal.classList.remove('hidden');

            function cleanup() {
                DOM.confirmModal.classList.add('hidden');
                DOM.modalCancel.removeEventListener('click', onCancel);
                DOM.modalConfirm.removeEventListener('click', onConfirm);
            }

            function onCancel() { cleanup(); resolve(false); }
            function onConfirm() { cleanup(); resolve(true); }

            DOM.modalCancel.addEventListener('click', onCancel);
            DOM.modalConfirm.addEventListener('click', onConfirm);
        });
    }

    // ── Edit Group Modal ───────────────────────────────────────
    // ── Group Popover ──────────────────────────────────────────
    let activePopoverResolve = null;

    function openGroupPopover(targetEl, currentGroup, allGroups) {
        return new Promise((resolve) => {
            if (activePopoverResolve) {
                activePopoverResolve(null);
                closeGroupPopover();
            }
            activePopoverResolve = resolve;

            // Position popover
            const rect = targetEl.getBoundingClientRect();
            DOM.groupPopover.style.top = `${rect.bottom + window.scrollY + 8}px`;
            DOM.groupPopover.style.left = `${rect.left + window.scrollX}px`;

            // Populate list
            DOM.popoverGroupList.innerHTML = allGroups.map(g => `
                <div class="popover-item" data-group="${escapeHtml(g)}">${escapeHtml(g)}</div>
            `).join('');

            // Click on existing group
            DOM.popoverGroupList.querySelectorAll('.popover-item').forEach(item => {
                item.onclick = () => {
                    resolve(item.dataset.group);
                    closeGroupPopover();
                };
            });

            DOM.popoverNewGroup.value = currentGroup === 'Sin Grupo' ? '' : currentGroup;
            DOM.groupPopover.classList.remove('hidden');
            DOM.popoverNewGroup.focus();

            DOM.popoverSaveBtn.onclick = () => {
                resolve(DOM.popoverNewGroup.value);
                closeGroupPopover();
            };

            DOM.popoverNewGroup.onkeyup = (e) => {
                if (e.key === 'Enter') DOM.popoverSaveBtn.click();
                if (e.key === 'Escape') {
                    resolve(null);
                    closeGroupPopover();
                }
            };
        });
    }

    function closeGroupPopover() {
        DOM.groupPopover.classList.add('hidden');
        activePopoverResolve = null;
    }

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
        if (!DOM.groupPopover.classList.contains('hidden')) {
            if (!DOM.groupPopover.contains(e.target) && !e.target.classList.contains('clickable-group')) {
                if (activePopoverResolve) activePopoverResolve(null);
                closeGroupPopover();
            }
        }
    });

    // ── Animated Counter ───────────────────────────────────────
    function animateCounter(el, targetValue, suffix = '') {
        const startValue = parseInt(el.textContent) || 0;
        const target = parseInt(targetValue) || 0;
        if (startValue === target) {
            el.textContent = target + suffix;
            return;
        }

        const duration = CONFIG.COUNTER_ANIMATION_DURATION;
        const startTime = performance.now();
        const diff = target - startValue;

        function step(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3); // ease out cubic
            const current = Math.round(startValue + diff * eased);
            el.textContent = current + suffix;
            if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // ── Workers ────────────────────────────────────────────────
    async function fetchWorkers() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/workers');
            if (ok) {
                state.workers = data.workers || data || [];
                renderWorkers();
            }
        } catch (err) {
            console.error('Workers fetch error:', err);
        }
    }

    function renderWorkers() {
        const workers = state.workers;
        if (!workers || workers.length === 0) {
            DOM.workersGrid.innerHTML = `
                <div class="worker-card glass-card offline" style="grid-column: 1/-1">
                    <div class="empty-state">
                        <div class="empty-state-icon">🖥️</div>
                        <div class="empty-state-text">No hay workers configurados</div>
                    </div>
                </div>`;
            return;
        }

        DOM.workersGrid.innerHTML = workers.map((w, i) => {
            const online = w.online || w.status === 'online' || w.status === 'ok' || w.healthy === true;
            const statusClass = online ? 'online' : 'offline';
            const statusText = online ? '🟢 Online' : '🔴 Offline';
            const name = w.name || w.label || `Worker ${i + 1}`;
            const ip = w.ip || w.host || w.url || '—';
            const uptime = w.uptime || '—';
            const lastResult = w.lastResult || w.last_result || w.lastExecution || null;

            let resultHtml = '';
            if (lastResult) {
                let resultClass, resultText;
                if (typeof lastResult.successes !== 'undefined') {
                    resultClass = lastResult.successes === lastResult.total ? 'success' : (lastResult.successes > 0 ? 'warning' : 'error');
                    resultText = `${lastResult.successes}/${lastResult.total} Éxitos`;
                } else {
                    resultClass = lastResult.success ? 'success' : (lastResult.error ? 'error' : 'idle');
                    resultText = lastResult.message || lastResult.status || (lastResult.success ? 'Éxito' : 'Error');
                }
                resultHtml = `<div class="worker-result ${resultClass}">${escapeHtml(resultText)}</div>`;
            } else {
                resultHtml = `<div class="worker-result idle">Sin ejecuciones</div>`;
            }

            return `
                <div class="worker-card glass-card ${statusClass} fade-in" style="animation-delay: ${i * 0.08}s">
                    <div class="worker-header">
                        <span class="worker-name">${escapeHtml(name)}</span>
                        <span class="worker-status-badge ${statusClass}">${statusText}</span>
                    </div>
                    <div class="worker-detail">
                        <span class="worker-detail-label">IP</span>
                        <span class="worker-detail-value">${escapeHtml(String(ip))}</span>
                    </div>
                    <div class="worker-detail">
                        <span class="worker-detail-label">Uptime</span>
                        <span class="worker-detail-value">${escapeHtml(String(uptime))}</span>
                    </div>
                    ${resultHtml}
                </div>`;
        }).join('');
    }

    // ── Stats ──────────────────────────────────────────────────
    async function fetchStats() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/stats');
            if (ok) {
                state.stats = data;
                renderStats();
            }
        } catch (err) {
            console.error('Stats fetch error:', err);
        }
    }

    function renderStats() {
        const s = state.stats;
        const accounts = s.totalAccounts ?? s.accounts ?? 0;
        const rate = s.successRate ?? s.success_rate ?? 0;
        const cupos = s.cuposToday ?? s.cupos ?? s.totalCupos ?? 0;
        const jobs = s.activeJobs ?? s.jobs ?? s.active_jobs ?? 0;

        animateCounter(DOM.statAccounts, accounts);
        animateCounter(DOM.statSuccessRate, rate, '%');
        animateCounter(DOM.statCupos, cupos);
        animateCounter(DOM.statJobs, jobs);

        // Cron info
        if (s.cronExpression || s.cron) {
            DOM.cronExpression.textContent = s.cronExpression || s.cron;
        }
        if (s.nextExecution || s.next_execution) {
            const next = new Date(s.nextExecution || s.next_execution);
            DOM.nextExecution.textContent = next.toLocaleString('es-PE', {
                timeZone: CONFIG.TIMEZONE,
                dateStyle: 'short',
                timeStyle: 'short',
            });
        }
    }

    // ── Accounts ───────────────────────────────────────────────
    async function fetchAccounts() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/accounts');
            if (ok) {
                state.accounts = data.accounts || data || [];
                renderAccounts();
            }
        } catch (err) {
            console.error('Accounts fetch error:', err);
        }
    }

    function renderAccounts() {
        let accounts = state.accounts || [];

        // Update group dropdown options
        const groups = [...new Set(accounts.map(a => a.grupo || 'Sin Grupo'))].sort();
        const currentGroup = state.groupFilter;
        DOM.groupFilterSelect.innerHTML = '<option value="">Todos los grupos</option>' + 
            groups.map(g => `<option value="${escapeHtml(g)}"${currentGroup === g ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('');

        // Apply group filter
        if (state.groupFilter) {
            accounts = accounts.filter(a => (a.grupo || 'Sin Grupo') === state.groupFilter);
        }

        // Apply search filter
        if (state.searchQuery) {
            const q = state.searchQuery.toLowerCase();
            accounts = accounts.filter(a => 
                (a.nombre && a.nombre.toLowerCase().includes(q)) || 
                (a.dni && String(a.dni).includes(q)) || 
                (a.codigo && String(a.codigo).includes(q))
            );
        }

        const totalFiltered = accounts.length;
        const totalPages = Math.ceil(totalFiltered / state.accountsPerPage) || 1;
        
        // Ensure page is within bounds
        if (state.accountsPage > totalPages) state.accountsPage = totalPages;
        if (state.accountsPage < 1) state.accountsPage = 1;

        // Apply pagination
        const startIndex = (state.accountsPage - 1) * state.accountsPerPage;
        const paginatedAccounts = accounts.slice(startIndex, startIndex + state.accountsPerPage);

        // Update UI counters and buttons
        DOM.accountsCount.textContent = `${totalFiltered} cuenta${totalFiltered !== 1 ? 's' : ''}`;
        DOM.pageIndicator.textContent = `Página ${state.accountsPage} de ${totalPages}`;
        DOM.prevPageBtn.disabled = state.accountsPage <= 1;
        DOM.nextPageBtn.disabled = state.accountsPage >= totalPages;

        if (totalFiltered === 0) {
            DOM.accountsBody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <div class="empty-state-icon">📋</div>
                            <div class="empty-state-text">${state.searchQuery ? 'No se encontraron resultados' : 'No hay cuentas registradas'}</div>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        DOM.accountsBody.innerHTML = paginatedAccounts.map((a, i) => {
            const dni = a.dni || a.DNI || '—';
            const code = a.codigo || a.code || a.Code || '—';
            const name = a.nombre || a.name || a.Name || '—';
            const grupo = a.grupo || 'Sin Grupo';
            const status = a.status || a.estado || a.lastStatus || null;

            const isActive = a.active !== false;

            let badgeHtml = '<span class="badge badge-neutral">—</span>';
            if (status) {
                const s = String(status).toLowerCase();
                if (s.includes('success') || s.includes('éxito') || s.includes('ok') || s.includes('reserv')) {
                    badgeHtml = `<span class="badge badge-success">${escapeHtml(status)}</span>`;
                } else if (s.includes('error') || s.includes('fail') || s.includes('fallo')) {
                    badgeHtml = `<span class="badge badge-error">${escapeHtml(status)}</span>`;
                } else {
                    badgeHtml = `<span class="badge badge-warning">${escapeHtml(status)}</span>`;
                }
            }
            
            const toggleHtml = `
                <label class="toggle-switch" title="Activar/Desactivar cuenta">
                    <input type="checkbox" class="account-toggle" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}" ${isActive ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            `;

            return `
                <tr class="fade-in ${isActive ? '' : 'inactive-row'}" style="animation-delay: ${i * 0.03}s" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}">
                    <td>
                        <input type="number" class="form-input order-input" value="${state.accounts.findIndex(acc => String(acc.dni || acc.DNI) === String(dni)) + 1}" min="1" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}" style="width: 50px; text-align: center; padding: 0.2rem; height: auto;" title="Posición global">
                    </td>
                    <td>${escapeHtml(String(dni))}</td>
                    <td>${escapeHtml(String(code))}</td>
                    <td>${escapeHtml(String(name))}</td>
                    <td><span class="badge badge-neutral clickable-group" style="cursor: pointer;" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}" data-current-group="${escapeHtml(String(grupo))}" title="Clic para cambiar grupo">${escapeHtml(String(grupo))}</span></td>
                    <td>${badgeHtml}</td>
                    <td>
                        <div style="display: flex; gap: 0.5rem; align-items: center; justify-content: flex-end;">
                            ${toggleHtml}
                            <button class="btn-transfer-sm" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}" title="Transferir cuenta" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--primary); padding: 0 4px;">⇄</button>
                            <button class="btn-delete-sm" data-dni="${escapeHtml(String(dni))}" data-chatid="${escapeHtml(String(a.chatId || 'any'))}" title="Eliminar cuenta">
                                ✕
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join('');

        // Attach delete handlers
        DOM.accountsBody.querySelectorAll('.btn-delete-sm').forEach(btn => {
            btn.addEventListener('click', () => deleteAccount(btn.dataset.chatid || 'any', btn.dataset.dni));
        });

        // Attach transfer handlers
        DOM.accountsBody.querySelectorAll('.btn-transfer-sm').forEach(btn => {
            btn.addEventListener('click', () => openTransferModal(btn.dataset.chatid || 'any', btn.dataset.dni));
        });

        // Attach toggle handlers
        DOM.accountsBody.querySelectorAll('.account-toggle').forEach(chk => {
            chk.addEventListener('change', async (e) => {
                const dni = e.target.dataset.dni;
                const chatId = e.target.dataset.chatid || 'any';
                const active = e.target.checked;
                
                try {
                    const res = await api('POST', '/api/dashboard/accounts/toggle', { chatId, dni, active });
                    if (!res.ok) {
                        e.target.checked = !active; // revert
                        toast('error', 'Error', res.data.message || 'No se pudo cambiar el estado.');
                    } else {
                        // Optimistically update local state so pagination doesn't break
                        const acc = state.accounts.find(a => String(a.dni) === String(dni));
                        if (acc) acc.active = active;
                        
                        const row = e.target.closest('tr');
                        if (active) row.classList.remove('inactive-row');
                        else row.classList.add('inactive-row');
                    }
                } catch (err) {
                    e.target.checked = !active; // revert
                    toast('error', 'Error', 'Error de red.');
                }
            });
        });

        // Attach interactive handlers (Order and Group)
        attachInteractiveHandlers();
    }

    function attachInteractiveHandlers() {
        // Handle Group Editing
        DOM.accountsBody.querySelectorAll('.clickable-group').forEach(badge => {
            badge.addEventListener('click', async function() {
                const chatId = this.dataset.chatid;
                const dni = this.dataset.dni;
                const currentGroup = this.dataset.currentGroup || 'Sin Grupo';
                
                // Get all existing unique groups
                const allAccounts = state.accounts || [];
                const allGroups = [...new Set(allAccounts.map(a => a.grupo).filter(g => g && g !== 'Sin Grupo'))].sort();
                
                const newGroup = await openGroupPopover(this, currentGroup, allGroups);

                if (newGroup !== null) {
                    const trimmedGroup = newGroup.trim();
                    try {
                        const { ok, data } = await api('PUT', '/api/dashboard/accounts/group', { chatId, dni, grupo: trimmedGroup });
                        if (ok) {
                            toast('success', 'Grupo actualizado', `La cuenta ahora está en ${trimmedGroup || 'Sin Grupo'}`);
                            fetchAccounts(); // Refresh
                        } else {
                            toast('error', 'Error', data.message || 'No se pudo actualizar el grupo');
                        }
                    } catch (err) {
                        toast('error', 'Error de conexión', 'No se pudo actualizar el grupo');
                    }
                }
            });
        });

        // Handle Numeric Reordering
        DOM.accountsBody.querySelectorAll('.order-input').forEach(input => {
            const handleOrderChange = async function() {
                const chatId = this.dataset.chatid;
                const dni = this.dataset.dni;
                
                // Absolute global indices
                const currentGlobalIdx = state.accounts.findIndex(a => String(a.dni || a.DNI) === String(dni));
                const targetGlobalIdx = parseInt(this.value, 10) - 1; // 0-based
                
                if (targetGlobalIdx === currentGlobalIdx || targetGlobalIdx < 0 || targetGlobalIdx >= state.accounts.length) {
                    this.value = currentGlobalIdx + 1; // Revert
                    return;
                }

                // Check if target global position belongs to the SAME chatId
                const targetAccount = state.accounts[targetGlobalIdx];
                if (String(targetAccount.chatId || 'any') !== String(chatId)) {
                    toast('error', 'Movimiento inválido', 'No puedes mezclar cuentas entre diferentes usuarios. Mantén el orden dentro del bloque de tu propio usuario.');
                    this.value = currentGlobalIdx + 1; // Revert
                    return;
                }
                
                // Get local arrays for this user
                const userAccounts = state.accounts.filter(a => String(a.chatId || 'any') === String(chatId));
                const currentLocalIdx = userAccounts.findIndex(a => String(a.dni || a.DNI) === String(dni));
                const targetLocalIdx = userAccounts.findIndex(a => String(a.dni || a.DNI) === String(targetAccount.dni || targetAccount.DNI));

                // Get current order of DNIS for this user
                let order = userAccounts.map(a => String(a.dni || a.DNI));
                
                // Perform local swap/move
                const [movedDni] = order.splice(currentLocalIdx, 1);
                order.splice(targetLocalIdx, 0, movedDni);

                try {
                    const { ok, data } = await api('POST', '/api/dashboard/accounts/reorder', { chatId, order });
                    if (ok) {
                        toast('success', 'Orden guardado', 'Las cuentas han sido reordenadas');
                        fetchAccounts(); // Refresh to sync state
                    } else {
                        toast('error', 'Error', data.error || data.message || 'No se pudo guardar el orden');
                        fetchAccounts(); // Revert
                    }
                } catch (err) {
                    toast('error', 'Error de conexión', 'No se pudo guardar el orden');
                    fetchAccounts(); // Revert
                }
            };

            input.addEventListener('change', handleOrderChange);
            input.addEventListener('keyup', (e) => {
                if (e.key === 'Enter') handleOrderChange.call(input);
            });
        });
    }

    async function fetchUsers() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/users');
            if (ok && data.users) {
                // Populate user select
                if (DOM.inputUser) {
                    DOM.inputUser.innerHTML = '<option value="" disabled selected>Seleccione un usuario...</option>';
                    data.users.forEach(u => {
                        const name = u.firstName || u.username || 'Usuario Anónimo';
                        const option = document.createElement('option');
                        option.value = u.chatId;
                        option.textContent = `${name} (${u.chatId}) - ${u.accountCount} cuentas`;
                        DOM.inputUser.appendChild(option);
                    });
                    if (data.users.length > 0) {
                        DOM.inputUser.selectedIndex = 1; // Default to first user
                    }
                }
            }
        } catch (e) {
            console.error('Error fetching users:', e);
        }
    }

    async function addAccount(e) {
        e.preventDefault();
        const dni = DOM.inputDni.value.trim();
        const codigo = DOM.inputCode.value.trim();
        const nombre = DOM.inputName.value.trim();
        const grupo = DOM.inputGroup ? DOM.inputGroup.value.trim() : '';
        const chatId = DOM.inputUser ? DOM.inputUser.value : '';

        if (!dni || !codigo || !nombre) {
            toast('warning', 'Campos incompletos', 'Todos los campos obligatorios deben llenarse');
            return;
        }

        try {
            const { ok, data } = await api('POST', '/api/dashboard/accounts/add', { chatId, dni, codigo, nombre, grupo });
            if (ok) {
                toast('success', 'Cuenta agregada', `${nombre} (${dni})`);
                DOM.addAccountForm.reset();
                fetchAccounts();
                fetchStats();
            } else {
                toast('error', 'Error', data.error || data.message || 'No se pudo agregar la cuenta');
            }
        } catch (err) {
            toast('error', 'Error de conexión', 'No se pudo conectar con el servidor');
        }
    }

    async function openTransferModal(chatId, dni) {
        DOM.transferTargetUser.innerHTML = '<option value="">Cargando usuarios...</option>';
        DOM.transferModal.classList.remove('hidden');
        
        try {
            const { ok, data } = await api('GET', '/api/dashboard/users');
            if (ok && data.users) {
                const users = data.users;
                let options = '<option value="" disabled selected>Selecciona un usuario...</option>';
                users.forEach(u => {
                    const name = u.firstName || u.username || 'Sin Nombre';
                    options += `<option value="${escapeHtml(u.chatId)}">${escapeHtml(name)} (${escapeHtml(u.chatId)})</option>`;
                });
                DOM.transferTargetUser.innerHTML = options;
            } else {
                DOM.transferTargetUser.innerHTML = '<option value="">Error cargando usuarios</option>';
            }
        } catch (err) {
            DOM.transferTargetUser.innerHTML = '<option value="">Error de conexión</option>';
        }

        const onCancel = () => {
            DOM.transferModal.classList.add('hidden');
            cleanup();
        };

        const onConfirm = async () => {
            const targetChatId = DOM.transferTargetUser.value;
            if (!targetChatId) {
                toast('warning', 'Aviso', 'Selecciona un usuario destino.');
                return;
            }
            if (targetChatId === chatId) {
                toast('warning', 'Aviso', 'El usuario seleccionado ya es el dueño.');
                return;
            }

            try {
                const { ok, data } = await api('PUT', '/api/dashboard/accounts/transfer', { sourceChatId: chatId, dni, targetChatId });
                if (ok) {
                    toast('success', 'Transferido', 'La cuenta ha sido transferida exitosamente.');
                    fetchAccounts();
                    fetchStats();
                    DOM.transferModal.classList.add('hidden');
                    cleanup();
                } else {
                    toast('error', 'Error', data.message || 'No se pudo transferir');
                }
            } catch (err) {
                toast('error', 'Error', 'Fallo de conexión');
            }
        };

        const cleanup = () => {
            DOM.transferModalCancel.removeEventListener('click', onCancel);
            DOM.transferModalConfirm.removeEventListener('click', onConfirm);
        };

        DOM.transferModalCancel.addEventListener('click', onCancel);
        DOM.transferModalConfirm.addEventListener('click', onConfirm);
    }

    async function deleteAccount(chatId, dni) {
        const confirmed = await confirm(
            '🗑️',
            'Eliminar Cuenta',
            `¿Estás seguro de eliminar la cuenta con DNI ${dni}?`,
            'btn-danger'
        );
        if (!confirmed) return;

        try {
            const { ok, data } = await api('DELETE', `/api/dashboard/accounts/${chatId}/${dni}`);
            if (ok) {
                toast('success', 'Cuenta eliminada', `DNI: ${dni}`);
                fetchAccounts();
                fetchStats();
            } else {
                toast('error', 'Error', data.error || data.message || 'No se pudo eliminar la cuenta');
            }
        } catch (err) {
            toast('error', 'Error de conexión', 'No se pudo conectar con el servidor');
        }
    }

    async function bulkImport() {
        const text = DOM.bulkImportText.value.trim();
        if (!text) {
            toast('warning', 'Vacío', 'Ingresa datos JSON para importar');
            return;
        }

        let accounts;
        try {
            accounts = JSON.parse(text);
            if (!Array.isArray(accounts)) throw new Error('Not an array');
        } catch {
            toast('error', 'JSON inválido', 'El formato debe ser un array de objetos JSON');
            return;
        }

        let added = 0;
        let errors = 0;

        for (const acc of accounts) {
            try {
                const { ok } = await api('POST', '/api/dashboard/accounts/add', {
                    dni: acc.dni || acc.DNI,
                    codigo: acc.codigo || acc.code,
                    nombre: acc.nombre || acc.name,
                    grupo: acc.grupo || acc.group || '',
                });
                if (ok) added++; else errors++;
            } catch {
                errors++;
            }
        }

        if (added > 0) {
            toast('success', 'Importación completada', `${added} cuentas agregadas` + (errors > 0 ? `, ${errors} errores` : ''));
            DOM.bulkImportText.value = '';
            fetchAccounts();
            fetchStats();
        } else {
            toast('error', 'Error', 'No se pudo importar ninguna cuenta');
        }
    }

    // ── History ────────────────────────────────────────────────
    async function fetchHistory() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/history');
            if (ok) {
                state.history = data.history || data || [];
                renderHistory();
            }
        } catch (err) {
            console.error('History fetch error:', err);
        }
    }

    function renderHistory() {
        const history = state.history;

        if (!history || history.length === 0) {
            DOM.historyList.innerHTML = `
                <div class="glass-card">
                    <div class="empty-state">
                        <div class="empty-state-icon">📜</div>
                        <div class="empty-state-text">No hay ejecuciones registradas</div>
                    </div>
                </div>`;
            return;
        }

        DOM.historyList.innerHTML = history.map((entry, i) => {
            const time = entry.timestamp || entry.date || entry.time || '';
            const mode = entry.mode || entry.type || 'local';
            const successCount = entry.successCount ?? entry.success ?? 0;
            const total = entry.totalCount ?? entry.total ?? 0;
            const duration = entry.duration || entry.elapsed || '—';
            const details = entry.details || entry.results || [];

            // Determine color
            let colorClass = 'success';
            if (successCount === 0 && total > 0) colorClass = 'error';
            else if (successCount < total) colorClass = 'partial';
            else if (total === 0) colorClass = 'error';

            const modeLabel = String(mode).toLowerCase().includes('dist') ? 'Distribuida' : 'Local';
            const modeBadge = String(mode).toLowerCase().includes('dist') ? 'badge-info' : 'badge-neutral';

            let formattedTime = time;
            try {
                const d = new Date(time);
                if (!isNaN(d.getTime())) {
                    formattedTime = d.toLocaleString('es-PE', {
                        timeZone: CONFIG.TIMEZONE,
                        dateStyle: 'short',
                        timeStyle: 'medium',
                    });
                }
            } catch { }

            // Details HTML
            let detailsHtml = '';
            if (details && details.length > 0) {
                detailsHtml = details.map(d => {
                    const accName = d.nombre || d.name || d.dni || '—';
                    const accStatus = d.status || d.result || '—';
                    const accOk = d.success || String(accStatus).toLowerCase().includes('success') || String(accStatus).toLowerCase().includes('ok');
                    const badgeClass = accOk ? 'badge-success' : 'badge-error';
                    return `
                        <div class="history-account-row">
                            <span class="history-account-name">${escapeHtml(String(accName))}</span>
                            <span class="badge ${badgeClass}">${escapeHtml(String(accStatus))}</span>
                        </div>`;
                }).join('');
            }

            return `
                <div class="history-entry glass-card ${colorClass} fade-in" style="animation-delay: ${i * 0.05}s" onclick="this.classList.toggle('expanded')">
                    <div class="history-top">
                        <span class="history-time">${escapeHtml(formattedTime)}</span>
                        <div style="display:flex; gap:0.5rem; align-items:center;">
                            <span class="badge ${modeBadge}">${modeLabel}</span>
                        </div>
                    </div>
                    <div class="history-meta">
                        <span class="history-stat">
                            <span class="count-success">${successCount}</span>
                            <span class="count-total">/ ${total}</span>
                            <span>exitosas</span>
                        </span>
                        <span class="history-stat">⏱️ ${escapeHtml(String(duration))}</span>
                    </div>
                    ${detailsHtml ? `
                        <div class="history-expand-hint">▼ Click para detalles</div>
                        <div class="history-details">
                            <div class="history-details-inner">${detailsHtml}</div>
                        </div>
                    ` : ''}
                </div>`;
        }).join('');
    }

    // ── Execute ────────────────────────────────────────────────
    async function executeNow() {
        const confirmed = await confirm(
            '🚀',
            'Ejecutar Reservas',
            '¿Ejecutar reservas distribuidas en todos los workers ahora?',
            'btn-primary'
        );
        if (!confirmed) return;

        DOM.executeBtn.disabled = true;
        DOM.executeBtn.innerHTML = '<span class="spinner"></span> Ejecutando...';

        try {
            const { ok, data } = await api('POST', '/api/dashboard/execute');
            if (ok) {
                toast('success', 'Ejecución iniciada', data.message || 'Las reservas se están procesando');
                setTimeout(() => {
                    fetchHistory();
                    fetchStats();
                }, 3000);
            } else {
                toast('error', 'Error', data.error || data.message || 'No se pudo iniciar la ejecución');
            }
        } catch (err) {
            toast('error', 'Error de conexión', 'No se pudo conectar con el servidor');
        } finally {
            DOM.executeBtn.disabled = false;
            DOM.executeBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Ejecutar Ahora`;
        }
    }

    // ── Health Check ───────────────────────────────────────────
    async function healthCheck() {
        DOM.healthCheckBtn.disabled = true;
        DOM.healthCheckBtn.innerHTML = '<span class="spinner"></span> Verificando...';

        try {
            const { ok, data } = await api('GET', '/api/dashboard/health-check');
            if (ok) {
                toast('success', 'Health Check', data.message || 'Workers verificados correctamente');
                fetchWorkers();
            } else {
                toast('warning', 'Health Check', data.error || data.message || 'Algunos workers no respondieron');
            }
        } catch (err) {
            toast('error', 'Error de conexión', 'No se pudo realizar el health check');
        } finally {
            DOM.healthCheckBtn.disabled = false;
            DOM.healthCheckBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Verificar Workers`;
        }
    }

    // ── Refresh Timers ─────────────────────────────────────────
    function startTimers() {
        // Countdown display
        state.intervals.countdown = setInterval(() => {
            state.timers.workers--;
            state.timers.history--;

            if (state.timers.workers <= 0) {
                state.timers.workers = CONFIG.WORKERS_REFRESH_INTERVAL;
                fetchWorkers();
            }

            if (state.timers.history <= 0) {
                state.timers.history = CONFIG.HISTORY_REFRESH_INTERVAL;
                fetchHistory();
                fetchStats();
            }

            DOM.workersTimer.textContent = `Actualización en ${state.timers.workers}s`;
            DOM.historyTimer.textContent = `Actualización en ${state.timers.history}s`;
        }, 1000);

        // Clock
        state.intervals.clock = setInterval(() => {
            updateClock();
            updateUptime();
        }, 1000);
    }

    function clearAllIntervals() {
        Object.values(state.intervals).forEach(clearInterval);
        state.intervals = {};
    }

    // ── Init Dashboard ─────────────────────────────────────────
    async function initDashboard() {
        clearAllIntervals();
        updateClock();
        updateUptime();

        // Initial data load
        await Promise.allSettled([
            fetchWorkers(),
            fetchStats(),
            fetchAccounts(),
            fetchHistory(),
            fetchSchedule(),
            fetchUsers(),
        ]);

        startTimers();
    }

    // ── Schedule Management ────────────────────────────────────
    const ALL_DAYS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
    const DAY_LABELS = { lun: 'LUN', mar: 'MAR', mie: 'MIE', jue: 'JUE', vie: 'VIE', sab: 'SAB', dom: 'DOM' };

    async function fetchSchedule() {
        try {
            const { ok, data } = await api('GET', '/api/dashboard/accounts');
            if (ok && data.ok) {
                renderSchedule(data.accounts || []);
            }
        } catch (err) {
            console.error('Schedule fetch error:', err);
        }
    }

    function renderSchedule(accounts) {
        const scheduleBody = document.getElementById('scheduleBody');
        const todayBadge = document.getElementById('scheduleTodayBadge');
        const todayCount = document.getElementById('scheduleTodayCount');

        if (!scheduleBody) return;

        // Get today's day name in Lima timezone
        const limaDate = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
        const dayIdx = limaDate.getDay();
        const dayNames = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
        const todayDay = dayNames[dayIdx];

        if (todayBadge) todayBadge.textContent = `Hoy: ${todayDay.toUpperCase()}`;

        if (!accounts || accounts.length === 0) {
            scheduleBody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-text">No hay cuentas registradas</div></div></td></tr>`;
            if (todayCount) todayCount.textContent = 'Hoy: 0 cuentas activas';
            return;
        }

        // Count today's active accounts (ignoring filter)
        let activeToday = 0;
        for (const acc of accounts) {
            const dias = acc.dias || ['lun', 'mar', 'mie', 'jue', 'vie'];
            const isGloballyInactive = acc.active === false;
            if (dias.includes(todayDay) && !isGloballyInactive) activeToday++;
        }

        const searchTerm = (DOM.searchScheduleInput?.value || '').toLowerCase().trim();
        const filteredAccounts = accounts.filter(a => {
            if (!searchTerm) return true;
            return (
                (a.nombre && a.nombre.toLowerCase().includes(searchTerm)) ||
                (a.dni && a.dni.toLowerCase().includes(searchTerm)) ||
                (a.codigo && a.codigo.toLowerCase().includes(searchTerm))
            );
        });

        if (filteredAccounts.length === 0) {
            scheduleBody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-text">No se encontraron cuentas</div></div></td></tr>`;
            if (todayCount) todayCount.textContent = `Hoy: ${activeToday} cuentas activas`;
            return;
        }

        scheduleBody.innerHTML = filteredAccounts.map((acc, i) => {
            const dias = acc.dias || ['lun', 'mar', 'mie', 'jue', 'vie'];
            const isGloballyInactive = acc.active === false;
            const isActiveToday = dias.includes(todayDay) && !isGloballyInactive;

            const dayCells = ALL_DAYS.map(day => {
                const isActive = dias.includes(day);
                const isToday = day === todayDay;
                const cls = `schedule-toggle ${isActive ? 'active' : ''} ${isToday ? 'today' : ''}`;
                return `<td class="schedule-cell">
                    <button class="${cls}" 
                            data-chatid="${escapeHtml(acc.chatId)}" 
                            data-dni="${escapeHtml(acc.dni)}" 
                            data-day="${day}"
                            ${isGloballyInactive ? 'disabled style="cursor: not-allowed; opacity: 0.3"' : ''}
                            title="${isActive ? 'Desactivar' : 'Activar'} ${day.toUpperCase()}">
                        ${isActive ? '✅' : '❌'}
                    </button>
                </td>`;
            }).join('');

            const rowClass = isGloballyInactive ? 'inactive-row' : (isActiveToday ? '' : 'schedule-row-inactive');
            return `<tr class="fade-in ${rowClass}" style="animation-delay: ${i * 0.02}s">
                <td><strong>${escapeHtml(acc.nombre || '—')}</strong></td>
                <td class="text-muted">${escapeHtml(acc.dni)}</td>
                ${dayCells}
            </tr>`;
        }).join('');

        if (todayCount) todayCount.textContent = `Hoy: ${activeToday} cuentas activas`;

        // Highlight today's column header
        const headers = document.querySelectorAll('.schedule-day-header');
        headers.forEach(h => {
            const dayText = h.textContent.toLowerCase();
            if (dayText === todayDay) {
                h.style.color = 'var(--color-primary)';
                h.style.fontWeight = '700';
            } else {
                h.style.color = '';
                h.style.fontWeight = '';
            }
        });

        // Bind toggle click handlers
        scheduleBody.querySelectorAll('.schedule-toggle').forEach(btn => {
            btn.addEventListener('click', () => toggleDay(btn));
        });
    }

    async function toggleDay(btn) {
        const chatId = btn.dataset.chatid;
        const dni = btn.dataset.dni;
        const day = btn.dataset.day;
        const isCurrentlyActive = btn.classList.contains('active');

        // Find the account in state
        const acc = state.accounts.find(a => a.chatId === chatId && a.dni === dni);
        if (!acc) return;

        let newDias = acc.dias || ['lun', 'mar', 'mie', 'jue', 'vie'];
        if (isCurrentlyActive) {
            newDias = newDias.filter(d => d !== day);
        } else {
            newDias = [...newDias, day];
        }

        // Optimistic UI update
        btn.classList.toggle('active');
        btn.textContent = isCurrentlyActive ? '❌' : '✅';

        try {
            const { ok, data } = await api('PUT', '/api/dashboard/accounts/schedule', { chatId, dni, dias: newDias });
            if (ok && data.ok) {
                acc.dias = data.dias;
                updateTodayCount();
            } else {
                // Revert
                btn.classList.toggle('active');
                btn.textContent = isCurrentlyActive ? '✅' : '❌';
                toast('error', 'Error', data?.message || 'No se pudo actualizar el horario');
            }
        } catch (err) {
            // Revert on network error
            btn.classList.toggle('active');
            btn.textContent = isCurrentlyActive ? '✅' : '❌';
            toast('error', 'Error de conexión', 'No se pudo conectar con el servidor');
        }
    }

    function updateTodayCount() {
        const todayCount = document.getElementById('scheduleTodayCount');
        if (!todayCount) return;
        const limaDate = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
        const dayNames = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
        const todayDay = dayNames[limaDate.getDay()];
        let count = 0;
        for (const acc of state.accounts) {
            const dias = acc.dias || ['lun', 'mar', 'mie', 'jue', 'vie'];
            const isGloballyInactive = acc.active === false;
            if (dias.includes(todayDay) && !isGloballyInactive) count++;
        }
        todayCount.textContent = `Hoy: ${count} cuentas activas`;
    }

    async function scheduleAllWeekdays() {
        const users = {};
        for (const acc of state.accounts) {
            if (!users[acc.chatId]) users[acc.chatId] = [];
            users[acc.chatId].push(acc);
        }

        const dias = ['lun', 'mar', 'mie', 'jue', 'vie'];
        let success = 0;
        try {
            for (const chatId of Object.keys(users)) {
                const { ok } = await api('PUT', '/api/dashboard/accounts/schedule/bulk', { chatId, dias });
                if (ok) success++;
            }

            if (success > 0) {
                toast('success', 'Horario actualizado', `Todas las cuentas activadas Lun-Vie`);
                await fetchAccounts();
                fetchSchedule();
            } else {
                toast('error', 'Error', 'No se pudo actualizar el horario');
            }
        } catch (err) {
            toast('error', 'Error de conexión', 'No se pudo conectar con el servidor');
        }
    }

    // ── Event Listeners ────────────────────────────────────────
    function bindEvents() {
        DOM.addAccountForm.addEventListener('submit', addAccount);
        DOM.bulkImportBtn.addEventListener('click', bulkImport);
        DOM.executeBtn.addEventListener('click', executeNow);
        DOM.healthCheckBtn.addEventListener('click', healthCheck);

        // Search and Pagination
        DOM.searchAccountInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim();
            state.accountsPage = 1; // Reset to first page on search
            renderAccounts();
        });

        if (DOM.searchScheduleInput) {
            DOM.searchScheduleInput.addEventListener('input', () => {
                renderSchedule(state.accounts);
            });
        }

        if (DOM.groupFilterSelect) {
            DOM.groupFilterSelect.addEventListener('change', (e) => {
                state.groupFilter = e.target.value;
                state.accountsPage = 1;
                renderAccounts();
            });
        }

        DOM.prevPageBtn.addEventListener('click', () => {
            if (state.accountsPage > 1) {
                state.accountsPage--;
                renderAccounts();
            }
        });

        DOM.nextPageBtn.addEventListener('click', () => {
            state.accountsPage++;
            renderAccounts();
        });

        // Schedule buttons
        const scheduleAllBtn = document.getElementById('scheduleAllDays');
        const scheduleRefreshBtn = document.getElementById('scheduleRefresh');
        if (scheduleAllBtn) scheduleAllBtn.addEventListener('click', scheduleAllWeekdays);
        if (scheduleRefreshBtn) scheduleRefreshBtn.addEventListener('click', () => {
            fetchSchedule();
            toast('info', 'Actualizado', 'Horario actualizado');
        });

        DOM.refreshWorkersBtn.addEventListener('click', () => {
            state.timers.workers = CONFIG.WORKERS_REFRESH_INTERVAL;
            fetchWorkers();
            toast('info', 'Actualizado', 'Workers actualizados');
        });

        DOM.refreshHistoryBtn.addEventListener('click', () => {
            state.timers.history = CONFIG.HISTORY_REFRESH_INTERVAL;
            fetchHistory();
            fetchStats();
            toast('info', 'Actualizado', 'Historial actualizado');
        });

        // Close modal on overlay click
        DOM.confirmModal.addEventListener('click', (e) => {
            if (e.target === DOM.confirmModal) {
                DOM.modalCancel.click();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!DOM.confirmModal.classList.contains('hidden')) {
                    DOM.modalCancel.click();
                }
            }
        });
    }

    // ── Utility ────────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        bindEvents();
        initAuth();

        // Inject schedule CSS
        const style = document.createElement('style');
        style.textContent = `
            .schedule-cell { text-align: center; padding: 0.25rem !important; }
            .schedule-toggle {
                width: 36px; height: 36px; border-radius: 8px;
                border: 2px solid var(--color-border);
                background: rgba(255,255,255,0.03);
                cursor: pointer; font-size: 0.85rem;
                transition: all 0.2s ease;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .schedule-toggle:hover { transform: scale(1.15); border-color: var(--color-primary); }
            .schedule-toggle.active { background: rgba(16, 185, 129, 0.15); border-color: var(--color-success); }
            .schedule-toggle.today { box-shadow: 0 0 8px rgba(139, 92, 246, 0.5); }
            .schedule-toggle.active.today { box-shadow: 0 0 8px rgba(16, 185, 129, 0.5); }
            .schedule-row-inactive td { opacity: 0.5; }
            .schedule-row-inactive:hover td { opacity: 1; }
            .schedule-day-header { text-align: center !important; font-size: 0.75rem; letter-spacing: 0.05em; }
            .btn-sm { font-size: 0.8rem; padding: 0.35rem 0.75rem; }
        `;
        document.head.appendChild(style);
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
