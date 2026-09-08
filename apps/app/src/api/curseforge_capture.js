(() => {
  if (location.hostname !== 'authors.curseforge.com') return;

  const bucket = () => {
    if (!Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__ = [];
    return window.__FODRINTH_CF_CAPTURES__;
  };

  const record = (url, text, contentType) => {
    try {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      const looksJson = /json/i.test(contentType || '') || trimmed.startsWith('{') || trimmed.startsWith('[');
      if (!looksJson) return;
      const captures = bucket();
      captures.push({
        url: String(url || ''),
        text: text.length > 3000000 ? text.slice(0, 3000000) : text,
        at: Date.now(),
      });
      if (captures.length > 320) captures.splice(0, captures.length - 320);
    } catch (_) {}
  };

  if (window.__FODRINTH_CF_CAPTURE_INSTALLED__) {
    bucket();
    return;
  }
  window.__FODRINTH_CF_CAPTURE_INSTALLED__ = true;
  bucket();

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        clone.text().then((text) => record(
          clone.url || args[0]?.url || args[0] || '',
          text,
          clone.headers?.get?.('content-type') || '',
        )).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__fodrinthUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      try {
        if (typeof this.responseText === 'string') {
          record(
            this.responseURL || this.__fodrinthUrl || '',
            this.responseText,
            this.getResponseHeader('content-type') || '',
          );
        }
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
