// `node --test tests/js` runs this folder as one module, so this file loads every test file in it.
// Node 22 and later read a --test argument as a file pattern, not a folder to search; this file is what makes the folder name work.
"use strict";
var fs = require("node:fs");
var path = require("node:path");

fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); }).sort().forEach(function (f) {
  require(path.join(__dirname, f));
});
