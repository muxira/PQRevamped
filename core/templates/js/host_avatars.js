(function () {
    const MAX_HASHES_PER_REQUEST = 24;
    const HOST_ID_RE = /^pq[ap]_[A-Za-z0-9_-]+$/;

    window.hostAvatars = { disabled: new Set(), entries: [], images: {}, requested: new Set() };

    function isHostAvatarId(id) { return typeof id === 'string' && HOST_ID_RE.test(id); }

    function isDefaultAvatarDisabled(file) {
        return window.hostAvatars.disabled.has(String(file).replace(/\.png$/i, ''));
    }

    function hostAvatarSrc(id) {
        const e = window.hostAvatars.entries.find(function (x) { return x.Id === id; });
        return (e && e.ImageHash && window.hostAvatars.images[e.ImageHash]) || null;
    }

    function applyHostAvatars(msg) {
        const h = window.hostAvatars;
        msg = msg || {};
        h.disabled = new Set(msg.DisabledDefaults || []);
        h.entries = Array.isArray(msg.Entries) ? msg.Entries.filter(function (e) { return e && isHostAvatarId(e.Id); }) : [];

        const missing = [];
        h.entries.forEach(function (e) {
            if (e.ImageHash && !h.images[e.ImageHash] && !h.requested.has(e.ImageHash) && missing.indexOf(e.ImageHash) < 0)
                missing.push(e.ImageHash);
        });
        for (let i = 0; i < missing.length; i += MAX_HASHES_PER_REQUEST) {
            const chunk = missing.slice(i, i + MAX_HASHES_PER_REQUEST);
            chunk.forEach(function (x) { h.requested.add(x); });
            if (typeof window.RequestHostAvatarImages === 'function') window.RequestHostAvatarImages(chunk);
        }
        if (typeof window.rebuildAvatarList === 'function') window.rebuildAvatarList(true);
    }

    function addHostAvatarImage(msg) {
        if (!msg || !msg.Hash || !msg.Png) return;
        window.hostAvatars.images[msg.Hash] = 'data:image/png;base64,' + msg.Png;
        if (typeof window.refreshHostAvatarImages === 'function') window.refreshHostAvatarImages();
    }

    window.isHostAvatarId = isHostAvatarId;
    window.isDefaultAvatarDisabled = isDefaultAvatarDisabled;
    window.hostAvatarSrc = hostAvatarSrc;
    window.applyHostAvatars = applyHostAvatars;
    window.addHostAvatarImage = addHostAvatarImage;
})();
