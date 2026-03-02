/**
 * event-calc - Calculation node for multi-topic expressions
 *
 * Features:
 * - Maps variables to exact topics
 * - Evaluates JavaScript expressions when inputs update
 * - Trigger modes: 'any' (any input updates) or 'all' (all inputs have values)
 * - Cached compiled functions for high throughput
 * - Dynamic expression update via input message
 * - Built-in helper functions for common operations
 */
module.exports = function(RED) {

    // Helper functions available in expressions
    const helpers = {
        // Math shortcuts
        min: (...args) => Math.min(...args.flat()),
        max: (...args) => Math.max(...args.flat()),
        abs: Math.abs,
        sqrt: Math.sqrt,
        pow: Math.pow,
        log: Math.log,
        log10: Math.log10,
        exp: Math.exp,
        floor: Math.floor,
        ceil: Math.ceil,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        PI: Math.PI,
        E: Math.E,

        // Aggregation
        sum: (...args) => args.flat().reduce((a, b) => a + b, 0),
        avg: (...args) => {
            const flat = args.flat();
            return flat.length > 0 ? flat.reduce((a, b) => a + b, 0) / flat.length : 0;
        },
        count: (...args) => args.flat().length,

        // Utility
        round: (value, decimals = 0) => {
            const factor = Math.pow(10, decimals);
            return Math.round(value * factor) / factor;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        map: (value, inMin, inMax, outMin, outMax) => {
            return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
        },
        lerp: (a, b, t) => a + (b - a) * t,

        // Boolean/conditional helpers
        ifelse: (condition, trueVal, falseVal) => condition ? trueVal : falseVal,
        between: (value, min, max) => value >= min && value <= max,

        // Delta/change detection (returns difference)
        delta: (current, previous) => current - previous,
        pctChange: (current, previous) => previous !== 0 ? ((current - previous) / previous) * 100 : 0,

        // Date/time helpers (all based on local time)
        hour: () => new Date().getHours(),
        minute: () => new Date().getMinutes(),
        second: () => new Date().getSeconds(),
        day: () => new Date().getDay(),          // 0=Sun, 1=Mon, ..., 6=Sat
        dayOfMonth: () => new Date().getDate(),
        month: () => new Date().getMonth() + 1,  // 1-12
        year: () => new Date().getFullYear(),
        isWeekday: () => { const d = new Date().getDay(); return d >= 1 && d <= 5; },
        isWeekend: () => { const d = new Date().getDay(); return d === 0 || d === 6; },
        hoursBetween: (startHour, endHour) => {
            const h = new Date().getHours();
            return startHour <= endHour
                ? h >= startHour && h < endHour
                : h >= startHour || h < endHour; // wraps midnight
        }
    };

    // Pre-compute helper keys (shared across all nodes, never changes)
    const helperKeys = Object.keys(helpers);
    const helperValues = Object.values(helpers);

    function EventCalcNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cacheConfig = RED.nodes.getNode(config.cache);
        node.inputMappings = config.inputMappings || [];
        node.expression = config.expression || '';
        node.triggerOn = config.triggerOn || 'any';
        node.outputTopic = config.outputTopic || 'calc/result';
        node.externalTrigger = config.externalTrigger || false;

        const subscriptionIds = [];

        if (!node.cacheConfig) {
            node.status({ fill: "red", shape: "ring", text: "no cache configured" });
            return;
        }

        if (node.inputMappings.length === 0) {
            node.status({ fill: "yellow", shape: "ring", text: "no inputs defined" });
            return;
        }

        if (!node.expression) {
            node.status({ fill: "yellow", shape: "ring", text: "no expression" });
            return;
        }

        // Track subscribed topics to ignore updates from our own output
        const subscribedTopics = new Set();
        for (const input of node.inputMappings) {
            const topicName = input.topic || input.pattern;
            if (topicName) {
                subscribedTopics.add(topicName);
            }
        }

        // Subscribe to inputs
        const latestValues = new Map();

        // Dynamic helpers that need access to cache (created per-node)
        const cacheHelpers = {
            now: Date.now,
            hasChanged: (varName) => {
                const data = latestValues.get(varName);
                if (!data || !data.topic) return false;
                const entry = node.cacheConfig.getValue(data.topic);
                if (!entry || !entry.previous) return false;
                return entry.value !== entry.previous.value;
            },
            timeSinceLastChange: (varName) => {
                const data = latestValues.get(varName);
                if (!data || !data.topic) return 0;
                const entry = node.cacheConfig.getValue(data.topic);
                if (!entry) return 0;
                if (!entry.previous || entry.value === entry.previous.value) {
                    return Date.now() - (entry.previous ? entry.previous.ts : entry.ts);
                }
                return Date.now() - entry.ts;
            },
            prev: (varName) => {
                const data = latestValues.get(varName);
                if (!data || !data.topic) return undefined;
                const prev = node.cacheConfig.getPrevious(data.topic);
                return prev ? prev.value : undefined;
            }
        };

        // Pre-compute cache helper keys
        const cacheHelperKeys = Object.keys(cacheHelpers);
        const cacheHelperValues = Object.values(cacheHelpers);

        // Pre-compute input variable names (order is stable)
        const inputNames = node.inputMappings.map(m => m.name);

        // --- Compiled function cache ---
        // All param names = helpers + cacheHelpers + input variable names
        // helpers and cacheHelpers are fixed; input names are fixed per node
        const allParamNames = [...helperKeys, ...cacheHelperKeys, ...inputNames];
        // Pre-allocate the values array (reused on every call)
        const allParamValues = new Array(allParamNames.length);
        // Fill the fixed portion (helpers + cacheHelpers)
        const fixedCount = helperKeys.length + cacheHelperKeys.length;
        for (let i = 0; i < helperKeys.length; i++) {
            allParamValues[i] = helperValues[i];
        }
        for (let i = 0; i < cacheHelperKeys.length; i++) {
            allParamValues[helperKeys.length + i] = cacheHelperValues[i];
        }

        // Compiled function + expression it was compiled from
        let compiledFn = null;
        let compiledExpression = '';

        function compileExpression(expr) {
            if (expr === compiledExpression && compiledFn) return compiledFn;
            compiledFn = new Function(...allParamNames, `return ${expr};`);
            compiledExpression = expr;
            return compiledFn;
        }

        // Compile initial expression
        try {
            compileExpression(node.expression);
        } catch (err) {
            node.status({ fill: "red", shape: "ring", text: "compile error" });
        }

        /**
         * Attempt to calculate and output result
         */
        function tryCalculate(triggerTopic, triggerTs) {
            // Ignore updates triggered by our own output
            if (triggerTopic === node.outputTopic) {
                return;
            }

            if (node.triggerOn === 'all') {
                for (let i = 0; i < inputNames.length; i++) {
                    if (!latestValues.has(inputNames[i])) {
                        return;
                    }
                }
            }

            if (latestValues.size === 0) {
                return;
            }

            // Fill input variable values into the pre-allocated array
            let hasAllInputs = true;
            for (let i = 0; i < inputNames.length; i++) {
                const data = latestValues.get(inputNames[i]);
                if (data && data.value !== undefined && data.value !== null) {
                    allParamValues[fixedCount + i] = data.value;
                } else {
                    allParamValues[fixedCount + i] = undefined;
                    hasAllInputs = false;
                }
            }

            try {
                const fn = compileExpression(node.expression);
                const result = fn(...allParamValues);

                // Check for NaN or invalid result
                if (typeof result === 'number' && isNaN(result)) {
                    node.send([null, {
                        topic: node.outputTopic,
                        payload: { error: 'Expression resulted in NaN', expression: node.expression },
                        trigger: triggerTopic,
                        ts: triggerTs
                    }]);
                    node.status({ fill: "yellow", shape: "ring", text: "NaN" });
                    return;
                }

                node.send([{
                    topic: node.outputTopic,
                    payload: result,
                    expression: node.expression,
                    trigger: triggerTopic,
                    ts: triggerTs
                }, null]);

                node.cacheConfig.setValue(node.outputTopic, result, {
                    source: 'event-calc',
                    expression: node.expression
                });

                const resultStr = String(result);
                const displayResult = resultStr.length > 15 ? resultStr.substring(0, 12) + '...' : resultStr;
                node.status({ fill: "green", shape: "dot", text: `= ${displayResult}` });

            } catch (err) {
                node.send([null, {
                    topic: node.outputTopic,
                    payload: { error: err.message, expression: node.expression },
                    trigger: triggerTopic,
                    ts: triggerTs
                }]);
                node.status({ fill: "red", shape: "ring", text: "eval error" });
            }
        }

        for (const input of node.inputMappings) {
            const topicName = input.topic || input.pattern;
            if (!input.name || !topicName) continue;

            const subId = node.cacheConfig.subscribe(topicName, (topic, entry) => {
                latestValues.set(input.name, {
                    topic: topic,
                    value: entry.value,
                    ts: entry.ts
                });
                tryCalculate(topic, entry.ts);
            });
            subscriptionIds.push(subId);
        }

        node.status({ fill: "green", shape: "dot", text: "ready" });

        // Handle input messages for dynamic updates
        node.on('input', function(msg, send, done) {
            // For Node-RED 0.x compatibility
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            // Allow expression update via message
            if (msg.expression && typeof msg.expression === 'string') {
                node.expression = msg.expression;
                compiledFn = null; // Force recompile
                compiledExpression = '';
                node.status({ fill: "blue", shape: "dot", text: "expr updated" });
            }

            // External trigger: any incoming message triggers calculation
            if (node.externalTrigger) {
                const triggerSource = msg.topic || '_external';
                const triggerTs = msg.timestamp || Date.now();
                tryCalculate(triggerSource, triggerTs);
                done();
                return;
            }

            // Force recalculation (use special topic to bypass self-output check)
            if (msg.payload === 'recalc' || msg.topic === 'recalc') {
                if (latestValues.size > 0) {
                    const triggerTs = msg.timestamp || Date.now();
                    tryCalculate('_recalc', triggerTs);
                }
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
            done();
        });
    }

    RED.nodes.registerType("event-calc", EventCalcNode);
};
