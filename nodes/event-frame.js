/**
 * event-frame - ISA-88 batch structure tracking node
 *
 * Creates ISA-88 procedural model records:
 *   Procedure > Unit Procedure > Operation > Phase
 *
 * Features:
 * - Trigger-based: starts on true, ends on false
 * - Auto-generated unique IDs
 * - Chainable: start output carries frame_id for child nodes to use as parent_id
 * - Auto-end children: when a parent ends, all children with matching parent_id end too
 * - Hierarchical parent-child linking via global context dictionary
 * - Outputs complete batch record on end
 */
module.exports = function(RED) {
    const crypto = require('crypto');
    const EventEmitter = require('events');

    // Shared emitter for end-children cascade (one per contextKey)
    const sharedEmitters = new Map();

    function getEmitter(contextKey) {
        if (!sharedEmitters.has(contextKey)) {
            const emitter = new EventEmitter();
            emitter.setMaxListeners(100);
            sharedEmitters.set(contextKey, emitter);
        }
        return sharedEmitters.get(contextKey);
    }

    function EventFrameNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.level = config.level || 'operation';
        node.batchName = config.batchName || '';
        node.batchNameType = config.batchNameType || 'str';
        node.unit = config.unit || '';
        node.unitType = config.unitType || 'str';
        node.batchId = config.batchId || '';
        node.batchIdType = config.batchIdType || 'str';
        node.parentLevel = config.parentLevel || '';
        node.triggerField = config.triggerField || 'payload';
        node.metadataField = config.metadataField || '';
        node.contextKey = config.contextKey || 'isa88_batches';
        node.endChildren = config.endChildren !== false; // default true

        const globalContext = node.context().global;
        const emitter = getEmitter(node.contextKey);

        // Tracker key: use node.id so multiple nodes at the same level can coexist
        const trackerKey = node.id;

        function getTracker() {
            return globalContext.get(node.contextKey) || {};
        }

        function setTracker(tracker) {
            globalContext.set(node.contextKey, tracker);
        }

        function generateId() {
            return crypto.randomUUID();
        }

        function resolveValue(value, type, msg) {
            if (!value) return '';
            switch (type) {
                case 'msg': return RED.util.getMessageProperty(msg, value) || '';
                case 'flow': return node.context().flow.get(value) || '';
                case 'global': return globalContext.get(value) || '';
                case 'env': return RED.util.evaluateNodeProperty(value, 'env', node, msg) || '';
                default: return value;
            }
        }

        // Resolve parent_id: msg.frame_id (from chained wiring) > parentLevel lookup
        function resolveParentId(tracker, msg) {
            if (msg.frame_id) {
                return msg.frame_id;
            }
            if (node.parentLevel) {
                // Search tracker for an active record at the parent level
                for (const key in tracker) {
                    const entry = tracker[key];
                    if (entry && entry.active && entry.record && entry.record.level === node.parentLevel) {
                        return entry.id;
                    }
                }
            }
            return '';
        }

        /**
         * End the current frame record, emit cascade event, and output
         */
        function endFrame(send) {
            const tracker = getTracker();
            const entry = tracker[trackerKey];
            if (!entry || !entry.active) return null;

            const record = entry.record;
            record.endtime = new Date().toISOString();
            record.state = 'complete';

            // Clear active record
            tracker[trackerKey] = { active: false };
            setTracker(tracker);

            node.status({ fill: "grey", shape: "ring", text: `${node.level}: complete` });

            const endMsg = {
                topic: `batch/${node.level}/end`,
                payload: { ...record },
                frame_id: record.id
            };

            if (send) {
                send([null, endMsg]);
            } else {
                node.send([null, endMsg]);
            }

            // Cascade: signal children to end
            if (node.endChildren) {
                emitter.emit('end-frame', record.id);
            }

            return record;
        }

        // Listen for parent ending — auto-end this frame if our parent_id matches
        function onParentEnd(parentId) {
            const tracker = getTracker();
            const entry = tracker[trackerKey];
            if (entry && entry.active && entry.record && entry.record.parent_id === parentId) {
                endFrame(null);
            }
        }

        emitter.on('end-frame', onParentEnd);

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                // Extract trigger value
                let trigger;
                if (node.triggerField.startsWith('msg.')) {
                    trigger = RED.util.getMessageProperty(msg, node.triggerField.substring(4));
                } else {
                    trigger = RED.util.getMessageProperty(msg, node.triggerField);
                }
                const isActive = !!trigger;

                const tracker = getTracker();
                const entry = tracker[trackerKey] || { active: false };

                if (isActive && !entry.active) {
                    // ── START frame record ──
                    const id = generateId();
                    const batchName = resolveValue(node.batchName, node.batchNameType, msg);
                    const unitVal = resolveValue(node.unit, node.unitType, msg);
                    const batchIdVal = resolveValue(node.batchId, node.batchIdType, msg);
                    const parentId = resolveParentId(tracker, msg);

                    // Extract optional metadata
                    let metadata = '';
                    if (node.metadataField) {
                        const raw = RED.util.getMessageProperty(msg, node.metadataField);
                        metadata = (raw !== undefined) ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : '';
                    }

                    const record = {
                        id: id,
                        starttime: new Date().toISOString(),
                        endtime: '9999-12-31T23:59:59.000Z',
                        name: batchName,
                        parent_id: parentId,
                        level: node.level,
                        state: 'running',
                        batch_id: batchIdVal,
                        unit: unitVal,
                        metadata: metadata
                    };

                    // Store active record in tracker
                    tracker[trackerKey] = {
                        active: true,
                        id: id,
                        record: record
                    };
                    setTracker(tracker);

                    node.status({ fill: "green", shape: "dot", text: `${node.level}: running` });

                    // Output start event — frame_id enables chaining to child nodes
                    const startMsg = {
                        topic: `batch/${node.level}/start`,
                        payload: { ...record },
                        frame_id: id
                    };
                    send([startMsg, null]);
                    done();

                } else if (!isActive && entry.active) {
                    // ── END frame record ──
                    endFrame(send);
                    done();

                } else {
                    // No state change
                    done();
                }
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        node.on('close', function(done) {
            emitter.removeListener('end-frame', onParentEnd);
            done();
        });
    }

    RED.nodes.registerType("event-frame", EventFrameNode);

    // Admin endpoint to get current batch tracker state
    RED.httpAdmin.get("/event-frame/tracker", function(req, res) {
        const contextKey = req.query.key || 'isa88_batches';
        let tracker = {};
        RED.nodes.eachNode(function(n) {
            if (n.type === 'event-frame') {
                const frameNode = RED.nodes.getNode(n.id);
                if (frameNode) {
                    tracker = frameNode.context().global.get(contextKey) || {};
                }
            }
        });
        res.json(tracker);
    });
};
