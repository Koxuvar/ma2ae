/*
    Wave Engine for After Effects
    A GrandMA-style effects engine / phaser: waveform + low/high + phase spread + BPM,
    baked as keyframes onto one property across many layers.

    Install:  copy this file into
                Adobe After Effects <version>/Scripts/ScriptUI Panels/
              restart AE, then open it from the Window menu (dockable panel).
              Or run once via File > Scripts > Run Script File.

    Use:      1. In the timeline, click the property you want to animate on ANY layer
                 (Opacity, Scale, an effect parameter like Exposure, etc.) and press "Grab Selected".
              2. Select the layers to animate (the order you click them matters for "Selection order").
              3. Set waveform, low/high, tempo and phase, then "Apply to Selected Layers".
              Range = the comp's work area. Everything is one undo step.
*/
(function (thisObj) {
  var NAME = "Wave Engine";
  var WAVES = ["Sine", "Triangle", "Ramp Up", "Ramp Down", "Square"];
  var ORDERS = ["Selection order", "Top to bottom", "Bottom to top", "Random"];
  var DIMS = ["All", "X / 1st", "Y / 2nd", "Z / 3rd"];
  var MARKER_TAG = "WE ";
  // Speed-0 ease with 1/3 influence gives a smoothstep curve, within about 1% of a true sine.
  var EASE_INFLUENCE = 33.333;

  var state = { path: null, propName: "" };

  // ---------------------------------------------------------------- helpers
  function num(txt, label) {
    var v = parseFloat(txt);
    if (isNaN(v)) throw new Error(label + " is not a number.");
    return v;
  }
  function toInt(txt, label, min) {
    var v = parseInt(txt, 10);
    if (isNaN(v) || v < min)
      throw new Error(label + " must be a whole number >= " + min + ".");
    return v;
  }
  function frac(x) {
    return x - Math.floor(x);
  }
  function isArrayLike(v) {
    return v !== null && typeof v === "object" && v.length !== undefined;
  }

  function activeComp() {
    var c = app.project.activeItem;
    return c && c instanceof CompItem ? c : null;
  }

  function isKeyable(p) {
    return p && p.propertyType === PropertyType.PROPERTY && p.canVaryOverTime;
  }

  // Record the property as a chain of (matchName, index) from the layer down,
  // so the same property can be found on every other selected layer.
  function buildPath(prop) {
    var steps = [],
      p = prop;
    while (p && p.propertyDepth > 0) {
      steps.unshift({ matchName: p.matchName, index: p.propertyIndex });
      p = p.parentProperty;
    }
    return steps;
  }

  function resolvePath(layer, steps) {
    var cur = layer,
      i,
      s,
      cand;
    for (i = 0; i < steps.length; i++) {
      s = steps[i];
      cand = null;
      try {
        cand = cur.property(s.index);
      } catch (e) {
        cand = null;
      }
      if (!cand || cand.matchName !== s.matchName) {
        try {
          cand = cur.property(s.matchName);
        } catch (e2) {
          cand = null;
        }
      }
      if (!cand) return null;
      cur = cand;
    }
    return cur;
  }

  // ---------------------------------------------------------------- waveforms
  // x = position in the cycle, 0..1. Returns 0 (low) .. 1 (high). Every wave starts a cycle at low
  // except Ramp Down and Square, which start high.
  function waveValue(wave, x, width) {
    switch (wave) {
      case 0:
        return (1 - Math.cos(2 * Math.PI * x)) / 2;
      case 1:
        return x < 0.5 ? 2 * x : 2 - 2 * x;
      case 2:
        return x;
      case 3:
        return 1 - x;
      case 4:
        return x < width ? 1 : 0;
    }
    return 0;
  }

  // Minimal-key representation: keys only at turning points, shaped by interpolation.
  // t: "ease" = bezier speed 0, "linear" = linear in/out, "hold" = linear in, hold out.
  function criticalPoints(wave, width, eps) {
    switch (wave) {
      case 0:
        return [
          { c: 0, v: 0, t: "ease" },
          { c: 0.5, v: 1, t: "ease" },
        ];
      case 1:
        return [
          { c: 0, v: 0, t: "linear" },
          { c: 0.5, v: 1, t: "linear" },
        ];
      case 2:
        return [
          { c: 0, v: 0, t: "linear" },
          { c: 1 - eps, v: 1, t: "hold" },
        ];
      case 3:
        return [
          { c: 0, v: 1, t: "linear" },
          { c: 1 - eps, v: 0, t: "hold" },
        ];
      case 4:
        return [
          { c: 0, v: 1, t: "hold" },
          { c: width, v: 0, t: "hold" },
        ];
    }
    return [];
  }

  // ---------------------------------------------------------------- phase distribution
  function orderLayers(layers, mode) {
    var arr = [],
      i,
      j,
      tmp;
    for (i = 0; i < layers.length; i++) arr.push(layers[i]);
    if (mode === 1)
      arr.sort(function (a, b) {
        return a.index - b.index;
      });
    else if (mode === 2)
      arr.sort(function (a, b) {
        return b.index - a.index;
      });
    else if (mode === 3) {
      for (i = arr.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    }
    return arr;
  }

  // Wings: split the list into N parts, every second part mirrored.
  // Blocks: N consecutive layers share one phase.
  // Groups: the phase pattern repeats every N elements (0 = off).
  // If the span is a whole multiple of 360, phases divide by count (seamless chase: 0/90/180/270);
  // otherwise by count-1, so the first and last layers land exactly on From and To.
  function phaseFor(i, n, from, to, blocks, groups, wings) {
    var m = n,
      j = i,
      wingSize,
      w,
      k,
      span,
      seamless;
    if (wings > 1) {
      wingSize = Math.ceil(n / wings);
      w = Math.floor(i / wingSize);
      j = i % wingSize;
      if (w % 2 === 1) j = wingSize - 1 - j;
      m = wingSize;
    }
    k = Math.floor(j / blocks);
    m = Math.ceil(m / blocks);
    if (groups > 0) {
      k = k % groups;
      m = Math.min(groups, m);
    }
    if (m <= 1) return from;
    span = to - from;
    seamless = Math.abs(span) >= 360 && Math.abs(span) % 360 === 0;
    return from + (span * k) / (seamless ? m : m - 1);
  }

  // ---------------------------------------------------------------- keyframing
  function applyToProp(prop, cfg, phaseDeg, dimIndex, layerName, errors) {
    var target = prop;
    if (prop.dimensionsSeparated) {
      if (dimIndex < 0) {
        errors.push(
          layerName + ": Position dimensions are separated. Pick X, Y or Z.",
        );
        return;
      }
      target = prop.getSeparationFollower(dimIndex);
      dimIndex = -1;
    }
    if (target.expressionEnabled && target.expression !== "") {
      errors.push(
        layerName +
          ": " +
          target.name +
          " has an active expression, which will override these keys.",
      );
    }

    var vt = target.propertyValueType,
      PVT = PropertyValueType;
    if (!(
      vt === PVT.OneD ||
      vt === PVT.TwoD ||
      vt === PVT.ThreeD ||
      vt === PVT.TwoD_SPATIAL ||
      vt === PVT.ThreeD_SPATIAL
    )) {
      errors.push(
        layerName +
          ": " +
          target.name +
          " is not a numeric property (colors, paths, text are not supported).",
      );
      return;
    }

    var base = target.valueAtTime(cfg.start, true);
    var isArr = isArrayLike(base);
    var dims = isArr ? base.length : 1;
    if (!isArr) dimIndex = -1;
    if (isArr && dimIndex >= dims) {
      errors.push(
        layerName + ": " + target.name + " has only " + dims + " dimensions.",
      );
      return;
    }

    function makeVal(n) {
      var v = cfg.low + (cfg.high - cfg.low) * n,
        out,
        d;
      if (!isArr) return v;
      out = [];
      for (d = 0; d < dims; d++) out.push(base[d]);
      if (dimIndex < 0) {
        for (d = 0; d < dims; d++) out[d] = v;
      } else out[dimIndex] = v;
      return out;
    }

    var offset = phaseDeg / 360;
    var keys = [],
      i;

    if (cfg.perFrame) {
      var fd = cfg.frameDur,
        f0 = Math.round(cfg.start / fd),
        f1 = Math.round(cfg.end / fd),
        f,
        t,
        x;
      for (f = f0; f <= f1; f++) {
        t = f * fd;
        x = frac((t - cfg.anchor) / cfg.period - offset);
        keys.push({
          time: t,
          n: waveValue(cfg.wave, x, cfg.width),
          type: cfg.wave === 4 ? "hold" : "linear",
        });
      }
    } else {
      var eps = Math.min(cfg.frameDur / cfg.period, 0.25);
      var crit = criticalPoints(cfg.wave, cfg.width, eps);
      var nMin = Math.floor((cfg.start - cfg.anchor) / cfg.period - offset) - 1;
      var nMax = Math.ceil((cfg.end - cfg.anchor) / cfg.period - offset) + 1;
      var all = [],
        cyc,
        c,
        first = 0,
        last;
      for (cyc = nMin; cyc <= nMax; cyc++) {
        for (c = 0; c < crit.length; c++) {
          all.push({
            time: cfg.anchor + (cyc + crit[c].c + offset) * cfg.period,
            n: crit[c].v,
            type: crit[c].t,
          });
        }
      }
      // Keep every key inside the range plus one on each side, so the curve is exact at the edges.
      last = all.length - 1;
      for (i = 0; i < all.length; i++) if (all[i].time <= cfg.start) first = i;
      for (i = all.length - 1; i >= 0; i--)
        if (all[i].time >= cfg.end) last = i;
      keys = all.slice(first, last + 1);
    }
    if (keys.length === 0) return;

    if (cfg.replace && target.numKeys > 0) {
      var tA = keys[0].time - cfg.frameDur / 2,
        tB = keys[keys.length - 1].time + cfg.frameDur / 2,
        k,
        kt;
      for (k = target.numKeys; k >= 1; k--) {
        kt = target.keyTime(k);
        if (kt >= tA && kt <= tB) target.removeKey(k);
      }
    }

    var times = [],
      vals = [];
    for (i = 0; i < keys.length; i++) {
      times.push(keys[i].time);
      vals.push(makeVal(keys[i].n));
    }
    target.setValuesAtTimes(times, vals);

    var KIT = KeyframeInterpolationType;
    var spatial = target.isSpatial && isArr;
    var easeLen = target.isSpatial || !isArr ? 1 : dims;
    var easeArr = [],
      zeroVec = [],
      d,
      idx;
    for (d = 0; d < easeLen; d++)
      easeArr.push(new KeyframeEase(0, EASE_INFLUENCE));
    for (d = 0; d < dims; d++) zeroVec.push(0);

    for (i = 0; i < keys.length; i++) {
      idx = target.nearestKeyIndex(keys[i].time);
      if (keys[i].type === "ease") {
        target.setInterpolationTypeAtKey(idx, KIT.BEZIER, KIT.BEZIER);
        target.setTemporalContinuousAtKey(idx, false);
        target.setTemporalAutoBezierAtKey(idx, false);
        target.setTemporalEaseAtKey(idx, easeArr, easeArr);
      } else if (keys[i].type === "hold") {
        target.setInterpolationTypeAtKey(idx, KIT.LINEAR, KIT.HOLD);
      } else {
        target.setInterpolationTypeAtKey(idx, KIT.LINEAR, KIT.LINEAR);
      }
      if (spatial) {
        // Straight-line motion only: no auto-bezier arcs or overshoot in the motion path.
        target.setSpatialAutoBezierAtKey(idx, false);
        target.setSpatialContinuousAtKey(idx, false);
        target.setSpatialTangentsAtKey(idx, zeroVec, zeroVec);
      }
    }
  }

  function addBeatMarkers(comp, cfg) {
    var mp = comp.markerProperty,
      k,
      beatDur = 60 / cfg.bpm,
      kMin,
      kMax,
      beatInBar,
      bar;
    for (k = mp.numKeys; k >= 1; k--) {
      if (mp.keyValue(k).comment.indexOf(MARKER_TAG) === 0) mp.removeKey(k);
    }
    kMin = Math.ceil((cfg.start - cfg.anchor) / beatDur - 1e-6);
    kMax = Math.floor((cfg.end - cfg.anchor) / beatDur + 1e-6);
    for (k = kMin; k <= kMax; k++) {
      beatInBar = ((k % 4) + 4) % 4;
      bar = Math.floor(k / 4) + 1;
      mp.setValueAtTime(
        cfg.anchor + k * beatDur,
        new MarkerValue(MARKER_TAG + bar + "." + (beatInBar + 1)),
      );
    }
  }

  // ---------------------------------------------------------------- main
  function run(ui) {
    var comp = activeComp();
    if (!comp) {
      alert("Open a composition first.");
      return;
    }
    if (!state.path) {
      alert("Click a property in the timeline, then press Grab Selected.");
      return;
    }
    var layers = comp.selectedLayers;
    if (!layers || layers.length === 0) {
      alert("Select the layers to animate.");
      return;
    }

    var cfg;
    try {
      cfg = {
        wave: ui.wave.selection.index,
        low: num(ui.low.text, "Low"),
        high: num(ui.high.text, "High"),
        width: num(ui.width.text, "Width") / 100,
        bpm: num(ui.bpm.text, "BPM"),
        beats: num(ui.beats.text, "Beats per cycle"),
        anchor: num(ui.anchor.text, "Beat 1 time"),
        phFrom: num(ui.phFrom.text, "Phase From"),
        phTo: num(ui.phTo.text, "Phase To"),
        order: ui.order.selection.index,
        blocks: toInt(ui.blocks.text, "Blocks", 1),
        groups: toInt(ui.groups.text, "Groups", 0),
        wings: toInt(ui.wings.text, "Wings", 1),
        dim: ui.dim.selection.index - 1,
        perFrame: ui.mode.selection.index === 1,
        replace: ui.replace.value,
        markers: ui.markers.value,
      };
      if (cfg.bpm <= 0) throw new Error("BPM must be greater than 0.");
      if (cfg.beats <= 0)
        throw new Error("Beats per cycle must be greater than 0.");
      cfg.width = Math.max(0.01, Math.min(0.99, cfg.width));
    } catch (e) {
      alert(e.message);
      return;
    }

    cfg.period = (cfg.beats * 60) / cfg.bpm;
    cfg.frameDur = comp.frameDuration;
    cfg.start = comp.workAreaStart;
    cfg.end = comp.workAreaStart + comp.workAreaDuration;

    var errors = [];
    if (cfg.period < 2 * cfg.frameDur) {
      errors.push(
        "Warning: one cycle is shorter than 2 frames, so the wave will alias at this frame rate.",
      );
    }

    var ordered = orderLayers(layers, cfg.order),
      n = ordered.length,
      i,
      layer,
      prop,
      phase;
    app.beginUndoGroup(NAME);
    try {
      for (i = 0; i < n; i++) {
        layer = ordered[i];
        try {
          prop = resolvePath(layer, state.path);
          if (!prop || !isKeyable(prop)) {
            errors.push(
              layer.name + ": has no '" + state.propName + "' property.",
            );
            continue;
          }
          phase = phaseFor(
            i,
            n,
            cfg.phFrom,
            cfg.phTo,
            cfg.blocks,
            cfg.groups,
            cfg.wings,
          );
          applyToProp(prop, cfg, phase, cfg.dim, layer.name, errors);
        } catch (le) {
          errors.push(layer.name + ": " + le.toString());
        }
      }
      if (cfg.markers) addBeatMarkers(comp, cfg);
    } finally {
      app.endUndoGroup();
    }
    if (errors.length) alert(errors.join("\n"));
  }

  // ---------------------------------------------------------------- UI
  function buildUI(thisObj) {
    var w =
      thisObj instanceof Panel
        ? thisObj
        : new Window("palette", NAME, undefined, { resizeable: true });
    w.orientation = "column";
    w.alignChildren = ["fill", "top"];
    w.spacing = 6;
    w.margins = 10;
    var ui = {},
      r;

    function panel(title) {
      var p = w.add("panel", undefined, title);
      p.orientation = "column";
      p.alignChildren = ["fill", "top"];
      p.margins = [10, 14, 10, 8];
      p.spacing = 4;
      return p;
    }
    function row(parent) {
      var g = parent.add("group");
      g.orientation = "row";
      g.alignChildren = ["left", "center"];
      g.spacing = 6;
      return g;
    }
    function label(parent, txt, wd) {
      var s = parent.add("statictext", undefined, txt);
      s.preferredSize.width = wd || 78;
      return s;
    }
    function field(parent, val, chars) {
      var e = parent.add("edittext", undefined, val);
      e.characters = chars || 6;
      return e;
    }
    function drop(parent, items, sel) {
      var d = parent.add("dropdownlist", undefined, items);
      d.selection = sel || 0;
      return d;
    }

    var pP = panel("Property");
    r = row(pP);
    var grab = r.add("button", undefined, "Grab Selected");
    ui.propLabel = r.add("statictext", undefined, "(none)");
    ui.propLabel.characters = 22;
    r = row(pP);
    label(r, "Dimension");
    ui.dim = drop(r, DIMS, 0);

    var pW = panel("Waveform");
    r = row(pW);
    label(r, "Form");
    ui.wave = drop(r, WAVES, 0);
    r = row(pW);
    label(r, "Low");
    ui.low = field(r, "0");
    label(r, "High", 34);
    ui.high = field(r, "100");
    r = row(pW);
    label(r, "Width %");
    ui.width = field(r, "50");

    var pT = panel("Tempo");
    r = row(pT);
    label(r, "BPM");
    ui.bpm = field(r, "120");
    label(r, "Beats/cycle", 72);
    ui.beats = field(r, "1", 4);
    r = row(pT);
    label(r, "Beat 1 at (s)");
    ui.anchor = field(r, "0", 8);
    var fromCTI = r.add("button", undefined, "From CTI");

    var pPh = panel("Phase (degrees)");
    r = row(pPh);
    label(r, "From");
    ui.phFrom = field(r, "0", 5);
    label(r, "To", 34);
    ui.phTo = field(r, "0", 5);
    r = row(pPh);
    label(r, "Order");
    ui.order = drop(r, ORDERS, 0);
    r = row(pPh);
    label(r, "Blocks", 44);
    ui.blocks = field(r, "1", 3);
    label(r, "Groups", 44);
    ui.groups = field(r, "0", 3);
    label(r, "Wings", 40);
    ui.wings = field(r, "1", 3);

    var pO = panel("Output");
    r = row(pO);
    label(r, "Keys");
    ui.mode = drop(r, ["Minimal (editable curves)", "Every frame"], 0);
    ui.replace = pO.add(
      "checkbox",
      undefined,
      "Replace existing keys in range",
    );
    ui.replace.value = true;
    ui.markers = pO.add("checkbox", undefined, "Add beat markers to comp");
    ui.markers.value = false;
    pO.add("statictext", undefined, "Range = comp work area.");

    var apply = w.add("button", undefined, "Apply to Selected Layers");

    ui.wave.onChange = function () {
      ui.width.enabled = this.selection.index === 4;
    };
    ui.width.enabled = false;

    grab.onClick = function () {
      var comp = activeComp(),
        sel,
        p = null,
        i,
        parent;
      if (!comp) {
        alert("Open a composition first.");
        return;
      }
      sel = comp.selectedProperties;
      for (i = sel.length - 1; i >= 0; i--) {
        if (isKeyable(sel[i])) {
          p = sel[i];
          break;
        }
      }
      if (!p) {
        alert(
          "Click a keyframe-able property (Opacity, Scale, an effect parameter...) in the timeline first.",
        );
        return;
      }
      state.path = buildPath(p);
      state.propName = p.name;
      parent = p.parentProperty;
      ui.propLabel.text =
        (parent && parent.propertyDepth > 0 ? parent.name + " > " : "") +
        p.name;
    };

    fromCTI.onClick = function () {
      var comp = activeComp();
      if (!comp) {
        alert("Open a composition first.");
        return;
      }
      ui.anchor.text = comp.time.toFixed(4);
    };

    apply.onClick = function () {
      run(ui);
    };

    w.onResizing = w.onResize = function () {
      this.layout.resize();
    };
    if (w instanceof Window) {
      w.center();
      w.show();
    } else {
      w.layout.layout(true);
    }
  }

  buildUI(thisObj);
})(this);
