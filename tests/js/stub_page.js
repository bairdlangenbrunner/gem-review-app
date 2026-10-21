// A stub browser page for the JS tests: every element keeps its fields and attributes, records its listeners, and finds nothing inside itself.
// page(opts) loads app.js whole in a fresh VM context, with the scripts in opts.before ahead of it (a store) and the ones in opts.after behind it (a tracker), and waits for it to boot the way the page boots it.
// This file is a helper, not a test file: index.js loads only *.test.js.
"use strict";
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "..", "..");
var APP_JS = fs.readFileSync(path.join(ROOT, "review_core", "web", "app.js"), "utf8");

function noop() {}
// arrays made in the VM context have that context's prototypes; a JSON round trip makes them plain arrays of this one
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function element(name) {
  var attrs = {}, listeners = {};
  var el = {
    _name: name, _listeners: listeners, id: name, innerHTML: "", textContent: "", value: "", title: "", className: "", placeholder: "",
    style: {}, dataset: {}, checked: false, hidden: false, open: false, disabled: false, isConnected: true, options: [], children: [],
    offsetWidth: 0, offsetHeight: 0, scrollTop: 0, nextSibling: null, firstChild: null,
    classList: {add: noop, remove: noop, toggle: noop, contains: function () { return false; }},
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: noop,
    setAttribute: function (k, v) { attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute: function (k) { delete attrs[k]; },
    hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    contains: function () { return false; },
    matches: function () { return false; },
    getBoundingClientRect: function () { return {left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0}; },
    appendChild: function (c) { return c; }, insertBefore: function (c) { return c; }, removeChild: function (c) { return c; },
    remove: noop, focus: noop, blur: noop, select: noop, click: noop, scrollIntoView: noop, setSelectionRange: noop,
    showModal: function () { el.open = true; }, close: function () { el.open = false; }
  };
  el.parentNode = {insertBefore: function (c) { return c; }, removeChild: function (c) { return c; }, appendChild: function (c) { return c; }};
  return el;
}

// a localStorage that lives in memory
function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    key: function (i) { return Object.keys(m)[i] || null; },
    get length() { return Object.keys(m).length; }
  };
}

// opts: globals (set on window before any script runs), before and after ([source, filename] pairs)
function page(opts) {
  opts = opts || {};
  var byId = {}, bySel = {}, listeners = {};
  function byName(map, k) { return map[k] || (map[k] = element(k)); }
  var document = {
    readyState: "complete", activeElement: null,
    getElementById: function (id) { return byName(byId, id); },
    // the suggest form is never open here; anything else the app looks up is there
    querySelector: function (sel) { return /sform|li\.sel/.test(sel) ? null : byName(bySel, sel); },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return element(tag); },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: noop, execCommand: function () { return false; }
  };
  document.body = element("body");
  document.documentElement = element("html");
  var ctx = {
    document: document, console: {info: noop, log: noop, warn: noop, error: console.error},
    performance: {now: function () { return 0; }}, Intl: Intl, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: noop,
    localStorage: memoryStorage(), crypto: globalThis.crypto,
    matchMedia: function () { return {matches: false, addEventListener: noop}; },
    history: {pushState: noop, replaceState: noop}, location: {hash: ""}, navigator: {},
    addEventListener: noop, innerWidth: 1200, innerHeight: 800,
    requestAnimationFrame: function (f) { return setTimeout(f, 0); }
  };
  Object.keys(opts.globals || {}).forEach(function (k) { ctx[k] = opts.globals[k]; });
  ctx.window = ctx;
  vm.createContext(ctx);
  (opts.before || []).forEach(function (s) { vm.runInContext(s[0], ctx, {filename: s[1]}); });
  vm.runInContext(APP_JS, ctx, {filename: "app.js"});
  (opts.after || []).forEach(function (s) { vm.runInContext(s[0], ctx, {filename: s[1]}); });
  var booted = new Promise(function (ok, fail) {
    (function wait(n) {
      if (ctx.ReviewApp.timing && ctx.ReviewApp.timing.totalMs != null) return ok();
      if (n > 200) return fail(new Error("app.js did not boot"));
      setTimeout(function () { wait(n + 1); }, 5);
    })(0);
  });
  return {ctx: ctx, app: ctx.ReviewApp, $: document.getElementById, booted: booted};
}

module.exports = {ROOT: ROOT, noop: noop, plain: plain, element: element, memoryStorage: memoryStorage, page: page};
