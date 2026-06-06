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
