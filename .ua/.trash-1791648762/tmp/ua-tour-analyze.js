#!/usr/bin/env node
const fs = require('fs');

const [,, inPath, outPath] = process.argv;
try {
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const layers = data.layers || [];

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // A. Fan-in / B. Fan-out
  const fanIn = new Map(), fanOut = new Map();
  nodes.forEach(n => { fanIn.set(n.id, 0); fanOut.set(n.id, 0); });
  for (const e of edges) {
    if (nodeById.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
    if (nodeById.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
  }
  const fanInRanking = [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, v]) => ({ id, fanIn: v, name: nodeById.get(id).name }));
  const fanOutRanking = [...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, v]) => ({ id, fanOut: v, name: nodeById.get(id).name }));

  // C. Entry point candidates
  const entryNames = new Set(['index.ts','index.js','main.ts','main.js','app.ts','app.js','server.ts','server.js','mod.rs','main.go','main.py','main.rs','manage.py','app.py','wsgi.py','asgi.py','run.py','__main__.py','Application.java','Main.java','Program.cs','config.ru','index.php','App.swift','Application.kt','main.cpp','main.c']);
  const fanOutValues = [...fanOut.values()].sort((a, b) => b - a);
  const fanInValues = [...fanIn.values()].sort((a, b) => a - b);
  const topFanOutThreshold = fanOutValues[Math.max(0, Math.floor(fanOutValues.length * 0.1) - 1)] ?? Infinity;
  const lowFanInThreshold = fanInValues[Math.min(fanInValues.length - 1, Math.floor(fanInValues.length * 0.25))] ?? -1;

  const candidates = [];
  for (const n of nodes) {
    let score = 0;
    const fp = (n.filePath || '').replace(/\\/g, '/');
    const isRoot = !fp.includes('/');
    const depthOne = (fp.match(/\//g) || []).length === 1;
    if (n.type === 'document') {
      if (fp === 'README.md') score += 5;
      else if (isRoot && fp.endsWith('.md')) score += 2;
    } else if (n.type === 'file' || n.type === 'config') {
      if (entryNames.has(n.name)) score += 3;
      if (isRoot || depthOne) score += 1;
      if (fanOut.get(n.id) >= topFanOutThreshold && fanOut.get(n.id) > 0) score += 1;
      if (fanIn.get(n.id) <= lowFanInThreshold) score += 1;
    }
    if (score > 0) candidates.push({ id: n.id, score, name: n.name, summary: n.summary || '' });
  }
  candidates.sort((a, b) => b.score - a.score);
  const entryPointCandidates = candidates.slice(0, 5);

  // D. BFS from top code entry point (imports/calls edges)
  const adj = new Map();
  for (const e of edges) {
    if (e.type === 'imports' || e.type === 'calls') {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
  }
  const codeEntry = candidates.find(c => {
    const t = nodeById.get(c.id).type;
    return (t === 'file' || t === 'config') && entryNames.has(c.name);
  }) || candidates.find(c => nodeById.get(c.id).type === 'file');
  const bfs = { startNode: null, order: [], depthMap: {}, byDepth: {} };
  if (codeEntry) {
    bfs.startNode = codeEntry.id;
    const visited = new Set([codeEntry.id]);
    let queue = [codeEntry.id];
    let depth = 0;
    while (queue.length) {
      bfs.byDepth[String(depth)] = [];
      const next = [];
      for (const id of queue) {
        bfs.order.push(id);
        bfs.depthMap[id] = depth;
        bfs.byDepth[String(depth)].push(id);
        for (const t of (adj.get(id) || [])) {
          if (!visited.has(t) && nodeById.has(t)) { visited.add(t); next.push(t); }
        }
      }
      queue = next;
      depth++;
    }
  }

  // E. Non-code inventory
  const nonCodeFiles = { documentation: [], infrastructure: [], data: [], config: [] };
  for (const n of nodes) {
    const item = { id: n.id, name: n.name, type: n.type, summary: n.summary || '' };
    if (n.type === 'document') nonCodeFiles.documentation.push(item);
    else if (['service', 'pipeline', 'resource'].includes(n.type)) nonCodeFiles.infrastructure.push(item);
    else if (['table', 'schema', 'endpoint'].includes(n.type)) nonCodeFiles.data.push(item);
    else if (n.type === 'config') nonCodeFiles.config.push(item);
  }

  // F. Clusters (mutual edges, expand by 2+ connections)
  const edgeSet = new Set(edges.map(e => `${e.source}\u0000${e.target}`));
  const pairKey = (a, b) => a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  const pairs = new Map();
  for (const e of edges) {
    if (nodeById.has(e.source) && nodeById.has(e.target) && e.source !== e.target) {
      const k = pairKey(e.source, e.target);
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const mutual = [];
  for (const [k, c] of pairs) {
    if (c >= 2) { const [a, b] = k.split('\u0000'); mutual.push([a, b]); }
  }
  const adjacencyAll = new Map();
  for (const e of edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target) || e.source === e.target) continue;
    if (!adjacencyAll.has(e.source)) adjacencyAll.set(e.source, new Set());
    if (!adjacencyAll.has(e.target)) adjacencyAll.set(e.target, new Set());
    adjacencyAll.get(e.source).add(e.target);
    adjacencyAll.get(e.target).add(e.source);
  }
  const clusters = [];
  const used = new Set();
  for (const [a, b] of mutual) {
    if (used.has(a) && used.has(b)) continue;
    const cluster = new Set([a, b]);
    let changed = true;
    while (changed && cluster.size < 5) {
      changed = false;
      for (const n of nodes) {
        if (cluster.has(n.id)) continue;
        let conn = 0;
        for (const m of cluster) if ((adjacencyAll.get(n.id) || new Set()).has(m)) conn++;
        if (conn >= 2) { cluster.add(n.id); changed = true; if (cluster.size >= 5) break; }
      }
    }
    let edgeCount = 0;
    const arr = [...cluster];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++)
        edgeCount += pairs.get(pairKey(arr[i], arr[j])) || 0;
    clusters.push({ nodes: arr, edgeCount });
    arr.forEach(x => used.add(x));
    if (clusters.length >= 10) break;
  }
  clusters.sort((a, b) => b.edgeCount - a.edgeCount);

  // G. Layers
  const layersOut = {
    count: layers.length,
    list: layers.map(l => ({ id: l.id, name: l.name, description: l.description }))
  };

  // H. Node summary index
  const nodeSummaryIndex = {};
  for (const n of nodes) nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary || '' };

  const result = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal: bfs,
    nonCodeFiles,
    clusters,
    layers: layersOut,
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}
