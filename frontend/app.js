// ArchWatch — D3 force-directed architecture diagram

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────
  let graphData = null;
  let originalGraphData = null; // full unfiltered graph — never overwritten by folder filter
  let simulation = null;
  let selectedNode = null;
  const expandedModules = new Set();

  // Live update state (shared across renders)
  let nodeSel = null;
  let edgeSel = null;
  let nodeTimers = {};

  // Activity feed state
  const activityLog = [];
  let sessionStats = { filesChanged: 0, modulesHit: 0, linesDelta: 0 };
  let sidebarOpen = false;

  // Enhanced visualization state
  let currentMode = 'live'; // 'live' | 'diff'
  let snapshotMode = false;
  const snapshotNodes = new Set();
  let autoFocusEnabled = true;
  const moduleLastChange = new Map(); // moduleId → timestamp
  const AUTO_COLLAPSE_MS = 30000;
  const changeFrequency = new Map(); // nodeId → count
  const diffChurn = new Map(); // nodeId → total churn, diff mode only
  let lastDiffData = null; // stored for re-applying after module expand
  let changedFilesOnly = true; // filter expanded modules to changed files

  // Hierarchy layout constants
  const HIERARCHY_Y_OFFSET = 100;
  const HIERARCHY_X_SPACING = 160;
  const HIERARCHY_FORCE_STRENGTH = 0.6;

  // Folder navigation state
  let folderNavOpen = false;
  let activeFolderFilter = null; // null = show all, 'src/app' = only that subtree

  // Current mutable node/edge arrays (for expand/collapse without full re-render)
  let currentNodes = [];
  let currentEdges = [];

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const diagramEl = document.getElementById('diagram');
  const tooltip = document.getElementById('tooltip');
  const tooltipTitle = document.getElementById('tooltip-title');
  const tooltipBody = document.getElementById('tooltip-body');
  const wsDot = document.getElementById('ws-dot');
  const wsLabel = document.getElementById('ws-label');
  const activitySidebar = document.getElementById('activity-sidebar');
  const activityList = document.getElementById('activity-list');

  // ─── Dimensions ───────────────────────────────────────────────────────────
  function getDims() {
    return { w: diagramEl.clientWidth, h: diagramEl.clientHeight };
  }

  // ─── Node sizing ──────────────────────────────────────────────────────────
  const NODE_MIN_W = 140;
  const NODE_MAX_W = 220;
  const NODE_H_BASE = 52;
  const NODE_H_WITH_STATS = 68;
  const CHAR_W = 7.5; // approx px per char at 12px JetBrains Mono

  function nodeWidth(d) {
    const labelW = d.label.length * CHAR_W + 48; // padding + icon
    return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, labelW));
  }

  function nodeHeight(d) {
    return (d.file_count > 0 || d.line_count > 0) ? NODE_H_WITH_STATS : NODE_H_BASE;
  }

  function nodeRadius(d) {
    return Math.sqrt((nodeWidth(d) / 2) ** 2 + (nodeHeight(d) / 2) ** 2);
  }

  // ─── Custom cluster force ─────────────────────────────────────────────────
  function clusterForce(nodes) {
    const strength = 0.3;

    function force(alpha) {
      // Compute centroids per cluster
      const centroids = new Map();
      const counts = new Map();

      for (const d of nodes) {
        const c = d.cluster || 'default';
        if (!centroids.has(c)) {
          centroids.set(c, { x: 0, y: 0 });
          counts.set(c, 0);
        }
        const cen = centroids.get(c);
        cen.x += d.x;
        cen.y += d.y;
        counts.set(c, counts.get(c) + 1);
      }

      for (const [c, cen] of centroids) {
        const n = counts.get(c);
        cen.x /= n;
        cen.y /= n;
      }

      // Pull each node toward its cluster centroid (skip child nodes — hierarchy force owns them)
      for (const d of nodes) {
        if (d._parent) continue;
        const c = d.cluster || 'default';
        const cen = centroids.get(c);
        d.vx += (cen.x - d.x) * strength * alpha;
        d.vy += (cen.y - d.y) * strength * alpha;
      }
    }

    return force;
  }

  // ─── Hierarchy force ──────────────────────────────────────────────────────
  function hierarchyForce(nodes) {
    return function(alpha) {
      const byId = new Map();
      for (const d of nodes) byId.set(d.id, d);
      for (const d of nodes) {
        if (!d._parent) continue;
        const parent = byId.get(d._parent);
        if (!parent) continue;
        d.vy += (parent.y + HIERARCHY_Y_OFFSET - d.y) * HIERARCHY_FORCE_STRENGTH * alpha;
        d.vx += (parent.x - d.x) * 0.3 * alpha;
      }
    };
  }

  // ─── Build SVG ────────────────────────────────────────────────────────────
  function buildSvg() {
    const { w, h } = getDims();

    const svg = d3.select('#diagram')
      .append('svg')
      .attr('width', w)
      .attr('height', h);

    // Defs: grid pattern + glow filters
    const defs = svg.append('defs');

    defs.append('pattern')
      .attr('id', 'grid-pattern')
      .attr('width', 20)
      .attr('height', 20)
      .attr('patternUnits', 'userSpaceOnUse')
      .append('path')
      .attr('d', 'M 20 0 L 0 0 0 20')
      .attr('fill', 'none')
      .attr('stroke', '#111820')
      .attr('stroke-width', '0.5');

    // Arrow marker for edges
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', '#2d3a4a');

    // Grid background
    svg.append('rect')
      .attr('class', 'grid-bg')
      .attr('width', w)
      .attr('height', h);

    // Root group for pan/zoom
    const root = svg.append('g').attr('class', 'root');

    // Zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        root.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Reset button
    document.getElementById('btn-reset').addEventListener('click', () => {
      svg.transition().duration(500).call(
        zoom.transform,
        d3.zoomIdentity.translate(w / 2, h / 2).scale(0.9)
      );
    });

    // Click background to deselect
    svg.on('click', (event) => {
      if (event.target === svg.node() || event.target.classList.contains('grid-bg')) {
        clearSelection();
      }
    });

    return { svg, root, zoom, w, h };
  }

  // ─── Render graph ─────────────────────────────────────────────────────────
  // Accepts either renderGraph(data) or renderGraph(nodes, edges) for in-place expand/collapse updates.
  function renderGraph(dataOrNodes, edgesArg) {
    let nodes, edges, metadata;

    if (Array.isArray(dataOrNodes)) {
      // Called as renderGraph(nodes, edges) — in-place update from expand/collapse
      nodes = dataOrNodes;
      edges = edgesArg;
      metadata = graphData ? graphData.metadata : {};
      // Sync mutable arrays (already set by caller, but keep consistent)
      currentNodes = nodes;
      currentEdges = edges;
      // Delegate to applyGraphUpdate-style in-place update
      _applyNodesEdges(nodes, edges, null);
      return;
    }

    const data = dataOrNodes;

    // Remove old SVG before re-rendering (prevents stacking)
    d3.select('#diagram svg').remove();
    if (simulation) simulation.stop();

    graphData = data;

    const { nodes: n, edges: e, metadata: m } = data;
    nodes = n; edges = e; metadata = m;

    // Sync mutable arrays
    currentNodes = nodes;
    currentEdges = edges;

    updateStats(metadata, nodes, edges);

    const { svg, root, zoom, w, h } = buildSvg();

    // Edge layer (behind nodes)
    const edgeGroup = root.append('g').attr('class', 'edges');
    const nodeGroup = root.append('g').attr('class', 'nodes');

    // Build edge elements
    edgeSel = edgeGroup
      .selectAll('line.edge')
      .data(edges)
      .join('line')
      .attr('class', d => 'edge' + (d.weight > 1 ? ' strong' : '') + (d.kind === 'contains' ? ' edge-contains' : ''))
      .attr('marker-end', d => d.kind === 'contains' ? null : 'url(#arrowhead)');

    // Build node elements
    nodeSel = nodeGroup
      .selectAll('g.node')
      .data(nodes, d => d.id)
      .join('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', dragStart)
        .on('drag', dragging)
        .on('end', dragEnd)
      )
      .on('click', (event, d) => {
        event.stopPropagation();
        if (d.kind === 'module' && d.files && d.files.length > 0) {
          toggleModuleExpand(d);
        } else {
          toggleSelect(d, edgeSel, nodeSel);
        }
      })
      .on('mouseenter', (event, d) => showTooltip(event, d))
      .on('mousemove', (event) => moveTooltip(event))
      .on('mouseleave', () => hideTooltip());

    // Draw each node's visual
    nodeSel.each(function (d) {
      const g = d3.select(this);
      const nw = nodeWidth(d);
      const nh = nodeHeight(d);
      const isModule = d.kind === 'module';

      g.append('rect')
        .attr('x', -nw / 2)
        .attr('y', -nh / 2)
        .attr('width', nw)
        .attr('height', nh)
        .attr('rx', 6);

      // Icon (folder for module, file page for file)
      if (isModule) {
        // Folder icon
        g.append('path')
          .attr('class', 'node-icon')
          .attr('d', `M${-nw / 2 + 10},${-nh / 2 + 12} h6 l2,-3 h8 a2,2 0 0 1 2,2 v8 a2,2 0 0 1,-2,2 h-16 a2,2 0 0 1,-2,-2 z`)
          .attr('fill', 'none')
          .attr('stroke', '#4a5a6a')
          .attr('stroke-width', '1.2');
      } else {
        // File icon
        g.append('path')
          .attr('class', 'node-icon')
          .attr('d', `M${-nw / 2 + 10},${-nh / 2 + 10} h8 l4,4 v12 h-12 z M${-nw / 2 + 18},${-nh / 2 + 10} v4 h4`)
          .attr('fill', 'none')
          .attr('stroke', '#4a5a6a')
          .attr('stroke-width', '1.2');
      }

      // Label
      g.append('text')
        .attr('class', 'node-label')
        .attr('x', -nw / 2 + 30)
        .attr('y', (d.file_count > 0 || d.line_count > 0) ? -7 : 4)
        .text(d.label);

      // Stats row
      if (d.file_count > 0 || d.line_count > 0) {
        const statsY = 12;

        // Divider
        g.append('line')
          .attr('class', 'node-divider')
          .attr('x1', -nw / 2 + 10)
          .attr('x2', nw / 2 - 10)
          .attr('y1', statsY - 6)
          .attr('y2', statsY - 6);

        const parts = [];
        if (d.file_count > 0) parts.push(`${d.file_count} files`);
        if (d.line_count > 0) parts.push(`${fmtLines(d.line_count)} lines`);

        g.append('text')
          .attr('class', 'node-stats')
          .attr('x', -nw / 2 + 10)
          .attr('y', statsY + 8)
          .text(parts.join(' · '));
      }

      // Expand/collapse indicator for module nodes
      if (isModule && d.files && d.files.length > 0) {
        g.append('text')
          .attr('class', 'node-expand-icon')
          .attr('x', nw / 2 - 14)
          .attr('y', -nh / 2 + 16)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .text(d._expanded ? '\u2212' : '+');
      }

      if (d._parent) g.classed('node-child', true);
    });

    // ─── Force simulation ───────────────────────────────────────────────────
    const cfForce = (alpha) => clusterForce(nodes)(alpha);

    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(d => d.id)
        .distance(d => d.kind === 'contains' ? 80 : 150).strength(0.3))
      .force('charge', d3.forceManyBody().strength(d => d._parent ? -100 : -400))
      .force('center', d3.forceCenter(0, 0))
      .force('cluster', cfForce)
      .force('hierarchy', hierarchyForce(nodes))
      .force('collide', d3.forceCollide().radius(d => nodeRadius(d) + 12).strength(0.8))
      .on('tick', tick);

    function tick() {
      edgeSel
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => {
          // Shorten edge so arrowhead touches node border
          const dx = d.target.x - d.source.x;
          const dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const r = nodeRadius(d.target) + 6;
          return d.target.x - (dx / dist) * r;
        })
        .attr('y2', d => {
          const dx = d.target.x - d.source.x;
          const dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const r = nodeRadius(d.target) + 6;
          return d.target.y - (dy / dist) * r;
        });

      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
    }

    // Initial view: fit the graph centered
    const { w: vw, h: vh } = getDims();
    svg.call(zoom.transform, d3.zoomIdentity.translate(vw / 2, vh / 2).scale(0.85));
  }

  // ─── Internal: apply nodes/edges to existing SVG (used by expand/collapse) ──
  function _applyNodesEdges(nodes, edges, changes) {
    if (!nodeSel || !edgeSel || !simulation) return;

    const svg = d3.select('#diagram svg');
    const nodeGroup = svg.select('.nodes');
    const edgeGroup = svg.select('.edges');

    simulation.nodes(nodes);
    simulation.force('link').links(edges);

    edgeSel = edgeGroup
      .selectAll('line.edge')
      .data(edges)
      .join('line')
      .attr('class', d => 'edge' + (d.weight > 1 ? ' strong' : '') + (d.kind === 'contains' ? ' edge-contains' : ''))
      .attr('marker-end', d => d.kind === 'contains' ? null : 'url(#arrowhead)');

    let topologyChanged = false;
    nodeSel = nodeGroup
      .selectAll('g.node')
      .data(nodes, d => d.id)
      .join(
        enter => {
          topologyChanged = true;
          const g = enter.append('g').attr('class', 'node');
          g.call(d3.drag()
            .on('start', dragStart)
            .on('drag', dragging)
            .on('end', dragEnd)
          )
            .on('click', (event, d) => {
              event.stopPropagation();
              if (d.kind === 'module' && d.files && d.files.length > 0) {
                toggleModuleExpand(d);
              } else {
                toggleSelect(d, edgeSel, nodeSel);
              }
            })
            .on('mouseenter', (event, d) => showTooltip(event, d))
            .on('mousemove', (event) => moveTooltip(event))
            .on('mouseleave', () => hideTooltip());

          g.each(function (d) {
            drawNodeVisual(d3.select(this), d);
          });

          return g;
        },
        update => {
          update.each(function(nd) {
            const g = d3.select(this);
            g.classed('node-expanded', !!nd._expanded);
            g.classed('node-child', !!nd._parent);
            const icon = g.select('.node-expand-icon');
            if (!icon.empty()) {
              icon.text(nd._expanded ? '\u2212' : '+');
            }
          });
          return update;
        },
        exit => {
          topologyChanged = true;
          return exit.remove();
        }
      );

    if (topologyChanged) {
      simulation.alpha(0.1).restart();
    }
  }

  // ─── In-place graph update ────────────────────────────────────────────────
  function applyGraphUpdate(newData, changes) {
    if (!graphData || !nodeSel || !edgeSel) {
      renderGraph(newData);
      return;
    }

    // Re-inject child nodes for any currently expanded modules
    if (expandedModules.size > 0) {
      reinjectExpandedChildren(newData);
    }

    const { nodes: newNodes, edges: newEdges, metadata } = newData;
    graphData = newData;

    // Update folder tree with new node data
    buildFolderTree(newNodes);

    // Preserve _expanded flags from current nodes onto incoming nodes
    if (currentNodes.length > 0) {
      const expandedFlags = new Map(currentNodes.filter(n => n._expanded).map(n => [n.id, true]));
      newNodes.forEach(n => {
        if (expandedFlags.has(n.id)) n._expanded = true;
      });
    }

    // Sync mutable arrays
    currentNodes = newNodes;
    currentEdges = newEdges;

    updateStats(metadata, newNodes, newEdges);

    const svg = d3.select('#diagram svg');
    const nodeGroup = svg.select('.nodes');
    const edgeGroup = svg.select('.edges');

    // Update simulation with new nodes/edges
    simulation.nodes(newNodes);
    simulation.force('link').links(newEdges);

    // Rebuild edge selection via enter/exit
    edgeSel = edgeGroup
      .selectAll('line.edge')
      .data(newEdges)
      .join('line')
      .attr('class', d => 'edge' + (d.weight > 1 ? ' strong' : '') + (d.kind === 'contains' ? ' edge-contains' : ''))
      .attr('marker-end', d => d.kind === 'contains' ? null : 'url(#arrowhead)');

    // Rebuild node selection via enter/exit
    let topologyChanged = false;
    nodeSel = nodeGroup
      .selectAll('g.node')
      .data(newNodes, d => d.id)
      .join(
        enter => {
          topologyChanged = true;
          const g = enter.append('g').attr('class', 'node');
          g.call(d3.drag()
            .on('start', dragStart)
            .on('drag', dragging)
            .on('end', dragEnd)
          )
            .on('click', (event, d) => {
              event.stopPropagation();
              if (d.kind === 'module' && d.files && d.files.length > 0) {
                toggleModuleExpand(d);
              } else {
                toggleSelect(d, edgeSel, nodeSel);
              }
            })
            .on('mouseenter', (event, d) => showTooltip(event, d))
            .on('mousemove', (event) => moveTooltip(event))
            .on('mouseleave', () => hideTooltip());

          g.each(function (d) {
            drawNodeVisual(d3.select(this), d);
          });

          return g;
        },
        update => {
          update.each(function(nd) {
            const g = d3.select(this);
            g.classed('node-expanded', !!nd._expanded);
            g.classed('node-child', !!nd._parent);
            const icon = g.select('.node-expand-icon');
            if (!icon.empty()) {
              icon.text(nd._expanded ? '\u2212' : '+');
            }
          });
          return update;
        },
        exit => {
          topologyChanged = true;
          return exit.remove();
        }
      );

    // Highlight changed nodes
    if (changes && changes.affected_nodes) {
      highlightChangedNodes(changes.affected_nodes, changes.modified_files_rel);
    }

    // Auto-expand affected modules
    if (autoFocusEnabled && changes && changes.modified_files_rel) {
      const now = Date.now();
      changes.modified_files_rel.forEach(file => {
        if (activeFolderFilter && !file.startsWith(activeFolderFilter + '/') && file !== activeFolderFilter) {
          // skip visual update but data is already tracked
          return;
        }
        const filePath = file;
        // Find the module containing this file
        const parts = filePath.split('/');
        if (parts.length > 1) {
          const moduleId = parts.slice(0, -1).join('/');
          moduleLastChange.set(moduleId, now);
          // Find and expand the module node
          const moduleNode = currentNodes.find(n => n.id === moduleId && n.kind === 'module' && !n._expanded);
          if (moduleNode) {
            expandModule(moduleNode);
          }
        }
      });

      // Re-highlight after expand so newly injected file nodes get colored
      highlightChangedNodes(changes.affected_nodes, changes.modified_files_rel);

      // Schedule auto-collapse for stale modules
      setTimeout(() => {
        const cutoff = Date.now() - AUTO_COLLAPSE_MS;
        moduleLastChange.forEach((timestamp, moduleId) => {
          if (timestamp < cutoff) {
            const moduleNode = currentNodes.find(n => n.id === moduleId && n._expanded);
            if (moduleNode) {
              collapseModule(moduleNode);
            }
            moduleLastChange.delete(moduleId);
          }
        });
      }, AUTO_COLLAPSE_MS);
    }

    // Only reheat simulation when nodes were added or removed; skip for content-only updates
    if (topologyChanged) {
      simulation.alpha(0.1).restart();
    }
  }

  function drawNodeVisual(g, d) {
    const nw = nodeWidth(d);
    const nh = nodeHeight(d);
    const isModule = d.kind === 'module';

    g.append('rect')
      .attr('x', -nw / 2)
      .attr('y', -nh / 2)
      .attr('width', nw)
      .attr('height', nh)
      .attr('rx', 6);

    if (isModule) {
      g.append('path')
        .attr('class', 'node-icon')
        .attr('d', `M${-nw / 2 + 10},${-nh / 2 + 12} h6 l2,-3 h8 a2,2 0 0 1 2,2 v8 a2,2 0 0 1,-2,2 h-16 a2,2 0 0 1,-2,-2 z`)
        .attr('fill', 'none')
        .attr('stroke', '#4a5a6a')
        .attr('stroke-width', '1.2');
    } else {
      g.append('path')
        .attr('class', 'node-icon')
        .attr('d', `M${-nw / 2 + 10},${-nh / 2 + 10} h8 l4,4 v12 h-12 z M${-nw / 2 + 18},${-nh / 2 + 10} v4 h4`)
        .attr('fill', 'none')
        .attr('stroke', '#4a5a6a')
        .attr('stroke-width', '1.2');
    }

    g.append('text')
      .attr('class', 'node-label')
      .attr('x', -nw / 2 + 30)
      .attr('y', (d.file_count > 0 || d.line_count > 0) ? -7 : 4)
      .text(d.label);

    if (d.file_count > 0 || d.line_count > 0) {
      const statsY = 12;

      g.append('line')
        .attr('class', 'node-divider')
        .attr('x1', -nw / 2 + 10)
        .attr('x2', nw / 2 - 10)
        .attr('y1', statsY - 6)
        .attr('y2', statsY - 6);

      const parts = [];
      if (d.file_count > 0) parts.push(`${d.file_count} files`);
      if (d.line_count > 0) parts.push(`${fmtLines(d.line_count)} lines`);

      g.append('text')
        .attr('class', 'node-stats')
        .attr('x', -nw / 2 + 10)
        .attr('y', statsY + 8)
        .text(parts.join(' · '));
    }

    // Expand/collapse indicator for module nodes
    if (isModule && d.files && d.files.length > 0) {
      g.append('text')
        .attr('class', 'node-expand-icon')
        .attr('x', nw / 2 - 14)
        .attr('y', -nh / 2 + 16)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .text(d._expanded ? '\u2212' : '+');
    }

    if (d._parent) g.classed('node-child', true);
  }

  // ─── Change highlighting ───────────────────────────────────────────────────
  function highlightChangedNodes(affectedNodeIds, modifiedFilesRel) {
    const affectedSet = new Set(affectedNodeIds);
    const modifiedSet = new Set(modifiedFilesRel || []);

    nodeSel.each(function (d) {
      const isAffected = affectedSet.has(d.id) || modifiedSet.has(d.id);
      if (!isAffected) return;

      // Update frequency
      changeFrequency.set(d.id, (changeFrequency.get(d.id) || 0) + 1);
      const freq = changeFrequency.get(d.id);
      let tier;
      if (freq >= 16) tier = 5;
      else if (freq >= 8) tier = 4;
      else if (freq >= 4) tier = 3;
      else if (freq >= 2) tier = 2;
      else tier = 1;

      const el = d3.select(this);
      el.attr('data-freq', tier);
      el.classed('node-active', true);

      if (snapshotMode) {
        snapshotNodes.add(d.id);
        // No fade timer in snapshot mode
      } else {
        // Clear any existing timer
        if (d._fadeTimer) clearTimeout(d._fadeTimer);
        d._fadeTimer = setTimeout(() => {
          el.classed('node-active', false);
          d._fadeTimer = null;
        }, 3000);
      }
    });

    // Highlight edges connected to affected nodes
    edgeSel.each(function (d) {
      const srcId = typeof d.source === 'object' ? d.source.id : d.source;
      const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
      const isAffected = affectedSet.has(srcId) || affectedSet.has(tgtId)
        || modifiedSet.has(srcId) || modifiedSet.has(tgtId);

      if (!isAffected) return;

      const el = this;
      d3.select(el)
        .classed('edge-active', true)
        .classed('edge-recent', false);

      setTimeout(() => {
        d3.select(el)
          .classed('edge-active', false)
          .classed('edge-recent', true);

        setTimeout(() => {
          d3.select(el).classed('edge-recent', false);
        }, 12000);
      }, 8000);
    });
  }

  // ─── Drag handlers ────────────────────────────────────────────────────────
  function dragStart(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragging(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragEnd(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // ─── Selection ────────────────────────────────────────────────────────────
  function toggleSelect(d, edgeSel, nodeSel) {
    if (selectedNode === d.id) {
      clearSelection();
      return;
    }
    selectedNode = d.id;

    // Find connected node ids
    const connected = new Set([d.id]);
    edgeSel.each(nd => {
      const srcId = typeof nd.source === 'object' ? nd.source.id : nd.source;
      const tgtId = typeof nd.target === 'object' ? nd.target.id : nd.target;
      if (srcId === d.id || tgtId === d.id) {
        connected.add(srcId);
        connected.add(tgtId);
      }
    });

    nodeSel
      .classed('selected', nd => nd.id === d.id)
      .classed('dimmed', nd => !connected.has(nd.id));

    edgeSel.classed('dimmed', nd => {
      const srcId = typeof nd.source === 'object' ? nd.source.id : nd.source;
      const tgtId = typeof nd.target === 'object' ? nd.target.id : nd.target;
      return srcId !== d.id && tgtId !== d.id;
    }).classed('highlighted', nd => {
      const srcId = typeof nd.source === 'object' ? nd.source.id : nd.source;
      const tgtId = typeof nd.target === 'object' ? nd.target.id : nd.target;
      return srcId === d.id || tgtId === d.id;
    });
  }

  function clearSelection() {
    selectedNode = null;
    d3.selectAll('.node').classed('selected', false).classed('dimmed', false);
    d3.selectAll('.edge').classed('dimmed', false).classed('highlighted', false);
  }

  // ─── Module expand/collapse ─────────────────────────────────────────────
  function toggleModuleExpand(d) {
    if (d._expanded) {
      collapseModule(d);
    } else {
      expandModule(d);
    }
  }

  function expandModule(d) {
    if (!d.files || d.files.length === 0 || d._expanded) return;
    d._expanded = true;
    expandedModules.add(d.id);

    // Filter to changed files only (with fallback to all if none changed)
    let filesToShow = d.files;
    if (changedFilesOnly) {
      const changed = filesToShow.filter(f => {
        const path = typeof f === 'string' ? f : f.path;
        return changeFrequency.has(path);
      });
      if (changed.length > 0) filesToShow = changed;
    }
    d._filteredExpand = changedFilesOnly && filesToShow.length < d.files.length;

    // Group files by immediate subdirectory
    const directFiles = [];
    const subDirs = new Map(); // subDirName → files[]

    filesToShow.forEach(f => {
      const filePath = typeof f === 'string' ? f : f.path;
      const relPath = filePath.startsWith(d.id + '/') ? filePath.slice(d.id.length + 1) : filePath;
      const slashIdx = relPath.indexOf('/');
      if (slashIdx === -1) {
        directFiles.push({ path: filePath, language: f.language, line_count: f.line_count });
      } else {
        const subDirName = relPath.slice(0, slashIdx);
        if (!subDirs.has(subDirName)) subDirs.set(subDirName, []);
        subDirs.get(subDirName).push(f);
      }
    });

    const children = [];
    const childEdges = [];
    const totalItems = subDirs.size + directFiles.length;
    const totalWidth = Math.max(0, (totalItems - 1)) * HIERARCHY_X_SPACING;
    const startX = d.x - totalWidth / 2;
    const childY = d.y + HIERARCHY_Y_OFFSET;
    let i = 0;

    // Create sub-module nodes for subdirectories first (folders on the left)
    subDirs.forEach((files, subDirName) => {
      const subModuleId = d.id + '/' + subDirName;
      const totalLines = files.reduce((sum, f) => sum + (typeof f === 'object' ? (f.line_count || 0) : 0), 0);
      const child = {
        id: subModuleId,
        label: subDirName,
        kind: 'module',
        file_count: files.length,
        line_count: totalLines,
        files: files,
        x: startX + (i++) * HIERARCHY_X_SPACING,
        y: childY,
        _parent: d.id,
        _synthetic: true,
      };
      children.push(child);
      childEdges.push({ source: d.id, target: subModuleId, kind: 'contains', weight: 1 });
    });

    // Create direct file child nodes (files on the right)
    directFiles.forEach(f => {
      const child = {
        id: f.path,
        label: f.path.split('/').pop(),
        kind: 'file',
        language: f.language,
        line_count: f.line_count || 0,
        file_count: 0,
        files: [],
        x: startX + (i++) * HIERARCHY_X_SPACING,
        y: childY,
        _parent: d.id,
      };
      children.push(child);
      childEdges.push({ source: d.id, target: f.path, kind: 'contains', weight: 1 });
    });

    d._children = children.map(c => c.id);

    currentNodes.push(...children);
    currentEdges.push(...childEdges);

    renderGraph(currentNodes, currentEdges);

    // Re-apply diff overlay to newly created child nodes
    if (currentMode === 'diff' && lastDiffData) {
      applyDiffOverlay(lastDiffData);
    }
  }

  function collapseModule(d) {
    if (!d._expanded) return;
    d._expanded = false;
    expandedModules.delete(d.id);

    // Recursively collapse children that are expanded sub-modules
    if (d._children) {
      d._children.forEach(childId => {
        const childNode = currentNodes.find(n => n.id === childId);
        if (childNode && childNode._expanded) {
          collapseModule(childNode);
        }
      });
    }

    // Remove children and their edges
    const childSet = new Set(d._children || []);
    currentNodes = currentNodes.filter(n => !childSet.has(n.id));
    currentEdges = currentEdges.filter(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return !childSet.has(src) && !childSet.has(tgt);
    });

    d._children = null;
    renderGraph(currentNodes, currentEdges);
  }

  function toggleChangedFilesOnly() {
    changedFilesOnly = !changedFilesOnly;
    // Re-expand all currently expanded modules with new filter
    const expandedIds = currentNodes.filter(n => n._expanded).map(n => n.id);
    [...expandedIds].reverse().forEach(id => {
      const node = currentNodes.find(n => n.id === id);
      if (node) collapseModule(node);
    });
    expandedIds.forEach(id => {
      const node = currentNodes.find(n => n.id === id);
      if (node) expandModule(node);
    });
  }

  function reinjectExpandedChildren(data) {
    const oldNodes = graphData ? graphData.nodes : [];

    for (const moduleId of [...expandedModules]) {
      const parentNode = data.nodes.find(n => n.id === moduleId);
      if (!parentNode || !parentNode.files) {
        expandedModules.delete(moduleId);
        continue;
      }
      // Restore the _expanded flag on the incoming node so flags stay in sync
      parentNode._expanded = true;
      if (data.nodes.some(n => n._parent === moduleId)) continue;

      const parentOld = oldNodes.find(n => n.id === moduleId);
      const px = parentOld ? parentOld.x : 0;
      const py = parentOld ? parentOld.y : 0;

      const files = parentNode.files;
      const totalWidth = Math.max(0, (files.length - 1)) * HIERARCHY_X_SPACING;
      const startX = px - totalWidth / 2;
      const childY = py + HIERARCHY_Y_OFFSET;

      const childNodes = files.map((filePath, idx) => {
        const old = oldNodes.find(n => n.id === filePath);
        return {
          id: filePath,
          label: filePath.split('/').pop().replace(/\.\w+$/, ''),
          kind: 'file',
          language: parentNode.language,
          file_count: 0,
          line_count: 0,
          files: [filePath],
          _parent: parentNode.id,
          x: old ? old.x : startX + idx * HIERARCHY_X_SPACING,
          y: old ? old.y : childY,
        };
      });

      const childEdges = childNodes.map(child => ({
        source: parentNode.id,
        target: child.id,
        kind: 'contains',
        weight: 1,
      }));

      data.nodes.push(...childNodes);
      data.edges.push(...childEdges);
    }
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────
  function showTooltip(event, d) {
    tooltipTitle.textContent = d.label;

    const lines = [];
    if (d.kind) lines.push(`<span class="label">kind</span>  <span class="value">${d.kind}</span>`);
    if (d.language) lines.push(`<span class="label">lang</span>  <span class="value">${d.language}</span>`);
    if (d.file_count > 0) lines.push(`<span class="label">files</span> <span class="value">${d.file_count}</span>`);
    if (d.line_count > 0) lines.push(`<span class="label">lines</span> <span class="value">${fmtLines(d.line_count)}</span>`);
    if (d.cluster) lines.push(`<span class="label">cluster</span> <span class="value">${d.cluster}</span>`);

    if (d.files && d.files.length > 0) {
      const shown = d.files.slice(0, 5);
      const more = d.files.length - shown.length;
      lines.push(`<div class="file-list">${shown.join('<br>')}${more > 0 ? `<br>+${more} more` : ''}</div>`);
    }

    if (currentMode === 'diff' && diffChurn.has(d.id)) {
      lines.push(`<span class="label">churn</span> <span class="value">±${diffChurn.get(d.id)} lines</span>`);
    }

    tooltipBody.innerHTML = lines.join('<br>');
    tooltip.classList.remove('hidden');
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const pad = 14;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = event.clientX + pad;
    let y = event.clientY + pad;

    if (x + tw > window.innerWidth - 8) x = event.clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
  }

  // ─── Header stats ─────────────────────────────────────────────────────────
  function updateStats(meta, nodes, edges) {
    document.getElementById('stat-modules').textContent = nodes.length;
    document.getElementById('stat-files').textContent = meta.total_files ?? '—';
    document.getElementById('stat-lines').textContent = meta.total_lines ? fmtLines(meta.total_lines) : '—';
    document.getElementById('stat-ms').textContent = meta.analysis_ms != null ? meta.analysis_ms : '—';
  }

  function fmtLines(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // ─── Activity feed ────────────────────────────────────────────────────────
  function addActivityEntry(changes) {
    const now = Date.now();
    const files = changes.modified_files || [];
    const nodes = changes.affected_nodes || [];

    // Session stats
    sessionStats.filesChanged += files.length;
    const newModules = nodes.filter(n => !activityLog.some(e => e.nodes.includes(n)));
    sessionStats.modulesHit += newModules.length;

    const entry = {
      timestamp: changes.timestamp || now,
      files,
      nodes,
      linesAdded: changes.lines_added || null,
      linesRemoved: changes.lines_removed || null,
    };

    activityLog.unshift(entry);
    if (activityLog.length > 50) activityLog.pop();

    renderActivityFeed();
    updateSessionStats();
  }

  function renderActivityFeed() {
    if (activityLog.length === 0) {
      activityList.innerHTML = '<div class="activity-empty">No changes yet</div>';
      return;
    }

    const now = Date.now();
    const html = activityLog.map(entry => {
      const age = now - entry.timestamp;
      let ageClass;
      if (age < 3000) ageClass = 'entry-active';
      else if (age < 15000) ageClass = 'entry-recent';
      else ageClass = 'entry-old';

      const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const moduleText = entry.nodes.length > 0 ? entry.nodes[0] : '—';
      const fileText = entry.files.length > 0 ? entry.files[0].split('/').slice(-2).join('/') : '—';
      const moreFiles = entry.files.length > 1 ? ` +${entry.files.length - 1}` : '';

      const linesHtml = (entry.linesAdded != null || entry.linesRemoved != null)
        ? `<div class="activity-entry-lines">
            ${entry.linesAdded != null ? `<span class="lines-added">+${entry.linesAdded}</span>` : ''}
            ${entry.linesRemoved != null ? `<span class="lines-removed">-${entry.linesRemoved}</span>` : ''}
          </div>`
        : '';

      return `<div class="activity-entry ${ageClass}">
        <div class="activity-entry-time">${timeStr}</div>
        <div class="activity-entry-module">${moduleText}</div>
        <div class="activity-entry-file">${fileText}${moreFiles}</div>
        ${linesHtml}
      </div>`;
    }).join('');

    activityList.innerHTML = html;
  }

  function updateSessionStats() {
    document.getElementById('stat-changed-files').textContent = sessionStats.filesChanged;
    document.getElementById('stat-modules-hit').textContent = sessionStats.modulesHit;
    const delta = sessionStats.linesDelta;
    const el = document.getElementById('stat-lines-delta');
    el.textContent = (delta >= 0 ? '+' : '') + delta;
    el.style.color = delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : '';
  }

  // Refresh age-based colors in activity feed every 3s
  setInterval(() => {
    if (activityLog.length > 0) renderActivityFeed();
  }, 3000);

  // ─── Activity sidebar toggle ───────────────────────────────────────────────
  function openSidebar() {
    sidebarOpen = true;
    activitySidebar.classList.add('open');
    diagramEl.classList.add('sidebar-open');
  }

  function closeSidebar() {
    sidebarOpen = false;
    activitySidebar.classList.remove('open');
    diagramEl.classList.remove('sidebar-open');
  }

  function toggleSidebar() {
    if (sidebarOpen) closeSidebar();
    else openSidebar();
  }

  // ─── Folder navigation sidebar ────────────────────────────────────────────
  function buildFolderTree(nodes) {
    const modules = nodes.filter(n => n.kind === 'module').map(n => n.id).sort();
    const tree = document.getElementById('folder-nav-tree');
    if (!tree) return;
    tree.innerHTML = '';

    const allItem = createFolderItem('All', null, 0);
    tree.appendChild(allItem);

    modules.forEach(modId => {
      const depth = modId.split('/').length;
      const label = modId.split('/').pop();
      tree.appendChild(createFolderItem(label, modId, depth));
    });
  }

  function createFolderItem(label, path, depth) {
    const el = document.createElement('div');
    el.className = 'folder-item' + (path === activeFolderFilter ? ' active' : '');
    if (path === null && activeFolderFilter === null) el.classList.add('active');
    el.innerHTML = `<span class="folder-indent" style="width:${depth * 12}px"></span>`
      + `<span class="folder-icon">${path ? '&#x25B8;' : '&#x25C6;'}</span>`
      + `<span class="folder-name">${label}</span>`;
    el.addEventListener('click', () => setFolderFilter(path));
    return el;
  }

  function setFolderFilter(path) {
    if (path === activeFolderFilter) return; // deduplicate double-clicks
    activeFolderFilter = path;

    const source = originalGraphData || graphData;
    buildFolderTree(source.nodes);

    if (!path) {
      renderGraph(source);
      return;
    }

    const filtered = source.nodes.filter(n =>
      n.id === path || n.id.startsWith(path + '/')
    );
    const filteredIds = new Set(filtered.map(n => n.id));
    const filteredEdges = source.edges.filter(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return filteredIds.has(src) && filteredIds.has(tgt);
    });

    renderGraph({ nodes: filtered, edges: filteredEdges, metadata: source.metadata });
  }

  function toggleFolderNav() {
    folderNavOpen = !folderNavOpen;
    document.getElementById('folder-nav')?.classList.toggle('open', folderNavOpen);
    diagramEl.classList.toggle('folder-nav-open', folderNavOpen);
  }

  document.getElementById('btn-folders')?.addEventListener('click', toggleFolderNav);
  document.getElementById('folder-nav-close')?.addEventListener('click', toggleFolderNav);

  document.getElementById('btn-activity').addEventListener('click', toggleSidebar);
  document.getElementById('activity-close').addEventListener('click', closeSidebar);

  document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (event.key === 'a' || event.key === 'A') toggleSidebar();
    if (event.key === 'n' || event.key === 'N') toggleFolderNav();
  });

  // ── Mode toggle ──
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // ── Snapshot toggle ──
  const btnSnapshot = document.getElementById('btn-snapshot');
  if (btnSnapshot) {
    btnSnapshot.addEventListener('click', () => {
      snapshotMode = !snapshotMode;
      btnSnapshot.classList.toggle('active', snapshotMode);
      if (!snapshotMode) {
        // Clear all persistent highlights
        snapshotNodes.clear();
        nodeSel.classed('node-active', false);
      }
    });
  }

  // ── Auto-focus toggle ──
  const btnAutofocus = document.getElementById('btn-autofocus');
  if (btnAutofocus) {
    btnAutofocus.classList.add('active'); // match default-on state
    btnAutofocus.addEventListener('click', () => {
      autoFocusEnabled = !autoFocusEnabled;
      btnAutofocus.classList.toggle('active', autoFocusEnabled);
    });
  }

  // ── Changed-files-only toggle ──
  const btnChangedOnly = document.getElementById('btn-changed-only');
  if (btnChangedOnly) {
    btnChangedOnly.addEventListener('click', () => {
      toggleChangedFilesOnly();
      btnChangedOnly.classList.toggle('active', changedFilesOnly);
    });
  }

  // ── Diff refresh ──
  const btnDiffRefresh = document.getElementById('btn-diff-refresh');
  if (btnDiffRefresh) {
    btnDiffRefresh.addEventListener('click', async () => {
      if (currentMode !== 'diff') return;
      const baseBranch = document.getElementById('branch-input')?.value || 'main';
      const diffData = await fetchBranchDiff(baseBranch);
      if (diffData) applyDiffOverlay(diffData);
    });
  }

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case 's':
        btnSnapshot?.click();
        break;
      case 'f':
        btnAutofocus?.click();
        break;
      case 'c':
        btnChangedOnly?.click();
        break;
      case 'd':
        switchMode(currentMode === 'live' ? 'diff' : 'live');
        break;
    }
  });

  // ─── Fetch graph ──────────────────────────────────────────────────────────
  function loadGraph() {
    fetch('/api/graph')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        originalGraphData = data;
        renderGraph(data);
        buildFolderTree(data.nodes);
      })
      .catch(err => {
        showError(err.message);
      });
  }

  function showError(msg) {
    diagramEl.innerHTML = `
      <div class="error-overlay">
        <div class="error-code">Failed to load graph data</div>
        <div class="error-msg">${msg}</div>
      </div>`;
  }

  // ── Diff Mode ──────────────────────────────────────────────────────────────
  async function fetchBranchDiff(baseBranch) {
    try {
      const resp = await fetch(`/api/branch-diff?base=${encodeURIComponent(baseBranch)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const msg = err.error || resp.statusText;
        console.error('Branch diff failed:', msg);
        showDiffError(msg);
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.error('Branch diff fetch error:', e);
      showDiffError('Could not connect to diff API');
      return null;
    }
  }

  function diffTier(churn) {
    if (churn >= 100) return 5;
    if (churn >= 41) return 4;
    if (churn >= 16) return 3;
    if (churn >= 6) return 2;
    if (churn >= 1) return 1;
    return 0;
  }

  function applyDiffOverlay(diffData) {
    if (!diffData || !diffData.diff) return;
    lastDiffData = diffData;

    // Clear any live highlights
    nodeSel.classed('node-active', false);

    const fileMap = new Map();
    diffData.diff.files.forEach(f => {
      fileMap.set(f.path, {
        status: f.status,
        churn: (f.additions || 0) + (f.deletions || 0),
      });
    });

    // Also map to module-level
    const moduleMap = new Map();
    diffData.diff.files.forEach(f => {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        const moduleId = parts.slice(0, -1).join('/');
        const churn = (f.additions || 0) + (f.deletions || 0);
        if (!moduleMap.has(moduleId)) {
          moduleMap.set(moduleId, { status: f.status, churn });
        } else {
          const existing = moduleMap.get(moduleId);
          existing.churn += churn;
          if (existing.status !== f.status) existing.status = 'modified';
        }
      }
    });

    diffChurn.clear();

    nodeSel.each(function (d) {
      const el = d3.select(this);
      el.classed('diff-added', false).classed('diff-modified', false).classed('diff-deleted', false);

      const entry = fileMap.get(d.id) || moduleMap.get(d.id);
      if (!entry) return;

      const { status, churn } = entry;
      el.classed('diff-' + status, true);

      if (status !== 'deleted') {
        const tier = diffTier(churn);
        if (tier > 0) el.attr('data-diff-tier', tier);
      }

      diffChurn.set(d.id, churn);
    });

    // Auto-expand modules with changed files
    if (diffData.diff.summary && diffData.diff.summary.affected_modules) {
      diffData.diff.summary.affected_modules.forEach(moduleId => {
        const moduleNode = currentNodes.find(n => n.id === moduleId && n.kind === 'module' && !n._expanded);
        if (moduleNode) expandModule(moduleNode);
      });
    }
  }

  function clearDiffOverlay() {
    nodeSel.each(function () {
      d3.select(this)
        .classed('diff-added', false)
        .classed('diff-modified', false)
        .classed('diff-deleted', false)
        .attr('data-diff-tier', null);
    });
    diffChurn.clear();
    lastDiffData = null;
  }

  function showDiffError(msg) {
    let toast = document.getElementById('diff-error-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'diff-error-toast';
      toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#ff6b6b;border:1px solid #ff6b6b;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;pointer-events:auto;cursor:pointer;opacity:0;transition:opacity 0.3s';
      toast.addEventListener('click', () => { toast.style.opacity = '0'; });
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 4000);
  }

  async function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    // Update UI buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const branchSelect = document.getElementById('branch-select');

    if (mode === 'diff') {
      branchSelect?.classList.remove('hidden');
      document.getElementById('legend-live')?.classList.add('hidden');
      document.getElementById('legend-diff')?.classList.remove('hidden');

      const baseBranch = document.getElementById('branch-input')?.value || 'main';
      const diffData = await fetchBranchDiff(baseBranch);
      if (diffData) {
        applyDiffOverlay(diffData);
      } else {
        setTimeout(() => switchMode('live'), 3000);
        return;
      }
    } else {
      branchSelect?.classList.add('hidden');
      document.getElementById('legend-live')?.classList.remove('hidden');
      document.getElementById('legend-diff')?.classList.add('hidden');
      clearDiffOverlay();
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────
  let wsRetryTimer = null;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    let ws;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setWsState('error', 'unavailable');
      return;
    }

    setWsState('connecting', 'connecting');

    ws.addEventListener('open', () => {
      console.log('[ArchWatch] WebSocket connected to', url);
      setWsState('connected', 'live');
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'graph_update') {
        console.log('[ArchWatch] Graph update received', msg.changes);
        applyGraphUpdate(msg.graph, msg.changes);
        addActivityEntry(msg.changes || {});
      }
    });

    ws.addEventListener('close', () => {
      setWsState('error', 'reconnecting');
      console.log('[ArchWatch] WebSocket closed, reconnecting in 2s...');
      wsRetryTimer = setTimeout(connectWs, 2000);
    });

    ws.addEventListener('error', () => {
      setWsState('error', 'error');
    });
  }

  function setWsState(state, label) {
    wsDot.className = 'ws-dot' + (state !== 'connecting' ? ' ' + state : '');
    wsLabel.textContent = label;
  }

  // ─── Resize ───────────────────────────────────────────────────────────────
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!graphData) return;
      d3.select('#diagram svg').remove();
      if (simulation) simulation.stop();
      renderGraph(graphData);
    }, 200);
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  loadGraph();
  connectWs();
})();
