#!/usr/bin/env node
const fs = require('fs');

const [,, inPath, outPath] = process.argv;
try {
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const fileNodes = data.fileNodes || [];
  const importEdges = data.importEdges || [];
  const allEdges = data.allEdges || importEdges;

  const ids = new Set(fileNodes.map(n => n.id));
  const nodeById = Object.fromEntries(fileNodes.map(n => [n.id, n]));

  // ---- A. Directory grouping ----
  const paths = fileNodes.map(n => n.filePath || n.id.replace(/^[a-z]+:/, ''));
  // common prefix: compare first segments
  const segs = paths.map(p => p.split('/'));
  let prefix = [];
  if (segs.length > 1) {
    const first = segs[0];
    for (let i = 0; i < first.length - 1; i++) {
      const seg = first[i];
      if (segs.every(s => s.length > i + 1 && s[i] === seg)) prefix.push(seg);
      else break;
    }
  } else if (segs.length === 1) {
    prefix = segs[0].slice(0, -1);
  }
  const prefixLen = prefix.length;

  function groupOf(p) {
    const parts = p.split('/');
    if (parts.length - 1 <= prefixLen) {
      // file directly under prefix -> root group
      return parts.length === 1 ? 'root' : parts[parts.length - 2] === prefix[prefixLen.length] ? 'root' : 'root';
    }
    const g = parts[prefixLen];
    return g;
  }

  const directoryGroups = {};
  const nodeGroup = {};
  for (const n of fileNodes) {
    const p = n.filePath || n.id.replace(/^[a-z]+:/, '');
    const g = groupOf(p);
    (directoryGroups[g] = directoryGroups[g] || []).push(n.id);
    nodeGroup[n.id] = g;
  }

  // ---- B. Node type grouping ----
  const nodeTypeGroups = {};
  for (const n of fileNodes) (nodeTypeGroups[n.type] = nodeTypeGroups[n.type] || []).push(n.id);

  // ---- C. fan in/out ----
  const fileFanIn = {}, fileFanOut = {};
  for (const e of importEdges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    fileFanOut[e.source] = (fileFanOut[e.source] || 0) + 1;
    fileFanIn[e.target] = (fileFanIn[e.target] || 0) + 1;
  }

  // ---- D. Cross-category edges ----
  const crossMap = {};
  for (const e of allEdges) {
    const s = nodeById[e.source], t = nodeById[e.target];
    if (!s || !t || s.id === t.id) continue;
    if (s.type === t.type) continue;
    const k = `${s.type}|${t.type}|${e.type}`;
    crossMap[k] = (crossMap[k] || 0) + 1;
  }
  const crossCategoryEdges = Object.entries(crossMap).map(([k, count]) => {
    const [fromType, toType, edgeType] = k.split('|');
    return { fromType, toType, edgeType, count };
  }).sort((a, b) => b.count - a.count);

  // ---- E. inter-group imports ----
  const interMap = {};
  const intra = {};
  for (const e of importEdges) {
    const gs = nodeGroup[e.source], gt = nodeGroup[e.target];
    if (!gs || !gt) continue;
    if (gs === gt) {
      intra[gs] = intra[gs] || { internalEdges: 0, totalEdges: 0 };
      intra[gs].internalEdges++;
    } else {
      const k = `${gs}|${gt}`;
      interMap[k] = (interMap[k] || 0) + 1;
    }
  }
  const interGroupImports = Object.entries(interMap).map(([k, count]) => {
    const [from, to] = k.split('|');
    return { from, to, count };
  }).sort((a, b) => b.count - a.count);

  // intra total edges: count all import edges touching the group
  const groupTouch = {};
  for (const e of importEdges) {
    const gs = nodeGroup[e.source], gt = nodeGroup[e.target];
    if (gs) { intra[gs] = intra[gs] || { internalEdges: 0, totalEdges: 0 }; intra[gs].totalEdges++; }
    if (gt && gt !== gs) { intra[gt] = intra[gt] || { internalEdges: 0, totalEdges: 0 }; intra[gt].totalEdges++; }
  }
  const intraGroupDensity = {};
  for (const g of Object.keys(intra)) {
    const { internalEdges, totalEdges } = intra[g];
    intraGroupDensity[g] = { internalEdges, totalEdges, density: totalEdges ? +(internalEdges / totalEdges).toFixed(2) : 0 };
  }

  // ---- G. pattern matching ----
  const dirPatterns = [
    [/^(routes|api|controllers|endpoints|handlers|serializers|routers|controller|blueprints)$/, 'api'],
    [/^(services|core|lib|domain|logic|signals|composables|mailers|jobs|channels|internal)$/, 'service'],
    [/^(models|db|data|persistence|repository|entities|migrations|entity|sql|database|schema)$/, 'data'],
    [/^(components|views|pages|ui|layouts|screens)$/, 'ui'],
    [/^(middleware|plugins|interceptors|guards)$/, 'middleware'],
    [/^(utils|helpers|common|shared|tools|templatetags|pkg)$/, 'utility'],
    [/^(config|constants|env|settings|management|commands)$/, 'config'],
    [/^(__tests__|test|tests|spec|specs)$/, 'test'],
    [/^(types|interfaces|schemas|contracts|dtos|dto|request|response)$/, 'types'],
    [/^hooks$/, 'hooks'],
    [/^(store|state|reducers|actions|slices)$/, 'state'],
    [/^(assets|static|public)$/, 'assets'],
    [/^(cmd|bin)$/, 'entry'],
    [/^(docs|documentation|wiki)$/, 'documentation'],
    [/^(deploy|deployment|infra|infrastructure|k8s|kubernetes|helm|charts|terraform|tf|docker)$/, 'infrastructure'],
    [/^(\.github|\.gitlab|\.circleci)$/, 'ci-cd'],
    [/^(scripts|bin)$/, 'entry'],
  ];
  const patternMatches = {};
  for (const g of Object.keys(directoryGroups)) {
    for (const [re, label] of dirPatterns) {
      if (re.test(g)) { patternMatches[g] = label; break; }
    }
  }

  const fileStats = {
    totalFileNodes: fileNodes.length,
    filesPerGroup: Object.fromEntries(Object.entries(directoryGroups).map(([g, a]) => [g, a.length])),
    nodeTypeCounts: Object.fromEntries(Object.entries(nodeTypeGroups).map(([t, a]) => [t, a.length])),
  };

  // ---- H. deployment topology ----
  const infraFiles = fileNodes.filter(n =>
    /Dockerfile|docker-compose|\.tf$|\.tfvars$|k8s|kubernetes|Jenkinsfile|\.gitlab-ci|Makefile/i.test(n.filePath)
  ).map(n => n.id);
  const ciFiles = fileNodes.filter(n => /\.github\/workflows|\.gitlab-ci|Jenkinsfile/.test(n.filePath)).map(n => n.id);
  const deploymentTopology = {
    hasDockerfile: infraFiles.some(f => /Dockerfile/.test(f)),
    hasCompose: infraFiles.some(f => /docker-compose/.test(f)),
    hasK8s: infraFiles.some(f => /k8s|kubernetes/i.test(f)),
    hasTerraform: infraFiles.some(f => /\.tf$/.test(f)),
    hasCI: ciFiles.length > 0,
    infraFiles, ciFiles,
  };

  // ---- I. data pipeline ----
  const dataPipeline = {
    schemaFiles: fileNodes.filter(n => /\.(sql|graphql|gql|proto|prisma)$/.test(n.filePath)).map(n => n.id),
    migrationFiles: fileNodes.filter(n => /migrations\//.test(n.filePath)).map(n => n.id),
    dataModelFiles: fileNodes.filter(n => /\/(models|db)\//.test(n.filePath)).map(n => n.id),
    apiHandlerFiles: fileNodes.filter(n => /\/(routes|api|controllers)\//.test(n.filePath)).map(n => n.id),
  };

  // ---- J. doc coverage ----
  const docFiles = fileNodes.filter(n => /\.(md|rst)$/.test(n.filePath));
  const groupsWithDocs = Object.keys(directoryGroups).filter(g =>
    directoryGroups[g].some(id => /\.(md|rst)$/.test(nodeById[id].filePath))
  );
  const docCoverage = {
    groupsWithDocs: groupsWithDocs.length,
    totalGroups: Object.keys(directoryGroups).length,
    coverageRatio: +(groupsWithDocs.length / Object.keys(directoryGroups).length).toFixed(2),
    undocumentedGroups: Object.keys(directoryGroups).filter(g => !groupsWithDocs.includes(g)),
    docFiles: docFiles.map(n => n.id),
  };

  // ---- K. dependency direction ----
  const dirMatrix = {};
  for (const { from, to, count } of interGroupImports) {
    const k = from < to ? `${from}|${to}` : `${to}|${from}`;
    dirMatrix[k] = dirMatrix[k] || {};
    if (from < to) dirMatrix[k].a2b = count; else dirMatrix[k].b2a = count;
  }
  const dependencyDirection = Object.entries(dirMatrix).map(([k, v]) => {
    let [a, b] = k.split('|');
    const a2b = v.a2b || 0, b2a = v.b2a || 0;
    return a2b >= b2a ? { dependent: a, dependsOn: b, weight: a2b, reverse: b2a } : { dependent: b, dependsOn: a, weight: b2a, reverse: a2b };
  }).sort((x, y) => y.weight - x.weight);

  const result = {
    scriptCompleted: true,
    commonPrefix: prefix.join('/'),
    directoryGroups, nodeTypeGroups, crossCategoryEdges,
    interGroupImports, intraGroupDensity, patternMatches,
    deploymentTopology, dataPipeline, docCoverage,
    dependencyDirection, fileStats, fileFanIn, fileFanOut,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('OK');
} catch (err) {
  console.error(err.stack || err.message);
  process.exit(1);
}
