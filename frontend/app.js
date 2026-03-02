// ArchWatch — D3 force-directed architecture diagram

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────
  let graphData = null;
  let simulation = null;
  let selectedNode = null;

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const diagramEl = document.getElementById('diagram');
  const tooltip = document.getElementById('tooltip');
  const tooltipTitle = document.getElementById('tooltip-title');
  const tooltipBody = document.getElementById('tooltip-body');
  const wsDot = document.getElementById('ws-dot');
  const wsLabel = document.getElementById('ws-label');

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

      // Pull each node toward its cluster centroid
      for (const d of nodes) {
        const c = d.cluster || 'default';
        const cen = centroids.get(c);
        d.vx += (cen.x - d.x) * strength * alpha;
        d.vy += (cen.y - d.y) * strength * alpha;
      }
    }

    return force;
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
  function renderGraph(data) {
    graphData = data;

    const { nodes, edges, metadata } = data;

    updateStats(metadata, nodes, edges);

    const { svg, root, zoom, w, h } = buildSvg();

    // Edge layer (behind nodes)
    const edgeGroup = root.append('g').attr('class', 'edges');
    const nodeGroup = root.append('g').attr('class', 'nodes');

    // Build edge elements
    const edgeSel = edgeGroup
      .selectAll('line.edge')
      .data(edges)
      .join('line')
      .attr('class', d => `edge${d.weight > 1 ? ' strong' : ''}`)
      .attr('marker-end', 'url(#arrowhead)');

    // Build node elements
    const nodeSel = nodeGroup
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
        toggleSelect(d, edgeSel, nodeSel);
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
    });

    // ─── Force simulation ───────────────────────────────────────────────────
    const cfForce = (alpha) => clusterForce(nodes)(alpha);

    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges)
        .id(d => d.id)
        .distance(150)
        .strength(0.3)
      )
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(0, 0))
      .force('cluster', cfForce)
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

  // ─── Fetch graph ──────────────────────────────────────────────────────────
  function loadGraph() {
    fetch('/api/graph')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        renderGraph(data);
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

  // ─── WebSocket stub ───────────────────────────────────────────────────────
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
        console.log('[ArchWatch] Graph update received');
        // Reload the full graph on update
        // Future: apply incremental patch
        loadGraph();
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
