// WCAG 2.1 contrast audit of every theme in index.html
const src = require('fs').readFileSync('index.html', 'utf8');
const blocks = {};
const re = /(:root|\[data-theme="(\w+)"\])\s*\{([^}]+)\}/g;
let m;
while ((m = re.exec(src))) {
  const name = m[2] || 'dark';
  const vars = {};
  for (const v of m[3].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[v[1]] = v[2];
  if (Object.keys(vars).length > 5) blocks[name] = vars;
}
function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
// pair: [fg, bg, minimum, label]  (AA: 4.5 normal text, 3.0 large/bold/UI)
const PAIRS = [
  ['text', 'bg', 4.5, 'body text'], ['text', 'panel', 4.5, 'panel text'],
  ['text', 'control', 4.5, 'button text'], ['muted', 'panel', 4.5, 'muted text'],
  ['dim', 'panel', 3.0, 'dim text (hints)'], ['head-text', 'panel-head', 4.5, 'card titles'],
  ['go-text', 'go', 4.5, 'run buttons'], ['ok', 'panel', 4.5, 'success msgs'],
  ['err', 'panel', 4.5, 'error msgs'], ['console-text', 'editor-bg', 4.5, 'console'],
  ['gutter-text', 'editor-bg', 3.0, 'line numbers'],
  ['syn-keyword', 'editor-bg', 4.5, 'syntax keyword'], ['syn-builtin', 'editor-bg', 4.5, 'syntax builtin'],
  ['syn-string', 'editor-bg', 4.5, 'syntax string'], ['syn-string2', 'editor-bg', 4.5, 'syntax char'],
  ['syn-number', 'editor-bg', 4.5, 'syntax number'], ['syn-comment', 'editor-bg', 4.5, 'syntax comment'],
  ['syn-operator', 'editor-bg', 4.5, 'syntax operator'], ['syn-atom', 'editor-bg', 4.5, 'syntax atom'],
  ['syn-var', 'editor-bg', 4.5, 'syntax variable'],
  ['tag-bin', 'panel', 3.0, 'BIN tag'], ['tag-rom', 'panel', 3.0, 'ROM tag'],
  ['tag-disk', 'panel', 3.0, 'DISK tag'], ['tag-hdf', 'panel', 3.0, 'HDF tag'],
  ['tag-project', 'panel', 3.0, 'PROJECT tag'],
];
let fails = 0;
for (const [theme, vars] of Object.entries(blocks)) {
  const bad = [];
  for (const [fg, bg, min, label] of PAIRS) {
    if (!vars[fg] || !vars[bg]) { bad.push(`MISSING ${fg}/${bg}`); continue; }
    const r = ratio(vars[fg], vars[bg]);
    if (r < min) bad.push(`${label}: ${vars[fg]} on ${vars[bg]} = ${r.toFixed(2)} (need ${min})`);
  }
  console.log(`\n=== ${theme}: ${bad.length ? bad.length + ' FAILURES' : 'ALL PASS'} ===`);
  bad.forEach(b => console.log('  ' + b));
  fails += bad.length;
}
process.exit(fails ? 1 : 0);
