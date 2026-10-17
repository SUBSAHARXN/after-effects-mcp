/**
 * Lottie Compiler and Compliance Engine for After Effects
 * Provides auditing, auto-workaround restructuring, and Lottie JSON export.
 */

if (typeof JSON === "undefined") {
    JSON = {};
}
if (typeof JSON.parse !== "function") {
    JSON.parse = function(text) {
        return eval("(" + text + ")");
    };
}
if (typeof JSON.stringify !== "function") {
    (function() {
        function esc(str) {
            return (str + "")
                .replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"')
                .replace(/\n/g, "\\n")
                .replace(/\r/g, "\\r")
                .replace(/\t/g, "\\t");
        }
        function toJSON(val) {
            if (val === null) return "null";
            var t = typeof val;
            if (t === "number" || t === "boolean") return String(val);
            if (t === "string") return '"' + esc(val) + '"';
            if (val instanceof Array) {
                var a = [];
                for (var i = 0; i < val.length; i++) a.push(toJSON(val[i]));
                return "[" + a.join(",") + "]";
            }
            if (t === "object") {
                var props = [];
                for (var k in val) {
                    if (val.hasOwnProperty(k) && typeof val[k] !== "function" && typeof val[k] !== "undefined") {
                        props.push('"' + esc(k) + '":' + toJSON(val[k]));
                    }
                }
                return "{" + props.join(",") + "}";
            }
            return "null";
        }
        JSON.stringify = function(value, _replacer, _space) {
            return toJSON(value);
        };
    })();
}

function auditLottieCompliance(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var issues = [];
        var stats = {
            totalLayers: comp.numLayers,
            expressionsCount: 0,
            unbakedExpressions: 0,
            effectsCount: 0,
            unsupportedEffects: 0,
            textLayers: 0,
            vectorFootageLayers: 0,
            mergePathsCount: 0,
            adjustmentLayers: 0,
            threeDLayers: 0
        };

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);

            // Layer type checks
            if (layer instanceof TextLayer || layer.text) {
                stats.textLayers++;
                issues.push({
                    severity: "error",
                    type: "unconverted_text",
                    layerIndex: i,
                    layerName: layer.name,
                    property: "Source Text",
                    details: "Text layer requires embedded font or glyphs, frequently causing missing characters or misalignment in Lottie.",
                    workaround: "Convert to native shape layer using 'Create Shapes from Text'."
                });
            }

            if (layer.source && layer.source instanceof FootageItem) {
                var srcFile = layer.source.file;
                if (srcFile && /\.(ai|eps|svg|pdf)$/i.test(srcFile.name)) {
                    stats.vectorFootageLayers++;
                    issues.push({
                        severity: "warning",
                        type: "unconverted_vector_footage",
                        layerIndex: i,
                        layerName: layer.name,
                        property: "Source Footage",
                        details: "Vector footage from Illustrator/EPS will export as raster PNG unless converted to vector shape paths.",
                        workaround: "Convert to native shape layer using 'Create Shapes from Vector Layer'."
                    });
                }
            }

            if (layer.adjustmentLayer) {
                stats.adjustmentLayers++;
                issues.push({
                    severity: "error",
                    type: "adjustment_layer",
                    layerIndex: i,
                    layerName: layer.name,
                    property: "Layer",
                    details: "Adjustment layers are raster post-processing filters not supported by vector Lottie players.",
                    workaround: "Remove adjustment layer or replace with vector shapes/masks."
                });
            }

            if (layer.threeDLayer) {
                stats.threeDLayers++;
                issues.push({
                    severity: "warning",
                    type: "3d_layer",
                    layerIndex: i,
                    layerName: layer.name,
                    property: "3D Layer Switch",
                    details: "3D layers break perspective or fail in 2D Lottie players (iOS/Android/Web).",
                    workaround: "Flatten to 2D layer or pre-compose."
                });
            }

            // Effects inspection
            if (layer.effect && layer.effect.numProperties > 0) {
                for (var e = 1; e <= layer.effect.numProperties; e++) {
                    var eff = layer.effect(e);
                    stats.effectsCount++;
                    stats.unsupportedEffects++;
                    issues.push({
                        severity: "error",
                        type: "unsupported_effect",
                        layerIndex: i,
                        layerName: layer.name,
                        property: eff.name,
                        matchName: eff.matchName,
                        details: "Effect '" + eff.name + "' is a raster pixel filter. Lottie only renders vector SVG paths and transforms.",
                        workaround: "Remove effect or bake resulting deformation into vector path keyframes."
                    });
                }
            }

            // Recursive property & expression inspection
            scanLayerForLottieIssues(layer, layer, i, issues, stats);
        }

        var isCompliant = issues.filter(function(x) { return x.severity === "error"; }).length === 0;

        return JSON.stringify({
            status: "success",
            composition: {
                id: comp.id,
                name: comp.name,
                width: comp.width,
                height: comp.height,
                duration: comp.duration,
                frameRate: comp.frameRate
            },
            lottieCompliant: isCompliant,
            stats: stats,
            issueCount: issues.length,
            issues: issues
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function scanLayerForLottieIssues(propGroup, layer, layerIndex, issues, stats) {
    if (!propGroup || !propGroup.numProperties) return;

    for (var j = 1; j <= propGroup.numProperties; j++) {
        var prop = propGroup.property(j);

        // Check for Merge Paths
        if (prop.matchName && prop.matchName.indexOf("ADBE Vector Filter - Merge") !== -1) {
            stats.mergePathsCount++;
            issues.push({
                severity: "warning",
                type: "merge_paths",
                layerIndex: layerIndex,
                layerName: layer.name,
                property: prop.name,
                details: "Merge Paths operator causes rendering glitches or crashes on Android hardware acceleration.",
                workaround: "Separate into discrete vector paths or boolean combine before importing."
            });
        }

        // Check expressions
        if (prop.canSetExpression && prop.expressionEnabled && prop.expression !== "") {
            stats.expressionsCount++;
            var exprText = prop.expression;
            var isRisky = false;
            var reason = "Unbaked expression.";

            if (/sourceRectAtTime/i.test(exprText)) {
                isRisky = true;
                reason = "Uses sourceRectAtTime(), unsupported at runtime in most Lottie mobile players.";
            } else if (/sampleImage/i.test(exprText)) {
                isRisky = true;
                reason = "Uses sampleImage(), completely unsupported in Lottie.";
            } else if (/valueAtTime|velocityAtTime/i.test(exprText)) {
                isRisky = true;
                reason = "Uses valueAtTime()/velocityAtTime(), prone to desync and high CPU lag.";
            } else if (/lookAt|toComp|fromComp|toWorld|fromWorld/i.test(exprText)) {
                isRisky = true;
                reason = "Uses space transform matrix functions not evaluated properly in Lottie.";
            } else if (/comp\(/i.test(exprText)) {
                isRisky = true;
                reason = "References external composition. Lottie cannot cross-reference outside comp tree.";
            } else if (/wiggle\(/i.test(exprText)) {
                reason = "Procedural wiggle() causes random seed mismatch between browsers and native devices.";
            }

            stats.unbakedExpressions++;
            issues.push({
                severity: isRisky ? "error" : "warning",
                type: "unbaked_expression",
                layerIndex: layerIndex,
                layerName: layer.name,
                property: prop.name,
                expressionPreview: exprText.length > 80 ? exprText.substring(0, 80) + "..." : exprText,
                details: reason,
                workaround: "Auto-bake expression into discrete keyframes using compile-lottie-comp."
            });
        }

        if (prop.numProperties && prop.numProperties > 0) {
            scanLayerForLottieIssues(prop, layer, layerIndex, issues, stats);
        }
    }
}

function compileLottieComp(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var bakeExpressions = args.bakeExpressions !== false;
        var convertText = args.convertTextToShapes !== false;
        var convertFootage = args.convertVectorFootageToShapes !== false;
        var removeEffects = args.removeUnsupportedEffects !== false;
        var removeDisabled = args.removeDisabledLayers !== false;
        var flatten3D = args.flatten3D !== false;
        var removeAudio = args.removeAudioAndAdjustmentLayers !== false;
        var outCompName = args.outputCompName || (comp.name + "_LottieReady");

        // Step 1: Duplicate composition to preserve original
        var clone = comp.duplicate();
        clone.name = outCompName;

        var report = {
            createdCompName: clone.name,
            createdCompId: clone.id,
            bakedPropertiesCount: 0,
            convertedTextLayersCount: 0,
            convertedFootageLayersCount: 0,
            removedEffectsCount: 0,
            removedLayersCount: 0
        };

        var duration = clone.duration;
        var frameStep = clone.frameDuration;

        // Step 2: Iterate layers
        for (var i = clone.numLayers; i >= 1; i--) {
            var layer = clone.layer(i);

            // Remove disabled layers
            if (removeDisabled && !layer.enabled) {
                layer.remove();
                report.removedLayersCount++;
                continue;
            }

            // Remove adjustment layers or audio
            if (removeAudio && (layer.adjustmentLayer || (layer.hasAudio && !layer.hasVideo))) {
                layer.remove();
                report.removedLayersCount++;
                continue;
            }

            // Flatten 3D
            if (flatten3D && layer.threeDLayer) {
                layer.threeDLayer = false;
            }

            // Convert Text to Shapes
            if (convertText && (layer instanceof TextLayer || layer.text)) {
                try {
                    deselectAllLayers(clone);
                    layer.selected = true;
                    var cmdText = app.findMenuCommandId("Create Shapes from Text");
                    if (cmdText > 0) {
                        app.executeCommand(cmdText);
                        layer.remove(); // remove original text layer
                        report.convertedTextLayersCount++;
                    }
                } catch(e) {}
                continue;
            }

            // Convert Illustrator/Vector footage to Shapes
            if (convertFootage && layer.source && layer.source instanceof FootageItem) {
                var sf = layer.source.file;
                if (sf && /\.(ai|eps|svg|pdf)$/i.test(sf.name)) {
                    try {
                        deselectAllLayers(clone);
                        layer.selected = true;
                        var cmdVector = app.findMenuCommandId("Create Shapes from Vector Layer");
                        if (cmdVector > 0) {
                            app.executeCommand(cmdVector);
                            layer.remove();
                            report.convertedFootageLayersCount++;
                        }
                    } catch(e) {}
                    continue;
                }
            }

            // Remove unsupported raster effects
            if (removeEffects && layer.effect && layer.effect.numProperties > 0) {
                for (var e = layer.effect.numProperties; e >= 1; e--) {
                    layer.effect(e).remove();
                    report.removedEffectsCount++;
                }
            }

            // Bake all expressions to pure keyframes
            if (bakeExpressions) {
                report.bakedPropertiesCount += bakeLayerExpressions(layer, 0, duration, frameStep);
            }
        }

        return JSON.stringify({
            status: "success",
            message: "Composition compiled and restructured for Lottie compliance.",
            report: report
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function bakeLayerExpressions(propGroup, startT, endT, stepT) {
    if (!propGroup || !propGroup.numProperties) return 0;
    var count = 0;

    for (var k = 1; k <= propGroup.numProperties; k++) {
        var prop = propGroup.property(k);

        if (prop.canSetExpression && prop.expressionEnabled && prop.expression !== "") {
            var samples = [];
            for (var t = startT; t <= endT + 0.0001; t += stepT) {
                try {
                    samples.push({
                        time: t,
                        val: prop.valueAtTime(t, false)
                    });
                } catch(e) {}
            }

            if (samples.length > 0) {
                prop.expression = ""; // clear expression
                // Clear existing keys
                while (prop.numKeys > 0) {
                    prop.removeKey(1);
                }
                // Set baked keyframes
                for (var s = 0; s < samples.length; s++) {
                    try {
                        prop.setValueAtTime(samples[s].time, samples[s].val);
                    } catch(e) {}
                }
                count++;
            }
        }

        if (prop.numProperties && prop.numProperties > 0) {
            count += bakeLayerExpressions(prop, startT, endT, stepT);
        }
    }
    return count;
}

function deselectAllLayers(comp) {
    for (var i = 1; i <= comp.numLayers; i++) {
        comp.layer(i).selected = false;
    }
}

function resolveTargetComp(args) {
    args = args || {};
    if (args.compIndex && args.compIndex > 0 && args.compIndex <= app.project.numItems) {
        var it = app.project.item(args.compIndex);
        if (it instanceof CompItem) return it;
    }
    if (args.compName) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var c = app.project.item(i);
            if (c instanceof CompItem && c.name === args.compName) return c;
        }
    }
    if (app.project.activeItem instanceof CompItem) {
        return app.project.activeItem;
    }
    for (var j = 1; j <= app.project.numItems; j++) {
        var fallback = app.project.item(j);
        if (fallback instanceof CompItem) return fallback;
    }
    return null;
}

function exportLottieJson(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var outputPath = args.outputPath;
        if (!outputPath) {
            var home = Folder.myDocuments.fsName;
            outputPath = home + "/" + comp.name.replace(/[^a-zA-Z0-9_\-]/g, "_") + ".json";
        }

        // Build standalone compliant Lottie JSON model
        var lottie = {
            v: "5.7.4",
            fr: Math.round(comp.frameRate),
            ip: 0,
            op: Math.round(comp.duration * comp.frameRate),
            w: Math.round(comp.width),
            h: Math.round(comp.height),
            nm: comp.name,
            ddd: 0,
            assets: [],
            layers: []
        };

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!layer.enabled) continue;

            var lLayer = serializeLayerToLottie(layer, comp);
            if (lLayer) {
                lottie.layers.push(lLayer);
            }
        }

        // Write to target JSON file
        var outFile = new File(outputPath);
        var outFolder = outFile.parent;
        if (!outFolder.exists) {
            outFolder.create();
        }

        outFile.encoding = "UTF-8";
        outFile.open("w");
        outFile.write(JSON.stringify(lottie, null, 2));
        outFile.close();

        return JSON.stringify({
            status: "success",
            message: "Lottie JSON exported successfully",
            filePath: outFile.fsName,
            fileSizeBytes: outFile.length,
            layersExported: lottie.layers.length,
            durationSeconds: comp.duration,
            frameRate: lottie.fr,
            frameCount: lottie.op
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function serializeLayerToLottie(layer, comp) {
    var fr = comp.frameRate;
    var tr = layer.property("Transform");
    if (!tr) return null;

    var pos = tr.property("Position");
    var scale = tr.property("Scale");
    var rot = tr.property("Rotation");
    var opac = tr.property("Opacity");
    var anch = tr.property("Anchor Point");

    var ks = {
        o: serializePropertyToLottie(opac, fr, 100),
        r: serializePropertyToLottie(rot, fr, 0),
        p: serializePropertyToLottie(pos, fr, [comp.width/2, comp.height/2, 0]),
        a: serializePropertyToLottie(anch, fr, [0, 0, 0]),
        s: serializePropertyToLottie(scale, fr, [100, 100, 100])
    };

    var lottieLayer = {
        ddd: 0,
        ind: layer.index,
        ty: 4, // shape layer
        nm: layer.name,
        sr: 1,
        ks: ks,
        ao: 0,
        ip: Math.round(layer.inPoint * fr),
        op: Math.round(layer.outPoint * fr),
        st: Math.round(layer.startTime * fr),
        bm: 0,
        shapes: []
    };

    // Serialize Shape groups
    var contents = layer.property("Contents");
    if (contents && contents.numProperties > 0) {
        for (var g = 1; g <= contents.numProperties; g++) {
            var group = contents.property(g);
            var lGroup = serializeShapeGroupToLottie(group, fr);
            if (lGroup) {
                lottieLayer.shapes.push(lGroup);
            }
        }
    }

    return lottieLayer;
}

function serializeShapeGroupToLottie(group, fr) {
    if (!group) return null;
    var gContents = group.property("Contents");
    if (!gContents) return null;

    var items = [];

    for (var i = 1; i <= gContents.numProperties; i++) {
        var prop = gContents.property(i);
        var mName = prop.matchName;

        // Path
        if (mName === "ADBE Vector Shape - Group") {
            var pProp = prop.property("ADBE Vector Shape");
            if (pProp) {
                var pVal = pProp.value;
                items.push({
                    ty: "sh",
                    nm: prop.name,
                    ks: {
                        a: 0,
                        k: {
                            c: pVal.closed,
                            i: pVal.inTangents || [],
                            o: pVal.outTangents || [],
                            v: pVal.vertices || []
                        }
                    }
                });
            }
        }
        // Fill
        else if (mName === "ADBE Vector Graphic - Fill") {
            var col = prop.property("Color");
            var colVal = col ? col.value : [1, 1, 1, 1];
            var fOp = prop.property("Opacity");
            items.push({
                ty: "fl",
                nm: prop.name,
                c: { a: 0, k: [colVal[0], colVal[1], colVal[2], 1] },
                o: { a: 0, k: fOp ? fOp.value : 100 },
                r: 1,
                bm: 0
            });
        }
        // Stroke
        else if (mName === "ADBE Vector Graphic - Stroke") {
            var sCol = prop.property("Color");
            var sColVal = sCol ? sCol.value : [0, 0, 0, 1];
            var sW = prop.property("Stroke Width");
            var sOp = prop.property("Opacity");
            items.push({
                ty: "st",
                nm: prop.name,
                c: { a: 0, k: [sColVal[0], sColVal[1], sColVal[2], 1] },
                o: { a: 0, k: sOp ? sOp.value : 100 },
                w: { a: 0, k: sW ? sW.value : 1 },
                lc: 2,
                lj: 2,
                bm: 0
            });
        }
    }

    // Add group transform
    var gTransform = group.property("Transform");
    var gPos = gTransform ? gTransform.property("Position") : null;
    var gAnchor = gTransform ? gTransform.property("Anchor Point") : null;
    var gScale = gTransform ? gTransform.property("Scale") : null;
    var gRot = gTransform ? gTransform.property("Rotation") : null;
    var gOpac = gTransform ? gTransform.property("Opacity") : null;

    items.push({
        ty: "tr",
        nm: "Transform",
        p: { a: 0, k: gPos ? gPos.value : [0, 0] },
        a: { a: 0, k: gAnchor ? gAnchor.value : [0, 0] },
        s: { a: 0, k: gScale ? gScale.value : [100, 100] },
        r: { a: 0, k: gRot ? gRot.value : 0 },
        o: { a: 0, k: gOpac ? gOpac.value : 100 }
    });

    return {
        ty: "gr",
        nm: group.name,
        it: items
    };
}

function serializePropertyToLottie(prop, fr, fallback) {
    if (!prop) {
        return { a: 0, k: fallback };
    }

    if (prop.numKeys && prop.numKeys > 0) {
        var keyframes = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = Math.round(prop.keyTime(k) * fr);
            var kv = prop.keyValue(k);
            var nextKv = (k < prop.numKeys) ? prop.keyValue(k + 1) : kv;

            keyframes.push({
                t: kt,
                s: (kv instanceof Array) ? kv : [kv],
                e: (nextKv instanceof Array) ? nextKv : [nextKv],
                i: { x: [0.833], y: [0.833] },
                o: { x: [0.167], y: [0.167] }
            });
        }
        return { a: 1, k: keyframes };
    }

    var val = prop.value;
    return { a: 0, k: val !== undefined ? val : fallback };
}

function addLottieStateMarkers(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var fr = comp.frameRate;
        var states = [];

        if (args.preset === "button_toggle") {
            var totalFrames = Math.round(comp.duration * fr);
            var slice = Math.floor(totalFrames / 4);
            states = [
                { name: "idle", startFrame: 0, durationFrames: slice, comment: "idle" },
                { name: "hover", startFrame: slice, durationFrames: slice, comment: "hover" },
                { name: "active", startFrame: slice * 2, durationFrames: slice, comment: "active" },
                { name: "exit", startFrame: slice * 3, durationFrames: totalFrames - (slice * 3), comment: "exit" }
            ];
        } else if (args.preset === "hover_loop") {
            var totalFrames = Math.round(comp.duration * fr);
            var idleFrames = Math.floor(totalFrames * 0.4);
            var hoverIn = Math.floor(totalFrames * 0.2);
            var hoverLoop = Math.floor(totalFrames * 0.3);
            var hoverOut = totalFrames - (idleFrames + hoverIn + hoverLoop);
            states = [
                { name: "idle", startFrame: 0, durationFrames: idleFrames, comment: "idle" },
                { name: "hover_in", startFrame: idleFrames, durationFrames: hoverIn, comment: "hover_in" },
                { name: "hover_loop", startFrame: idleFrames + hoverIn, durationFrames: hoverLoop, comment: "hover_loop" },
                { name: "hover_out", startFrame: idleFrames + hoverIn + hoverLoop, durationFrames: hoverOut, comment: "hover_out" }
            ];
        } else if (args.preset === "toggle_switch") {
            var totalFrames = Math.round(comp.duration * fr);
            var half = Math.floor(totalFrames / 2);
            states = [
                { name: "off_to_on", startFrame: 0, durationFrames: half, comment: "off_to_on" },
                { name: "on_to_off", startFrame: half, durationFrames: totalFrames - half, comment: "on_to_off" }
            ];
        } else if (args.states && args.states.length > 0) {
            states = args.states;
        } else {
            return JSON.stringify({ status: "error", message: "Provide either a preset ('button_toggle', 'hover_loop', 'toggle_switch') or an array of states." });
        }

        var markerGroup = comp.markerProperty;
        if (!markerGroup) {
            return JSON.stringify({ status: "error", message: "Composition does not support markers." });
        }

        if (args.clearExistingMarkers !== false) {
            while (markerGroup.numKeys > 0) {
                markerGroup.removeKey(1);
            }
        }

        var added = [];
        for (var s = 0; s < states.length; s++) {
            var st = states[s];
            var startTime = (st.startFrame !== undefined) ? (st.startFrame / fr) : ((st.startTime !== undefined) ? st.startTime : 0);
            var durTime = (st.durationFrames !== undefined) ? (st.durationFrames / fr) : ((st.duration !== undefined) ? st.duration : 1.0);

            var mv = new MarkerValue(st.comment || st.name);
            mv.duration = durTime;
            if (st.colorIndex !== undefined) {
                mv.label = st.colorIndex;
            }

            markerGroup.setValueAtTime(startTime, mv);
            added.push({
                name: st.name,
                startTime: startTime,
                startFrame: Math.round(startTime * fr),
                durationSeconds: durTime,
                durationFrames: Math.round(durTime * fr)
            });
        }

        return JSON.stringify({
            status: "success",
            message: "State markers added to composition.",
            compName: comp.name,
            markersCount: added.length,
            states: added
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function getLottieMarkers(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var fr = comp.frameRate;
        var markerGroup = comp.markerProperty;
        var markers = [];

        if (markerGroup && markerGroup.numKeys > 0) {
            for (var m = 1; m <= markerGroup.numKeys; m++) {
                var t = markerGroup.keyTime(m);
                var mv = markerGroup.keyValue(m);
                var name = mv.comment || ("Marker_" + m);
                var dur = mv.duration || 0;
                var startF = Math.round(t * fr);
                var endF = Math.round((t + dur) * fr);

                markers.push({
                    index: m,
                    name: name,
                    startTime: t,
                    startFrame: startF,
                    durationSeconds: dur,
                    endFrame: (dur > 0) ? endF : startF + 1
                });
            }
        }

        return JSON.stringify({
            status: "success",
            compName: comp.name,
            markerCount: markers.length,
            markers: markers
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function generateLottieInteractivity(args) {
    try {
        var comp = resolveTargetComp(args);
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "Target composition not found." });
        }

        var fr = comp.frameRate;
        var markersRes = JSON.parse(getLottieMarkers({ compName: comp.name }));
        var markers = (markersRes && markersRes.markers) ? markersRes.markers : [];
        var animId = args.animationId || "animation_1";

        var stateMachine = {
            version: "1.0",
            id: args.stateMachineId || "dotLottie_state_machine",
            initial: "idle",
            states: {}
        };

        if (markers.length === 0) {
            stateMachine.states = {
                idle: {
                    animationId: animId,
                    playbackSettings: {
                        segments: [0, Math.round(comp.duration * fr)],
                        loop: true
                    },
                    onClick: {
                        state: "idle"
                    }
                }
            };
        } else {
            var firstState = markers[0].name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
            stateMachine.initial = firstState;

            for (var i = 0; i < markers.length; i++) {
                var mk = markers[i];
                var sName = mk.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
                var seg = [mk.startFrame, mk.endFrame];
                var isLooping = /loop|idle/i.test(sName);

                var stObj = {
                    animationId: animId,
                    playbackSettings: {
                        segments: seg,
                        loop: isLooping
                    }
                };

                if (/idle/i.test(sName)) {
                    var hoverTarget = findStateMatching(markers, /hover/i);
                    var clickTarget = findStateMatching(markers, /click|active|toggle/i);
                    if (hoverTarget) stObj.onMouseEnter = { state: hoverTarget };
                    if (clickTarget) stObj.onClick = { state: clickTarget };
                } else if (/hover_in|hover/i.test(sName)) {
                    var idleTarget = findStateMatching(markers, /idle/i);
                    var hoverLoopTarget = findStateMatching(markers, /hover_loop/i);
                    var clickTarget = findStateMatching(markers, /click|active|toggle/i);

                    if (hoverLoopTarget && sName !== hoverLoopTarget) {
                        stObj.onComplete = { state: hoverLoopTarget };
                    }
                    if (idleTarget) stObj.onMouseLeave = { state: idleTarget };
                    if (clickTarget) stObj.onClick = { state: clickTarget };
                } else if (/active|click|toggle/i.test(sName)) {
                    var exitTarget = findStateMatching(markers, /exit|reset/i);
                    var idleTarget = findStateMatching(markers, /idle/i);
                    stObj.onComplete = { state: exitTarget || idleTarget || stateMachine.initial };
                } else if (/exit|reset/i.test(sName)) {
                    var idleTarget = findStateMatching(markers, /idle/i);
                    stObj.onComplete = { state: idleTarget || stateMachine.initial };
                } else {
                    var nextIdx = (i + 1 < markers.length) ? markers[i + 1].name.toLowerCase().replace(/[^a-z0-9_]/g, "_") : stateMachine.initial;
                    stObj.onComplete = { state: nextIdx };
                }

                stateMachine.states[sName] = stObj;
            }
        }

        if (args.customStates) {
            for (var c in args.customStates) {
                stateMachine.states[c] = args.customStates[c];
            }
        }

        return JSON.stringify({
            status: "success",
            message: "dotLottie interactivity state machine generated.",
            stateMachine: stateMachine
        }, null, 2);

    } catch(err) {
        return JSON.stringify({ status: "error", message: err.toString(), line: err.line });
    }
}

function findStateMatching(markers, regex) {
    for (var i = 0; i < markers.length; i++) {
        var n = markers[i].name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        if (regex.test(n)) {
            return n;
        }
    }
    return null;
}

