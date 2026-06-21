/* Drawbridge Admin Panel - API Client & Utilities */

const API = {
    async request(method, path, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
        };
        if (body && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }
        const resp = await fetch(path, opts);
        if (resp.status === 401) {
            // Session expired or not authenticated — bounce to login instead of
            // leaving the page showing an "Unauthorized" error.
            window.location.href = '/admin/login';
            throw new Error('Session expired — please log in again.');
        }
        const data = await resp.json();
        if (!resp.ok && !data.warned) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return { ...data, _status: resp.status };
    },

    get(path) {
        return this.request('GET', path);
    },

    post(path, body) {
        return this.request('POST', path, body);
    },

    put(path, body) {
        return this.request('PUT', path, body);
    },

    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.3s';
            setTimeout(() => el.remove(), 300);
        }, 4000);
    },

    createProgressBar(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return null;
        container.style.display = 'block';
        container.innerHTML = `
            <div class="progress-bar-track">
                <div class="progress-bar-fill" id="${containerId}-fill"></div>
            </div>
            <div class="progress-message">
                <span id="${containerId}-msg">Initializing...</span>
                <span class="progress-percent" id="${containerId}-pct">0%</span>
            </div>
        `;
        return {
            update(pct, msg) {
                const fill = document.getElementById(`${containerId}-fill`);
                const msgEl = document.getElementById(`${containerId}-msg`);
                const pctEl = document.getElementById(`${containerId}-pct`);
                if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
                if (msgEl) msgEl.textContent = msg || '';
                if (pctEl) pctEl.textContent = `${pct}%`;
            },
            setStatus(type) {
                const fill = document.getElementById(`${containerId}-fill`);
                if (fill) {
                    fill.className = 'progress-bar-fill' + (type ? ` ${type}` : '');
                }
            },
            remove() {
                container.style.display = 'none';
                container.innerHTML = '';
            },
        };
    },

    /**
     * Run a background task with a progress bar.
     * @param {string} endpoint - POST endpoint to start the task
     * @param {object} payload - JSON body
     * @param {string} progressContainerId - ID of the progress container element
     * @returns {Promise<object>} - The task result on completion
     */
    async runTask(endpoint, payload, progressContainerId) {
        const bar = this.createProgressBar(progressContainerId);
        try {
            const resp = await this.post(endpoint, payload);
            if (!resp.task_id) {
                bar.setStatus('error');
                bar.update(100, resp.error || 'Unexpected response');
                throw new Error(resp.error || 'No task_id returned');
            }
            const taskId = resp.task_id;
            for (;;) {
                await new Promise(r => setTimeout(r, 1200));
                const status = await this.get(`/admin/api/tasks/${taskId}`);
                if (status.status === 'completed') {
                    bar.setStatus('success');
                    bar.update(100, status.message || 'Complete');
                    return status.result || status;
                }
                if (status.status === 'failed') {
                    bar.setStatus('error');
                    bar.update(100, status.error || 'Task failed');
                    throw new Error(status.error || 'Task failed');
                }
                bar.update(status.progress || 0, status.message || 'Working...');
            }
        } catch (e) {
            bar.setStatus('error');
            bar.update(100, e.message);
            throw e;
        }
    },

    async checkAuth() {
        try {
            const resp = await this.get('/admin/api/auth/me');
            if (!resp.authenticated) {
                window.location.href = '/admin/login';
                return null;
            }
            return resp.user;
        } catch {
            window.location.href = '/admin/login';
            return null;
        }
    }
};

// Auto-check auth on page load for admin pages
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.startsWith('/admin/') &&
        !window.location.pathname.endsWith('/login') &&
        !window.location.pathname.includes('/auth/')) {
        API.checkAuth();
    }
});
