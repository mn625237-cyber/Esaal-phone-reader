// Phase 6 — helper used only by the test harness: pulls exact source slices out of the
// REAL index.html (never a hand-retyped copy) so tests exercise the actual shipped code,
// not a parallel re-implementation that could drift from it.
const fs = require('fs');
const path = require('path');

function readIndexHtml(){
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

// Extracts everything between two exact, unique anchor strings already present in the
// file (both anchors are kept out of the slice itself).
function sliceBetween(text, startAnchor, endAnchor){
  const startIdx = text.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('start anchor not found: ' + startAnchor);
  const endIdx = text.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('end anchor not found: ' + endAnchor);
  return text.slice(startIdx, endIdx);
}

// Extracts a single top-level `function name(...) { ... }` declaration by brace-matching
// from its own source, regardless of what surrounds it.
function extractFunction(text, name){
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  if (start === -1) throw new Error('function not found: ' + name);
  const braceOpen = text.indexOf('{', start);
  let depth = 0, i = braceOpen;
  for (; i < text.length; i++){
    if (text[i] === '{') depth++;
    else if (text[i] === '}'){
      depth--;
      if (depth === 0) break;
    }
  }
  return text.slice(start, i + 1);
}

module.exports = { readIndexHtml, sliceBetween, extractFunction };
