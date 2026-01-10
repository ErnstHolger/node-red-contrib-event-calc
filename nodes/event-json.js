/**
 * event-json - Bidirectional JSON envelope converter
 *
 * Automatically detects direction:
 * - Object with {value, topic?, timestamp?} -> extracts to msg
 * - Any other payload -> wraps in {timestamp, topic, value}
 */
module.exports = function(RED) {
    function EventJsonNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                let data = msg.payload;

                // If string, try to parse as JSON
                if (typeof data === 'string') {
                    try {
                        data = JSON.parse(data);
                    } catch (e) {
                        // Not JSON string - wrap it
                        msg.payload = {
                            timestamp: Date.now(),
                            topic: msg.topic,
                            value: msg.payload
                        };
                        node.status({ fill: "green", shape: "dot", text: "wrapped" });
                        send(msg);
                        done();
                        return;
                    }
                }

                // Check if it's an envelope object (has 'value' property)
                if (typeof data === 'object' && data !== null && 'value' in data) {
                    // Unwrap: extract from envelope
                    if (data.topic) {
                        msg.topic = data.topic;
                    }
                    if (data.timestamp) {
                        msg.timestamp = data.timestamp;
                    }
                    msg.payload = data.value;
                    node.status({ fill: "blue", shape: "dot", text: "unwrapped" });
                } else {
                    // Wrap: create envelope
                    msg.payload = {
                        timestamp: Date.now(),
                        topic: msg.topic,
                        value: data
                    };
                    node.status({ fill: "green", shape: "dot", text: "wrapped" });
                }

                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });
    }

    RED.nodes.registerType("event-json", EventJsonNode);
};
