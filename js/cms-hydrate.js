/* Spectrum Auto — CMS overlay.
   Content is already baked into the HTML; this layer only overwrites it when a payload
   is available. Any failure is a silent no-op, so the static site never degrades.
   See content/MODEL.md for the binding convention and the Contentful mapping. */
(function () {
  'use strict';

  var api = {};
  window.SpectrumCMS = api;

  function get(obj, path) {
    if (!obj || !path) return undefined;
    var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  api.get = get;

  function applyAttrs(el, data, scope) {
    var spec = el.getAttribute('data-cms-attr');
    if (!spec) return;
    spec.split(',').forEach(function (pair) {
      var bits = pair.split(':');
      if (bits.length < 2) return;
      var attr = bits[0].trim();
      var path = bits.slice(1).join(':').trim();
      var val = get(data, path);
      if (val === undefined && scope) val = get(scope, path);
      if (val !== undefined && val !== null) el.setAttribute(attr, String(val));
    });
  }

  function bindNode(el, data, scope) {
    var path = el.getAttribute('data-cms');
    if (path) {
      var val = get(data, path);
      if (val === undefined && scope) val = get(scope, path);
      if (val !== undefined && val !== null && typeof val !== 'object') {
        if (el.hasAttribute('data-cms-html')) el.innerHTML = String(val);
        else if (el.tagName === 'IMAGE-SLOT') el.setAttribute('src', String(val));
        else el.textContent = String(val);
      }
    }
    applyAttrs(el, data, scope);
  }

  function bindList(container, data) {
    var listPath = container.getAttribute('data-cms-list');
    var items = get(data, listPath);
    if (!Array.isArray(items)) return;

    if (!container.__cmsTemplates) {
      var authored = Array.prototype.slice.call(container.children);
      if (!authored.length) return;
      container.__cmsTemplates = authored.map(function (n) { return n.cloneNode(true); });
    }
    var tpls = container.__cmsTemplates;

    if (items.length === 0) {
      var emptyMode = container.getAttribute('data-cms-empty');
      if (emptyMode === 'hide') {
        var host = container.closest('[data-cms-empty-target]') || container;
        host.style.display = 'none';
      }
      container.innerHTML = '';
      return;
    }

    container.innerHTML = '';
    items.forEach(function (item, i) {
      // Nth authored cell keeps its own styling (edge padding, closing rules).
      var node = (tpls[i] || tpls[tpls.length - 1]).cloneNode(true);
      var fields = (item !== null && typeof item === 'object') ? item : { value: item };
      var scope = Object.assign({ $index: i, $number: String(i + 1).padStart(2, '0') }, fields);
      if (node.matches('[data-cms],[data-cms-attr]')) bindNode(node, scope, data);
      node.querySelectorAll('[data-cms],[data-cms-attr]').forEach(function (child) {
        bindNode(child, scope, data);
      });
      container.appendChild(node);
    });
  }

  function renderAnnouncement(data) {
    var slot = document.querySelector('[data-cms-slot="announcement"]');
    var ann = get(data, 'announcement');
    if (!slot) return;
    if (!ann || !ann.enabled || !ann.text) { slot.innerHTML = ''; return; }

    var tones = {
      brass:   { bg: '#C9A227', fg: '#12100B' },
      neutral: { bg: '#1C1C1F', fg: '#EDEAE4' },
      alert:   { bg: '#8C2F1C', fg: '#F6EDE8' }
    };
    var t = tones[ann.tone] || tones.brass;

    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'background:' + t.bg + ';color:' + t.fg +
      ';font-family:"Archivo",system-ui,sans-serif;font-size:13px;letter-spacing:0.01em;' +
      'display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap;' +
      'padding:11px 24px;text-align:center';

    var text = document.createElement('span');
    text.textContent = ann.text;
    bar.appendChild(text);

    if (ann.linkUrl && ann.linkLabel) {
      var a = document.createElement('a');
      a.href = ann.linkUrl;
      a.textContent = ann.linkLabel;
      a.style.cssText = 'color:inherit;font-weight:600;text-underline-offset:3px;white-space:nowrap';
      bar.appendChild(a);
    }
    slot.innerHTML = '';
    slot.appendChild(bar);
  }

  api.apply = function (data) {
    if (!data) return;
    api.data = data;
    try {
      renderAnnouncement(data);
      document.querySelectorAll('[data-cms-list]').forEach(function (c) { bindList(c, data); });
      document.querySelectorAll('[data-cms],[data-cms-attr]').forEach(function (el) {
        if (el.closest('[data-cms-list]')) return;
        bindNode(el, data, null);
      });
    } catch (e) { /* baked-in content stands */ }
  };

  /* Flatten a Contentful `entries?include=2` response into site.json's shape.
     Extend alongside content/MODEL.md when fields are added. */
  api.mapContentful = function (res) {
    var assets = {}, entries = {};
    (((res.includes || {}).Asset) || []).forEach(function (a) { assets[a.sys.id] = a; });
    (res.items || []).concat(((res.includes || {}).Entry) || [])
      .forEach(function (e) { entries[e.sys.id] = e; });

    function assetUrl(link) {
      var a = link && assets[((link.sys || {}).id)];
      return a ? 'https:' + a.fields.file.url : undefined;
    }
    function byType(t) {
      return Object.keys(entries)
        .map(function (id) { return entries[id]; })
        .filter(function (e) { return e.sys.contentType.sys.id === t; })
        .sort(function (a, b) { return (a.fields.order || 0) - (b.fields.order || 0); });
    }
    function one(t) { return (byType(t)[0] || {}).fields || {}; }

    var s = one('siteSettings');
    var digits = String(s.phone || '').replace(/\D/g, '');

    return {
      settings: Object.assign({}, s, {
        phoneHref: digits ? 'tel:+1' + digits : undefined,
        smsHref: digits ? 'sms:+1' + digits : undefined
      }),
      announcement: one('announcement'),
      hero: one('sectionHero'),
      services: byType('service').map(function (e) { return e.fields; }),
      builds: byType('build').map(function (e) {
        return Object.assign({}, e.fields, { imageUrl: assetUrl(e.fields.image) });
      }),
      process: byType('processStep').map(function (e) { return e.fields; }),
      testimonials: byType('testimonial').map(function (e) { return e.fields; }),
      faq: byType('faqItem').map(function (e) {
        return { q: e.fields.question, a: e.fields.answer };
      })
    };
  };

  api.load = function () {
    var cfg = window.SPECTRUM_CMS;
    if (cfg && cfg.source === 'contentful' && cfg.space && cfg.token) {
      var env = cfg.environment || 'master';
      return fetch('https://cdn.contentful.com/spaces/' + cfg.space + '/environments/' +
                   env + '/entries?include=2&limit=500', {
        headers: { Authorization: 'Bearer ' + cfg.token }
      })
        .then(function (r) { return r.json(); })
        .then(function (j) { api.apply(api.mapContentful(j)); })
        .catch(function () { return api.loadStatic(); });
    }
    return api.loadStatic();
  };

  api.loadStatic = function () {
    return fetch('content/site.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { api.apply(j); })
      .catch(function () { /* offline / file:// — baked-in content stands */ });
  };

  /* Pages may finish streaming after DOMContentLoaded, so re-apply on load too.
     apply() is idempotent. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { api.load(); });
  } else {
    api.load();
  }
  window.addEventListener('load', function () { api.load(); });
})();
