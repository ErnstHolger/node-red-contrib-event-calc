/**
 * event-alarm - Alarm management node with ISA-18.2 lifecycle
 *
 * Alarm states:
 *   UNACK_ALM  - Active + Unacknowledged (just raised)
 *   ACK_ALM    - Active + Acknowledged (operator acked, condition still true)
 *   UNACK_RTN  - Inactive + Unacknowledged (condition cleared, not yet acked)
 *   NORM       - Normal (fully resolved, removed from state)
 *
 * Lifecycle transitions:
 *   NORM → condition true  → UNACK_ALM
 *   UNACK_ALM → ack        → ACK_ALM
 *   ACK_ALM → condition false → NORM (resolved)
 *   UNACK_ALM → condition false → UNACK_RTN
 *   UNACK_RTN → ack         → NORM (resolved)
 *
 * Outputs (one per state):
 *   0: Raised      (UNACK_ALM)
 *   1: Acknowledged (ACK_ALM)
 *   2: Cleared      (UNACK_RTN)
 *   3: Resolved     (NORM - lifecycle complete)
 */
module.exports = function(RED) {

    function EventAlarmNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cacheConfig = RED.nodes.getNode(config.cache);
        node.inputMappings = config.inputMappings || [];
        node.condition = config.condition || '';
        node.conditionId = config.conditionId || node.id;
        node.conditionName = config.conditionName || 'Alarm';
        node.severity = parseInt(config.severity) || 500;
        node.outputTopic = config.outputTopic || 'alarm/event';

        const subscriptionIds = [];

        if (!node.cacheConfig) {
            node.status({ fill: "red", shape: "ring", text: "no cache configured" });
            return;
        }

        if (node.inputMappings.length === 0) {
            node.status({ fill: "yellow", shape: "ring", text: "no inputs defined" });
            return;
        }

        if (!node.condition) {
            node.status({ fill: "yellow", shape: "ring", text: "no condition" });
            return;
        }

        // Alarm state dictionary: Map<source, alarmRecord>
        // Stored in node context for persistence across restarts
        const nodeContext = node.context();
        let alarms = new Map();

        // Restore from context
        const stored = nodeContext.get('alarms');
        if (stored && typeof stored === 'object') {
            for (const [key, val] of Object.entries(stored)) {
                alarms.set(key, val);
            }
        }

        function saveAlarms() {
            const obj = {};
            for (const [key, val] of alarms) {
                obj[key] = val;
            }
            nodeContext.set('alarms', obj);
        }

        // Track latest values from subscriptions
        const latestValues = new Map();
        const inputNames = node.inputMappings.map(m => m.name);

        // Compile condition expression
        let compiledFn = null;
        try {
            compiledFn = new Function(...inputNames, `return !!(${node.condition});`);
        } catch (err) {
            node.status({ fill: "red", shape: "ring", text: "compile error" });
            return;
        }

        function buildAlarmMsg(record) {
            return {
                topic: node.outputTopic,
                payload: {
                    condition_id: node.conditionId,
                    condition_name: node.conditionName,
                    source: record.source,
                    source_node: node.id,
                    active_state: record.active_state,
                    acked_state: record.acked_state,
                    severity: node.severity,
                    retain: record.retain,
                    ts: record.ts,
                    lifecycle: record.lifecycle
                }
            };
        }

        function updateStatus() {
            const active = [...alarms.values()].filter(a => a.active_state === 'Active');
            const unacked = [...alarms.values()].filter(a => a.acked_state === 'Unacknowledged');
            if (alarms.size === 0) {
                node.status({ fill: "green", shape: "dot", text: "normal" });
            } else if (active.length > 0 && unacked.length > 0) {
                node.status({ fill: "red", shape: "dot", text: `${alarms.size} alarm(s), ${unacked.length} unacked` });
            } else if (active.length > 0) {
                node.status({ fill: "yellow", shape: "dot", text: `${active.length} active` });
            } else {
                node.status({ fill: "blue", shape: "dot", text: `${unacked.length} unacked (cleared)` });
            }
        }

        function evaluateCondition(triggerTopic, triggerTs) {
            if (latestValues.size === 0) return;

            // Build argument values
            const args = inputNames.map(name => {
                const data = latestValues.get(name);
                return data ? data.value : undefined;
            });

            let isActive;
            try {
                isActive = compiledFn(...args);
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "eval error" });
                return;
            }

            const source = triggerTopic;
            const now = triggerTs || Date.now();
            const existing = alarms.get(source);

            if (isActive && !existing) {
                // NORM → UNACK_ALM: New alarm raised
                const record = {
                    source: source,
                    active_state: 'Active',
                    acked_state: 'Unacknowledged',
                    retain: true,
                    ts: now,
                    lifecycle: {
                        raised_ts: now
                    }
                };
                alarms.set(source, record);
                saveAlarms();
                updateStatus();
                node.send([buildAlarmMsg(record), null, null, null]);

            } else if (!isActive && existing && existing.active_state === 'Active') {
                if (existing.acked_state === 'Acknowledged') {
                    // ACK_ALM → NORM: Condition cleared after ack → fully resolved
                    existing.active_state = 'Inactive';
                    existing.retain = false;
                    existing.ts = now;
                    existing.lifecycle.resolved_ts = now;
                    const msg = buildAlarmMsg(existing);
                    alarms.delete(source);
                    saveAlarms();
                    updateStatus();
                    node.send([null, null, null, msg]);
                } else {
                    // UNACK_ALM → UNACK_RTN: Condition cleared but not yet acked
                    existing.active_state = 'Inactive';
                    existing.retain = true;
                    existing.ts = now;
                    existing.lifecycle.cleared_ts = now;
                    saveAlarms();
                    updateStatus();
                    node.send([null, null, buildAlarmMsg(existing), null]);
                }

            } else if (isActive && existing && existing.active_state === 'Inactive') {
                // UNACK_RTN → UNACK_ALM: Condition re-activated before ack
                existing.active_state = 'Active';
                existing.retain = true;
                existing.ts = now;
                existing.lifecycle.reraised_ts = now;
                saveAlarms();
                updateStatus();
                node.send([buildAlarmMsg(existing), null, null, null]);
            }
        }

        function handleAck(source) {
            const existing = alarms.get(source);
            if (!existing || existing.acked_state === 'Acknowledged') return;

            const now = Date.now();
            existing.acked_state = 'Acknowledged';
            existing.ts = now;
            existing.lifecycle.acked_ts = now;

            if (existing.active_state === 'Inactive') {
                // UNACK_RTN → NORM: Ack on cleared alarm → fully resolved
                existing.retain = false;
                existing.lifecycle.resolved_ts = now;
                const msg = buildAlarmMsg(existing);
                alarms.delete(source);
                saveAlarms();
                updateStatus();
                node.send([null, null, null, msg]);
            } else {
                // UNACK_ALM → ACK_ALM: Ack on active alarm
                saveAlarms();
                updateStatus();
                node.send([null, buildAlarmMsg(existing), null, null]);
            }
        }

        // Subscribe to input topics
        for (const input of node.inputMappings) {
            const topicName = input.topic || input.pattern;
            if (!input.name || !topicName) continue;

            const subId = node.cacheConfig.subscribe(topicName, (topic, entry) => {
                latestValues.set(input.name, {
                    topic: topic,
                    value: entry.value,
                    ts: entry.ts
                });
                evaluateCondition(topic, entry.ts);
            });
            subscriptionIds.push(subId);
        }

        updateStatus();

        // Handle input messages (ack, ack_all, clear)
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            const action = (msg.payload && msg.payload.action) || msg.action;

            if (action === 'ack') {
                const source = (msg.payload && msg.payload.source) || msg.source;
                if (source) {
                    handleAck(source);
                } else {
                    node.warn("ack requires a source");
                }
            } else if (action === 'ack_all') {
                const sources = [...alarms.keys()];
                for (const source of sources) {
                    handleAck(source);
                }
            } else if (action === 'list') {
                const list = [];
                for (const [source, record] of alarms) {
                    list.push({ ...record });
                }
                send([null, null, null, { topic: node.outputTopic + '/list', payload: list }]);
            }

            done();
        });

        node.on('close', function(done) {
            for (const subId of subscriptionIds) {
                if (node.cacheConfig) {
                    node.cacheConfig.unsubscribe(subId);
                }
            }
            subscriptionIds.length = 0;
            saveAlarms();
            done();
        });
    }

    RED.nodes.registerType("event-alarm", EventAlarmNode);

    // HTTP endpoint to get active alarms
    RED.httpAdmin.get("/event-alarm/:id/alarms", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            const ctx = node.context();
            const stored = ctx.get('alarms') || {};
            res.json(stored);
        } else {
            res.sendStatus(404);
        }
    });
};