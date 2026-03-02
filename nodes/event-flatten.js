module.exports = function(RED) {
    function EventFlattenNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            const payload = msg.payload;
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                delete msg.payload;
                Object.assign(msg, payload);
                node.status({ fill: "green", shape: "dot", text: `${Object.keys(payload).length} fields` });
            } else {
                node.status({ fill: "yellow", shape: "ring", text: "payload not an object" });
            }

            send(msg);
            done();
        });
    }

    RED.nodes.registerType("event-flatten", EventFlattenNode);
};