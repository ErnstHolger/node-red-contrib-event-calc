/**
 * event-preview - Message preview node with live updates
 *
 * Displays topic, timestamp, and payload of the latest message
 * Real-time updates via WebSocket with play/pause control
 */
module.exports = function(RED) {
    function EventPreviewNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name || '';
        node.latestMessage = null;
        node.active = true; // Whether to send updates

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            // Store the entire message (clone to avoid reference issues)
            const msgCopy = {};
            for (const key of Object.keys(msg)) {
                if (key !== '_msgid') { // Skip internal Node-RED field
                    msgCopy[key] = msg[key];
                }
            }
            // Ensure timestamp exists
            if (!msgCopy.timestamp) {
                msgCopy.timestamp = Date.now();
            }
            node.latestMessage = msgCopy;

            // Format timestamp for display
            const ts = new Date(node.latestMessage.timestamp);
            const timeStr = ts.toLocaleTimeString();

            // Format payload for status (truncate if needed)
            let payloadStr;
            if (typeof msg.payload === 'object') {
                payloadStr = JSON.stringify(msg.payload);
            } else {
                payloadStr = String(msg.payload);
            }
            if (payloadStr.length > 30) {
                payloadStr = payloadStr.substring(0, 27) + '...';
            }

            // Update node status with preview
            node.status({
                fill: node.active ? "green" : "grey",
                shape: "dot",
                text: `${msg.topic || '-'} | ${payloadStr} | ${timeStr}`
            });

            // Send real-time update to editor if active
            if (node.active) {
                RED.comms.publish("event-preview:" + node.id, node.latestMessage);
            }

            // Send message through to allow chaining
            send(msg);
            done();
        });

        // Handle pause/play commands from editor
        node.on('close', function(done) {
            node.latestMessage = null;
            done();
        });
    }

    RED.nodes.registerType("event-preview", EventPreviewNode);

    // HTTP endpoint to get latest message data
    RED.httpAdmin.get("/event-preview/:id/latest", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node && node.latestMessage) {
            res.json(node.latestMessage);
        } else {
            res.json(null);
        }
    });

    // HTTP endpoint to toggle active state
    RED.httpAdmin.post("/event-preview/:id/toggle", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            node.active = !node.active;
            node.status({
                fill: node.active ? "green" : "grey",
                shape: "dot",
                text: node.active ? "active" : "paused"
            });
            res.json({ active: node.active });
        } else {
            res.sendStatus(404);
        }
    });

    // HTTP endpoint to set active state
    RED.httpAdmin.post("/event-preview/:id/active/:state", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            node.active = req.params.state === 'true';
            node.status({
                fill: node.active ? "green" : "grey",
                shape: "dot",
                text: node.active ? "active" : "paused"
            });
            res.json({ active: node.active });
        } else {
            res.sendStatus(404);
        }
    });

    // HTTP endpoint to get active state
    RED.httpAdmin.get("/event-preview/:id/active", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            res.json({ active: node.active });
        } else {
            res.sendStatus(404);
        }
    });
};
