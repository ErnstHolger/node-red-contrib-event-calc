/**
 * simple-frame - Simple event recorder node
 *
 * Records events with start/end time, type, name, and metadata.
 * No ISA-88 hierarchy, no parent-child relationships, no cascade.
 *
 * Features:
 * - Trigger-based: truthy starts, falsy ends
 * - Auto-generated unique IDs
 * - Configurable type and name (str/msg/flow/global/env)
 * - Optional metadata from msg field
 * - Two outputs: [start, end]
 */
module.exports = function(RED) {
    const crypto = require('crypto');

    function SimpleFrameNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.eventType = config.eventType || '';
        node.eventTypeType = config.eventTypeType || 'str';
        node.eventName = config.eventName || '';
        node.eventNameType = config.eventNameType || 'str';
        node.triggerField = config.triggerField || 'payload';
        node.metadataField = config.metadataField || '';
        node.outputTopic = config.outputTopic || '';

        function resolveValue(value, type, msg) {
            if (!value) return '';
            switch (type) {
                case 'msg': return RED.util.getMessageProperty(msg, value) || '';
                case 'flow': return node.context().flow.get(value) || '';
                case 'global': return node.context().global.get(value) || '';
                case 'env': return RED.util.evaluateNodeProperty(value, 'env', node, msg) || '';
                default: return value;
            }
        }

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

                // Get active record from node context
                const activeRecord = node.context().get('activeRecord') || null;

                if (isActive && !activeRecord) {
                    // ── START event ──
                    const typeVal = resolveValue(node.eventType, node.eventTypeType, msg);
                    const nameVal = resolveValue(node.eventName, node.eventNameType, msg);

                    // Extract optional metadata
                    let metadata = '';
                    if (node.metadataField) {
                        const raw = RED.util.getMessageProperty(msg, node.metadataField);
                        metadata = (raw !== undefined) ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : '';
                    }

                    const record = {
                        id: crypto.randomUUID(),
                        starttime: new Date().toISOString(),
                        endtime: '9999-12-31T23:59:59.000Z',
                        type: typeVal,
                        name: nameVal,
                        state: 'running',
                        metadata: metadata
                    };

                    // Store in node context
                    node.context().set('activeRecord', record);

                    node.status({ fill: "green", shape: "dot", text: "running" });

                    const topic = node.outputTopic || (typeVal ? `event/${typeVal}/start` : 'event/start');
                    const startMsg = {
                        topic: topic,
                        payload: { ...record }
                    };
                    send([startMsg, null]);
                    done();

                } else if (!isActive && activeRecord) {
                    // ── END event ──
                    const record = { ...activeRecord };
                    record.endtime = new Date().toISOString();
                    record.state = 'complete';

                    // Clear active record
                    node.context().set('activeRecord', null);

                    node.status({ fill: "grey", shape: "ring", text: "complete" });

                    const typeVal = record.type;
                    const topic = node.outputTopic || (typeVal ? `event/${typeVal}/end` : 'event/end');
                    const endMsg = {
                        topic: topic,
                        payload: { ...record }
                    };
                    send([null, endMsg]);
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
    }

    RED.nodes.registerType("simple-frame", SimpleFrameNode);
};
